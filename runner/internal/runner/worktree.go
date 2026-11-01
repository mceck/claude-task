package runner

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"math/rand/v2"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"claude-task/runner/internal/protocol"
)

const (
	excludeEntry = ".claude-task/"
	// setupPendingMarker marks a new Worktree whose setup hasn't succeeded yet.
	setupPendingMarker = ".claude-task/setup-pending"
)

// worktreeRetryDelays pace the retries of a failed Worktree preparation. Its failures are mostly
// transient: the Git Proxy can still see the Job as not started when the first fetch arrives, and
// provider or network blips clear on their own. Three retries cover both within a few seconds.
var worktreeRetryDelays = []time.Duration{time.Second, 2 * time.Second, 4 * time.Second}

// retryDelay spreads a retry delay over [d, 1.5d): Runners retrying together (a backend or provider
// blip) don't come back in lockstep.
func retryDelay(d time.Duration) time.Duration {
	return d + time.Duration(rand.Int64N(int64(d)/2+1))
}

// prepareWorktree makes the Task's Worktree ready (docs/specs/runner.md) and reports whether it was just created.
// A new Worktree is marked setup-pending as soon as it exists.
func (j *job) prepareWorktree() (string, bool, error) {
	<-j.turn
	defer j.endTurn()
	home := j.r.cfg.Home
	wt, err := within(home, j.start.WorktreePath)
	if err != nil {
		return "", false, err
	}
	g := j.start.Git
	if g == nil {
		_, statErr := os.Stat(wt)
		if err := os.MkdirAll(wt, 0o755); err != nil {
			return "", false, err
		}
		created := os.IsNotExist(statErr)
		if created {
			if err := markSetupPending(wt); err != nil {
				return "", false, err
			}
		}
		return wt, created, nil
	}
	repo, err := within(home, g.RepoPath)
	if err != nil {
		return "", false, err
	}
	out := j.setupWriter()
	defer out.Flush()
	created, err := j.prepareGitWorktreeWithRetry(out, repo, wt, g)
	j.remoteBranchMissing = !refExists(repo, "refs/remotes/origin/"+g.TaskBranch)
	return wt, created, err
}

// prepareGitWorktreeWithRetry prepares the Worktree again after a failure, up to len(worktreeRetryDelays)
// times. Every attempt starts from whatever the previous one left: the steps are idempotent, and a
// Worktree created halfway is recreated by createWorktree. Each retry is announced in the setup output,
// where the failure's System Comment shows it; a cancel stops the wait and fails the Job as cancelled.
func (j *job) prepareGitWorktreeWithRetry(out *utf8Chunks, repo, wt string, g *protocol.GitSpec) (bool, error) {
	created, err := prepareGitWorktree(out, repo, wt, g, j.isCancelled)
	for attempt := 1; err != nil && !errors.Is(err, errCancelled) && attempt <= len(worktreeRetryDelays); attempt++ {
		wait := retryDelay(worktreeRetryDelays[attempt-1])
		fmt.Fprintf(out, "[runner] preparing the worktree failed (%v); retrying in %s (attempt %d/%d)\n", err, wait.Round(10*time.Millisecond), attempt, len(worktreeRetryDelays))
		out.Flush()
		select {
		case <-time.After(wait):
		case <-j.cancelled:
			return created, errCancelled
		}
		created, err = prepareGitWorktree(out, repo, wt, g, j.isCancelled)
	}
	return created, err
}

func prepareGitWorktree(out io.Writer, repo, wt string, g *protocol.GitSpec, cancelled func() bool) (bool, error) {
	check := func() error {
		if cancelled() {
			return errCancelled
		}
		return nil
	}
	git := func(dir string, args ...string) error {
		if err := check(); err != nil {
			return err
		}
		return runGit(out, dir, args...)
	}

	// A Project may change repository only with every Session closed. Discard the old
	// bare clone rather than reusing its local branch tips with a different repository.
	if staleClone(repo, g) {
		if err := os.RemoveAll(repo); err != nil {
			return false, err
		}
	}
	// 1. Bare clone (all branches as origin/*) on first use, otherwise fetch.
	if _, err := os.Stat(repo); os.IsNotExist(err) {
		if err := os.MkdirAll(filepath.Dir(repo), 0o755); err != nil {
			return false, err
		}
		if err := git("", "init", "--bare", "--quiet", repo); err != nil {
			return false, err
		}
		if err := git(repo, "remote", "add", "origin", g.CloneURL); err != nil {
			return false, err
		}
	} else if err := git(repo, "remote", "set-url", "origin", g.CloneURL); err != nil {
		return false, err
	}
	if g.RepositoryID != "" {
		if err := git(repo, "config", "claude-task.repository", g.RepositoryID); err != nil {
			return false, err
		}
	}
	if err := git(repo, "fetch", "--prune", "origin"); err != nil {
		return false, err
	}

	// 2. An existing Worktree is the Agent's working state: leave it alone.
	created := false
	if !validWorktree(wt) {
		if err := createWorktree(out, repo, wt, g, cancelled); err != nil {
			return false, err
		}
		created = true
	}

	// 4. Commit identity, 5. attachments stay out of git.
	if err := check(); err != nil {
		return false, err
	}
	if err := git(wt, "config", "user.name", g.CommitName); err != nil {
		return false, err
	}
	if err := git(wt, "config", "user.email", g.CommitEmail); err != nil {
		return false, err
	}
	if err := ensureExcluded(repo); err != nil {
		return false, err
	}
	return created, nil
}

// staleClone reports whether the bare clone belongs to another Repository. A clone made
// before identities were recorded is adopted: its origin may move to the Git Proxy URL,
// and its Worktrees must survive that.
func staleClone(repo string, g *protocol.GitSpec) bool {
	config := func(key string) (string, bool) {
		cmd := exec.Command("git", "-C", repo, "config", "--get", key)
		cmd.Env = gitEnv()
		out, err := cmd.Output()
		return strings.TrimSpace(string(out)), err == nil
	}
	if g.RepositoryID != "" {
		recorded, ok := config("claude-task.repository")
		return ok && recorded != g.RepositoryID
	}
	old, ok := config("remote.origin.url")
	return ok && old != g.CloneURL
}

func createWorktree(out io.Writer, repo, wt string, g *protocol.GitSpec, cancelled func() bool) error {
	git := func(dir string, args ...string) error {
		if cancelled() {
			return errCancelled
		}
		return runGit(out, dir, args...)
	}
	if err := git(repo, "worktree", "prune"); err != nil {
		return err
	}
	// A directory that isn't a valid worktree is a leftover; the deterministic path must be free.
	if err := os.RemoveAll(wt); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(wt), 0o755); err != nil {
		return err
	}
	b := g.TaskBranch
	remote := refExists(repo, "refs/remotes/origin/"+b)
	base := "origin/" + g.BaseBranch
	if remote {
		base = "origin/" + b
	}
	fail := func(err error) error {
		// A Worktree whose preparation stopped halfway must be recreated on the retry,
		// not mistaken for one that is already initialized.
		os.RemoveAll(wt)
		runGit(out, repo, "worktree", "prune")
		return err
	}
	// An absent worktree is recreated from the remote, including when a stale local branch remains.
	if err := git(repo, "worktree", "add", "--no-track", "-B", b, wt, base); err != nil {
		return fail(err)
	}
	if cancelled() {
		return fail(errCancelled)
	}
	if err := markSetupPending(wt); err != nil {
		return fail(err)
	}
	// 3. Upstream = origin/<task branch>, set by config so it works before the remote branch exists.
	if err := git(repo, "config", "branch."+b+".remote", "origin"); err != nil {
		return fail(err)
	}
	if err := git(repo, "config", "branch."+b+".merge", "refs/heads/"+b); err != nil {
		return fail(err)
	}
	return nil
}

func markSetupPending(wt string) error {
	p := filepath.Join(wt, setupPendingMarker)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return err
	}
	return os.WriteFile(p, nil, 0o644)
}

func validWorktree(wt string) bool {
	if _, err := os.Stat(filepath.Join(wt, ".git")); err != nil {
		return false
	}
	cmd := exec.Command("git", "-C", wt, "rev-parse", "--is-inside-work-tree")
	cmd.Env = gitEnv()
	outb, err := cmd.Output()
	return err == nil && strings.TrimSpace(string(outb)) == "true"
}

func refExists(repo, ref string) bool {
	cmd := exec.Command("git", "-C", repo, "show-ref", "--verify", "--quiet", ref)
	cmd.Env = gitEnv()
	return cmd.Run() == nil
}

func ensureExcluded(repo string) error {
	p := filepath.Join(repo, "info", "exclude")
	data, err := os.ReadFile(p)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	for _, line := range strings.Split(string(data), "\n") {
		if strings.TrimSpace(line) == excludeEntry {
			return nil
		}
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return err
	}
	if len(data) > 0 && !bytes.HasSuffix(data, []byte("\n")) {
		data = append(data, '\n')
	}
	return os.WriteFile(p, append(data, excludeEntry+"\n"...), 0o644)
}

func gitEnv() []string {
	return append(childEnv(), "GIT_TERMINAL_PROMPT=0", "LC_ALL=C")
}

func runGit(out io.Writer, dir string, args ...string) error {
	if dir != "" {
		args = append([]string{"-C", dir}, args...)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Env = gitEnv()
	// Hooks can leave a background process holding the output pipes after git itself
	// exits. WaitDelay closes them, and the process group kill removes the hook's child.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.WaitDelay = 5 * time.Second
	fmt.Fprintf(out, "$ git %s\n", strings.Join(args, " "))
	cmd.Stdout, cmd.Stderr = out, out
	err := cmd.Run()
	if cmd.Process != nil {
		syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	}
	// ErrWaitDelay means git itself succeeded but a hook child held the output pipe;
	// the process-group kill above removed it, so this is not a failed command.
	if err != nil && !errors.Is(err, exec.ErrWaitDelay) {
		return fmt.Errorf("git %s: %w", strings.Join(args, " "), err)
	}
	return nil
}

// removeWorktree deletes a Task's Worktree directory; branches are never deleted.
func (r *Runner) removeWorktree(m *protocol.Incoming) {
	wt, err := within(r.cfg.Home, m.WorktreePath)
	if err != nil {
		log.Printf("worktree.remove: %v", err)
		return
	}
	if m.RepoPath != nil {
		if repo, err := within(r.cfg.Home, *m.RepoPath); err == nil {
			if err := runGit(io.Discard, repo, "worktree", "remove", "--force", wt); err != nil {
				log.Printf("worktree.remove: %v", err)
			}
		}
	}
	if err := os.RemoveAll(wt); err != nil {
		log.Printf("worktree.remove: %v", err)
	}
	if m.RepoPath != nil {
		if repo, err := within(r.cfg.Home, *m.RepoPath); err == nil {
			runGit(io.Discard, repo, "worktree", "prune")
		}
	}
}
