package test

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
)

func readPid(t *testing.T, path string) int {
	t.Helper()
	var pid int
	waitUntil(t, 10*time.Second, path, func() bool {
		data, err := os.ReadFile(path)
		pid, _ = strconv.Atoi(strings.TrimSpace(string(data)))
		return err == nil && pid > 0
	})
	t.Cleanup(func() { syscall.Kill(pid, syscall.SIGKILL) })
	return pid
}

func alive(pid int) bool { return syscall.Kill(pid, 0) == nil }

// processedIndex returns the position of the first message of that Job and type, across all Jobs.
func (b *backend) processedIndex(jobID, typ string) int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return indexOf(b.processed, func(m msg) bool { return m.str("jobId") == jobID && m.str("type") == typ })
}

func TestSetupScriptBackgroundProcessDoesNotHangTheJob(t *testing.T) {
	b := newBackend(t)
	home := startRunner(t, b)
	b.send(jobStart(jobOpts{id: "j1", text: "go", setup: "echo started; sleep 600 & echo $! > setup-bg.pid"}))
	b.waitEvent("j1", "result", isResult)
	pid := readPid(t, filepath.Join(home, "worktrees/proj/T-1/setup-bg.pid"))
	waitUntil(t, 10*time.Second, "the setup script's background process to end", func() bool { return !alive(pid) })
	if !strings.Contains(b.setupOutput("j1"), "started") {
		t.Fatalf("setup output %q", b.setupOutput("j1"))
	}
	b.send(msg{"type": "job.end", "jobId": "j1"})
	b.waitType("j1", "job.exited")
}

func TestCancelStopsTheSetupScript(t *testing.T) {
	b := newBackend(t)
	home := startRunner(t, b)
	rec := filepath.Join(t.TempDir(), "rec.json")
	for i, setup := range []string{"echo running; sleep 600", "trap '' TERM; echo running; sleep 600", "trap 'exit 0' TERM; echo running; sleep 600"} {
		id := fmt.Sprintf("j%d", i+1)
		b.send(jobStart(jobOpts{id: id, worktree: "worktrees/proj/T-" + id, text: "go", setup: setup, env: map[string]string{"FAKE_CLAUDE_RECORD": rec}}))
		waitUntil(t, 10*time.Second, id+" setup running", func() bool { return strings.Contains(b.setupOutput(id), "running") })
		start := time.Now()
		b.send(msg{"type": "job.cancel", "jobId": id})
		if failed := b.waitType(id, "job.failed"); failed.str("stage") != "setup" {
			t.Fatalf("failed %v", failed)
		}
		if elapsed := time.Since(start); elapsed > 5*time.Second {
			t.Fatalf("%s: setup stopped after %s", id, elapsed)
		}
	}
	if _, err := os.Stat(rec); err == nil {
		t.Fatal("claude was spawned after a cancelled setup script")
	}
	if _, err := os.Stat(filepath.Join(home, "worktrees/proj/T-j3/.claude-task/setup-pending")); err != nil {
		t.Fatal("a cancelled Setup Script that exited 0 cleared its setup-pending mark")
	}
}

func TestCancelDuringGitPreparationStopsBeforeWorktreeReady(t *testing.T) {
	o := newOrigin(t)
	b := newBackend(t)
	home := startRunner(t, b)
	runJob(t, b, "j0", "worktrees/proj/T-0", o.spec("task/t-0"), "")
	repo := filepath.Join(home, "repos/proj.git")
	hook := filepath.Join(repo, "hooks/post-checkout")
	os.MkdirAll(filepath.Dir(hook), 0o755)
	if err := os.WriteFile(hook, []byte("#!/bin/sh\nsleep 2\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	b.send(jobStart(jobOpts{id: "j1", worktree: "worktrees/proj/T-1", git: o.spec("task/t-1"), setup: "touch setup-ran", text: "go"}))
	waitUntil(t, 10*time.Second, "git worktree add", func() bool { return strings.Contains(b.setupOutput("j1"), "git worktree add") })
	b.send(msg{"type": "job.cancel", "jobId": "j1"})
	b.waitType("j1", "job.failed")
	if b.processedIndex("j1", "job.worktree_ready") >= 0 {
		t.Fatal("a cancelled Job announced its Worktree as ready")
	}
	if _, err := os.Stat(filepath.Join(home, "worktrees/proj/T-1/setup-ran")); err == nil {
		t.Fatal("setup ran after cancellation during git preparation")
	}
	// Retrying the same Worktree must perform the setup and set its upstream.
	runJob(t, b, "j2", "worktrees/proj/T-1", o.spec("task/t-1"), "touch setup-ran")
	wt := filepath.Join(home, "worktrees/proj/T-1")
	if _, err := os.Stat(filepath.Join(wt, "setup-ran")); err != nil {
		t.Fatal("retry skipped setup after a cancelled Worktree creation")
	}
	if remote := gitIn(t, home, wt, "config", "--get", "branch.task/t-1.remote"); remote != "origin" {
		t.Fatalf("upstream remote after retry: %q", remote)
	}
	if merge := gitIn(t, home, wt, "config", "--get", "branch.task/t-1.merge"); merge != "refs/heads/task/t-1" {
		t.Fatalf("upstream merge after retry: %q", merge)
	}
}

func TestSetupScriptTimesOut(t *testing.T) {
	b := newBackend(t)
	startRunner(t, b, "CLAUDE_TASK_SETUP_TIMEOUT_MS=500")
	b.send(jobStart(jobOpts{id: "j1", text: "go", setup: "sleep 600"}))
	failed := b.waitType("j1", "job.failed")
	if failed.str("stage") != "setup" || !strings.Contains(failed.str("message"), "timed out") {
		t.Fatalf("failed %v", failed)
	}
}

func TestRunnerCredentialsStayOutOfChildProcesses(t *testing.T) {
	b := newBackend(t)
	startRunner(t, b)
	rec := filepath.Join(t.TempDir(), "rec.json")
	b.send(jobStart(jobOpts{id: "j1", text: "go", setup: "env", env: map[string]string{"FAKE_CLAUDE_RECORD": rec}}))
	b.waitEvent("j1", "result", isResult)
	out := b.setupOutput("j1")
	if !strings.Contains(out, "CLAUDE_TASK_HOME=") {
		t.Fatalf("setup env not printed: %q", out)
	}
	for _, secret := range []string{token, "CLAUDE_TASK_RUNNER_TOKEN", "CLAUDE_TASK_BACKEND_URL"} {
		if strings.Contains(out, secret) {
			t.Fatalf("setup script sees %s", secret)
		}
	}
	for k, v := range readRecord(t, rec).Env {
		if strings.Contains(v, token) || k == "CLAUDE_TASK_RUNNER_TOKEN" || k == "CLAUDE_TASK_BACKEND_URL" {
			t.Fatalf("claude sees %s", k)
		}
	}
	b.send(msg{"type": "job.end", "jobId": "j1"})
	b.waitType("j1", "job.exited")
}

func TestOversizedStdoutLineIsReplacedByAPlaceholder(t *testing.T) {
	b := newBackend(t)
	startRunner(t, b)
	b.send(jobStart(jobOpts{id: "j1", text: "HUGE"}))
	e := b.waitEvent("j1", "placeholder", func(e msg) bool { return e.str("type") == "unparsed" }).event()
	if e["truncated"] != true || e.num("bytes") < 70<<20 || len(e.str("line")) == 0 || len(e.str("line")) > 64<<10 {
		t.Fatalf("placeholder %v bytes, %d line bytes", e["bytes"], len(e.str("line")))
	}
	b.waitEvent("j1", "result", isResult)
	b.send(msg{"type": "job.end", "jobId": "j1"})
	b.waitType("j1", "job.exited")
	b.mu.Lock()
	hellos := len(b.hellos)
	b.mu.Unlock()
	if hellos != 1 {
		t.Fatalf("the connection was dropped %d times", hellos-1)
	}
}

func TestWorktreeRemovalDoesNotBlockTheConnection(t *testing.T) {
	release := make(chan struct{})
	var asked atomic.Bool
	var once sync.Once
	git := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		asked.Store(true)
		<-release
		http.Error(w, "gone", http.StatusInternalServerError)
	}))
	t.Cleanup(func() { once.Do(func() { close(release) }); git.Close() })
	b := newBackend(t)
	home := startRunner(t, b)
	spec := msg{
		"cloneUrl": git.URL + "/proj.git", "baseBranch": "main", "taskBranch": "task/t-1", "branchExists": false,
		"repoPath": "repos/proj.git", "commitName": "Ada", "commitEmail": "ada@example.com",
	}
	b.send(jobStart(jobOpts{id: "j1", git: spec, text: "go"}))
	waitUntil(t, 10*time.Second, "git fetch to start", asked.Load)

	other := filepath.Join(home, "worktrees/proj/T-2")
	os.MkdirAll(other, 0o755)
	b.send(msg{"type": "worktree.remove", "worktreePath": "worktrees/proj/T-2", "repoPath": nil})
	b.send(msg{"type": "ping"})
	b.waitFor("pong", func(m msg) bool { return m.str("type") == "pong" })
	if _, err := os.Stat(other); err != nil {
		t.Fatal("removed while the fetch held the Worktrees")
	}

	once.Do(func() { close(release) })
	if failed := b.waitType("j1", "job.failed"); failed.str("stage") != "worktree" {
		t.Fatalf("failed %v", failed)
	}
	waitUntil(t, 10*time.Second, "worktree removed", func() bool { _, err := os.Stat(other); return os.IsNotExist(err) })
}

func TestRemovingTheWorktreeOfARunningJobWaitsForIt(t *testing.T) {
	b := newBackend(t)
	home := startRunner(t, b)
	wt := filepath.Join(home, "worktrees/proj/T-1")
	b.send(jobStart(jobOpts{id: "j1", text: "STUCK", env: map[string]string{"FAKE_CLAUDE_IGNORE_TERM": "1"}}))
	b.waitEvent("j1", "first text", isAssistantText("Working on: STUCK"))
	// Closing a Task cancels its Job and removes its Worktree right away.
	b.send(msg{"type": "job.cancel", "jobId": "j1"})
	b.send(msg{"type": "worktree.remove", "worktreePath": "worktrees/proj/T-1", "repoPath": nil})
	time.Sleep(300 * time.Millisecond)
	if _, err := os.Stat(wt); err != nil {
		t.Fatal("worktree removed under the running Job")
	}
	b.waitType("j1", "job.exited")
	waitUntil(t, 10*time.Second, "worktree removed", func() bool { _, err := os.Stat(wt); return os.IsNotExist(err) })

	// A removal sent before the next job.start of the same Worktree happens first.
	os.MkdirAll(wt, 0o755)
	os.WriteFile(filepath.Join(wt, "old.txt"), nil, 0o644)
	b.send(msg{"type": "worktree.remove", "worktreePath": "worktrees/proj/T-1", "repoPath": nil})
	b.send(jobStart(jobOpts{id: "j2", session: "s-2", text: "go", setup: "touch setup-ran"}))
	b.waitEvent("j2", "result", isResult)
	if _, err := os.Stat(filepath.Join(wt, "old.txt")); err == nil {
		t.Fatal("the old worktree was kept")
	}
	if _, err := os.Stat(filepath.Join(wt, "setup-ran")); err != nil {
		t.Fatal("the new worktree was removed or not set up")
	}
	b.send(msg{"type": "job.end", "jobId": "j2"})
	b.waitType("j2", "job.exited")
}

func TestJobStartWaitsForACancelledJob(t *testing.T) {
	b := newBackend(t)
	startRunner(t, b)
	b.send(jobStart(jobOpts{id: "j1", text: "STUCK", env: map[string]string{"FAKE_CLAUDE_IGNORE_TERM": "1"}}))
	b.waitEvent("j1", "first text", isAssistantText("Working on: STUCK"))
	b.send(msg{"type": "job.cancel", "jobId": "j1"})
	b.send(jobStart(jobOpts{id: "j2", session: "s-2", worktree: "worktrees/proj/T-2", text: "next"}))
	b.waitEvent("j2", "result", isResult)
	if exited := b.waitType("j1", "job.exited"); exited.str("signal") != "SIGKILL" {
		t.Fatalf("exit %v", exited)
	}
	if b.processedIndex("j1", "job.exited") > b.processedIndex("j2", "job.accepted") {
		t.Fatal("j2 started before j1 ended")
	}
	b.send(msg{"type": "job.end", "jobId": "j2"})
	b.waitType("j2", "job.exited")
}

func TestNextJobRightAfterTheExitIsAccepted(t *testing.T) {
	b := newBackend(t)
	const jobs = 8
	b.mu.Lock()
	b.reply = func(m msg) []msg {
		switch m.str("type") {
		case "job.result":
			return []msg{{"type": "job.end", "jobId": m.str("jobId")}}
		case "job.exited":
			if n, _ := strconv.Atoi(strings.TrimPrefix(m.str("jobId"), "j")); n < jobs {
				return []msg{jobStart(jobOpts{id: fmt.Sprintf("j%d", n+1), text: "go"})}
			}
		}
		return nil
	}
	b.mu.Unlock()
	startRunner(t, b)
	b.send(jobStart(jobOpts{id: "j1", text: "go"}))
	b.waitFor("last job to exit", func(m msg) bool {
		if m.str("type") == "job.failed" {
			t.Fatalf("%s failed: %s", m.str("jobId"), m.str("message"))
		}
		return m.str("jobId") == fmt.Sprintf("j%d", jobs) && m.str("type") == "job.exited"
	})
}

func TestFailedSetupRunsAgainOnRetry(t *testing.T) {
	b := newBackend(t)
	home := startRunner(t, b)
	b.send(jobStart(jobOpts{id: "j1", text: "go", setup: "echo broken; exit 3"}))
	if failed := b.waitType("j1", "job.failed"); failed.str("stage") != "setup" {
		t.Fatalf("failed %v", failed)
	}
	b.send(jobStart(jobOpts{id: "j2", text: "go", setup: "touch setup-ran"}))
	b.waitEvent("j2", "result", isResult)
	b.send(msg{"type": "job.end", "jobId": "j2"})
	b.waitType("j2", "job.exited")
	ran := filepath.Join(home, "worktrees/proj/T-1/setup-ran")
	if _, err := os.Stat(ran); err != nil {
		t.Fatal("setup didn't run again after it failed")
	}

	// Once it succeeded, it doesn't run again.
	os.Remove(ran)
	b.send(jobStart(jobOpts{id: "j3", text: "go", setup: "touch setup-ran"}))
	b.waitEvent("j3", "result", isResult)
	b.send(msg{"type": "job.end", "jobId": "j3"})
	b.waitType("j3", "job.exited")
	if _, err := os.Stat(ran); err == nil {
		t.Fatal("setup ran again after it succeeded")
	}
}

func TestGitHookBackgroundProcessDoesNotHangWorktreePreparation(t *testing.T) {
	o := newOrigin(t)
	b := newBackend(t)
	home := startRunner(t, b)
	runJob(t, b, "j0", "worktrees/proj/T-0", o.spec("task/t-0"), "")
	repo := filepath.Join(home, "repos/proj.git")
	hook := filepath.Join(repo, "hooks/post-checkout")
	os.MkdirAll(filepath.Dir(hook), 0o755)
	pidFile := filepath.Join(home, "hook-bg.pid")
	script := "#!/bin/sh\nsleep 600 &\necho $! > '" + pidFile + "'\n"
	if err := os.WriteFile(hook, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	b.send(jobStart(jobOpts{id: "j1", worktree: "worktrees/proj/T-1", git: o.spec("task/t-1"), text: "go"}))
	b.waitEvent("j1", "result", isResult)
	pid := readPid(t, pidFile)
	waitUntil(t, 10*time.Second, "the hook's background process to end", func() bool { return !alive(pid) })
	b.send(msg{"type": "job.end", "jobId": "j1"})
	b.waitType("j1", "job.exited")
}

func TestSetupRunsAfterAFailedPreparationOfANewGitWorktree(t *testing.T) {
	o := newOrigin(t)
	b := newBackend(t)
	home := startRunner(t, b)
	runJob(t, b, "j0", "worktrees/proj/T-0", o.spec("task/t-0"), "")
	// Preparation fails right after `git worktree add`: the hook locks the repository's config.
	repo := filepath.Join(home, "repos/proj.git")
	hook := filepath.Join(repo, "hooks/post-checkout")
	os.MkdirAll(filepath.Dir(hook), 0o755)
	if err := os.WriteFile(hook, []byte("#!/bin/sh\ntouch '"+repo+"/config.lock'\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	b.send(jobStart(jobOpts{id: "j1", worktree: "worktrees/proj/T-1", git: o.spec("task/t-1"), setup: "touch setup-ran", text: "go"}))
	if failed := b.waitType("j1", "job.failed"); failed.str("stage") != "worktree" || !strings.Contains(failed.str("message"), "config") {
		t.Fatalf("failed %v", failed)
	}
	os.Remove(hook)
	os.Remove(filepath.Join(repo, "config.lock"))
	runJob(t, b, "j2", "worktrees/proj/T-1", o.spec("task/t-1"), "touch setup-ran")
	if _, err := os.Stat(filepath.Join(home, "worktrees/proj/T-1/setup-ran")); err != nil {
		t.Fatal("setup didn't run on the retry")
	}
	wt := filepath.Join(home, "worktrees/proj/T-1")
	if remote := gitIn(t, home, wt, "config", "--get", "branch.task/t-1.remote"); remote != "origin" {
		t.Fatalf("upstream remote after retry: %q", remote)
	}
	if merge := gitIn(t, home, wt, "config", "--get", "branch.task/t-1.merge"); merge != "refs/heads/task/t-1" {
		t.Fatalf("upstream merge after retry: %q", merge)
	}
}

func TestMultibyteOutputIsNeverSplit(t *testing.T) {
	b := newBackend(t)
	startRunner(t, b)
	stderr := "a" + strings.Repeat("é", 6000)
	b.send(jobStart(jobOpts{id: "j1", text: "go", setup: `printf 'a%s' "$(printf 'é%.0s' {1..20000})"`,
		env: map[string]string{"FAKE_CLAUDE_EXIT": "0", "FAKE_CLAUDE_STDERR": stderr}}))
	b.waitType("j1", "job.exited")
	if got := b.stderr("j1"); got != stderr {
		t.Fatalf("stderr has %d bytes, %d replacement characters", len(got), strings.Count(got, "�"))
	}
	if out := b.setupOutput("j1"); !strings.Contains(out, "a"+strings.Repeat("é", 20000)) {
		t.Fatalf("setup output has %d replacement characters", strings.Count(out, "�"))
	}
}

func TestInputThatCannotBeDeliveredIsReported(t *testing.T) {
	b := newBackend(t)
	startRunner(t, b)
	b.send(jobStart(jobOpts{id: "j1", text: "work", env: map[string]string{"FAKE_CLAUDE_TOOL_MS": "1500"}}))
	b.waitEvent("j1", "tool_use", isToolUse)
	b.send(msg{"type": "job.end", "jobId": "j1"})
	b.send(input("j1", "too late"))
	b.waitType("j1", "job.exited")
	if !strings.Contains(b.stderr("j1"), "could not deliver") {
		t.Fatalf("stderr %q", b.stderr("j1"))
	}
}

func TestBackgroundProcessesEndWithClaude(t *testing.T) {
	b := newBackend(t)
	home := startRunner(t, b)
	b.send(jobStart(jobOpts{id: "j1", text: "SPAWN"}))
	b.waitEvent("j1", "result", isResult)
	pid := readPid(t, filepath.Join(home, "worktrees/proj/T-1/bg.pid"))
	if !alive(pid) {
		t.Fatal("background process not running")
	}
	b.send(msg{"type": "job.end", "jobId": "j1"})
	b.waitType("j1", "job.exited")
	waitUntil(t, 10*time.Second, "background process to end", func() bool { return !alive(pid) })
}

func TestOutputStillComingAfterTheExitIsForwarded(t *testing.T) {
	b := newBackend(t)
	startRunner(t, b)
	b.send(jobStart(jobOpts{id: "j1", text: "TRICKLE"}))
	b.waitEvent("j1", "result", isResult)
	b.send(msg{"type": "job.end", "jobId": "j1"})
	exited := b.waitType("j1", "job.exited")
	n := 0
	for _, m := range b.jobMessages("j1") {
		if m.str("type") == "job.event" && m.event().str("subtype") == "trickle" && m.num("seq") < exited.num("seq") {
			n++
		}
	}
	if n != 8 {
		t.Fatalf("%d of 8 lines forwarded", n)
	}
}
