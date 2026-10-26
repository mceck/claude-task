package test

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

func TestHelloAndArgumentsForANewSession(t *testing.T) {
	b := newBackend(t)
	home := startRunner(t, b)
	hello := b.waitHello(1)
	if hello.str("claudeVersion") != "9.9.9" || hello["activeJobId"] != nil || hello.num("protocolVersion") != 2 {
		t.Fatalf("unexpected hello %v", hello)
	}

	rec := filepath.Join(t.TempDir(), "rec.json")
	b.send(jobStart(jobOpts{
		id: "j1", session: "s-1", text: "hello", model: "opus", systemPrompt: "Be nice",
		env: map[string]string{"FAKE_CLAUDE_RECORD": rec, "PROJECT_VAR": "x", "CLAUDE_CODE_OAUTH_TOKEN": "secret"},
	}))
	b.waitType("j1", "job.accepted")
	b.waitEvent("j1", "result", isResult)
	if b.waitType("j1", "job.result").num("eventSeq") == 0 {
		t.Fatal("job.result without eventSeq")
	}

	r := readRecord(t, rec)
	want := []string{"-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
		"--include-partial-messages", "--session-id", "s-1", "--model", "opus", "--permission-mode", "bypassPermissions",
		"--append-system-prompt", "Be nice", "--mcp-config", `{"mcpServers":{}}`}
	if !slices.Equal(r.Args, want) {
		t.Fatalf("args\n got %q\nwant %q", r.Args, want)
	}
	if r.Env["PROJECT_VAR"] != "x" || r.Env["CLAUDE_CODE_OAUTH_TOKEN"] != "secret" || r.Env["CLAUDE_TASK_HOME"] != home {
		t.Fatalf("env not merged: %v", r.Env)
	}
	if wantCwd, _ := filepath.EvalSymlinks(filepath.Join(home, "worktrees/proj/T-1")); evalCwd(r.Cwd) != wantCwd {
		t.Fatalf("cwd %s, want %s", r.Cwd, wantCwd)
	}
	if got := stdinTexts(r); !slices.Equal(got, []string{"hello"}) {
		t.Fatalf("stdin %q", got)
	}

	b.send(msg{"type": "job.end", "jobId": "j1"})
	exited := b.waitType("j1", "job.exited")
	if exited.num("exitCode") != 0 || exited["signal"] != nil {
		t.Fatalf("exit %v", exited)
	}
}

func evalCwd(p string) string {
	r, _ := filepath.EvalSymlinks(p)
	return r
}

func TestResumeAndReusedSessionID(t *testing.T) {
	b := newBackend(t)
	startRunner(t, b)
	rec := filepath.Join(t.TempDir(), "rec.json")
	env := map[string]string{"FAKE_CLAUDE_RECORD": rec}

	b.send(jobStart(jobOpts{id: "j1", session: "s-1", text: "first", env: env, model: "opus", effort: "high"}))
	b.waitEvent("j1", "result", isResult)
	b.send(msg{"type": "job.end", "jobId": "j1"})
	b.waitType("j1", "job.exited")
	if r := readRecord(t, rec); !slices.Contains(r.Args, "--effort") {
		t.Fatalf("effort missing: %q", r.Args)
	}

	b.send(jobStart(jobOpts{id: "j2", session: "s-1", mode: "resume", text: "again", env: env}))
	b.waitEvent("j2", "result", isResult)
	r := readRecord(t, rec)
	if i := slices.Index(r.Args, "--resume"); i < 0 || r.Args[i+1] != "s-1" || slices.Contains(r.Args, "--session-id") {
		t.Fatalf("not resumed: %q", r.Args)
	}
	if slices.Contains(r.Args, "--model") || slices.Contains(r.Args, "--effort") {
		t.Fatalf("null model/effort must be omitted: %q", r.Args)
	}
	b.send(msg{"type": "job.end", "jobId": "j2"})
	b.waitType("j2", "job.exited")

	// The CLI refuses a session id that already exists; the runner just reports the exit.
	b.send(jobStart(jobOpts{id: "j3", session: "s-1", text: "new again", env: env}))
	exited := b.waitType("j3", "job.exited")
	if exited.num("exitCode") != 1 || !strings.Contains(b.stderr("j3"), "already in use") {
		t.Fatalf("exit %v, stderr %q", exited, b.stderr("j3"))
	}
}

func TestMidTurnInputReachesTheRunningTurn(t *testing.T) {
	b := newBackend(t)
	startRunner(t, b)
	rec := filepath.Join(t.TempDir(), "rec.json")
	b.send(jobStart(jobOpts{id: "j1", text: "work", env: map[string]string{"FAKE_CLAUDE_RECORD": rec, "FAKE_CLAUDE_TOOL_MS": "1500"}}))
	b.waitEvent("j1", "tool_use", isToolUse)
	b.send(input("j1", "steer left"))

	noted := b.waitEvent("j1", "noted", isAssistantText("Also noted: steer left"))
	result := b.waitEvent("j1", "result", isResult)
	if noted.num("seq") > result.num("seq") {
		t.Fatal("the input was only seen after the turn ended")
	}
	if got := stdinTexts(readRecord(t, rec)); !slices.Equal(got, []string{"work", "steer left"}) {
		t.Fatalf("stdin %q", got)
	}
	b.send(msg{"type": "job.end", "jobId": "j1"})
	if b.waitType("j1", "job.exited").num("exitCode") != 0 {
		t.Fatal("unclean exit")
	}
}

func TestMessagesBeforeSpawnAreAppliedInOrder(t *testing.T) {
	b := newBackend(t)
	startRunner(t, b)
	rec := filepath.Join(t.TempDir(), "rec.json")
	b.send(jobStart(jobOpts{id: "j1", text: "initial", setup: "sleep 1", env: map[string]string{"FAKE_CLAUDE_RECORD": rec}}))
	b.waitType("j1", "job.accepted")
	b.send(input("j1", "early"))
	b.send(msg{"type": "job.end", "jobId": "j1"})

	exited := b.waitType("j1", "job.exited")
	if exited.num("exitCode") != 0 {
		t.Fatalf("exit %v", exited)
	}
	if got := stdinTexts(readRecord(t, rec)); !slices.Equal(got, []string{"initial", "early"}) {
		t.Fatalf("stdin %q", got)
	}
	b.waitEvent("j1", "second turn", isAssistantText("Done: early"))
}

func TestInterruptEndsTheTurnButKeepsTheProcess(t *testing.T) {
	b := newBackend(t)
	startRunner(t, b)
	rec := filepath.Join(t.TempDir(), "rec.json")
	b.send(jobStart(jobOpts{id: "j1", text: "HANG", env: map[string]string{"FAKE_CLAUDE_RECORD": rec}}))
	b.waitEvent("j1", "tool_use", isToolUse)
	b.send(msg{"type": "job.interrupt", "jobId": "j1"})

	b.waitEvent("j1", "control_response", func(e msg) bool { return e.str("type") == "control_response" })
	if r := b.waitEvent("j1", "result", isResult).event(); r.str("subtype") != "error_during_execution" {
		t.Fatalf("result %v", r)
	}
	r := readRecord(t, rec)
	if !strings.Contains(r.Stdin[len(r.Stdin)-1], `"subtype":"interrupt"`) {
		t.Fatalf("no control_request interrupt on stdin: %q", r.Stdin)
	}

	b.send(input("j1", "go on"))
	b.waitEvent("j1", "next turn", isAssistantText("Done: go on"))
	b.send(msg{"type": "job.end", "jobId": "j1"})
	b.waitType("j1", "job.exited")
}

func TestCancelEscalatesToKill(t *testing.T) {
	b := newBackend(t)
	startRunner(t, b)
	b.send(jobStart(jobOpts{id: "j1", text: "STUCK", env: map[string]string{"FAKE_CLAUDE_IGNORE_TERM": "1"}}))
	b.waitEvent("j1", "first text", isAssistantText("Working on: STUCK"))
	start := time.Now()
	b.send(msg{"type": "job.cancel", "jobId": "j1"})
	exited := b.waitType("j1", "job.exited")
	if exited.str("signal") != "SIGKILL" || exited["exitCode"] != nil {
		t.Fatalf("exit %v", exited)
	}
	if elapsed := time.Since(start); elapsed < 800*time.Millisecond {
		t.Fatalf("killed after %s, before the KILL timeout", elapsed)
	}

	// Without ignoring it, SIGTERM is enough.
	b.send(jobStart(jobOpts{id: "j2", session: "s-2", text: "STUCK"}))
	b.waitEvent("j2", "first text", isAssistantText("Working on: STUCK"))
	b.send(msg{"type": "job.cancel", "jobId": "j2"})
	if exited := b.waitType("j2", "job.exited"); exited.str("signal") != "SIGTERM" {
		t.Fatalf("exit %v", exited)
	}
}

func TestResendAfterBackendDisconnect(t *testing.T) {
	t.Run("in memory", func(t *testing.T) { testResend(t) })
	// A tiny memory budget makes the outbox spill to the Agent Volume.
	t.Run("spilled to disk", func(t *testing.T) { testResend(t, "CLAUDE_TASK_OUTBOX_MEMORY_BYTES=100") })
}

func testResend(t *testing.T, env ...string) {
	b := newBackend(t)
	home := startRunner(t, b, env...)
	spill := filepath.Join(home, ".claude-task/outbox/j1.jsonl")
	b.waitHello(1)
	// Nothing gets acked before the drop, so everything sent so far must come again.
	b.setAutoAck(false)
	b.send(jobStart(jobOpts{id: "j1", text: "work", env: map[string]string{"FAKE_CLAUDE_TOOL_MS": "1200"}}))
	b.waitEvent("j1", "tool_use", isToolUse)
	b.drop()
	if _, err := os.Stat(spill); (err == nil) != (len(env) > 0) {
		t.Fatalf("spill file present = %v", err == nil)
	}
	b.setAutoAck(true)

	hello := b.waitHello(2)
	if hello.str("activeJobId") != "j1" {
		t.Fatalf("hello after reconnect %v", hello)
	}
	b.waitEvent("j1", "result", isResult)
	b.send(msg{"type": "job.end", "jobId": "j1"})
	b.waitType("j1", "job.exited")

	b.mu.Lock()
	gaps, dups := b.gaps, b.duplicates
	b.mu.Unlock()
	if len(gaps) > 0 {
		t.Fatalf("gaps: %v", gaps)
	}
	if dups == 0 {
		t.Fatal("expected the unacked messages to be resent")
	}
	for i, m := range b.jobMessages("j1") {
		if m.num("seq") != int64(i+1) {
			t.Fatalf("message %d has seq %d", i, m.num("seq"))
		}
	}

	// Once everything is acked the job is forgotten.
	time.Sleep(200 * time.Millisecond)
	b.drop()
	if h := b.waitHello(3); h["activeJobId"] != nil {
		t.Fatalf("job still active after all acks: %v", h)
	}
	if _, err := os.Stat(spill); err == nil {
		t.Fatal("spill file left behind")
	}
}

func TestOnlyOneJobAtATime(t *testing.T) {
	b := newBackend(t)
	startRunner(t, b)
	b.send(jobStart(jobOpts{id: "j1", text: "HANG"}))
	b.waitEvent("j1", "tool_use", isToolUse)
	b.send(jobStart(jobOpts{id: "j2", session: "s-2", text: "other"}))
	failed := b.waitType("j2", "job.failed")
	if failed.str("stage") != "spawn" || !strings.Contains(failed.str("message"), "another job") {
		t.Fatalf("failed %v", failed)
	}
	if m := b.jobMessages("j2"); len(m) != 1 {
		t.Fatalf("j2 should only fail, got %v", m)
	}
	b.send(msg{"type": "job.cancel", "jobId": "j1"})
	b.waitType("j1", "job.exited")
}

func TestSetupScriptRunsOnlyForANewWorktree(t *testing.T) {
	b := newBackend(t)
	home := startRunner(t, b)
	setup := "echo setting-up; echo $PROJECT_VAR; touch marker"
	env := map[string]string{"PROJECT_VAR": "from-env"}
	b.send(jobStart(jobOpts{id: "j1", text: "a", setup: setup, env: env}))
	b.waitEvent("j1", "result", isResult)
	if out := b.setupOutput("j1"); !strings.Contains(out, "setting-up") || !strings.Contains(out, "from-env") {
		t.Fatalf("setup output %q", out)
	}
	b.send(msg{"type": "job.end", "jobId": "j1"})
	b.waitType("j1", "job.exited")

	marker := filepath.Join(home, "worktrees/proj/T-1/marker")
	if err := os.Remove(marker); err != nil {
		t.Fatal(err)
	}
	b.send(jobStart(jobOpts{id: "j2", session: "s-2", text: "b", setup: setup, env: env}))
	b.waitEvent("j2", "result", isResult)
	if _, err := os.Stat(marker); err == nil || strings.Contains(b.setupOutput("j2"), "setting-up") {
		t.Fatal("setup ran again on an existing worktree")
	}
	b.send(msg{"type": "job.end", "jobId": "j2"})
	b.waitType("j2", "job.exited")

	rec := filepath.Join(t.TempDir(), "rec.json")
	b.send(jobStart(jobOpts{id: "j3", session: "s-3", worktree: "worktrees/proj/T-2", text: "c", setup: "echo broken; exit 3",
		env: map[string]string{"FAKE_CLAUDE_RECORD": rec}}))
	failed := b.waitType("j3", "job.failed")
	if failed.str("stage") != "setup" || !strings.Contains(failed.str("message"), "3") || !strings.Contains(b.setupOutput("j3"), "broken") {
		t.Fatalf("failed %v, output %q", failed, b.setupOutput("j3"))
	}
	if _, err := os.Stat(rec); err == nil {
		t.Fatal("claude was spawned after a failed setup script")
	}
}

// The Runner token outlives the Job: claude, its tools and the setup script never see it
// (their output reaches the Timeline), while git still finds the credential socket.
func TestRunnerTokenStaysOutOfJobProcesses(t *testing.T) {
	b := newBackend(t)
	startRunner(t, b)
	rec := filepath.Join(t.TempDir(), "rec.json")
	b.send(jobStart(jobOpts{id: "j1", text: "a", setup: `echo "token=[$CLAUDE_TASK_RUNNER_TOKEN]"`,
		env: map[string]string{"FAKE_CLAUDE_RECORD": rec}}))
	b.waitEvent("j1", "result", isResult)
	if out := b.setupOutput("j1"); !strings.Contains(out, "token=[]") {
		t.Fatalf("setup script saw the runner token: %q", out)
	}
	r := readRecord(t, rec)
	if _, ok := r.Env["CLAUDE_TASK_RUNNER_TOKEN"]; ok {
		t.Fatal("claude got the runner token")
	}
	if r.Env["CLAUDE_TASK_GIT_SOCKET"] == "" {
		t.Fatal("claude lost the git credential socket")
	}
	b.send(msg{"type": "job.end", "jobId": "j1"})
	b.waitType("j1", "job.exited")
}

func TestWorktreePathsMustStayInHome(t *testing.T) {
	b := newBackend(t)
	startRunner(t, b)
	b.send(jobStart(jobOpts{id: "j1", worktree: "../outside", text: "x"}))
	if failed := b.waitType("j1", "job.failed"); failed.str("stage") != "worktree" {
		t.Fatalf("failed %v", failed)
	}
}

func TestAttachmentsAreFetchedIntoTheWorktree(t *testing.T) {
	b := newBackend(t)
	home := startRunner(t, b)
	b.files["a"] = []byte("log contents")
	b.files["b"] = []byte("second file")
	rec := filepath.Join(t.TempDir(), "rec.json")
	b.send(jobStart(jobOpts{id: "j1", text: "see file", env: map[string]string{"FAKE_CLAUDE_RECORD": rec, "FAKE_CLAUDE_TOOL_MS": "300"},
		attachments: []msg{
			{"url": b.srv.URL + "/files/a", "path": ".claude-task/attachments/c1/log.txt"},
			{"url": b.srv.URL + "/files/a", "path": "../../escape.txt"},
		}}))
	b.waitEvent("j1", "result", isResult)
	wt := filepath.Join(home, "worktrees/proj/T-1")
	if data, err := os.ReadFile(filepath.Join(wt, ".claude-task/attachments/c1/log.txt")); err != nil || string(data) != "log contents" {
		t.Fatalf("attachment: %q %v", data, err)
	}
	if !strings.Contains(b.stderr("j1"), "could not fetch attachment ../../escape.txt") {
		t.Fatalf("escaping path not refused: %q", b.stderr("j1"))
	}
	if _, err := os.Stat(filepath.Join(home, "escape.txt")); err == nil {
		t.Fatal("wrote outside the worktree")
	}

	b.send(input("j1", "and this", msg{"url": b.srv.URL + "/files/b", "path": ".claude-task/attachments/c2/b.txt"}))
	b.waitEvent("j1", "second turn", isAssistantText("Done: and this"))
	if data, _ := os.ReadFile(filepath.Join(wt, ".claude-task/attachments/c2/b.txt")); string(data) != "second file" {
		t.Fatalf("input attachment %q", data)
	}
	b.send(msg{"type": "job.end", "jobId": "j1"})
	b.waitType("j1", "job.exited")
}
