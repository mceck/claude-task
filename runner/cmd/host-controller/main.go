package main

import (
	"context"
	"log"
	"os"
	"os/signal"
	"syscall"

	"claude-task/runner/internal/hostcontroller"
)

var version = "dev"

func main() {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	cfg, err := hostcontroller.FromEnv(version)
	if err != nil {
		log.Printf("Host Controller configuration: %v", err)
		<-ctx.Done()
		return
	}
	hostcontroller.Run(ctx, cfg)
}
