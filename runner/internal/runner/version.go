package runner

import (
	"context"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// probeLimit bounds the version probe of a Job: a hanging `claude --version` delays its start by
// at most this, and then the Job runs without the flag.
const probeLimit = 10 * time.Second

var versionPattern = regexp.MustCompile(`(\d+)\.(\d+)\.(\d+)`)

// supportsForwardSubagentText asks the exact `claude` this Job will start for its version, in the
// Worktree so a repository's mise configuration counts. A failed or slow probe says no: the Run
// still shows its tool calls, only its text is missing.
func supportsForwardSubagentText(path, dir string, env []string, cancelled <-chan struct{}) bool {
	out, ok := runVersionProbe(path, dir, env, cancelled)
	return ok && versionAtLeast(out, 2, 1, 211)
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
