package test

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func TestHostControllerTunnel(t *testing.T) {
	socketPath := filepath.Join(t.TempDir(), "docker.sock")
	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go func() {
				defer conn.Close()
				if _, err := io.Copy(conn, conn); err != nil {
					return
				}
			}()
		}
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	connected := make(chan *websocket.Conn, 2)
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/host-controller" || r.Header.Get("Authorization") != "Bearer host-secret" {
			w.WriteHeader(401)
			return
		}
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		connected <- c

	}))
	defer backend.Close()
	cmd := exec.CommandContext(ctx, controllerBin)
	cmd.Env = append(os.Environ(), "CLAUDE_TASK_URL="+backend.URL, "CLAUDE_TASK_HOST_TOKEN=host-secret", "CLAUDE_TASK_ALLOW_INSECURE=true", "DOCKER_SOCKET="+socketPath)
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { cmd.Process.Kill(); cmd.Wait() }()
	var c *websocket.Conn
	select {
	case c = <-connected:
	case <-ctx.Done():
		t.Fatal("Controller did not connect")
	}
	_, data, err := c.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var hello map[string]any
	if err := json.Unmarshal(data, &hello); err != nil {
		t.Fatal(err)
	}
	if hello["protocolVersion"] != float64(1) || hello["backendUrl"] != backend.URL || hello["type"] != "hello" {
		t.Fatalf("hello: %s", data)
	}
	send := func(op byte, payload string) {
		t.Helper()
		frame := make([]byte, 5+len(payload))
		frame[0] = op
		binary.BigEndian.PutUint32(frame[1:], 7)
		copy(frame[5:], payload)
		if err := c.Write(ctx, websocket.MessageBinary, frame); err != nil {
			t.Fatal(err)
		}
	}
	send(1, "")
	send(2, "GET /version HTTP/1.1\r\n\r\n")
	_, data, err = c.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if data[0] != 2 || string(data[5:]) != "GET /version HTTP/1.1\r\n\r\n" {
		t.Fatalf("round trip: %q", data)
	}
	send(3, "")
	_, data, err = c.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if data[0] != 3 && data[0] != 4 {
		t.Fatalf("end: %v", data)
	}
	c.CloseNow()
	select {
	case c = <-connected:
	case <-ctx.Done():
		t.Fatal("Controller did not reconnect")
	}
	if err := c.Close(4004, "host deleted"); err != nil {
		t.Log(err)
	}
	select {
	case <-connected:
		t.Fatal("deleted Controller reconnected")
	case <-time.After(1500 * time.Millisecond):
	}
}

func TestHostControllerRefused(t *testing.T) {
	for _, tc := range []struct {
		name     string
		insecure bool
		status   int
		attempts int64
		message  string
	}{
		{"http without opt in", false, 200, 0, "http requires"},
		{"unknown token", true, 401, 1, "stopped reconnecting"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var attempts atomic.Int64
			backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { attempts.Add(1); w.WriteHeader(tc.status) }))
			defer backend.Close()
			ctx, cancel := context.WithTimeout(context.Background(), 1600*time.Millisecond)
			defer cancel()
			cmd := exec.CommandContext(ctx, controllerBin)
			cmd.Env = append(os.Environ(), "CLAUDE_TASK_URL="+backend.URL, "CLAUDE_TASK_HOST_TOKEN=unknown", "CLAUDE_TASK_ALLOW_INSECURE="+fmt.Sprint(tc.insecure))
			output, err := cmd.CombinedOutput()
			if err == nil {
				t.Fatal("Controller should remain running")
			}
			if attempts.Load() != tc.attempts || !strings.Contains(string(output), tc.message) {
				t.Fatalf("attempts %d, output %s", attempts.Load(), output)
			}
		})
	}
}

func TestHostControllerFailedSocketDial(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	accepted := make(chan *websocket.Conn, 1)
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, nil)
		if err == nil {
			accepted <- c
		}
	}))
	defer backend.Close()
	cmd := exec.CommandContext(ctx, controllerBin)
	cmd.Env = append(os.Environ(), "CLAUDE_TASK_URL="+backend.URL, "CLAUDE_TASK_HOST_TOKEN=token", "CLAUDE_TASK_ALLOW_INSECURE=true", "DOCKER_SOCKET="+filepath.Join(t.TempDir(), "missing.sock"))
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { cmd.Process.Kill(); cmd.Wait() }()
	var c *websocket.Conn
	select {
	case c = <-accepted:
	case <-ctx.Done():
		t.Fatal("no Controller")
	}
	defer c.CloseNow()
	if _, _, err := c.Read(ctx); err != nil {
		t.Fatal(err)
	}
	frame := []byte{1, 0, 0, 0, 42}
	if err := c.Write(ctx, websocket.MessageBinary, frame); err != nil {
		t.Fatal(err)
	}
	_, data, err := c.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(data) <= 5 || data[0] != 4 || binary.BigEndian.Uint32(data[1:5]) != 42 {
		t.Fatalf("failed dial: %q", data)
	}
}
