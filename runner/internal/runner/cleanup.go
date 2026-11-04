package runner

import (
	"errors"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"claude-task/runner/internal/protocol"
)

// Only directories the platform names after a Project or Agent id are ever cleaned.
var uuidName = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// cleanVolume removes the Bare Clones and Worktrees of the Projects and the Agent Profiles of the
// Agents a volume.cleanup does not keep, and answers with what it removed
// (docs/specs/runner.md, "Cleaning the Worker Volume").
func (r *Runner) cleanVolume(m *protocol.Incoming) {
	keepProjects := setOf(m.KeepProjects)
	keepAgents := setOf(m.KeepAgents)
	// What this Runner's own unfinished Jobs use stays, whatever the backend asked.
	r.mu.Lock()
	for _, j := range r.jobs {
		if j.finished {
			continue
		}
		if parts := strings.Split(j.start.WorktreePath, "/"); len(parts) > 1 && parts[0] == "worktrees" {
			keepProjects[parts[1]] = true
		}
		keepAgents[filepath.Base(j.start.AgentProfilePath)] = true
	}
	r.mu.Unlock()

	var problems []string
	var bytes int64
	fail := func(err error) { problems = append(problems, err.Error()) }
	projects := map[string]bool{}

	for _, id := range staleEntries(filepath.Join(r.cfg.Home, "repos"), ".git", keepProjects) {
		repo := filepath.Join(r.cfg.Home, "repos", id+".git")
		unlock, err := lockRepo(repo)
		if err != nil {
			fail(err)
			continue
		}
		bytes += sizeOf(repo)
		err = os.RemoveAll(repo)
		if err == nil {
			projects[id] = true
			err = os.Remove(repo + ".lock")
			if errors.Is(err, fs.ErrNotExist) {
				err = nil
			}
		}
		unlock()
		if err != nil {
			fail(err)
		}
	}
	for _, id := range staleEntries(filepath.Join(r.cfg.Home, "worktrees"), "", keepProjects) {
		dir := filepath.Join(r.cfg.Home, "worktrees", id)
		bytes += sizeOf(dir)
		if err := os.RemoveAll(dir); err != nil {
			fail(err)
			continue
		}
		projects[id] = true
	}
	profiles := 0
	for _, id := range staleEntries(filepath.Join(r.cfg.Home, ".claude-agents"), "", keepAgents) {
		dir := filepath.Join(r.cfg.Home, ".claude-agents", id)
		bytes += sizeOf(dir)
		if err := os.RemoveAll(dir); err != nil {
			fail(err)
			continue
		}
		profiles++
	}

	answer := map[string]any{
		"type":           "volume.cleanup.result",
		"requestId":      m.RequestID,
		"bareClones":     len(projects),
		"agentProfiles":  profiles,
		"reclaimedBytes": bytes,
		"error":          nil,
	}
	if len(problems) > 0 {
		msg := strings.Join(problems, "; ")
		if len(msg) > 1000 {
			msg = msg[:1000]
		}
		log.Printf("volume.cleanup: %s", msg)
		answer["error"] = msg
	}
	r.sendNow(answer)
}

func setOf(ids []string) map[string]bool {
	set := make(map[string]bool, len(ids))
	for _, id := range ids {
		set[strings.ToLower(id)] = true
	}
	return set
}

// staleEntries lists the ids of `dir`'s directories named `<uuid><suffix>` that `keep` lacks.
func staleEntries(dir, suffix string, keep map[string]bool) []string {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var ids []string
	for _, e := range entries {
		id, ok := strings.CutSuffix(e.Name(), suffix)
		if !ok || !e.IsDir() || !uuidName.MatchString(id) || keep[id] {
			continue
		}
		ids = append(ids, id)
	}
	return ids
}

// sizeOf adds up the sizes of the files under dir, without following symbolic links.
func sizeOf(dir string) int64 {
	var total int64
	filepath.WalkDir(dir, func(_ string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.Type().IsRegular() {
			if info, err := d.Info(); err == nil {
				total += info.Size()
			}
		}
		return nil
	})
	return total
}

