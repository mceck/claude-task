package test

import (
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

func TestClaudeRunsWithTheAgentProfile(t *testing.T) {
	b := newBackend(t)
	home := startRunner(t, b)
	b.waitHello(1)
	rec := filepath.Join(t.TempDir(), "rec.json")
	b.send(jobStart(jobOpts{id: "j1", text: "hello", profile: ".claude-agents/a1", env: map[string]string{"FAKE_CLAUDE_RECORD": rec}}))
	b.waitEvent("j1", "result", isResult)
	r := readRecord(t, rec)
	if r.Env["CLAUDE_CONFIG_DIR"] != filepath.Join(home, ".claude-agents/a1") {
		t.Fatalf("CLAUDE_CONFIG_DIR = %q", r.Env["CLAUDE_CONFIG_DIR"])
	}
	if info, err := os.Stat(filepath.Join(home, ".claude-agents/a1")); err != nil || !info.IsDir() {
		t.Fatal("the Agent Profile directory was not created")
	}
	b.send(msg{"type": "job.end", "jobId": "j1"})
	b.waitType("j1", "job.exited")
}

func TestAnAgentProfileOutsideTheHomeFailsTheJob(t *testing.T) {
	b := newBackend(t)
	startRunner(t, b)
	b.waitHello(1)
	b.send(jobStart(jobOpts{id: "j1", text: "hello", profile: "../elsewhere"}))
	failed := b.waitType("j1", "job.failed")
	if failed.str("stage") != "spawn" {
		t.Fatalf("stage %q", failed.str("stage"))
	}
}

func TestWorktreePreparationWaitsForTheBareCloneLock(t *testing.T) {
	o := newOrigin(t)
	b := newBackend(t)
	home := startRunner(t, b)
	b.waitHello(1)
	// Another Worker Container of the Worker is updating the same Bare Clone.
	os.MkdirAll(filepath.Join(home, "repos"), 0o755)
	f, err := os.OpenFile(filepath.Join(home, "repos/proj.git.lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX); err != nil {
		t.Fatal(err)
	}
	b.send(jobStart(jobOpts{id: "j1", worktree: "worktrees/proj/T-1", git: o.spec("task/t-1"), text: "go"}))
	b.waitType("j1", "job.accepted")
	time.Sleep(700 * time.Millisecond)
	ready := false
	for _, m := range b.jobMessages("j1") {
		ready = ready || m.str("type") == "job.worktree_ready"
	}
	if ready {
		t.Fatal("prepared the worktree while another container held the Bare Clone")
	}
	syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
	f.Close()
	b.waitType("j1", "job.worktree_ready")
	b.waitEvent("j1", "result", isResult)
}
