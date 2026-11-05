package test

import (
	"encoding/json"
	"path/filepath"
	"slices"
	"strings"
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

// Delivery reads come from the CLI echoing each user message, with the uuid it was written with,
// when it reads it. The Runner asks for the echo when the `claude` it starts has it.
func TestReplayUserMessagesEchoesEachMessageWithItsUuid(t *testing.T) {
	cases := []struct {
		version string
		want    bool
	}{
		{"2.1.310", true},
		{"2.0.0", true},
		{"1.0.99", false},
		{"fail", false},
	}
	for _, c := range cases {
		t.Run(c.version, func(t *testing.T) {
			b := newBackend(t)
			startRunner(t, b)
			rec := filepath.Join(t.TempDir(), "rec.json")
			b.send(jobStart(jobOpts{
				id: "j1", text: "hello", replayUserMessages: true, messageID: "11111111-1111-4111-8111-111111111111",
				env: map[string]string{"FAKE_CLAUDE_RECORD": rec, "FAKE_CLAUDE_VERSION": c.version},
			}))
			b.waitEvent("j1", "result", isResult)
			in := input("j1", "and this")
			in["messageId"] = "22222222-2222-4222-8222-222222222222"
			b.send(in)
			b.waitEvent("j1", "second result", func(e msg) bool { return isResult(e) && strings.Contains(e.str("result"), "and this") })
			b.send(msg{"type": "job.end", "jobId": "j1"})
			b.waitType("j1", "job.exited")

			r := readRecord(t, rec)
			if got := slices.Contains(r.Args, "--replay-user-messages"); got != c.want {
				t.Fatalf("flag present = %v, want %v: %q", got, c.want, r.Args)
			}
			// The uuid goes with every message whatever the version: an older CLI ignores it.
			for i, id := range []string{"11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"} {
				var line struct {
					UUID string `json:"uuid"`
				}
				if err := json.Unmarshal([]byte(r.Stdin[i]), &line); err != nil || line.UUID != id {
					t.Fatalf("stdin line %d: uuid %q, want %q (%s)", i, line.UUID, id, r.Stdin[i])
				}
			}
			var replays []string
			for _, m := range b.jobMessages("j1") {
				if e := m.event(); m.str("type") == "job.event" && e.str("type") == "user" && e["isReplay"] == true {
					replays = append(replays, e.str("uuid"))
				}
			}
			if c.want && !slices.Equal(replays, []string{"11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"}) {
				t.Fatalf("replays %q", replays)
			}
		})
	}
}
