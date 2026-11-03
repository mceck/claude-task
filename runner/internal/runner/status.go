package runner

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"time"

	"claude-task/runner/internal/protocol"
)

const (
	// maxWorktreeFiles caps what one answer carries; total still counts the rest.
	maxWorktreeFiles = 1000
	// maxStatusBytes caps the git output the Runner keeps in memory.
	maxStatusBytes = 256 << 10
	statusTimeout  = 10 * time.Second
)

// answerWorktreeStatus reads the Worktree named by a worktree.status.request and sends its
// uncommitted changes back. It runs outside the Job stream, so a Task view can show them
// without starting a Job (docs/specs/git-integration.md).
func (r *Runner) answerWorktreeStatus(m *protocol.Incoming) {
	files := []protocol.WorktreeFile{}
	total, truncated := 0, false
	errorKind := ""

	wt, err := within(r.cfg.Home, m.WorktreePath)
	if err != nil {
		errorKind = "not-found"
	} else if _, statErr := os.Stat(wt); statErr != nil {
		errorKind = "not-found"
	} else if !validWorktree(wt) {
		// A Project without a Repository gets a plain directory here.
		errorKind = "not-a-worktree"
	} else if files, total, truncated, err = readWorktreeStatus(wt); err != nil {
		files, total, truncated, errorKind = []protocol.WorktreeFile{}, 0, false, "failed"
	}

	answer := map[string]any{
		"type":      "worktree.status.result",
		"requestId": m.RequestID,
		"files":     files,
		"total":     total,
		"truncated": truncated,
	}
	if errorKind != "" {
		answer["error"] = errorKind
	}
	r.sendNow(answer)
}

// readWorktreeStatus runs `git status` with optional locks off, so a read never waits on or
// interferes with a Job working in the same Worktree.
func readWorktreeStatus(wt string) ([]protocol.WorktreeFile, int, bool, error) {
	ctx, cancel := context.WithTimeout(context.Background(), statusTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", "-C", wt, "status", "--porcelain=v2", "-z", "--untracked-files=normal")
	cmd.Env = append(gitEnv(), "GIT_OPTIONAL_LOCKS=0")
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	out := &limitedBuffer{limit: maxStatusBytes}
	cmd.Stdout = out
	cmd.Stderr = &bytes.Buffer{}
	err := cmd.Run()
	if cmd.Process != nil {
		syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	}
	if err != nil {
		return nil, 0, false, err
	}
	files, total := parseWorktreeStatus(out.Bytes())
	return files, total, out.truncated || total > len(files), nil
}

// parseWorktreeStatus reads porcelain v2 records separated by NUL bytes. Paths may contain
// spaces, so only the last field of each record is the path.
func parseWorktreeStatus(data []byte) ([]protocol.WorktreeFile, int) {
	files := []protocol.WorktreeFile{}
	total := 0
	tokens := bytes.Split(data, []byte{0})
	for i := 0; i < len(tokens); i++ {
		line := string(tokens[i])
		if line == "" || line[0] == '#' || line[0] == '!' {
			continue
		}
		var path, status string
		switch line[0] {
		case '?':
			path, status = strings.TrimPrefix(line, "? "), "untracked"
		case '1':
			fields := strings.SplitN(line, " ", 9)
			if len(fields) < 9 {
				continue
			}
			path, status = fields[8], statusXY(fields[1])
		case '2':
			fields := strings.SplitN(line, " ", 10)
			if len(fields) < 10 {
				continue
			}
			// The original path is the next NUL-separated token.
			if i+1 < len(tokens) {
				i++
			}
			path, status = fields[9], "renamed"
			if strings.HasPrefix(fields[1], "C") {
				status = "copied"
			}
		case 'u':
			fields := strings.SplitN(line, " ", 11)
			if len(fields) < 11 {
				continue
			}
			path, status = fields[10], "conflicted"
		default:
			continue
		}
		total++
		if len(files) < maxWorktreeFiles {
			files = append(files, protocol.WorktreeFile{Path: path, Status: status})
		}
	}
	return files, total
}

// statusXY turns porcelain v2's two index/worktree columns into one status for the UI.
func statusXY(xy string) string {
	if len(xy) != 2 {
		return "modified"
	}
	x, y := xy[0], xy[1]
	switch {
	case x == 'D' || y == 'D':
		return "deleted"
	case x == 'A':
		return "added"
	case x == 'T' || y == 'T':
		return "type-changed"
	default:
		return "modified"
	}
}

// limitedBuffer keeps at most limit bytes and notes that it dropped the rest.
type limitedBuffer struct {
	buf       bytes.Buffer
	limit     int
	truncated bool
}

func (b *limitedBuffer) Write(p []byte) (int, error) {
	remaining := b.limit - b.buf.Len()
	if remaining <= 0 {
		b.truncated = true
		return len(p), nil
	}
	if len(p) > remaining {
		b.buf.Write(p[:remaining])
		b.truncated = true
		return len(p), nil
	}
	b.buf.Write(p)
	return len(p), nil
}

func (b *limitedBuffer) Bytes() []byte { return b.buf.Bytes() }
