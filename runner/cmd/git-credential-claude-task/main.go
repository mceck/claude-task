package main

import (
	"bufio"
	"claude-task/runner/internal/credentials"
	"fmt"
	"os"
	"strings"
)

func main() {
	// store/erase are deliberate no-ops: tokens must never be persisted by git.
	if len(os.Args) < 2 || os.Args[1] != "get" {
		return
	}
	values := map[string]string{}
	scanner := bufio.NewScanner(os.Stdin)
	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			break
		}
		key, value, ok := strings.Cut(line, "=")
		if ok {
			values[key] = value
		}
	}
	req := credentials.Request{Protocol: values["protocol"], Host: values["host"], Path: values["path"]}
	if _, err := credentials.Repository(req); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	home := os.Getenv("CLAUDE_TASK_HOME")
	if home == "" {
		home, _ = os.UserHomeDir()
	}
	response, err := credentials.Get(credentials.SocketPath(home), req)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	fmt.Printf("username=%s\npassword=%s\n\n", response.Username, response.Password)
}
