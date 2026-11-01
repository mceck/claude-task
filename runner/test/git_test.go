package test

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// gitIn runs git with the test's isolated config and returns trimmed output.
func gitIn(t *testing.T, home, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
	cmd.Env = isolatedEnv(home)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v in %s: %v\n%s", args, dir, err, out)
	}
	return strings.TrimSpace(string(out))
}

// origin is a bare repository standing in for GitHub, with `main` and an existing Task Branch.
type origin struct {
	t          *testing.T
	home, bare string
	seed       string
}

func newOrigin(t *testing.T) *origin {
	dir := t.TempDir()
	o := &origin{t: t, home: dir, bare: filepath.Join(dir, "origin.git"), seed: filepath.Join(dir, "seed")}
	gitIn(t, dir, dir, "init", "--bare", "--quiet", "-b", "main", o.bare)
	gitIn(t, dir, dir, "clone", "--quiet", o.bare, o.seed)
	gitIn(t, dir, o.seed, "checkout", "--quiet", "-b", "main")
	o.commit("README.md", "hello", "initial")
	gitIn(t, dir, o.seed, "push", "--quiet", "origin", "main")
	gitIn(t, dir, o.seed, "checkout", "--quiet", "-b", "task/t-9-existing")
	o.commit("feature.txt", "earlier work", "earlier work")
	gitIn(t, dir, o.seed, "push", "--quiet", "origin", "task/t-9-existing")
	gitIn(t, dir, o.seed, "checkout", "--quiet", "main")
	return o
}

func (o *origin) commit(file, content, message string) {
	if err := os.MkdirAll(filepath.Dir(filepath.Join(o.seed, file)), 0o755); err != nil {
		o.t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(o.seed, file), []byte(content), 0o644); err != nil {
		o.t.Fatal(err)
	}
	gitIn(o.t, o.home, o.seed, "add", file)
	gitIn(o.t, o.home, o.seed, "-c", "user.name=Seed", "-c", "user.email=seed@example.com", "commit", "--quiet", "-m", message)
}

func (o *origin) url() string { return "file://" + o.bare }

func (o *origin) spec(branch string) msg {
	return msg{
		"cloneUrl": o.url(), "baseBranch": "main", "taskBranch": branch, "branchExists": false,
		"repoPath": "repos/proj.git", "commitName": "Ada (claude-task)", "commitEmail": "ada@agents.claude-task.local",
	}
}

// runJob starts a Job on a git Worktree and ends it after its first Turn.
func runJob(t *testing.T, b *backend, id, worktree string, git msg, setup string) {
	t.Helper()
	b.send(jobStart(jobOpts{id: id, session: "s-" + id, worktree: worktree, git: git, setup: setup, text: "go"}))
	b.waitEvent(id, "result", isResult)
	b.send(msg{"type": "job.end", "jobId": id})
	b.waitType(id, "job.exited")
}

func TestWorktreeOnANewTaskBranch(t *testing.T) {
	o := newOrigin(t)
	b := newBackend(t)
	home := startRunner(t, b)
	runJob(t, b, "j1", "worktrees/proj/T-1", o.spec("task/t-1-login"), "mkdir -p .claude-task && touch .claude-task/setup-ran")

	wt := filepath.Join(home, "worktrees/proj/T-1")
	repo := filepath.Join(home, "repos/proj.git")
	if gitIn(t, home, wt, "rev-parse", "--abbrev-ref", "HEAD") != "task/t-1-login" {
		t.Fatal("worktree not on the task branch")
	}
	if gitIn(t, home, wt, "rev-parse", "HEAD") != gitIn(t, home, o.seed, "rev-parse", "main") {
		t.Fatal("task branch doesn't start at origin/main")
	}
	if _, err := os.Stat(filepath.Join(wt, ".claude-task/setup-ran")); err != nil {
		t.Fatal("setup script didn't run in the new worktree")
	}
	if out := b.setupOutput("j1"); !strings.Contains(out, "git") {
		t.Fatalf("git output not streamed: %q", out)
	}
	if gitIn(t, home, wt, "config", "user.name") != "Ada (claude-task)" || gitIn(t, home, wt, "config", "user.email") != "ada@agents.claude-task.local" {
		t.Fatal("commit identity not set")
	}

	// Attachments are invisible to git, and a plain `git push` publishes the task branch.
	os.MkdirAll(filepath.Join(wt, ".claude-task/attachments/c1"), 0o755)
	os.WriteFile(filepath.Join(wt, ".claude-task/attachments/c1/x.log"), []byte("x"), 0o644)
	os.WriteFile(filepath.Join(wt, "change.txt"), []byte("work"), 0o644)
	if status := gitIn(t, home, wt, "status", "--porcelain"); status != "?? change.txt" {
		t.Fatalf("status %q", status)
	}
	gitIn(t, home, wt, "add", "change.txt")
	gitIn(t, home, wt, "commit", "--quiet", "-m", "agent work")
	gitIn(t, home, wt, "push", "--quiet")
	if author := gitIn(t, home, o.bare, "log", "-1", "--format=%an <%ae>", "task/t-1-login"); author != "Ada (claude-task) <ada@agents.claude-task.local>" {
		t.Fatalf("pushed commit author %q", author)
	}
	if !strings.Contains(gitIn(t, home, repo, "branch", "--list"), "task/t-1-login") {
		t.Fatal("local task branch missing")
	}
}

func TestWorktreeFromAnExistingRemoteTaskBranch(t *testing.T) {
	o := newOrigin(t)
	b := newBackend(t)
	home := startRunner(t, b)
	spec := o.spec("task/t-9-existing")
	spec["branchExists"] = true
	runJob(t, b, "j1", "worktrees/proj/T-9", spec, "")

	wt := filepath.Join(home, "worktrees/proj/T-9")
	if data, err := os.ReadFile(filepath.Join(wt, "feature.txt")); err != nil || string(data) != "earlier work" {
		t.Fatalf("previous work missing: %q %v", data, err)
	}
	os.WriteFile(filepath.Join(wt, "more.txt"), []byte("more"), 0o644)
	gitIn(t, home, wt, "add", "more.txt")
	gitIn(t, home, wt, "commit", "--quiet", "-m", "more")
	gitIn(t, home, wt, "push", "--quiet")
	if gitIn(t, home, o.bare, "log", "-1", "--format=%s", "task/t-9-existing") != "more" {
		t.Fatal("push didn't reach the existing remote branch")
	}
}

func TestNextJobsFetchAndKeepTheExistingWorktree(t *testing.T) {
	o := newOrigin(t)
	b := newBackend(t)
	home := startRunner(t, b)
	runJob(t, b, "j1", "worktrees/proj/T-1", o.spec("task/t-1"), "")

	wt := filepath.Join(home, "worktrees/proj/T-1")
	os.WriteFile(filepath.Join(wt, "wip.txt"), []byte("uncommitted"), 0o644)
	o.commit("news.txt", "new on main", "news")
	gitIn(t, o.home, o.seed, "push", "--quiet", "origin", "main")

	// Same Task again: the worktree with uncommitted work is left as it is, and no setup runs.
	runJob(t, b, "j2", "worktrees/proj/T-1", o.spec("task/t-1"), "touch setup-ran")
	if data, _ := os.ReadFile(filepath.Join(wt, "wip.txt")); string(data) != "uncommitted" {
		t.Fatal("uncommitted work lost")
	}
	if _, err := os.Stat(filepath.Join(wt, "setup-ran")); err == nil {
		t.Fatal("setup ran on an existing worktree")
	}

	// Another Task branches from the freshly fetched main.
	runJob(t, b, "j3", "worktrees/proj/T-2", o.spec("task/t-2"), "")
	if _, err := os.Stat(filepath.Join(home, "worktrees/proj/T-2/news.txt")); err != nil {
		t.Fatal("new worktree isn't based on the fetched main")
	}
}

func TestRemovingAWorktreeKeepsTheBranches(t *testing.T) {
	o := newOrigin(t)
	b := newBackend(t)
	home := startRunner(t, b)
	runJob(t, b, "j1", "worktrees/proj/T-1", o.spec("task/t-1"), "")
	wt := filepath.Join(home, "worktrees/proj/T-1")
	repo := filepath.Join(home, "repos/proj.git")
	os.WriteFile(filepath.Join(wt, "change.txt"), []byte("work"), 0o644)
	gitIn(t, home, wt, "add", "change.txt")
	gitIn(t, home, wt, "commit", "--quiet", "-m", "committed, not pushed")
	os.WriteFile(filepath.Join(wt, "dirty.txt"), []byte("dirty"), 0o644)

	b.send(msg{"type": "worktree.remove", "worktreePath": "worktrees/proj/T-1", "repoPath": "repos/proj.git"})
	waitUntil(t, 10*time.Second, "worktree removed", func() bool { _, err := os.Stat(wt); return os.IsNotExist(err) })
	if strings.Contains(gitIn(t, home, repo, "worktree", "list"), "T-1") {
		t.Fatal("worktree still registered")
	}
	if gitIn(t, home, repo, "log", "-1", "--format=%s", "task/t-1") != "committed, not pushed" {
		t.Fatal("local task branch lost")
	}

	// With no remote task branch, reopening recreates from the latest base branch (docs/specs/git-integration.md).
	runJob(t, b, "j2", "worktrees/proj/T-1", o.spec("task/t-1"), "")
	if gitIn(t, home, wt, "rev-parse", "HEAD") != gitIn(t, home, o.bare, "rev-parse", "main") {
		t.Fatal("missing remote branch was not recreated from the base")
	}

	b.send(msg{"type": "worktree.remove", "worktreePath": "worktrees/proj/T-3", "repoPath": nil})
	os.MkdirAll(filepath.Join(home, "worktrees/proj/T-3"), 0o755)
	b.send(msg{"type": "worktree.remove", "worktreePath": "worktrees/proj/T-3", "repoPath": nil})
	waitUntil(t, 10*time.Second, "plain worktree removed", func() bool {
		_, err := os.Stat(filepath.Join(home, "worktrees/proj/T-3"))
		return os.IsNotExist(err)
	})
}

func TestDeletedRemoteTaskBranchIsRecreatedFromTheLatestBase(t *testing.T) {
	o := newOrigin(t)
	b := newBackend(t)
	home := startRunner(t, b)
	spec := o.spec("task/t-9-existing")
	spec["branchExists"] = true
	runJob(t, b, "j1", "worktrees/proj/T-9", spec, "")
	wt := filepath.Join(home, "worktrees/proj/T-9")
	b.send(msg{"type": "worktree.remove", "worktreePath": "worktrees/proj/T-9", "repoPath": "repos/proj.git"})
	waitUntil(t, 10*time.Second, "worktree removed", func() bool { _, err := os.Stat(wt); return os.IsNotExist(err) })
	gitIn(t, o.home, o.seed, "push", "--quiet", "origin", ":task/t-9-existing")
	o.commit("README.md", "latest base", "base advanced")
	gitIn(t, o.home, o.seed, "push", "--quiet", "origin", "main")
	spec["branchExists"] = false
	runJob(t, b, "j2", "worktrees/proj/T-9", spec, "")
	if gitIn(t, home, wt, "rev-parse", "HEAD") != gitIn(t, o.home, o.bare, "rev-parse", "main") {
		t.Fatal("reopened branch did not start at the latest base")
	}
	if ready := b.waitType("j2", "job.worktree_ready"); ready["remoteBranchMissing"] != true || ready["created"] != true {
		t.Fatalf("missing-branch observation: %v", ready)
	}
}

func TestChangingARepositoryDoesNotReuseOldBranchCommits(t *testing.T) {
	first := newOrigin(t)
	second := newOrigin(t)
	second.commit("different.txt", "different repository", "new repository")
	gitIn(t, second.home, second.seed, "push", "--quiet", "origin", "main")
	b := newBackend(t)
	home := startRunner(t, b)
	runJob(t, b, "j1", "worktrees/proj/T-1", first.spec("task/t-1"), "")
	runJob(t, b, "j2", "worktrees/proj/T-1", second.spec("task/t-1"), "")
	wt := filepath.Join(home, "worktrees/proj/T-1")
	if _, err := os.Stat(filepath.Join(wt, "different.txt")); err != nil {
		t.Fatal("worktree still belongs to the previous repository")
	}
	if gitIn(t, home, wt, "rev-parse", "HEAD") != gitIn(t, second.home, second.bare, "rev-parse", "main") {
		t.Fatal("old local task branch was reused for the new repository")
	}
}

func TestMovingOriginToTheGitProxyKeepsClonesAndWorktrees(t *testing.T) {
	o := newOrigin(t)
	b := newBackend(t)
	home := startRunner(t, b)
	// A clone made before the Git Proxy: direct origin URL, no recorded identity.
	runJob(t, b, "j1", "worktrees/proj/T-1", o.spec("task/t-1"), "")
	wt := filepath.Join(home, "worktrees/proj/T-1")
	os.WriteFile(filepath.Join(wt, "wip.txt"), []byte("uncommitted"), 0o644)
	head := gitIn(t, home, wt, "rev-parse", "HEAD")

	// The same Repository through another URL (the proxy), now with its identity.
	alias := filepath.Join(t.TempDir(), "proxy.git")
	if err := os.Symlink(o.bare, alias); err != nil {
		t.Fatal(err)
	}
	spec := o.spec("task/t-1")
	spec["cloneUrl"] = "file://" + alias
	spec["repositoryId"] = "conn-1/42"
	runJob(t, b, "j2", "worktrees/proj/T-1", spec, "touch setup-ran")
	if data, _ := os.ReadFile(filepath.Join(wt, "wip.txt")); string(data) != "uncommitted" {
		t.Fatal("uncommitted work lost when origin moved")
	}
	if _, err := os.Stat(filepath.Join(wt, "setup-ran")); err == nil {
		t.Fatal("the existing worktree was recreated")
	}
	if gitIn(t, home, wt, "rev-parse", "HEAD") != head {
		t.Fatal("worktree HEAD changed")
	}
	repo := filepath.Join(home, "repos/proj.git")
	if gitIn(t, home, repo, "config", "--get", "remote.origin.url") != "file://"+alias {
		t.Fatal("origin wasn't rewritten")
	}
	if gitIn(t, home, repo, "config", "--get", "claude-task.repository") != "conn-1/42" {
		t.Fatal("repository identity not recorded")
	}
}

func TestChangingTheRepositoryBehindTheSameProxyURL(t *testing.T) {
	first := newOrigin(t)
	second := newOrigin(t)
	second.commit("different.txt", "different repository", "new repository")
	gitIn(t, second.home, second.seed, "push", "--quiet", "origin", "main")
	// One proxy URL per Project, whatever Repository is behind it.
	proxy := filepath.Join(t.TempDir(), "proxy.git")
	link := func(target string) {
		os.Remove(proxy)
		if err := os.Symlink(target, proxy); err != nil {
			t.Fatal(err)
		}
	}
	spec := func(o *origin, id string) msg {
		s := o.spec("task/t-1")
		s["cloneUrl"] = "file://" + proxy
		s["repositoryId"] = id
		return s
	}
	b := newBackend(t)
	home := startRunner(t, b)
	link(first.bare)
	runJob(t, b, "j1", "worktrees/proj/T-1", spec(first, "conn-1/1"), "")
	wt := filepath.Join(home, "worktrees/proj/T-1")
	link(second.bare)
	runJob(t, b, "j2", "worktrees/proj/T-1", spec(second, "conn-1/2"), "")
	if _, err := os.Stat(filepath.Join(wt, "different.txt")); err != nil {
		t.Fatal("worktree still belongs to the previous repository")
	}
	if gitIn(t, home, wt, "rev-parse", "HEAD") != gitIn(t, second.home, second.bare, "rev-parse", "main") {
		t.Fatal("old local task branch was reused for the new repository")
	}
}

// Exercise the real runner/worktree flow with a local stand-in for the network
// installer. The project setup must observe the files produced by mise.
func TestMiseInstallBeforeProjectSetup(t *testing.T) {
	for _, config := range []string{".tool-versions", "mise.toml", ".config/mise/conf.d/tools.toml"} {
		t.Run(config, func(t *testing.T) {
			o := newOrigin(t)
			o.commit(config, "node 22\n", "tool configuration")
			gitIn(t, o.home, o.seed, "push", "--quiet", "origin", "main")
			bin := t.TempDir()
			script := "#!/bin/sh\nset -eu\n[ \"$*\" = \"install --yes\" ]\nmkdir -p .claude-task\necho installed >> .claude-task/mise-calls\necho runtime-installed\n"
			if err := os.WriteFile(filepath.Join(bin, "mise"), []byte(script), 0o755); err != nil {
				t.Fatal(err)
			}
			b := newBackend(t)
			home := startRunner(t, b, "PATH="+bin+":"+os.Getenv("PATH"))
			runJob(t, b, "j1", "worktrees/proj/T-1", o.spec("task/t-1"), "test -f .claude-task/mise-calls && touch .claude-task/project-ready")
			wt := filepath.Join(home, "worktrees/proj/T-1")
			if _, err := os.Stat(filepath.Join(wt, ".claude-task/project-ready")); err != nil {
				t.Fatal(err)
			}
			if out := b.setupOutput("j1"); !strings.Contains(out, "runtime-installed") {
				t.Fatalf("missing mise output: %s", out)
			}
			b.send(jobStart(jobOpts{id: "j2", mode: "resume", worktree: "worktrees/proj/T-1", git: o.spec("task/t-1"), text: "go"}))
			b.waitEvent("j2", "result", isResult)
			b.send(msg{"type": "job.end", "jobId": "j2"})
			b.waitType("j2", "job.exited")
			calls, err := os.ReadFile(filepath.Join(wt, ".claude-task/mise-calls"))
			if err != nil || string(calls) != "installed\n" {
				t.Fatalf("mise repeated on resume: %q %v", calls, err)
			}
		})
	}
}

func TestMiseFailureStopsClaudeAndCanBeRetried(t *testing.T) {
	o := newOrigin(t)
	o.commit(".tool-versions", "node 22\n", "tool configuration")
	gitIn(t, o.home, o.seed, "push", "--quiet", "origin", "main")
	bin := t.TempDir()
	script := "#!/bin/sh\necho installing-runtime\nif [ \"${INSTALL_FAIL:-}\" = yes ]; then exit 7; fi\nmkdir -p .claude-task\ntouch .claude-task/runtime-ready\n"
	if err := os.WriteFile(filepath.Join(bin, "mise"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	b := newBackend(t)
	home := startRunner(t, b, "PATH="+bin+":"+os.Getenv("PATH"))
	rec := filepath.Join(t.TempDir(), "claude.json")
	b.send(jobStart(jobOpts{id: "j1", git: o.spec("task/t-1"), setup: "touch .claude-task/project-ready", text: "go", env: map[string]string{"INSTALL_FAIL": "yes", "FAKE_CLAUDE_RECORD": rec}}))
	failed := b.waitType("j1", "job.failed")
	if failed.str("stage") != "setup" || !strings.Contains(failed.str("message"), "exit status 7") {
		t.Fatalf("failure: %v", failed)
	}
	if _, err := os.Stat(rec); !os.IsNotExist(err) {
		t.Fatalf("Claude started after failed install: %v", err)
	}
	runJob(t, b, "j2", "worktrees/proj/T-1", o.spec("task/t-1"), "test -f .claude-task/runtime-ready && touch .claude-task/project-ready")
	if _, err := os.Stat(filepath.Join(home, "worktrees/proj/T-1/.claude-task/project-ready")); err != nil {
		t.Fatalf("project setup not retried: %v", err)
	}
	if _, err := os.Stat(filepath.Join(home, "worktrees/proj/T-1/.claude-task/runtime-ready")); err != nil {
		t.Fatalf("install not retried: %v", err)
	}
}

// Hooks in the Agent's repositories run during the Runner's own git commands: without the Runner token.
func TestRunnerGitCommandsKeepTheRunnerTokenFromHooks(t *testing.T) {
	o := newOrigin(t)
	b := newBackend(t)
	home := startRunner(t, b)
	runJob(t, b, "j1", "worktrees/proj/T-1", o.spec("task/t-1-login"), "")

	leak := filepath.Join(home, "leak")
	hook := "#!/bin/sh\necho \"[$CLAUDE_TASK_RUNNER_TOKEN]\" >> " + leak + "\n"
	if err := os.WriteFile(filepath.Join(home, "repos/proj.git/hooks/post-checkout"), []byte(hook), 0o755); err != nil {
		t.Fatal(err)
	}
	runJob(t, b, "j2", "worktrees/proj/T-2", o.spec("task/t-2-signup"), "")
	out, err := os.ReadFile(leak)
	if err != nil {
		t.Fatalf("the hook didn't run: %v", err)
	}
	if strings.TrimSpace(string(out)) != "[]" {
		t.Fatalf("a hook saw the runner token: %q", out)
	}
}

// A Worktree preparation that fails transiently (here: the origin not there yet, like a Git Proxy
// that hasn't settled the Job) is retried instead of failing the Job.
func TestWorktreePreparationRetriesATransientFailure(t *testing.T) {
	o := newOrigin(t)
	b := newBackend(t)
	home := startRunner(t, b)
	later := filepath.Join(t.TempDir(), "origin.git")
	spec := o.spec("task/t-9-existing")
	spec["cloneUrl"] = "file://" + later
	spec["branchExists"] = true

	b.send(jobStart(jobOpts{id: "j1", session: "s-j1", worktree: "worktrees/proj/T-9", git: spec, text: "go"}))
	waitUntil(t, 10*time.Second, "the first attempt to fail", func() bool {
		return strings.Contains(b.setupOutput("j1"), "preparing the worktree failed")
	})
	if err := os.Rename(o.bare, later); err != nil {
		t.Fatal(err)
	}
	b.waitEvent("j1", "result", isResult)
	b.send(msg{"type": "job.end", "jobId": "j1"})
	b.waitType("j1", "job.exited")

	if out := b.setupOutput("j1"); !strings.Contains(out, "(attempt 1/3)") {
		t.Fatalf("the retry isn't in the setup output: %q", out)
	}
	if ready := b.waitType("j1", "job.worktree_ready"); ready["created"] != true {
		t.Fatalf("worktree_ready: %v", ready)
	}
	wt := filepath.Join(home, "worktrees/proj/T-9")
	if gitIn(t, home, wt, "rev-parse", "--abbrev-ref", "HEAD") != "task/t-9-existing" {
		t.Fatal("the retry didn't create the Worktree on the task branch")
	}
}

// The retries are bounded: a preparation that never succeeds fails the Job after the last attempt.
func TestWorktreePreparationGivesUpAfterThreeRetries(t *testing.T) {
	b := newBackend(t)
	startRunner(t, b)
	spec := msg{
		"cloneUrl": "file://" + filepath.Join(t.TempDir(), "missing.git"), "baseBranch": "main", "taskBranch": "task/t-1",
		"branchExists": false, "repoPath": "repos/proj.git", "commitName": "Ada (claude-task)", "commitEmail": "ada@agents.claude-task.local",
	}
	b.send(jobStart(jobOpts{id: "j1", text: "go", git: spec}))
	failed := b.waitType("j1", "job.failed")
	if failed.str("stage") != "worktree" || !strings.Contains(failed.str("message"), "exit status 128") {
		t.Fatalf("failure: %v", failed)
	}
	out := b.setupOutput("j1")
	for _, attempt := range []string{"(attempt 1/3)", "(attempt 2/3)", "(attempt 3/3)"} {
		if !strings.Contains(out, attempt) {
			t.Fatalf("%s missing from the setup output: %q", attempt, out)
		}
	}
}

// Cancelling while a retry waits ends the Job at once instead of after the delay.
func TestCancelDuringAWorktreeRetryWaitEndsTheJob(t *testing.T) {
	b := newBackend(t)
	startRunner(t, b)
	spec := msg{
		"cloneUrl": "file://" + filepath.Join(t.TempDir(), "missing.git"), "baseBranch": "main", "taskBranch": "task/t-1",
		"branchExists": false, "repoPath": "repos/proj.git", "commitName": "Ada (claude-task)", "commitEmail": "ada@agents.claude-task.local",
	}
	b.send(jobStart(jobOpts{id: "j1", text: "go", git: spec}))
	waitUntil(t, 10*time.Second, "the retry to be announced", func() bool {
		return strings.Contains(b.setupOutput("j1"), "retrying in")
	})
	start := time.Now()
	b.send(msg{"type": "job.cancel", "jobId": "j1"})
	if failed := b.waitType("j1", "job.failed"); failed.str("stage") != "worktree" {
		t.Fatalf("failed %v", failed)
	}
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Fatalf("a cancelled Job waited %s for its retry", elapsed)
	}
	if b.processedIndex("j1", "job.worktree_ready") >= 0 {
		t.Fatal("a cancelled Job announced its Worktree as ready")
	}
}
