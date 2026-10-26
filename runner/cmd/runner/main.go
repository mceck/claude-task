// Command runner is the entrypoint of an Agent Container: it connects to the backend and runs Jobs.
package main

import (
	"context"
	"log"
	"os"
	"os/signal"
	"syscall"

	"claude-task/runner/internal/runner"
)

var version = "dev"

func main() {
	log.SetFlags(log.LstdFlags | log.Lmsgprefix)
	log.SetPrefix("runner: ")
	cfg, err := runner.ConfigFromEnv(version)
	if err != nil {
		log.Fatal(err)
	}
	// Nothing the Runner starts (claude, setup, mise, git and its hooks) may see its credentials.
	os.Unsetenv("CLAUDE_TASK_RUNNER_TOKEN")
	os.Unsetenv("CLAUDE_TASK_BACKEND_URL")
	hideMemory()
	r := runner.New(cfg)
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()
	log.Printf("version %s, home %s", version, cfg.Home)
	go r.Run(ctx)
	<-ctx.Done()
	r.Shutdown()
	os.Exit(0)
}
