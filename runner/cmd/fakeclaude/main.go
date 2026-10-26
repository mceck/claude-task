// Command fakeclaude stands in for `claude -p --input-format stream-json --output-format stream-json`
// in the runner's tests. It records how it was started and what it read, and answers every user
// message with a scripted Turn.
//
// Environment:
//
//	FAKE_CLAUDE_RECORD       JSON file receiving {args, env, cwd, stdin} (rewritten on every stdin line)
//	FAKE_CLAUDE_TOOL_MS      each Turn runs a fake Bash tool this long; messages arriving meanwhile are
//	                         taken into the same Turn ("Also noted: …")
//	FAKE_CLAUDE_IGNORE_TERM  "1" ignores SIGTERM
//	FAKE_CLAUDE_EXIT         exit right away with this code, after writing FAKE_CLAUDE_STDERR
//
// Message text keywords: "CRASH" kills the process with SIGKILL, "HANG" runs the tool until
// interrupted, "STUCK" stops responding to anything.
// Sessions are remembered in $HOME/.fakeclaude/sessions, like the real CLI refuses a reused
// --session-id and an unknown --resume.
package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

var (
	sessionID string
	outMu     sync.Mutex
	rec       = record{Env: map[string]string{}}
	recMu     sync.Mutex
)

type record struct {
	Args  []string          `json:"args"`
	Env   map[string]string `json:"env"`
	Cwd   string            `json:"cwd"`
	Stdin []string          `json:"stdin"`
}

func main() {
	args := os.Args[1:]
	if len(args) == 1 && args[0] == "--version" {
		fmt.Println("9.9.9 (Claude Code)")
		return
	}
	rec.Args = args
	rec.Cwd, _ = os.Getwd()
	for _, kv := range os.Environ() {
		k, v, _ := strings.Cut(kv, "=")
		rec.Env[k] = v
	}
	saveRecord()

	if os.Getenv("FAKE_CLAUDE_IGNORE_TERM") == "1" {
		signal.Ignore(syscall.SIGTERM)
	}
	if code := os.Getenv("FAKE_CLAUDE_EXIT"); code != "" {
		fmt.Fprint(os.Stderr, os.Getenv("FAKE_CLAUDE_STDERR"))
		n, _ := strconv.Atoi(code)
		os.Exit(n)
	}
	if !checkSession(args) {
		os.Exit(1)
	}

	lines := make(chan map[string]any)
	go readStdin(lines)
	var queue []map[string]any
	initDone := false
	for {
		if len(queue) == 0 {
			if lines == nil {
				return
			}
			m, ok := <-lines
			if !ok {
				return // stdin closed and nothing left to do
			}
			if handleControl(m) {
				continue
			}
			queue = append(queue, m)
			continue
		}
		m := queue[0]
		queue = queue[1:]
		if !initDone {
			emit(map[string]any{"type": "system", "subtype": "init", "session_id": sessionID, "model": "fake-model", "cwd": rec.Cwd, "tools": []string{"Bash"}, "mcp_servers": []any{map[string]any{"name": "claude-task", "status": "pending"}}})
			initDone = true
		}
		lines = turn(m, lines)
	}
}

// turn answers one message and returns the stdin channel, nil once stdin is closed.
func turn(m map[string]any, lines chan map[string]any) chan map[string]any {
	text := messageText(m)
	if strings.Contains(text, "CRASH") {
		syscall.Kill(os.Getpid(), syscall.SIGKILL)
	}
	start := time.Now()
	msgID := fmt.Sprintf("msg_%d", time.Now().UnixNano())
	assistant(msgID, map[string]any{"type": "text", "text": "Working on: " + text})
	if strings.Contains(text, "STUCK") {
		for { // deaf to stdin, interrupts and stdin closing
			time.Sleep(time.Hour)
		}
	}

	toolMs, _ := strconv.Atoi(os.Getenv("FAKE_CLAUDE_TOOL_MS"))
	hang := strings.Contains(text, "HANG")
	var noted []string
	interrupted := false
	if toolMs > 0 || hang {
		toolID := fmt.Sprintf("toolu_%d", time.Now().UnixNano())
		assistant(msgID, map[string]any{"type": "tool_use", "id": toolID, "name": "Bash", "input": map[string]any{"command": "sleep 1"}})
		var timer <-chan time.Time
		if !hang {
			timer = time.After(time.Duration(toolMs) * time.Millisecond)
		}
	wait:
		for {
			select {
			case <-timer:
				break wait
			case next, ok := <-lines:
				if !ok {
					lines = nil
					continue
				}
				if isInterrupt(next) {
					handleControl(next)
					interrupted = true
					break wait
				}
				if handleControl(next) {
					continue
				}
				noted = append(noted, messageText(next))
			}
		}
		emit(map[string]any{"type": "user", "session_id": sessionID, "parent_tool_use_id": nil, "message": map[string]any{"role": "user", "content": []any{
			map[string]any{"type": "tool_result", "tool_use_id": toolID, "content": "ok", "is_error": interrupted},
		}}})
	}
	for _, n := range noted {
		assistant(msgID, map[string]any{"type": "text", "text": "Also noted: " + n})
	}
	result := map[string]any{"type": "result", "subtype": "success", "is_error": false, "session_id": sessionID,
		"duration_ms": time.Since(start).Milliseconds(), "num_turns": 1, "total_cost_usd": 0.001, "result": "Done: " + text}
	if interrupted {
		// Like the real CLI after a control-request interrupt: no `result` text.
		delete(result, "result")
		result["subtype"] = "error_during_execution"
		result["is_error"] = true
		result["terminal_reason"] = "aborted_tools"
		result["errors"] = []string{"[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use"}
	} else {
		assistant(msgID, map[string]any{"type": "text", "text": "Done: " + text})
	}
	emit(result)
	return lines
}

func checkSession(args []string) bool {
	dir := filepath.Join(os.Getenv("HOME"), ".fakeclaude", "sessions")
	os.MkdirAll(dir, 0o755)
	for i := 0; i+1 < len(args); i++ {
		switch args[i] {
		case "--session-id":
			sessionID = args[i+1]
			p := filepath.Join(dir, sessionID)
			if _, err := os.Stat(p); err == nil {
				fmt.Fprintf(os.Stderr, "Error: Session ID %s is already in use.\n", sessionID)
				return false
			}
			os.WriteFile(p, nil, 0o644)
		case "--resume":
			sessionID = args[i+1]
			if _, err := os.Stat(filepath.Join(dir, sessionID)); err != nil {
				emit(map[string]any{"type": "result", "subtype": "error_during_execution", "is_error": true, "num_turns": 0, "session_id": sessionID})
				fmt.Fprintf(os.Stderr, "No conversation found with session ID: %s\n", sessionID)
				return false
			}
		}
	}
	return true
}

func readStdin(lines chan<- map[string]any) {
	sc := bufio.NewScanner(os.Stdin)
	sc.Buffer(make([]byte, 1<<20), 64<<20)
	for sc.Scan() {
		line := sc.Text()
		recMu.Lock()
		rec.Stdin = append(rec.Stdin, line)
		recMu.Unlock()
		saveRecord()
		var m map[string]any
		if json.Unmarshal([]byte(line), &m) == nil {
			lines <- m
		}
	}
	close(lines)
}

func isInterrupt(m map[string]any) bool {
	req, _ := m["request"].(map[string]any)
	return m["type"] == "control_request" && req["subtype"] == "interrupt"
}

// handleControl answers control requests; it reports whether m was one.
func handleControl(m map[string]any) bool {
	if m["type"] != "control_request" {
		return false
	}
	emit(map[string]any{"type": "control_response", "response": map[string]any{"subtype": "success", "request_id": m["request_id"], "response": map[string]any{}}})
	return true
}

func messageText(m map[string]any) string {
	msg, _ := m["message"].(map[string]any)
	blocks, _ := msg["content"].([]any)
	var parts []string
	for _, b := range blocks {
		block, _ := b.(map[string]any)
		switch block["type"] {
		case "text":
			s, _ := block["text"].(string)
			parts = append(parts, s)
		case "image":
			parts = append(parts, "[image]")
		}
	}
	return strings.Join(parts, " ")
}

func assistant(msgID string, block map[string]any) {
	emit(map[string]any{"type": "assistant", "session_id": sessionID, "parent_tool_use_id": nil,
		"message": map[string]any{"id": msgID, "role": "assistant", "model": "fake-model", "content": []any{block}}})
}

func emit(v map[string]any) {
	b, _ := json.Marshal(v)
	outMu.Lock()
	defer outMu.Unlock()
	os.Stdout.Write(append(b, '\n'))
}

func saveRecord() {
	p := os.Getenv("FAKE_CLAUDE_RECORD")
	if p == "" {
		return
	}
	recMu.Lock()
	b, _ := json.MarshalIndent(rec, "", "  ")
	recMu.Unlock()
	tmp := p + ".tmp"
	os.WriteFile(tmp, b, 0o644)
	os.Rename(tmp, p)
}
