package runner

import (
	"io"
	"os"
	"path/filepath"
	"strings"

	"claude-task/runner/internal/protocol"
)

const (
	maxProjectSkills = 200
	// skillHeadBytes is enough of a skill file for its frontmatter and first paragraph.
	skillHeadBytes = 8 << 10
)

// projectSkills reads the beginning of the Worktree's skills (.claude/skills/<name>/SKILL.md) and
// commands (.claude/commands/<name>.md), the ones claude loads from the project. Symlinks are
// followed while they stay inside the Worktree. Skills come first, so they win a shared name.
func projectSkills(wt string) []protocol.ProjectSkillFile {
	files := []protocol.ProjectSkillFile{}
	root, err := filepath.EvalSymlinks(wt)
	if err != nil {
		return files
	}
	add := func(name, path string) {
		if len(files) >= maxProjectSkills {
			return
		}
		real, err := filepath.EvalSymlinks(path)
		if err != nil {
			return
		}
		if rel, err := filepath.Rel(root, real); err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			return
		}
		f, err := os.Open(real)
		if err != nil {
			return
		}
		defer f.Close()
		if info, err := f.Stat(); err != nil || !info.Mode().IsRegular() {
			return
		}
		buf := make([]byte, skillHeadBytes)
		n, err := io.ReadFull(f, buf)
		if err != nil && err != io.EOF && err != io.ErrUnexpectedEOF {
			return
		}
		if n == len(buf) {
			n = completeUTF8(buf[:n])
		}
		files = append(files, protocol.ProjectSkillFile{Name: name, Head: string(buf[:n])})
	}
	skills := filepath.Join(wt, ".claude", "skills")
	if entries, err := os.ReadDir(skills); err == nil {
		for _, e := range entries {
			add(e.Name(), filepath.Join(skills, e.Name(), "SKILL.md"))
		}
	}
	commands := filepath.Join(wt, ".claude", "commands")
	if entries, err := os.ReadDir(commands); err == nil {
		for _, e := range entries {
			if name, ok := strings.CutSuffix(e.Name(), ".md"); ok && name != "" {
				add(name, filepath.Join(commands, e.Name()))
			}
		}
	}
	return files
}

// answerProjectSkills reads the Worktree named by a project_skills.request and sends the files
// back. It runs outside the Job stream, so the backend can fill a composer before the next Job.
func (r *Runner) answerProjectSkills(m *protocol.Incoming) {
	files := []protocol.ProjectSkillFile{}
	if wt, err := within(r.cfg.Home, m.WorktreePath); err == nil {
		files = projectSkills(wt)
	}
	r.sendNow(map[string]any{"type": "project_skills.result", "requestId": m.RequestID, "files": files})
}
