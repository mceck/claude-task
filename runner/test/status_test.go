package test

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

func TestReadsAWorktreesUncommittedChanges(t *testing.T) {
	b := newBackend(t)
	home := startRunner(t, b)
	wt := filepath.Join(home, "worktrees/proj/T-1")
	if err := os.MkdirAll(wt, 0o755); err != nil {
		t.Fatal(err)
	}
	gitIn(t, home, wt, "init", "-q")
	writeFile(t, filepath.Join(wt, "keep.go"), "package main\n")
	writeFile(t, filepath.Join(wt, "gone.txt"), "bye\n")
	writeFile(t, filepath.Join(wt, "old.txt"), "old\n")
	gitIn(t, home, wt, "add", ".")
	gitIn(t, home, wt, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-q", "-m", "initial")

	writeFile(t, filepath.Join(wt, "keep.go"), "package main // changed\n")
	if err := os.Remove(filepath.Join(wt, "gone.txt")); err != nil {
		t.Fatal(err)
	}
	gitIn(t, home, wt, "mv", "old.txt", "moved.txt")
	writeFile(t, filepath.Join(wt, "new.ts"), "export {}\n")

	b.send(msg{"type": "worktree.status.request", "requestId": "r1", "worktreePath": "worktrees/proj/T-1"})
	answer := b.waitFor("worktree.status.result", func(m msg) bool { return m.str("requestId") == "r1" })
	if answer["error"] != nil {
		t.Fatalf("error %v", answer["error"])
	}
	if got := answer.num("total"); got != 4 {
		t.Fatalf("total %d, want 4 (answer %v)", got, answer)
	}
	if answer["truncated"] != false {
		t.Fatalf("truncated %v", answer["truncated"])
	}
	files, _ := answer["files"].([]any)
	got := map[string]string{}
	for _, f := range files {
		m := msg(f.(map[string]any))
		got[m.str("path")] = m.str("status")
	}
	want := map[string]string{
		"keep.go":   "modified",
		"gone.txt":  "deleted",
		"moved.txt": "renamed",
		"new.ts":    "untracked",
	}
	for path, status := range want {
		if got[path] != status {
			t.Fatalf("%s is %q, want %q (files %v)", path, got[path], status, got)
		}
	}
}

func TestCapsAndTruncatesManyChanges(t *testing.T) {
	const cap = 1000 // the Runner's maxWorktreeFiles
	b := newBackend(t)
	home := startRunner(t, b)
	wt := filepath.Join(home, "worktrees/proj/T-1")
	if err := os.MkdirAll(wt, 0o755); err != nil {
		t.Fatal(err)
	}
	gitIn(t, home, wt, "init", "-q")
	for i := 0; i < cap+5; i++ {
		writeFile(t, filepath.Join(wt, fmt.Sprintf("file-%04d.txt", i)), "x\n")
	}

	b.send(msg{"type": "worktree.status.request", "requestId": "r1", "worktreePath": "worktrees/proj/T-1"})
	answer := b.waitFor("worktree.status.result", func(m msg) bool { return m.str("requestId") == "r1" })
	files, _ := answer["files"].([]any)
	if len(files) != cap {
		t.Fatalf("%d files, want %d", len(files), cap)
	}
	if answer.num("total") != cap+5 || answer["truncated"] != true {
		t.Fatalf("total %v truncated %v", answer["total"], answer["truncated"])
	}
}

func TestRefusesPathsOutsideTheHomeAndPlainDirectories(t *testing.T) {
	b := newBackend(t)
	home := startRunner(t, b)
	if err := os.MkdirAll(filepath.Join(home, "worktrees/proj/plain"), 0o755); err != nil {
		t.Fatal(err)
	}
	for requestID, path := range map[string]string{
		"r1": "../../etc",
		"r2": "worktrees/proj/missing",
		"r3": "worktrees/proj/plain",
	} {
		b.send(msg{"type": "worktree.status.request", "requestId": requestID, "worktreePath": path})
		answer := b.waitFor(requestID, func(m msg) bool { return m.str("type") == "worktree.status.result" && m.str("requestId") == requestID })
		want := "not-found"
		if requestID == "r3" {
			want = "not-a-worktree"
		}
		if answer.str("error") != want {
			t.Fatalf("%s: error %q, want %q", path, answer.str("error"), want)
		}
	}
}
