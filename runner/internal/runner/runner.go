// Package runner carries out Jobs for the backend: it keeps the WebSocket to the backend,
// prepares Worktrees and drives one `claude` process at a time.
package runner

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"math/rand/v2"
	"net/http"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"

	"claude-task/runner/internal/protocol"
)

const (
	writeTimeout = 10 * time.Second
	pingInterval = 30 * time.Second
	readLimit    = 64 << 20 // job.start can carry base64 images
	// maxMessageBytes caps an outgoing message well below the backend's 64 MiB limit: a bigger
	// one would drop the connection again on every resend.
	maxMessageBytes = 32 << 20
	previewBytes    = 16 << 10
)

type Runner struct {
	cfg           Config
	claudeVersion string

	mu        sync.Mutex
	conn      *websocket.Conn // nil while disconnected
	jobs      []*job          // Jobs with a live process or unacked messages, oldest first
	current   *job            // the Job being prepared or running, if any
	worktrees turns           // Worktree preparation and removal, in arrival order
}

func New(cfg Config) *Runner {
	return &Runner{cfg: cfg, claudeVersion: claudeVersion(cfg.ClaudePath)}
}

// Run connects and reconnects until ctx is done.
func (r *Runner) Run(ctx context.Context) {
	if !r.startCredentialServer(ctx) {
		return
	}
	backoff := time.Second
	for ctx.Err() == nil {
		connected, err := r.session(ctx)
		if ctx.Err() != nil {
			return
		}
		if connected {
			backoff = time.Second
		}
		log.Printf("backend connection: %v; reconnecting in ~%s", err, backoff)
		jitter := time.Duration(rand.Int64N(int64(backoff) / 2))
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff/2 + jitter):
		}
		backoff = min(backoff*2, 30*time.Second)
	}
}

// session runs one connection: hello, resend, then the read loop.
func (r *Runner) session(ctx context.Context) (bool, error) {
	dialCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(dialCtx, r.cfg.BackendURL, &websocket.DialOptions{
		HTTPHeader: http.Header{"Authorization": {"Bearer " + r.cfg.Token}},
	})
	if err != nil {
		return false, err
	}
	c.SetReadLimit(readLimit)
	defer c.CloseNow()

	if err := r.attach(ctx, c); err != nil {
		return true, err
	}
	defer r.detach(c)

	connCtx, stop := context.WithCancel(ctx)
	defer stop()
	go func() {
		for {
			select {
			case <-connCtx.Done():
				return
			case <-time.After(pingInterval):
			}
			pingCtx, cancel := context.WithTimeout(connCtx, 15*time.Second)
			err := c.Ping(pingCtx)
			cancel()
			if err != nil {
				c.CloseNow()
				return
			}
		}
	}()

	for {
		_, data, err := c.Read(connCtx)
		if err != nil {
			return true, err
		}
		var m protocol.Incoming
		if err := json.Unmarshal(data, &m); err != nil {
			log.Printf("ignoring malformed message: %v", err)
			continue
		}
		r.handle(&m)
	}
}

// attach sends hello and every unacked message, then makes the connection current.
// Holding the lock keeps newly emitted messages behind the resent ones.
func (r *Runner) attach(ctx context.Context, c *websocket.Conn) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	hello := protocol.Hello{
		Type:            "hello",
		ProtocolVersion: protocol.Version,
		RunnerVersion:   r.cfg.Version,
		ClaudeVersion:   r.claudeVersion,
		ActiveJobID:     r.activeJobID(),
	}
	data, _ := json.Marshal(hello)
	if err := write(ctx, c, data); err != nil {
		return err
	}
	for _, j := range r.jobs {
		if err := j.out.each(func(b []byte) error { return write(ctx, c, b) }); err != nil {
			return err
		}
	}
	r.conn = c
	return nil
}

func (r *Runner) detach(c *websocket.Conn) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.conn == c {
		r.conn = nil
	}
}

func (r *Runner) activeJobID() *string {
	if r.current != nil {
		return &r.current.id
	}
	for _, j := range r.jobs {
		if !j.out.empty() {
			return &j.id
		}
	}
	return nil
}

func write(ctx context.Context, c *websocket.Conn, data []byte) error {
	ctx, cancel := context.WithTimeout(ctx, writeTimeout)
	defer cancel()
	return c.Write(ctx, websocket.MessageText, data)
}

// sendLocked writes to the current connection, dropping it on failure. Caller holds r.mu.
func (r *Runner) sendLocked(data []byte) {
	if r.conn == nil {
		return
	}
	if err := write(context.Background(), r.conn, data); err != nil {
		r.conn.CloseNow()
		r.conn = nil
	}
}

// sendNow sends a message that isn't kept for resending (pong).
func (r *Runner) sendNow(v any) {
	data, _ := json.Marshal(v)
	r.mu.Lock()
	defer r.mu.Unlock()
	r.sendLocked(data)
}

// emit assigns the next seq of the Job, keeps the message until acked and sends it if connected.
func (r *Runner) emit(j *job, typ string, fields map[string]any) int64 {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.emitLocked(j, typ, fields)
}

func (r *Runner) emitLocked(j *job, typ string, fields map[string]any) int64 {
	j.seq++
	msg := map[string]any{"type": typ, "jobId": j.id, "seq": j.seq}
	for k, v := range fields {
		msg[k] = v
	}
	data, _ := json.Marshal(msg)
	if line, ok := msg["line"].(string); ok && len(data) > maxMessageBytes {
		// Within the limit as raw bytes, but not once escaped.
		msg["line"] = unparsedLine([]byte(line), len(line))
		data, _ = json.Marshal(msg)
	}
	if err := j.out.add(j.seq, data); err != nil {
		log.Printf("job %s: outbox: %v", j.id, err)
	}
	r.sendLocked(data)
	return j.seq
}

// unparsedLine stands in for a stdout line too big to send: valid stream-json the projection
// skips, with the beginning of the line.
func unparsedLine(line []byte, size int) string {
	keep := completeUTF8(line[:min(len(line), previewBytes)])
	b, _ := json.Marshal(struct {
		Type      string `json:"type"`
		Line      string `json:"line"`
		Truncated bool   `json:"truncated"`
		Bytes     int    `json:"bytes"`
	}{"unparsed", string(line[:keep]), true, size})
	return string(b)
}

func (r *Runner) handle(m *protocol.Incoming) {
	switch m.Type {
	case "ping":
		r.sendNow(map[string]string{"type": "pong"})
	case "ack":
		r.mu.Lock()
		if j := r.findLocked(m.JobID); j != nil {
			j.out.ack(m.Seq)
			r.retireLocked(j)
		}
		r.mu.Unlock()
	case "job.start":
		r.start(m)
	case "job.input", "job.interrupt", "job.end", "job.cancel":
		r.mu.Lock()
		j := r.findLocked(m.JobID)
		if j != nil && j.finished {
			j = nil
		}
		r.mu.Unlock()
		if j == nil {
			log.Printf("ignoring %s for job %s that isn't running", m.Type, m.JobID)
			return
		}
		j.control(m)
	case "job.upload":
		// Outside the Job's stream: off the read loop and independent of stdin work.
		r.mu.Lock()
		j := r.findLocked(m.JobID)
		if j != nil && j.finished {
			j = nil
		}
		r.mu.Unlock()
		if j == nil {
			log.Printf("ignoring job.upload %s for job %s that isn't running", m.RequestID, m.JobID)
			return
		}
		go j.upload(m)
	case "project_skills.request":
		// Off the read loop: the backend waits a short while for the answer.
		go r.answerProjectSkills(m)
	case "worktree.remove":
		// Off the read loop: it waits for Worktree work before it and for the Jobs using the Worktree.
		r.mu.Lock()
		turn, endTurn := r.worktrees.enter()
		users := r.usingLocked(m.WorktreePath)
		r.mu.Unlock()
		go func() {
			defer endTurn()
			<-turn
			for _, j := range users {
				<-j.done
			}
			r.removeWorktree(m)
		}()
	default:
		log.Printf("ignoring unknown message type %q", m.Type)
	}
}

func (r *Runner) start(m *protocol.Incoming) {
	r.mu.Lock()
	if r.findLocked(m.JobID) != nil {
		r.mu.Unlock()
		return // a resent job.start for a Job we already know
	}
	j := newJob(r, m)
	j.turn, j.endTurn = r.worktrees.enter()
	r.jobs = append(r.jobs, j)
	cur := r.current
	if cur == nil {
		r.current = j
	}
	r.mu.Unlock()
	switch {
	case cur == nil:
		go j.run()
	case cur.isCancelled():
		go r.startAfter(j, cur)
	default:
		r.finish(j, "job.failed", map[string]any{"stage": "spawn", "message": "another job is running"})
	}
}

// startAfter runs j once the cancelled Job cur has stopped: the backend sends the next Job as
// soon as it cancels one. cur gets until its KILL deadline, plus time to drain its output.
func (r *Runner) startAfter(j, cur *job) {
	deadline := time.After(r.cfg.CancelKill + drainIdle + 3*time.Second)
	for {
		select {
		case <-cur.done:
		case <-j.cancelled:
			j.fail("spawn", errCancelled)
			return
		case <-deadline:
			j.fail("spawn", errors.New("another job is running"))
			return
		}
		r.mu.Lock()
		if cur = r.current; cur == nil {
			r.current = j
		}
		r.mu.Unlock()
		if cur == nil {
			j.run()
			return
		}
		if !cur.isCancelled() {
			j.fail("spawn", errors.New("another job is running"))
			return
		}
	}
}

// finish sends the Job's last message and marks it done at once, so the next job.start, which
// the backend sends as soon as it reads that message, never finds this Job still current.
// The Job is forgotten once all its messages are acked.
func (r *Runner) finish(j *job, typ string, fields map[string]any) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.current == j {
		r.current = nil
	}
	r.emitLocked(j, typ, fields)
	j.finished = true
	close(j.done)
	j.endTurn()
	r.retireLocked(j)
}

func (r *Runner) retireLocked(j *job) {
	if !j.finished || !j.out.empty() {
		return
	}
	j.out.close()
	for i, x := range r.jobs {
		if x == j {
			r.jobs = append(r.jobs[:i], r.jobs[i+1:]...)
			break
		}
	}
}

// usingLocked returns the unfinished Jobs on a Worktree.
func (r *Runner) usingLocked(worktreePath string) []*job {
	wt, err := within(r.cfg.Home, worktreePath)
	if err != nil {
		return nil
	}
	var users []*job
	for _, j := range r.jobs {
		if !j.finished && j.worktreeDir() == wt {
			users = append(users, j)
		}
	}
	return users
}

func (r *Runner) findLocked(id string) *job {
	for _, j := range r.jobs {
		if j.id == id {
			return j
		}
	}
	return nil
}

// Shutdown forwards SIGTERM to a running claude process.
func (r *Runner) Shutdown() {
	r.mu.Lock()
	j := r.current
	r.mu.Unlock()
	if j != nil {
		j.terminate()
	}
}

// turns hands out Worktree work one at a time, in the order it was asked for.
type turns struct{ last chan struct{} }

// enter returns a channel closed when it's the caller's turn, and the func that ends the turn.
// Ending it early still keeps the order.
func (t *turns) enter() (<-chan struct{}, func()) {
	prev := t.last
	if prev == nil {
		prev = make(chan struct{})
		close(prev)
	}
	next := make(chan struct{})
	t.last = next
	var once sync.Once
	return prev, func() {
		once.Do(func() {
			go func() { <-prev; close(next) }()
		})
	}
}

func (r *Runner) spillPath(jobID string) string {
	return filepath.Join(r.cfg.Home, ".claude-task", "outbox", jobID+".jsonl")
}

func claudeVersion(path string) string {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, path, "--version")
	cmd.Env = childEnv()
	out, err := cmd.Output()
	if err != nil {
		return "unknown"
	}
	if f := strings.Fields(string(out)); len(f) > 0 {
		return f[0]
	}
	return "unknown"
}
