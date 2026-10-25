package runner

import (
	"claude-task/runner/internal/credentials"
	"claude-task/runner/internal/protocol"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type gitToken struct {
	value   string
	expires time.Time
}

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
				response := r.credential(ctx, request)
				json.NewEncoder(conn).Encode(response)
			}()
		}
	}()
	return nil
}
func (r *Runner) credential(ctx context.Context, request credentials.Request) credentials.Response {
	denied := func(message string) credentials.Response { return credentials.Response{Error: message} }
	repository, err := credentials.Repository(request)
	if err != nil {
		return denied("no active task for this repository")
	}
	// Serialize cache refreshes, without blocking the WebSocket reader that delivers the reply.
	r.tokenMu.Lock()
	defer r.tokenMu.Unlock()
	r.mu.Lock()
	j := r.current
	if j == nil || j.finished || j.start.Git == nil {
		r.mu.Unlock()
		return denied("no active task for this repository")
	}
	remote, err := url.Parse(j.start.Git.CloneURL)
	expected := ""
	if err == nil {
		expected = strings.ToLower(strings.TrimSuffix(strings.TrimPrefix(remote.Path, "/"), ".git"))
	}
	if err != nil || remote.Scheme != "https" || !strings.EqualFold(remote.Host, "github.com") || expected != repository {
		r.mu.Unlock()
		return denied("no active task for this repository")
	}
	if j.gitToken != nil && j.gitToken.expires.After(time.Now().Add(5*time.Minute)) {
		value := j.gitToken.value
		r.mu.Unlock()
		return credentials.Response{Username: "x-access-token", Password: value}
	}
	if r.conn == nil {
		r.mu.Unlock()
		return denied("backend disconnected; cannot obtain Git credentials")
	}
	r.tokenSeq++
	id := fmt.Sprintf("git-%d", r.tokenSeq)
	reply := make(chan *protocol.Incoming, 1)
	r.tokenWaiters[id] = reply
	r.mu.Unlock()
	defer func() { r.mu.Lock(); delete(r.tokenWaiters, id); r.mu.Unlock() }()
	r.sendNow(map[string]string{"type": "git.token_request", "requestId": id, "jobId": j.id, "repository": repository})
	select {
	case <-ctx.Done():
		return denied("Runner is shutting down")
	case <-time.After(35 * time.Second):
		return denied("Git credential request timed out; try again")
	case message := <-reply:
		r.mu.Lock()
		defer r.mu.Unlock()
		if r.current != j || j.finished || message.JobID != j.id {
			return denied("no active task for this repository")
		}
		expiry, err := time.Parse(time.RFC3339, message.ExpiresAt)
		if message.Error != "" || message.Token == "" || err != nil || !expiry.After(time.Now()) {
			return denied("Git credentials were refused; check the active task and GitHub App configuration")
		}
		j.gitToken = &gitToken{value: message.Token, expires: expiry}
		return credentials.Response{Username: "x-access-token", Password: message.Token}
	}
}
func (r *Runner) receiveGitToken(m *protocol.Incoming) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if waiter := r.tokenWaiters[m.RequestID]; waiter != nil {
		select {
		case waiter <- m:
		default:
		}
	}
}
func (r *Runner) startCredentialServer(ctx context.Context) bool {
	if err := r.serveCredentials(ctx); err != nil {
		log.Printf("credential socket: %v", err)
		return false
	}
	return true
}
