package runner

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
	"unicode/utf8"

	"claude-task/runner/internal/protocol"
)

type job struct {
	r     *Runner
	id    string
	start *protocol.Incoming

	// Guarded by r.mu.
	seq      int64
	out      *outbox
	finished bool

	done      chan struct{}   // closed once the Job is finished
	turn      <-chan struct{} // closed when the Job may prepare its Worktree
	endTurn   func()
	ops       chan *protocol.Incoming // stdin work, in arrival order
	cancelled chan struct{}           // closed on job.cancel

	mu                  sync.Mutex
	cmd                 *exec.Cmd // claude, once spawned
	pgid                int       // process group of the running child (a setup step or claude), 0 if none
	stdin               *os.File
	exited              chan struct{}
	remoteBranchMissing bool
	reqSeq              int
}

func newJob(r *Runner, m *protocol.Incoming) *job {
	return &job{
		r:         r,
		id:        m.JobID,
		start:     m,
		out:       newOutbox(r.cfg.OutboxMemoryBytes, r.spillPath(m.JobID)),
		done:      make(chan struct{}),
		ops:       make(chan *protocol.Incoming, 1024),
		cancelled: make(chan struct{}),
		exited:    make(chan struct{}),
	}
}

func (j *job) emit(typ string, fields map[string]any) int64 { return j.r.emit(j, typ, fields) }

func (j *job) fail(stage string, err error) {
	j.r.finish(j, "job.failed", map[string]any{"stage": stage, "message": err.Error()})
}

// isCancelled can't change while j.mu is held: control closes j.cancelled under it, so a
// process started under j.mu after the check is reached by escalate.
func (j *job) isCancelled() bool {
	select {
	case <-j.cancelled:
		return true
	default:
		return false
	}
}

var errCancelled = errors.New("cancelled before start")

func (j *job) run() {
	m := j.start
	j.emit("job.accepted", nil)
	worktree, created, err := j.prepareWorktree()
	if err != nil {
		j.fail("worktree", err)
		return
	}
	if m.Git != nil {
		j.emit("job.worktree_ready", map[string]any{"created": created, "remoteBranchMissing": j.remoteBranchMissing})
	}
	// A new Worktree is marked as soon as it exists, so a failure before its setup succeeded
	// (here or in an earlier attempt) makes the next Job run it again.
	pendingSetup := filepath.Join(worktree, setupPendingMarker)
	_, pendingErr := os.Stat(pendingSetup)
	pending := pendingErr == nil
	if m.Git != nil && (created || pending || m.Mode == "new") {
		if err := j.installTools(worktree); err != nil {
			j.fail("setup", err)
			return
		}
	}
	if pending {
		if m.SetupScript != "" {
			if err := j.runSetup(worktree); err != nil {
				j.fail("setup", err)
				return
			}
		}
		if err := os.Remove(pendingSetup); err != nil && !os.IsNotExist(err) {
			j.fail("setup", err)
			return
		}
	}
	j.fetchAttachments(worktree, m.AttachmentsToFetch)
	if err := j.spawn(worktree); err != nil {
		j.fail("spawn", err)
		return
	}
}

// env is the Runner's environment, without its backend credentials (see cmd/runner), plus the Job's.
func (j *job) env() []string {
	env := childEnv()
	for k, v := range j.start.Env {
		env = append(env, k+"="+v)
	}
	return env
}

func (j *job) args() []string {
	m := j.start
	a := []string{"-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages"}
	if m.Mode == "resume" {
		a = append(a, "--resume", m.SessionID)
	} else {
		a = append(a, "--session-id", m.SessionID)
	}
	c := m.ClaudeArgs
	if c.Model != nil {
		a = append(a, "--model", *c.Model)
	}
	if c.Effort != nil {
		a = append(a, "--effort", *c.Effort)
	}
	if c.PermissionMode != "" {
		a = append(a, "--permission-mode", c.PermissionMode)
	}
	if c.AppendSystemPrompt != "" {
		a = append(a, "--append-system-prompt", c.AppendSystemPrompt)
	}
	if c.MCPConfig != "" {
		a = append(a, "--mcp-config", c.MCPConfig)
	}
	for _, tool := range c.DisallowedTools {
		a = append(a, "--disallowedTools", tool)
	}
	return a
}

func (j *job) spawn(worktree string) error {
	stdinR, stdinW, err := os.Pipe()
	if err != nil {
		return err
	}
	stdoutR, stdoutW, err := os.Pipe()
	if err != nil {
		return err
	}
	stderrR, stderrW, err := os.Pipe()
	if err != nil {
		return err
	}
	cmd := exec.Command(j.r.cfg.ClaudePath, j.args()...)
	cmd.Dir = worktree
	cmd.Env = j.env()
	cmd.Stdin, cmd.Stdout, cmd.Stderr = stdinR, stdoutW, stderrW
	// Own process group, so signals reach the tools claude started too.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}

	j.mu.Lock()
	err = errCancelled
	if !j.isCancelled() {
		err = cmd.Start()
	}
	stdinR.Close()
	stdoutW.Close()
	stderrW.Close()
	if err != nil {
		j.mu.Unlock()
		stdinW.Close()
		stdoutR.Close()
		stderrR.Close()
		return err
	}
	j.cmd, j.pgid, j.stdin = cmd, cmd.Process.Pid, stdinW
	j.mu.Unlock()

	stdout, stderr := &pipe{f: stdoutR}, &pipe{f: stderrR}
	var readers sync.WaitGroup
	readers.Add(2)
	go func() { defer readers.Done(); j.forwardStdout(stdout) }()
	go func() { defer readers.Done(); j.forwardStderr(stderr) }()
	go j.feedStdin()

	go func() {
		err := cmd.Wait()
		// Background processes the tools started would hold ports and files into the next Job.
		syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		stdout.drain()
		stderr.drain()
		readersDone := make(chan struct{})
		go func() { readers.Wait(); close(readersDone) }()
		select {
		case <-readersDone:
		case <-time.After(drainLimit):
			stdoutR.Close()
			stderrR.Close()
			<-readersDone
		}
		stdoutR.Close()
		stderrR.Close()
		close(j.exited)
		j.mu.Lock()
		j.pgid = 0
		if j.stdin != nil {
			j.stdin.Close()
			j.stdin = nil
		}
		j.mu.Unlock()

		var exitCode any
		var signal any
		if cmd.ProcessState == nil {
			log.Printf("job %s: wait: %v", j.id, err)
		} else if ws, ok := cmd.ProcessState.Sys().(syscall.WaitStatus); ok && ws.Signaled() {
			signal = signalName(ws.Signal())
		} else {
			exitCode = cmd.ProcessState.ExitCode()
		}
		j.r.finish(j, "job.exited", map[string]any{"exitCode": exitCode, "signal": signal})
	}()
	return nil
}

func signalName(s syscall.Signal) string {
	switch s {
	case syscall.SIGKILL:
		return "SIGKILL"
	case syscall.SIGTERM:
		return "SIGTERM"
	case syscall.SIGINT:
		return "SIGINT"
	default:
		return fmt.Sprintf("SIG%d", int(s))
	}
}

const (
	// drainIdle is how long a child's output pipe may stay silent after the child exited
	// before it's given up on: a background process can hold it open forever.
	drainIdle = 2 * time.Second
	// drainLimit bounds the drain even when such a process keeps writing.
	drainLimit = time.Minute
)

// pipe reads a child's output. Once draining, a read gives up after drainIdle without data,
// so output already written is never lost, however slowly it's forwarded.
type pipe struct {
	f        *os.File
	draining atomic.Bool
}

func (p *pipe) Read(b []byte) (int, error) {
	if p.draining.Load() {
		p.f.SetReadDeadline(time.Now().Add(drainIdle))
	}
	return p.f.Read(b)
}

func (p *pipe) drain() {
	p.draining.Store(true)
	p.f.SetReadDeadline(time.Now().Add(drainIdle))
}

func (j *job) forwardStdout(r io.Reader) {
	br := bufio.NewReaderSize(r, 1<<20)
	for {
		line, size, err := readLine(br, maxMessageBytes)
		truncated := size > len(line)
		line = bytes.TrimRight(line, "\r\n")
		if len(bytes.TrimSpace(line)) > 0 {
			text := string(line)
			if truncated {
				text = unparsedLine(line, size)
			}
			seq := j.emit("job.event", map[string]any{"line": text})
			if lineType(line, truncated) == "result" {
				j.emit("job.result", map[string]any{"eventSeq": seq})
			}
		}
		if err != nil {
			return
		}
	}
}

// readLine reads one line and keeps at most limit bytes of it; size is the full length.
func readLine(br *bufio.Reader, limit int) (line []byte, size int, err error) {
	for {
		frag, err := br.ReadSlice('\n')
		size += len(frag)
		if room := limit - len(line); room > 0 {
			line = append(line, frag[:min(len(frag), room)]...)
		}
		if err != bufio.ErrBufferFull {
			return line, size, err
		}
	}
}

// lineType is the stream-json type of a line. Of a truncated line only a leading "type" counts.
func lineType(line []byte, truncated bool) string {
	if !truncated {
		var head struct {
			Type string `json:"type"`
		}
		json.Unmarshal(line, &head)
		return head.Type
	}
	dec := json.NewDecoder(bytes.NewReader(line))
	if t, err := dec.Token(); err != nil || t != json.Delim('{') {
		return ""
	}
	if key, err := dec.Token(); err != nil || key != "type" {
		return ""
	}
	t, _ := dec.Token()
	s, _ := t.(string)
	return s
}

func (j *job) forwardStderr(r io.Reader) {
	w := &utf8Chunks{send: func(s string) { j.emit("job.stderr", map[string]any{"chunk": s}) }}
	io.CopyBuffer(w, r, make([]byte, 8192))
	w.Flush()
}

// control queues stdin work; cancel also starts the TERM/KILL escalation right away.
func (j *job) control(m *protocol.Incoming) {
	if m.Type == "job.cancel" {
		j.mu.Lock()
		first := !j.isCancelled()
		if first {
			close(j.cancelled)
		}
		j.mu.Unlock()
		if first {
			go j.escalate()
		}
	}
	j.ops <- m
}

// feedStdin writes the initial message, then queued inputs, interrupts and stdin closes in order.
func (j *job) feedStdin() {
	if msg := j.start.InitialMessage; len(msg) > 0 && string(msg) != "null" {
		j.writeStdin(protocol.UserMessage(msg))
	}
	for {
		select {
		case <-j.exited:
			return
		case m := <-j.ops:
			switch m.Type {
			case "job.input":
				j.fetchAttachments(j.worktreeDir(), m.AttachmentsToFetch)
				if !j.writeStdin(protocol.UserMessage(m.Message)) {
					j.emit("job.stderr", map[string]any{"chunk": "[runner] could not deliver a message: claude's stdin is already closed\n"})
				}
			case "job.interrupt":
				j.interrupt()
			case "job.end":
				j.closeStdin()
			case "job.cancel":
				j.interrupt()
				j.closeStdin()
			}
		}
	}
}

func (j *job) writeStdin(b []byte) bool {
	j.mu.Lock()
	f := j.stdin
	j.mu.Unlock()
	if f == nil {
		return false
	}
	_, err := f.Write(b)
	return err == nil
}

func (j *job) interrupt() {
	j.mu.Lock()
	j.reqSeq++
	id := fmt.Sprintf("interrupt-%s-%d", j.id, j.reqSeq)
	j.mu.Unlock()
	if !j.writeStdin(protocol.InterruptRequest(id)) {
		j.signal(syscall.SIGINT)
	}
}

func (j *job) closeStdin() {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.stdin != nil {
		j.stdin.Close()
		j.stdin = nil
	}
}

// signal reaches the running child's whole process group.
func (j *job) signal(s syscall.Signal) {
	j.mu.Lock()
	pgid := j.pgid
	j.mu.Unlock()
	if pgid != 0 {
		syscall.Kill(-pgid, s)
	}
}

func (j *job) escalate() {
	term := j.r.cfg.CancelTerm
	kill := j.r.cfg.CancelKill
	// claude stops on the interrupt and closed stdin; a setup step has no gentler way than TERM.
	j.mu.Lock()
	spawned := j.cmd != nil
	j.mu.Unlock()
	if !spawned {
		j.signal(syscall.SIGTERM)
	}
	select {
	case <-j.done:
		return
	case <-time.After(term):
	}
	j.signal(syscall.SIGTERM)
	select {
	case <-j.done:
		return
	case <-time.After(max(kill-term, 0)):
	}
	j.signal(syscall.SIGKILL)
}

func (j *job) terminate() {
	j.signal(syscall.SIGTERM)
	select {
	case <-j.done:
	case <-time.After(5 * time.Second):
		j.signal(syscall.SIGKILL)
	}
}

func (j *job) worktreeDir() string {
	p, _ := within(j.r.cfg.Home, j.start.WorktreePath)
	return p
}

func (j *job) runSetup(worktree string) error {
	cmd := exec.Command("bash", "-lc", j.start.SetupScript)
	cmd.Dir = worktree
	cmd.Env = j.env()
	j.setupOutput("$ setup script\n")
	err := j.runStep(cmd)
	var exit *exec.ExitError
	switch {
	case err == nil:
		return nil
	case errors.As(err, &exit):
		return fmt.Errorf("setup script exited with code %d", exit.ExitCode())
	default:
		return fmt.Errorf("setup script: %w", err)
	}
}

// Install before the project setup script, which may need these runtimes. Repeat
// on a new-session retry, including when a failed install left a worktree behind.
func (j *job) installTools(worktree string) error {
	configured := false
	for _, name := range []string{".tool-versions", "mise.toml", ".mise.toml", "mise.local.toml", ".mise.local.toml", "mise/config.toml", ".mise/config.toml", ".config/mise.toml", ".config/mise/config.toml"} {
		if _, err := os.Stat(filepath.Join(worktree, name)); err == nil {
			configured = true
			break
		} else if !os.IsNotExist(err) {
			return fmt.Errorf("mise config: %w", err)
		}
	}
	if !configured {
		return nil
	}
	cmd := exec.Command("mise", "install", "--yes")
	cmd.Dir = worktree
	cmd.Env = j.env()
	j.setupOutput("$ mise install --yes\n")
	if err := j.runStep(cmd); err != nil {
		return fmt.Errorf("mise install: %w", err)
	}
	return nil
}

// runStep runs a preparation command in its own process group and streams its output. A
// cancel (see escalate) or the setup timeout stops the whole group, and whatever the command
// left running in the background is killed once it exits.
func (j *job) runStep(cmd *exec.Cmd) error {
	r, w, err := os.Pipe()
	if err != nil {
		return err
	}
	defer r.Close()
	cmd.Stdout, cmd.Stderr = w, w
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	j.mu.Lock()
	err = errCancelled
	if !j.isCancelled() {
		err = cmd.Start()
	}
	if err == nil {
		j.pgid = cmd.Process.Pid
	}
	j.mu.Unlock()
	w.Close()
	if err != nil {
		return err
	}
	pgid := cmd.Process.Pid
	var timedOut atomic.Bool
	timer := time.AfterFunc(j.r.cfg.SetupTimeout, func() {
		timedOut.Store(true)
		syscall.Kill(-pgid, syscall.SIGKILL)
	})
	out := &pipe{f: r}
	copied := make(chan struct{})
	go func() {
		chunks := j.setupWriter()
		io.Copy(chunks, out)
		chunks.Flush()
		close(copied)
	}()
	err = cmd.Wait()
	timer.Stop()
	syscall.Kill(-pgid, syscall.SIGKILL)
	out.drain()
	select {
	case <-copied:
	case <-time.After(drainLimit):
		r.Close()
		<-copied
	}
	j.mu.Lock()
	j.pgid = 0
	j.mu.Unlock()
	switch {
	case timedOut.Load():
		return fmt.Errorf("timed out after %s", j.r.cfg.SetupTimeout)
	case err != nil && j.isCancelled():
		return errors.New("cancelled")
	}
	return err
}

func (j *job) setupOutput(s string) { j.emit("job.setup_output", map[string]any{"chunk": s}) }

// setupWriter streams command output as job.setup_output.
func (j *job) setupWriter() *utf8Chunks { return &utf8Chunks{send: j.setupOutput} }

// maxChunkBytes keeps every output chunk a small message.
const maxChunkBytes = 64 << 10

// utf8Chunks streams output in chunks that never split a UTF-8 character: an incomplete one
// at the end of a write waits for the next write, or for Flush.
type utf8Chunks struct {
	mu      sync.Mutex
	pending []byte
	send    func(string)
}

func (c *utf8Chunks) Write(p []byte) (int, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	data := append(c.pending, p...)
	end := completeUTF8(data)
	for start := 0; start < end; {
		stop := end
		if stop-start > maxChunkBytes {
			stop = start + max(completeUTF8(data[start:start+maxChunkBytes]), 1)
		}
		c.send(string(data[start:stop]))
		start = stop
	}
	c.pending = append([]byte(nil), data[end:]...)
	return len(p), nil
}

func (c *utf8Chunks) Flush() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.pending) > 0 {
		c.send(string(c.pending))
		c.pending = nil
	}
}

// completeUTF8 is the length of p without a UTF-8 character cut off at its end.
func completeUTF8(p []byte) int {
	for i := len(p) - 1; i >= 0 && i >= len(p)-utf8.UTFMax; i-- {
		if utf8.RuneStart(p[i]) {
			if utf8.FullRune(p[i:]) {
				return len(p)
			}
			return i
		}
	}
	return len(p)
}

// fetchAttachments downloads files into the Worktree. A failure is reported but doesn't stop the Job.
func (j *job) fetchAttachments(worktree string, files []protocol.Attachment) {
	for _, a := range files {
		if err := j.fetch(worktree, a); err != nil {
			j.emit("job.stderr", map[string]any{"chunk": fmt.Sprintf("[runner] could not fetch attachment %s: %v\n", a.Path, err)})
		}
	}
}

func (j *job) fetch(worktree string, a protocol.Attachment) error {
	dest, err := within(worktree, a.Path)
	if err != nil {
		return err
	}
	req, err := http.NewRequest(http.MethodGet, a.URL, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+j.r.cfg.Token)
	client := &http.Client{Timeout: 5 * time.Minute}
	res, err := client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("HTTP %d", res.StatusCode)
	}
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return err
	}
	tmp := dest + ".part"
	f, err := os.Create(tmp)
	if err != nil {
		return err
	}
	if _, err := io.Copy(f, res.Body); err != nil {
		f.Close()
		os.Remove(tmp)
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return os.Rename(tmp, dest)
}
