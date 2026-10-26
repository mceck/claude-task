package runner

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"claude-task/runner/internal/protocol"
)

const excludeEntry = ".claude-task/"

// prepareWorktree makes the Task's Worktree ready (Spec 03) and reports whether it was just created.
func (j *job) prepareWorktree() (string, bool, error) {
	j.r.worktreeMu.Lock()
	defer j.r.worktreeMu.Unlock()
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
		return wt, os.IsNotExist(statErr), nil
	}
	repo, err := within(home, g.RepoPath)
	if err != nil {
		return "", false, err
	}
	out := &chunkWriter{j: j}
	created, err := prepareGitWorktree(out, repo, wt, g)
	j.remoteBranchMissing = !refExists(repo, "refs/remotes/origin/"+g.TaskBranch)
	return wt, created, err
}

func prepareGitWorktree(out io.Writer, repo, wt string, g *protocol.GitSpec) (bool, error) {
	git := func(dir string, args ...string) error { return runGit(out, dir, args...) }

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
		if err := createWorktree(out, repo, wt, g); err != nil {
			return false, err
		}
		created = true
	}

	// 4. Commit identity, 5. attachments stay out of git.
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
		out, err := exec.Command("git", "-C", repo, "config", "--get", key).Output()
		return strings.TrimSpace(string(out)), err == nil
	}
	if g.RepositoryID != "" {
		recorded, ok := config("claude-task.repository")
		return ok && recorded != g.RepositoryID
	}
	old, ok := config("remote.origin.url")
	return ok && old != g.CloneURL
}

func createWorktree(out io.Writer, repo, wt string, g *protocol.GitSpec) error {
	git := func(dir string, args ...string) error { return runGit(out, dir, args...) }
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
	// An absent worktree is recreated from the remote, including when a stale local branch remains.
	if err := git(repo, "worktree", "add", "--no-track", "-B", b, wt, base); err != nil {
		return err
	}
	// 3. Upstream = origin/<task branch>, set by config so it works before the remote branch exists.
	if err := git(repo, "config", "branch."+b+".remote", "origin"); err != nil {
		return err
	}
	return git(repo, "config", "branch."+b+".merge", "refs/heads/"+b)
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
	return append(os.Environ(), "GIT_TERMINAL_PROMPT=0", "LC_ALL=C")
}

func runGit(out io.Writer, dir string, args ...string) error {
	if dir != "" {
		args = append([]string{"-C", dir}, args...)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Env = gitEnv()
	fmt.Fprintf(out, "$ git %s\n", strings.Join(args, " "))
	cmd.Stdout, cmd.Stderr = out, out
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("git %s: %w", strings.Join(args, " "), err)
	}
	return nil
}

// removeWorktree deletes a Task's Worktree directory; branches are never deleted.
func (r *Runner) removeWorktree(m *protocol.Incoming) {
	r.worktreeMu.Lock()
	defer r.worktreeMu.Unlock()
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
