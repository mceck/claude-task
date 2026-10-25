// Package credentials is the private Unix-socket contract between git's helper and the Runner.
package credentials

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
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
func Repository(req Request) (string, error) {
	if req.Protocol != "https" || !strings.EqualFold(req.Host, "github.com") {
		return "", fmt.Errorf("no active task for this repository")
	}
	path := strings.TrimSuffix(strings.TrimPrefix(req.Path, "/"), ".git")
	parts := strings.Split(path, "/")
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return "", fmt.Errorf("no active task for this repository")
	}
	for _, part := range parts {
		if part == "." || part == ".." || strings.ContainsAny(part, "\\\r\n\t %:@?#") {
			return "", fmt.Errorf("no active task for this repository")
		}
	}
	return strings.ToLower(path), nil
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
