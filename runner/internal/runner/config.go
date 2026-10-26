package runner

import (
	"errors"
	"os"
	"slices"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	BackendURL        string
	Token             string
	ClaudePath        string
	Home              string
	CancelTerm        time.Duration
	CancelKill        time.Duration
	OutboxMemoryBytes int
	Version           string
}

func ConfigFromEnv(version string) (Config, error) {
	c := Config{
		BackendURL:        os.Getenv("CLAUDE_TASK_BACKEND_URL"),
		Token:             os.Getenv("CLAUDE_TASK_RUNNER_TOKEN"),
		ClaudePath:        envOr("CLAUDE_TASK_CLAUDE_PATH", "claude"),
		Home:              os.Getenv("CLAUDE_TASK_HOME"),
		CancelTerm:        time.Duration(envInt("CLAUDE_TASK_CANCEL_TERM_MS", 10_000)) * time.Millisecond,
		CancelKill:        time.Duration(envInt("CLAUDE_TASK_CANCEL_KILL_MS", 20_000)) * time.Millisecond,
		OutboxMemoryBytes: envInt("CLAUDE_TASK_OUTBOX_MEMORY_BYTES", 50<<20),
		Version:           version,
	}
	if c.Home == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return c, err
		}
		c.Home = home
	}
	if c.BackendURL == "" || c.Token == "" {
		return c, errors.New("CLAUDE_TASK_BACKEND_URL and CLAUDE_TASK_RUNNER_TOKEN are required")
	}
	return c, nil
}

func envOr(name, fallback string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return fallback
}

func envInt(name string, fallback int) int {
	if v, err := strconv.Atoi(os.Getenv(name)); err == nil && v >= 0 {
		return v
	}
	return fallback
}

// childEnv is the Runner's environment for the processes it starts, minus the Runner token:
// the token outlives the Job, while claude, its tools, the setup script and git hooks run Agent
// code, and their output reaches the Timeline.
func childEnv() []string {
	return slices.DeleteFunc(os.Environ(), func(kv string) bool { return strings.HasPrefix(kv, "CLAUDE_TASK_RUNNER_TOKEN=") })
}
