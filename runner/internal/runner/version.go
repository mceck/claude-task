package runner

import (
	"context"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"time"

	"claude-task/runner/internal/protocol"
)

// probeLimit bounds the version probe of a Job: a hanging `claude --version` delays its start by
// at most this, and then the Job runs without the flag.
const probeLimit = 10 * time.Second

var versionPattern = regexp.MustCompile(`(\d+)\.(\d+)\.(\d+)`)

// features are the optional CLI flags a Job runs with.
type features struct {
	forwardSubagentText bool
	replayUserMessages  bool
}

// probeFeatures asks the exact `claude` this Job will start for its version, in the Worktree so a
// repository's mise configuration counts, when the Job asked for a flag that depends on it. A
// failed or slow probe says no to both: the Run still shows its tool calls, only its text is
// missing, and Deliveries fall back to reading the end of each Turn.
func probeFeatures(path, dir string, env []string, cancelled <-chan struct{}, want protocol.ClaudeArgs) features {
	if !want.ForwardSubagentText && !want.ReplayUserMessages {
		return features{}
	}
	out, ok := runVersionProbe(path, dir, env, cancelled)
	if !ok {
		return features{}
	}
	return features{
		forwardSubagentText: want.ForwardSubagentText && versionAtLeast(out, 2, 1, 211),
		replayUserMessages:  want.ReplayUserMessages && versionAtLeast(out, 2, 0, 0),
	}
}

func runVersionProbe(path, dir string, env []string, cancelled <-chan struct{}) (string, bool) {
	ctx, cancel := context.WithTimeout(context.Background(), probeLimit)
	defer cancel()
	if cancelled != nil {
		go func() {
			select {
			case <-cancelled:
				cancel()
			case <-ctx.Done():
			}
		}()
	}
	cmd := exec.CommandContext(ctx, path, "--version")
	cmd.Dir = dir
	cmd.Env = env
	out, err := cmd.Output()
	if err != nil {
		return "", false
	}
	if f := strings.Fields(string(out)); len(f) > 0 {
		return f[0], true
	}
	return "", false
}

// versionAtLeast compares a `X.Y.Z` string with the wanted version; anything else is never enough.
func versionAtLeast(version string, want ...int) bool {
	m := versionPattern.FindStringSubmatch(version)
	if m == nil {
		return false
	}
	for i, w := range want {
		got, err := strconv.Atoi(m[i+1])
		if err != nil {
			return false
		}
		if got != w {
			return got > w
		}
	}
	return true
}
