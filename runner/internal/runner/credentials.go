package runner

import (
	"claude-task/runner/internal/credentials"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"path/filepath"
	"time"
)

func (r *Runner) serveCredentials(ctx context.Context) error {
	path := credentials.SocketPath(r.cfg.Home)
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	if info, err := os.Lstat(path); err == nil {
		if info.Mode()&os.ModeSocket == 0 {
			return fmt.Errorf("credential socket path is not a socket")
		}
		if err := os.Remove(path); err != nil {
			return err
		}
	}
	listener, err := net.Listen("unix", path)
	if err != nil {
		return err
	}
	if err := os.Chmod(path, 0600); err != nil {
		listener.Close()
		return err
	}
	go func() { <-ctx.Done(); listener.Close() }()
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go func() {
				defer conn.Close()
				conn.SetDeadline(time.Now().Add(40 * time.Second))
				var request credentials.Request
				if json.NewDecoder(io.LimitReader(conn, 4096)).Decode(&request) != nil {
					return
				}
				response := r.credential(request)
				json.NewEncoder(conn).Encode(response)
			}()
		}
	}()
	return nil
}

// credential serves the current Job's token, only for that Job's Git Proxy URL.
func (r *Runner) credential(request credentials.Request) credentials.Response {
	denied := credentials.Response{Error: "no active task for this repository"}
	r.mu.Lock()
	defer r.mu.Unlock()
	j := r.current
	if j == nil || j.finished || j.start.Git == nil || j.start.Git.Token == "" {
		return denied
	}
	if !credentials.Matches(j.start.Git.CloneURL, request) {
		return denied
	}
	return credentials.Response{Username: "claude-task", Password: j.start.Git.Token}
}
func (r *Runner) startCredentialServer(ctx context.Context) bool {
	if err := r.serveCredentials(ctx); err != nil {
		log.Printf("credential socket: %v", err)
		return false
	}
	return true
}
