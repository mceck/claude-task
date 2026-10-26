package runner

import (
	"bufio"
	"bytes"
	"context"
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
	"syscall"
	"time"

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

	ops                 chan *protocol.Incoming // stdin work, in arrival order
	mu                  sync.Mutex
	cmd                 *exec.Cmd
	stdin               *os.File
	cancelled           bool
	exited              chan struct{}
	remoteBranchMissing bool
	reqSeq              int
}

func newJob(r *Runner, m *protocol.Incoming) *job {
	return &job{
		r:      r,
		id:     m.JobID,
		start:  m,
		out:    newOutbox(r.cfg.OutboxMemoryBytes, r.spillPath(m.JobID)),
		ops:    make(chan *protocol.Incoming, 1024),
		exited: make(chan struct{}),
	}
}

func (j *job) emit(typ string, fields map[string]any) int64 { return j.r.emit(j, typ, fields) }

func (j *job) fail(stage string, err error) {
	j.emit("job.failed", map[string]any{"stage": stage, "message": err.Error()})
	j.r.finish(j)
}

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
	// Remember setup still needs to run if mise fails on a fresh worktree.
	pendingSetup := filepath.Join(worktree, ".claude-task", "setup-pending")
	if created && m.Git != nil && m.SetupScript != "" {
		if err := os.MkdirAll(filepath.Dir(pendingSetup), 0o755); err != nil {
			j.fail("setup", err)
			return
		}
		if err := os.WriteFile(pendingSetup, nil, 0o644); err != nil {
			j.fail("setup", err)
			return
		}
	}
	if m.Git != nil && (created || m.Mode == "new") {
		if err := j.installTools(worktree); err != nil {
			j.fail("setup", err)
			return
		}
	}
	_, pendingErr := os.Stat(pendingSetup)
	if (created || (m.Git != nil && pendingErr == nil)) && m.SetupScript != "" {
		if err := j.runSetup(worktree); err != nil {
			j.fail("setup", err)
			return
		}
		if m.Git != nil {
			if err := os.Remove(pendingSetup); err != nil && !os.IsNotExist(err) {
				j.fail("setup", err)
				return
			}
		}
	}
	j.fetchAttachments(worktree, m.AttachmentsToFetch)
	if err := j.spawn(worktree); err != nil {
		j.fail("spawn", err)
		return
	}
}

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
	if j.cancelled {
		j.mu.Unlock()
		for _, f := range []*os.File{stdinR, stdinW, stdoutR, stdoutW, stderrR, stderrW} {
			f.Close()
		}
		return errors.New("cancelled before start")
	}
	err = cmd.Start()
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
	j.cmd, j.stdin = cmd, stdinW
	j.mu.Unlock()

	var readers sync.WaitGroup
	readers.Add(2)
	go func() { defer readers.Done(); j.forwardStdout(stdoutR) }()
	go func() { defer readers.Done(); j.forwardStderr(stderrR) }()
	go j.feedStdin()

	go func() {
		err := cmd.Wait()
		// Background processes can keep the pipes open after claude exits; don't wait forever.
		done := make(chan struct{})
		go func() { readers.Wait(); close(done) }()
		select {
		case <-done:
		case <-time.After(2 * time.Second):
			stdoutR.Close()
			stderrR.Close()
			<-done
		}
		stdoutR.Close()
		stderrR.Close()
		close(j.exited)
		j.mu.Lock()
		if j.stdin != nil {
			j.stdin.Close()
			j.stdin = nil
		}
		j.mu.Unlock()

		var exitCode any
		var signal any
		if ws, ok := cmd.ProcessState.Sys().(syscall.WaitStatus); ok && ws.Signaled() {
			signal = signalName(ws.Signal())
		} else {
			exitCode = cmd.ProcessState.ExitCode()
		}
		if err != nil && cmd.ProcessState == nil {
			log.Printf("job %s: wait: %v", j.id, err)
		}
		j.emit("job.exited", map[string]any{"exitCode": exitCode, "signal": signal})
		j.r.finish(j)
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

func (j *job) forwardStdout(r io.Reader) {
	br := bufio.NewReaderSize(r, 1<<20)
	for {
		line, err := br.ReadBytes('\n')
		line = bytes.TrimRight(line, "\r\n")
		if len(bytes.TrimSpace(line)) > 0 {
			seq := j.emit("job.event", map[string]any{"line": string(line)})
			var head struct {
				Type string `json:"type"`
			}
			if json.Unmarshal(line, &head) == nil && head.Type == "result" {
				j.emit("job.result", map[string]any{"eventSeq": seq})
			}
		}
		if err != nil {
			return
		}
	}
}

func (j *job) forwardStderr(r io.Reader) {
	buf := make([]byte, 8192)
	for {
		n, err := r.Read(buf)
		if n > 0 {
			j.emit("job.stderr", map[string]any{"chunk": string(buf[:n])})
		}
		if err != nil {
			return
		}
	}
}

// control queues stdin work; cancel also starts the TERM/KILL escalation right away.
func (j *job) control(m *protocol.Incoming) {
	if m.Type == "job.cancel" {
		j.mu.Lock()
		j.cancelled = true
		j.mu.Unlock()
		go j.escalate()
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
					log.Printf("job %s: stdin closed, dropping input", j.id)
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

func (j *job) signal(s syscall.Signal) {
	j.mu.Lock()
	cmd := j.cmd
	j.mu.Unlock()
	if cmd != nil && cmd.Process != nil {
		syscall.Kill(-cmd.Process.Pid, s)
	}
}

func (j *job) escalate() {
	term := j.r.cfg.CancelTerm
	kill := j.r.cfg.CancelKill
	select {
	case <-j.exited:
		return
	case <-time.After(term):
	}
	j.signal(syscall.SIGTERM)
	select {
	case <-j.exited:
		return
	case <-time.After(max(kill-term, 0)):
	}
	j.signal(syscall.SIGKILL)
}

func (j *job) terminate() {
	j.signal(syscall.SIGTERM)
	select {
	case <-j.exited:
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
	w := &chunkWriter{j: j}
	cmd.Stdout, cmd.Stderr = w, w
	j.setupOutput("$ setup script\n")
	if err := cmd.Run(); err != nil {
		var exit *exec.ExitError
		if errors.As(err, &exit) {
			return fmt.Errorf("setup script exited with code %d", exit.ExitCode())
		}
		return fmt.Errorf("setup script: %w", err)
	}
	return nil
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
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, "mise", "install", "--yes")
	cmd.WaitDelay = 2 * time.Second
	cmd.Dir = worktree
	cmd.Env = j.env()
	w := &chunkWriter{j: j}
	cmd.Stdout, cmd.Stderr = w, w
	j.setupOutput("$ mise install --yes\n")
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("mise install: %w", err)
	}
	return nil
}

func (j *job) setupOutput(s string) { j.emit("job.setup_output", map[string]any{"chunk": s}) }

// chunkWriter streams command output as job.setup_output.
type chunkWriter struct {
	j  *job
	mu sync.Mutex
}

func (w *chunkWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.j.setupOutput(string(p))
	return len(p), nil
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
