// Package credentials is the private Unix-socket contract between git's helper and the Runner.
package credentials

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type Request struct {
	Protocol string `json:"protocol"`
	Host     string `json:"host"`
	Path     string `json:"path"`
}
type Response struct {
	Username string `json:"username,omitempty"`
	Password string `json:"password,omitempty"`
	Error    string `json:"error,omitempty"`
}

func SocketPath(home string) string {
	if path := os.Getenv("CLAUDE_TASK_GIT_SOCKET"); path != "" {
		return path
	}
	return filepath.Join(home, ".git-credentials.sock")
}

// Valid rejects requests that can never match a Git Proxy URL, before contacting the Runner.
// git must send the path (`credential.useHttpPath=true`).
func Valid(req Request) error {
	invalid := fmt.Errorf("no active task for this repository")
	if (req.Protocol != "http" && req.Protocol != "https") || req.Host == "" || req.Path == "" {
		return invalid
	}
	for _, value := range []string{req.Host, req.Path} {
		if strings.ContainsFunc(value, func(c rune) bool { return c < 0x20 || c == 0x7f || c == '\\' }) {
			return invalid
		}
	}
	for _, part := range strings.Split(req.Path, "/") {
		if part == "." || part == ".." {
			return invalid
		}
	}
	return nil
}

// Matches reports whether a helper request is for exactly this clone URL
// (same scheme, host and port; same path, ignoring the leading slash and a trailing ".git").
func Matches(cloneURL string, req Request) bool {
	if Valid(req) != nil {
		return false
	}
	u, err := url.Parse(cloneURL)
	if err != nil || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Scheme != req.Protocol || !strings.EqualFold(u.Host, req.Host) {
		return false
	}
	trim := func(p string) string { return strings.TrimSuffix(strings.TrimPrefix(p, "/"), ".git") }
	return trim(u.Path) != "" && trim(u.Path) == trim(req.Path)
}

func Get(socket string, req Request) (Response, error) {
	conn, err := net.DialTimeout("unix", socket, 3*time.Second)
	if err != nil {
		return Response{}, fmt.Errorf("the task Runner is unavailable")
	}
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(40 * time.Second))
	if err := json.NewEncoder(conn).Encode(req); err != nil {
		return Response{}, fmt.Errorf("credential request failed")
	}
	var response Response
	if err := json.NewDecoder(io.LimitReader(conn, 20000)).Decode(&response); err != nil {
		return Response{}, fmt.Errorf("credential response failed")
	}
	if response.Error != "" {
		return Response{}, fmt.Errorf("%s", response.Error)
	}
	return response, nil
}
