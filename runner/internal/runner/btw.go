package runner

import (
	"bufio"
	"bytes"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"time"

	"claude-task/runner/internal/protocol"
)

// btwTimeout bounds one fork; a longer one is killed and reported as failed.
const btwTimeout = 5 * time.Minute

// btwStderrBytes is how much of a fork's stderr goes back with `job.btw_done`.
const btwStderrBytes = 4096

// startBtw runs a Btw fork next to claude, as a child of the Job. It returns false when the Job
// can no longer take one.
func (j *job) startBtw(spec *protocol.BtwSpec) bool {
	j.btwMu.Lock()
	defer j.btwMu.Unlock()
	if j.btwClosing || j.hasExited() || j.isCancelled() {
		return false
	}
	j.btwWG.Add(1)
	go func() {
		defer j.btwWG.Done()
		j.runFork(spec)
	}()
	return true
}

// runBtwJob is a Job that only runs a Btw: it needs the Worktree to exist, prepares nothing and
// ends once the fork has.
func (j *job) runBtwJob() {
	<-j.turn
	j.endTurn()
	if j.start.Btw == nil {
		j.fail("spawn", fmt.Errorf("a btw job needs a btw"))
		return
	}
	wt := j.worktreeDir()
	if info, err := os.Stat(wt); err != nil || !info.IsDir() {
		j.fail("worktree", fmt.Errorf("the worktree %s is missing", j.start.WorktreePath))
		return
	}
	if err := j.setupProfile(); err != nil {
		j.fail("spawn", err)
		return
	}
	j.runFork(j.start.Btw)
	j.r.finish(j, "job.exited", map[string]any{"exitCode": 0, "signal": nil})
}

func (j *job) forkArgs(spec *protocol.BtwSpec) []string {
	a := []string{"-p", "--output-format", "stream-json", "--verbose", "--resume", spec.SessionID}
	if spec.Mode == "fork" {
		a = append(a, "--fork-session")
	}
	if spec.Model != nil {
		a = append(a, "--model", *spec.Model)
	}
	if spec.AppendSystemPrompt != "" {
		a = append(a, "--append-system-prompt", spec.AppendSystemPrompt)
	}
	// No tool and no MCP server: the fork only reads the conversation and answers.
	a = append(a, "--tools", "", "--strict-mcp-config")
	return a
}

// runFork runs one fork to its end and reports its lines and its exit as `job.btw_*` messages.
func (j *job) runFork(spec *protocol.BtwSpec) {
	done := func(exitCode any, signal any, stderr string) {
		j.emit("job.btw_done", map[string]any{"btwId": spec.ID, "exitCode": exitCode, "signal": signal, "stderr": stderr})
	}
	cmd := exec.Command(j.r.cfg.ClaudePath, j.forkArgs(spec)...)
	cmd.Dir = j.worktreeDir()
	cmd.Env = j.env()
	cmd.Stdin = strings.NewReader(spec.Question)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		done(nil, nil, err.Error())
		return
	}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	j.btwMu.Lock()
	err = cmd.Start()
	if err == nil {
		if j.forks == nil {
			j.forks = map[int]struct{}{}
		}
		j.forks[cmd.Process.Pid] = struct{}{}
	}
	j.btwMu.Unlock()
	if err != nil {
		done(nil, nil, err.Error())
		return
	}
	pgid := cmd.Process.Pid
	timer := time.AfterFunc(btwTimeout, func() { syscall.Kill(-pgid, syscall.SIGKILL) })
	defer timer.Stop()

	br := bufio.NewReaderSize(stdout, 1<<20)
	for {
		line, size, rerr := readLine(br, maxMessageBytes)
		line = bytes.TrimRight(line, "\r\n")
		if len(bytes.TrimSpace(line)) > 0 {
			text := string(line)
			if size > len(line)+2 {
				text = unparsedLine(line, size)
			}
			j.emit("job.btw_event", map[string]any{"btwId": spec.ID, "line": text})
		}
		if rerr != nil {
			if rerr != io.EOF {
				syscall.Kill(-pgid, syscall.SIGKILL)
			}
			break
		}
	}
	werr := cmd.Wait()
	syscall.Kill(-pgid, syscall.SIGKILL)
	j.btwMu.Lock()
	delete(j.forks, pgid)
	j.btwMu.Unlock()
	tail := stderr.String()
	if len(tail) > btwStderrBytes {
		tail = tail[len(tail)-btwStderrBytes:]
	}
	var exitCode, signal any
	if cmd.ProcessState == nil {
		tail += fmt.Sprintf("\n%v", werr)
	} else if ws, ok := cmd.ProcessState.Sys().(syscall.WaitStatus); ok && ws.Signaled() {
		signal = signalName(ws.Signal())
	} else {
		exitCode = cmd.ProcessState.ExitCode()
	}
	done(exitCode, signal, strings.ToValidUTF8(tail, "?"))
}
