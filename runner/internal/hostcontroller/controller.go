// Package hostcontroller forwards raw Docker socket streams over an outbound WebSocket.
package hostcontroller

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/coder/websocket"
)

// The protocol mirrors HOST_PROTOCOL_VERSION and HOST_CONTROLLER_PATH in shared/src/hosts.ts, and the
// frames (opcode byte, big-endian stream id, payload) mirror backend/src/hosts/tunnel.ts.
const protocolVersion = 1
const controllerPath = "/api/v1/host-controller"
const (
	open        byte = 1
	data        byte = 2
	end         byte = 3
	closeStream byte = 4
)

// Config holds the Controller's connection and local socket settings.
type Config struct{ URL, Token, Socket, Version string }

// FromEnv validates settings before any token can be sent over the network.
func FromEnv(version string) (Config, error) {
	c := Config{URL: strings.TrimRight(os.Getenv("CLAUDE_TASK_URL"), "/"), Token: os.Getenv("CLAUDE_TASK_HOST_TOKEN"), Socket: os.Getenv("DOCKER_SOCKET"), Version: version}
	if c.Socket == "" {
		c.Socket = "/var/run/docker.sock"
	}
	if c.URL == "" || c.Token == "" {
		return c, errors.New("CLAUDE_TASK_URL and CLAUDE_TASK_HOST_TOKEN are required")
	}
	u, err := url.Parse(c.URL)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") || u.RawQuery != "" || u.Fragment != "" || u.User != nil {
		return c, errors.New("CLAUDE_TASK_URL must be an absolute http or https base URL")
	}
	if u.Scheme == "http" && os.Getenv("CLAUDE_TASK_ALLOW_INSECURE") != "true" {
		return c, errors.New("http requires CLAUDE_TASK_ALLOW_INSECURE=true")
	}
	return c, nil
}

// Run reconnects with bounded backoff; a retired or unauthorized Controller stays idle.
func Run(ctx context.Context, cfg Config) {
	backoff := time.Second
	for ctx.Err() == nil {
		connected, terminal, err := session(ctx, cfg)
		if ctx.Err() != nil {
			return
		}
		if connected {
			backoff = time.Second
		}
		if terminal {
			log.Printf("Host Controller stopped reconnecting: %v", err)
			<-ctx.Done()
			return
		}
		log.Printf("Host Controller connection: %v; retrying in %s", err, backoff)
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		backoff = min(2*backoff, 30*time.Second)
	}
}

type stream struct {
	conn                *net.UnixConn
	readDone, writeDone bool
}

// session runs one connection; connected reports whether the backend accepted it, which resets the backoff.
func session(parent context.Context, cfg Config) (connected, terminal bool, err error) {
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	u, err := url.Parse(cfg.URL)
	if err != nil {
		return false, true, err
	}
	if u.Scheme == "https" {
		u.Scheme = "wss"
	} else {
		u.Scheme = "ws"
	}
	u.Path = strings.TrimRight(u.Path, "/") + controllerPath
	dialCtx, stopDial := context.WithTimeout(ctx, 15*time.Second)
	c, response, err := websocket.Dial(dialCtx, u.String(), &websocket.DialOptions{HTTPHeader: http.Header{"Authorization": {"Bearer " + cfg.Token}}})
	stopDial()
	if err != nil {
		return false, response != nil && response.StatusCode == 401, err
	}
	defer func() {
		if err := c.CloseNow(); err != nil {
			log.Printf("closing Controller connection: %v", err)
		}
	}()
	c.SetReadLimit(4 << 20)
	hello, err := json.Marshal(map[string]any{"type": "hello", "protocolVersion": protocolVersion, "controllerVersion": cfg.Version, "backendUrl": cfg.URL})
	if err != nil {
		return false, false, err
	}
	if err := c.Write(ctx, websocket.MessageText, hello); err != nil {
		return false, false, err
	}
	var mu sync.Mutex
	streams := make(map[uint32]*stream)
	var readers sync.WaitGroup
	// Closing every local socket unblocks reads and writes when this connection ends.
	stopped := make(chan struct{})
	go func() {
		defer close(stopped)
		<-ctx.Done()
		mu.Lock()
		defer mu.Unlock()
		for _, s := range streams {
			if err := s.conn.Close(); err != nil {
				log.Printf("closing Docker stream: %v", err)
			}
		}
	}()
	defer func() { cancel(); <-stopped; readers.Wait() }()
	send := func(op byte, id uint32, payload []byte) error {
		frame := make([]byte, 5+len(payload))
		frame[0] = op
		binary.BigEndian.PutUint32(frame[1:], id)
		copy(frame[5:], payload)
		writeCtx, stop := context.WithTimeout(ctx, 30*time.Second)
		defer stop()
		return c.Write(writeCtx, websocket.MessageBinary, frame)
	}
	discard := func(id uint32, s *stream) bool {
		mu.Lock()
		current := streams[id] == s
		if current {
			delete(streams, id)
		}
		mu.Unlock()
		if current {
			if err := s.conn.Close(); err != nil {
				log.Printf("closing Docker stream: %v", err)
			}
		}
		return current
	}
	finish := func(id uint32, s *stream, reading bool) {
		mu.Lock()
		if reading {
			s.readDone = true
		} else {
			s.writeDone = true
		}
		done := s.readDone && s.writeDone
		if done {
			delete(streams, id)
		}
		mu.Unlock()
		if done {
			if err := s.conn.Close(); err != nil {
				log.Printf("closing completed Docker stream: %v", err)
			}
			if err := send(closeStream, id, nil); err != nil {
				cancel()
			}
		}
	}
	for {
		kind, frame, err := c.Read(ctx)
		if err != nil {
			return connected, websocket.CloseStatus(err) == 4004, err
		}
		if kind != websocket.MessageBinary || len(frame) < 5 {
			return connected, false, errors.New("invalid tunnel frame")
		}
		// The backend tunnels its first Docker call only once it has accepted the hello.
		connected = true
		op, id, payload := frame[0], binary.BigEndian.Uint32(frame[1:5]), frame[5:]
		mu.Lock()
		s := streams[id]
		mu.Unlock()
		switch op {
		case open:
			if s != nil {
				return connected, false, fmt.Errorf("duplicate stream %d", id)
			}
			local, err := (&net.Dialer{Timeout: 10 * time.Second}).DialContext(ctx, "unix", cfg.Socket)
			if err != nil {
				if err := send(closeStream, id, []byte(err.Error())); err != nil {
					return connected, false, err
				}
				continue
			}
			s = &stream{conn: local.(*net.UnixConn)}
			mu.Lock()
			streams[id] = s
			mu.Unlock()
			readers.Add(1)
			go func(id uint32, s *stream) {
				defer readers.Done()
				buffer := make([]byte, 64<<10)
				for {
					n, err := s.conn.Read(buffer)
					if n > 0 {
						if err := send(data, id, buffer[:n]); err != nil {
							cancel()
							return
						}
					}
					if err != nil {
						if errors.Is(err, io.EOF) {
							if err := send(end, id, nil); err != nil {
								cancel()
							}
							finish(id, s, true)
						} else if ctx.Err() == nil && discard(id, s) {
							if err := send(closeStream, id, []byte(err.Error())); err != nil {
								cancel()
							}
						}
						return
					}
				}
			}(id, s)
		case data:
			if s == nil {
				continue
			}
			if _, err := s.conn.Write(payload); err != nil {
				discard(id, s)
				if err := send(closeStream, id, []byte(err.Error())); err != nil {
					return connected, false, err
				}
			}
		case end:
			if s != nil {
				if err := s.conn.CloseWrite(); err != nil && !errors.Is(err, syscall.ENOTCONN) && !errors.Is(err, net.ErrClosed) {
					if err := send(closeStream, id, []byte(err.Error())); err != nil {
						return connected, false, err
					}
				}
				finish(id, s, false)
			}
		case closeStream:
			if s != nil {
				discard(id, s)
			}
		default:
			return connected, false, fmt.Errorf("unknown tunnel operation %d", op)
		}
	}
}
