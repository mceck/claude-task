package test

import (
	"os"
	"path/filepath"
	"testing"
)

const (
	keptProject  = "11111111-1111-4111-8111-111111111111"
	goneProject  = "22222222-2222-4222-8222-222222222222"
	busyProject  = "33333333-3333-4333-8333-333333333333"
	keptAgent    = "44444444-4444-4444-8444-444444444444"
	goneAgent    = "55555555-5555-4555-8555-555555555555"
	busyAgent    = "66666666-6666-4666-8666-666666666666"
	cleanupID    = "77777777-7777-4777-8777-777777777777"
	fileContents = "0123456789"
)

func exists(path string) bool {
	_, err := os.Lstat(path)
	return err == nil
}

func TestVolumeCleanupRemovesWhatNoProjectOrAgentUses(t *testing.T) {
	b := newBackend(t)
	home := startRunner(t, b)
	for _, p := range []string{keptProject, goneProject, busyProject} {
		writeFile(t, filepath.Join(home, "repos", p+".git", "HEAD"), fileContents)
		writeFile(t, filepath.Join(home, "repos", p+".git.lock"), fileContents)
		writeFile(t, filepath.Join(home, "worktrees", p, "T-1", "file.txt"), fileContents)
	}
	for _, a := range []string{keptAgent, goneAgent, busyAgent} {
		writeFile(t, filepath.Join(home, ".claude-agents", a, "settings.json"), fileContents)
	}
	// The shared session data that profiles link to, and entries the platform does not name.
	writeFile(t, filepath.Join(home, ".claude-shared", "projects", "transcript.jsonl"), fileContents)
	if err := os.Symlink(filepath.Join(home, ".claude-shared", "projects"), filepath.Join(home, ".claude-agents", goneAgent, "projects")); err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(home, "repos", "not-a-project.git", "HEAD"), fileContents)
	writeFile(t, filepath.Join(home, "worktrees", "scratch", "notes.txt"), fileContents)
	writeFile(t, filepath.Join(home, ".claude-agents", "manual", "settings.json"), fileContents)

	// A Job of this Runner works in the busy Project, with the busy Agent's profile.
	b.send(jobStart(jobOpts{id: "j1", worktree: "worktrees/" + busyProject + "/T-1", profile: ".claude-agents/" + busyAgent, text: "STUCK", env: map[string]string{"FAKE_CLAUDE_IGNORE_TERM": "1"}}))
	b.waitEvent("j1", "first text", isAssistantText("Working on: STUCK"))

	b.send(msg{"type": "volume.cleanup", "requestId": cleanupID, "keepProjects": []string{keptProject}, "keepAgents": []string{keptAgent}})
	result := b.waitFor("volume.cleanup.result", func(m msg) bool { return m.str("type") == "volume.cleanup.result" })

	if result.str("requestId") != cleanupID || result.num("projects") != 1 || result.num("agentProfiles") != 1 || result["error"] != nil {
		t.Fatalf("result %v", result)
	}
	// The gone Project's HEAD and worktree file, and the gone Agent's settings (the link is not followed).
	if got := result.num("reclaimedBytes"); got != 3*int64(len(fileContents)) {
		t.Fatalf("reclaimed %d bytes", got)
	}
	for _, gone := range []string{"repos/" + goneProject + ".git", "worktrees/" + goneProject, ".claude-agents/" + goneAgent} {
		if exists(filepath.Join(home, gone)) {
			t.Errorf("%s was kept", gone)
		}
	}
	for _, kept := range []string{
		"repos/" + keptProject + ".git/HEAD", "worktrees/" + keptProject + "/T-1/file.txt", ".claude-agents/" + keptAgent,
		"repos/" + busyProject + ".git/HEAD", "worktrees/" + busyProject + "/T-1/file.txt", ".claude-agents/" + busyAgent,
		"repos/" + goneProject + ".git.lock", ".claude-shared/projects/transcript.jsonl", "repos/not-a-project.git/HEAD", "worktrees/scratch/notes.txt", ".claude-agents/manual",
	} {
		if !exists(filepath.Join(home, kept)) {
			t.Errorf("%s was removed", kept)
		}
	}
	b.send(msg{"type": "job.cancel", "jobId": "j1"})
	b.waitType("j1", "job.exited")
}
