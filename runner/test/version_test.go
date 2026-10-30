package test

import (
	"path/filepath"
	"slices"
	"testing"
)

// A Run's own text only reaches the browser on a CLI that forwards it: the Runner asks the
// `claude` it is about to start, and runs the Job without the flag whenever the probe fails.
func TestForwardSubagentTextFollowsTheClaudeVersion(t *testing.T) {
	cases := []struct {
		version string
		want    bool
	}{
		{"2.1.211", true},
		{"2.1.300", true},
		{"3.0.0", true},
		{"2.1.210", false},
		{"2.0.99", false},
		{"fail", false},
	}
	for _, c := range cases {
		t.Run(c.version, func(t *testing.T) {
			b := newBackend(t)
			startRunner(t, b)
			rec := filepath.Join(t.TempDir(), "rec.json")
			b.send(jobStart(jobOpts{
				id: "j1", text: "hello", forwardSubagentText: true,
				env: map[string]string{"FAKE_CLAUDE_RECORD": rec, "FAKE_CLAUDE_VERSION": c.version},
			}))
			b.waitEvent("j1", "result", isResult)
			b.send(msg{"type": "job.end", "jobId": "j1"})
			if exit := b.waitType("j1", "job.exited"); exit.num("exitCode") != 0 {
				t.Fatalf("a probe that answers %q must still run the Job: %v", c.version, exit)
			}
			if got := slices.Contains(readRecord(t, rec).Args, "--forward-subagent-text"); got != c.want {
				t.Fatalf("flag present = %v, want %v: %q", got, c.want, readRecord(t, rec).Args)
			}
		})
	}
}
