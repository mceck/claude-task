// Package runner carries out Jobs for the backend: it keeps the WebSocket to the backend,
// prepares Worktrees and drives one `claude` process at a time.
package runner

import (
	"context"
	"encoding/json"
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
)

type Runner struct {
	worktreeMu    sync.Mutex
	cfg           Config
	claudeVersion string

	mu      sync.Mutex
	conn    *websocket.Conn // nil while disconnected
	jobs    []*job          // Jobs with a live process or unacked messages, oldest first
	current *job            // the Job being prepared or running, if any
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

// sendNow sends a message that isn't kept for resending (pong).
func (r *Runner) sendNow(v any) {
	data, _ := json.Marshal(v)
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.conn != nil {
		if err := write(context.Background(), r.conn, data); err != nil {
			r.conn.CloseNow()
			r.conn = nil
		}
	}
}

// emit assigns the next seq of the Job, keeps the message until acked and sends it if connected.
func (r *Runner) emit(j *job, typ string, fields map[string]any) int64 {
	r.mu.Lock()
	defer r.mu.Unlock()
	j.seq++
	msg := map[string]any{"type": typ, "jobId": j.id, "seq": j.seq}
	for k, v := range fields {
		msg[k] = v
	}
	data, _ := json.Marshal(msg)
	if err := j.out.add(j.seq, data); err != nil {
		log.Printf("job %s: outbox: %v", j.id, err)
	}
	if r.conn != nil {
		if err := write(context.Background(), r.conn, data); err != nil {
			r.conn.CloseNow()
			r.conn = nil
		}
	}
	return j.seq
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
		j := r.current
		r.mu.Unlock()
		if j == nil || j.id != m.JobID {
			log.Printf("ignoring %s for job %s that isn't running", m.Type, m.JobID)
			return
		}
		j.control(m)
	case "worktree.remove":
		r.removeWorktree(m)
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
	r.jobs = append(r.jobs, j)
	busy := r.current != nil
	if !busy {
		r.current = j
	}
	r.mu.Unlock()
	if busy {
		r.emit(j, "job.failed", map[string]any{"stage": "spawn", "message": "another job is running"})
		r.finish(j)
		return
	}
	go j.run()
}

// finish marks a Job done; it's forgotten once all its messages are acked.
func (r *Runner) finish(j *job) {
	r.mu.Lock()
	defer r.mu.Unlock()
	j.finished = true
	if r.current == j {
		r.current = nil
	}
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

func (r *Runner) spillPath(jobID string) string {
	return filepath.Join(r.cfg.Home, ".claude-task", "outbox", jobID+".jsonl")
}

func claudeVersion(path string) string {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, path, "--version").Output()
	if err != nil {
		return "unknown"
	}
	if f := strings.Fields(string(out)); len(f) > 0 {
		return f[0]
	}
	return "unknown"
}
