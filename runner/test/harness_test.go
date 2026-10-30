// Package test drives the runner binary as a black box: a fake backend WebSocket on one
// side, the fakeclaude executable on the other.
package test

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/coder/websocket"
)

const token = "test-runner-token"

var runnerBin, fakeClaudeBin, credentialBin string

func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "runner-test-bin")
	if err != nil {
		panic(err)
	}
	runnerBin = filepath.Join(dir, "runner")
	fakeClaudeBin = filepath.Join(dir, "fakeclaude")
	credentialBin = filepath.Join(dir, "git-credential-claude-task")
	for bin, pkg := range map[string]string{runnerBin: "../cmd/runner", fakeClaudeBin: "../cmd/fakeclaude", credentialBin: "../cmd/git-credential-claude-task"} {
		args := []string{"build", "-o", bin}
		if os.Getenv("RUNNER_TEST_RACE") == "1" {
			args = append(args, "-race") // race-check the binaries themselves
		}
		out, err := exec.Command("go", append(args, pkg)...).CombinedOutput()
		if err != nil {
			panic(fmt.Sprintf("build %s: %v\n%s", pkg, err, out))
		}
	}
	code := m.Run()
	os.RemoveAll(dir)
	os.Exit(code)
}

type msg map[string]any

func (m msg) str(k string) string { s, _ := m[k].(string); return s }
func (m msg) num(k string) int64  { f, _ := m[k].(float64); return int64(f) }

// event decodes the stream-json line of a job.event.
func (m msg) event() msg {
	var e msg
	json.Unmarshal([]byte(m.str("line")), &e)
	return e
}

// backend is a fake backend: it processes job messages exactly once, in seq order, like the real one.
type backend struct {
	t   *testing.T
	srv *httptest.Server

	mu         sync.Mutex
	conn       *websocket.Conn
	hellos     []msg
	processed  []msg
	lastSeq    map[string]int64
	duplicates int
	gaps       []string
	autoAck    bool
	files      map[string][]byte
	uploads    map[string]upload
	// reply answers a processed message right away, like the real backend's scheduler.
	reply func(m msg) []msg
}

func newBackend(t *testing.T) *backend {
	b := &backend{t: t, lastSeq: map[string]int64{}, autoAck: true, files: map[string][]byte{}, uploads: map[string]upload{}}
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/runner", b.serveWS)
	mux.HandleFunc("/files/", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+token {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		b.mu.Lock()
		data, ok := b.files[strings.TrimPrefix(r.URL.Path, "/files/")]
		b.mu.Unlock()
		if !ok {
			http.NotFound(w, r)
			return
		}
		w.Write(data)
	})
	mux.HandleFunc("POST /api/v1/runner/uploads/{requestId}", b.serveUpload)
	b.srv = httptest.NewServer(mux)
	t.Cleanup(func() {
		b.drop()
		b.srv.Close()
	})
	return b
}

// upload is what the Runner posted for one job.upload: the manifest, then the file parts in order.
type upload struct {
	manifest []msg
	parts    []uploadPart
}

type uploadPart struct {
	field, filename, contentType string
	data                         []byte
}

func (b *backend) serveUpload(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("Authorization") != "Bearer "+token {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	mr, err := r.MultipartReader()
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	var u upload
	for i := 0; ; i++ {
		p, err := mr.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		data, _ := io.ReadAll(p)
		if i == 0 {
			if p.FormName() != "manifest" || json.Unmarshal(data, &u.manifest) != nil {
				http.Error(w, "the first part must be the manifest", http.StatusBadRequest)
				return
			}
			continue
		}
		u.parts = append(u.parts, uploadPart{p.FormName(), p.FileName(), p.Header.Get("Content-Type"), data})
	}
	b.mu.Lock()
	b.uploads[r.PathValue("requestId")] = u
	b.mu.Unlock()
}

func (b *backend) uploadURL(requestID string) string {
	return b.srv.URL + "/api/v1/runner/uploads/" + requestID
}

func (b *backend) waitUpload(requestID string) upload {
	b.t.Helper()
	var u upload
	waitUntil(b.t, 15*time.Second, "upload "+requestID, func() bool {
		b.mu.Lock()
		defer b.mu.Unlock()
		var ok bool
		u, ok = b.uploads[requestID]
		return ok
	})
	return u
}

func (b *backend) wsURL() string {
	return "ws" + strings.TrimPrefix(b.srv.URL, "http") + "/api/v1/runner"
}

func (b *backend) serveWS(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("Authorization") != "Bearer "+token {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	c, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	c.SetReadLimit(64 << 20)
	b.mu.Lock()
	if b.conn != nil {
		b.conn.CloseNow()
	}
	b.conn = c
	b.mu.Unlock()
	for {
		_, data, err := c.Read(context.Background())
		if err != nil {
			return
		}
		var m msg
		json.Unmarshal(data, &m)
		b.receive(c, m)
	}
}

func (b *backend) receive(c *websocket.Conn, m msg) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if m.str("type") == "hello" {
		b.hellos = append(b.hellos, m)
		return
	}
	jobID, seq := m.str("jobId"), m.num("seq")
	if jobID == "" || m.str("type") == "git.token_request" {
		b.processed = append(b.processed, m)
		return
	}
	switch last := b.lastSeq[jobID]; {
	case seq <= last:
		b.duplicates++
	case seq != last+1:
		b.gaps = append(b.gaps, fmt.Sprintf("%s: got seq %d after %d", jobID, seq, last))
		return
	default:
		b.lastSeq[jobID] = seq
		b.processed = append(b.processed, m)
	}
	if b.autoAck {
		data, _ := json.Marshal(msg{"type": "ack", "jobId": jobID, "seq": b.lastSeq[jobID]})
		c.Write(context.Background(), websocket.MessageText, data)
	}
	if b.reply != nil {
		for _, r := range b.reply(m) {
			data, _ := json.Marshal(r)
			c.Write(context.Background(), websocket.MessageText, data)
		}
	}
}

func (b *backend) setAutoAck(on bool) {
	b.mu.Lock()
	b.autoAck = on
	b.mu.Unlock()
}

// send waits for a connection, then sends m.
func (b *backend) send(m msg) {
	b.t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		b.mu.Lock()
		c := b.conn
		b.mu.Unlock()
		if c != nil {
			data, _ := json.Marshal(m)
			if err := c.Write(context.Background(), websocket.MessageText, data); err == nil {
				return
			}
		}
		if time.Now().After(deadline) {
			b.t.Fatalf("no runner connection to send %v", m["type"])
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// drop closes the connection from the backend side.
func (b *backend) drop() {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.conn != nil {
		b.conn.CloseNow()
		b.conn = nil
	}
}

func (b *backend) waitHello(n int) msg {
	b.t.Helper()
	var h msg
	waitUntil(b.t, 15*time.Second, fmt.Sprintf("hello #%d", n), func() bool {
		b.mu.Lock()
		defer b.mu.Unlock()
		if len(b.hellos) >= n {
			h = b.hellos[n-1]
			return true
		}
		return false
	})
	return h
}

// waitFor returns the first processed message matching pred.
func (b *backend) waitFor(what string, pred func(msg) bool) msg {
	b.t.Helper()
	var found msg
	waitUntil(b.t, 15*time.Second, what, func() bool {
		b.mu.Lock()
		defer b.mu.Unlock()
		for _, m := range b.processed {
			if pred(m) {
				found = m
				return true
			}
		}
		return false
	})
	return found
}

func (b *backend) waitType(jobID, typ string) msg {
	b.t.Helper()
	return b.waitFor(jobID+" "+typ, func(m msg) bool { return m.str("jobId") == jobID && m.str("type") == typ })
}

// waitEvent waits for a job.event whose stream-json line matches pred.
func (b *backend) waitEvent(jobID, what string, pred func(e msg) bool) msg {
	b.t.Helper()
	return b.waitFor(jobID+" "+what, func(m msg) bool {
		return m.str("jobId") == jobID && m.str("type") == "job.event" && pred(m.event())
	})
}

func (b *backend) jobMessages(jobID string) []msg {
	b.mu.Lock()
	defer b.mu.Unlock()
	var out []msg
	for _, m := range b.processed {
		if m.str("jobId") == jobID {
			out = append(out, m)
		}
	}
	return out
}

func (b *backend) setupOutput(jobID string) string {
	var s strings.Builder
	for _, m := range b.jobMessages(jobID) {
		if m.str("type") == "job.setup_output" {
			s.WriteString(m.str("chunk"))
		}
	}
	return s.String()
}

func (b *backend) stderr(jobID string) string {
	var s strings.Builder
	for _, m := range b.jobMessages(jobID) {
		if m.str("type") == "job.stderr" {
			s.WriteString(m.str("chunk"))
		}
	}
	return s.String()
}

func waitUntil(t *testing.T, timeout time.Duration, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// startRunner runs the runner binary with a fresh home and returns that home.
func startRunner(t *testing.T, b *backend, env ...string) string {
	t.Helper()
	home := t.TempDir()
	socketDir, err := os.MkdirTemp("", "ct-sock-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(socketDir) })
	cmd := exec.Command(runnerBin)
	cmd.Env = append(isolatedEnv(home),
		"CLAUDE_TASK_BACKEND_URL="+b.wsURL(),
		"CLAUDE_TASK_RUNNER_TOKEN="+token,
		"CLAUDE_TASK_CLAUDE_PATH="+fakeClaudeBin,
		"CLAUDE_TASK_HOME="+home,
		"CLAUDE_TASK_GIT_SOCKET="+filepath.Join(socketDir, "git.sock"),
		"CLAUDE_TASK_CANCEL_TERM_MS=300",
		"CLAUDE_TASK_CANCEL_KILL_MS=900",
	)
	cmd.Env = append(cmd.Env, env...)
	logFile, _ := os.Create(filepath.Join(t.TempDir(), "runner.log"))
	cmd.Stdout, cmd.Stderr = logFile, logFile
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cmd.Process.Signal(syscall.SIGTERM)
		done := make(chan struct{})
		go func() { cmd.Wait(); close(done) }()
		select {
		case <-done:
		case <-time.After(10 * time.Second):
			cmd.Process.Kill()
		}
		if t.Failed() {
			logFile.Seek(0, 0)
			out, _ := os.ReadFile(logFile.Name())
			t.Logf("runner log:\n%s", out)
		}
		logFile.Close()
	})
	return home
}

// isolatedEnv keeps the developer's git config and HOME out of the tests.
func isolatedEnv(home string) []string {
	return []string{
		"PATH=" + os.Getenv("PATH"),
		"HOME=" + home,
		"GIT_CONFIG_NOSYSTEM=1",
		"GIT_CONFIG_GLOBAL=" + filepath.Join(home, ".gitconfig-test"),
		"GORACE=" + os.Getenv("GORACE"),
	}
}

type jobOpts struct {
	id, session, mode, worktree, setup string
	text                               string
	model, effort                      any
	systemPrompt                       string
	env                                map[string]string
	git                                msg
	attachments                        []msg
	forwardSubagentText                bool
}

func jobStart(o jobOpts) msg {
	if o.mode == "" {
		o.mode = "new"
	}
	if o.session == "" {
		o.session = "sess-" + o.id
	}
	if o.worktree == "" {
		o.worktree = "worktrees/proj/T-1"
	}
	attachments := o.attachments
	if attachments == nil {
		attachments = []msg{}
	}
	var git any
	if o.git != nil {
		git = o.git
	}
	var initial any
	if o.text != "" {
		initial = []msg{{"type": "text", "text": o.text}}
	}
	return msg{
		"type": "job.start", "jobId": o.id, "sessionId": o.session, "mode": o.mode,
		"resumeInterrupted": false, "worktreePath": o.worktree, "git": git, "setupScript": o.setup,
		"env": o.env,
		"claudeArgs": msg{
			"model": o.model, "effort": o.effort, "permissionMode": "bypassPermissions",
			"appendSystemPrompt": o.systemPrompt, "mcpConfig": `{"mcpServers":{}}`,
			"disallowedTools": []string{"AskUserQuestion"}, "forwardSubagentText": o.forwardSubagentText,
		},
		"initialMessage": initial, "attachmentsToFetch": attachments,
	}
}

func input(jobID, text string, attachments ...msg) msg {
	if attachments == nil {
		attachments = []msg{}
	}
	return msg{"type": "job.input", "jobId": jobID, "message": []msg{{"type": "text", "text": text}}, "attachmentsToFetch": attachments}
}

type record struct {
	Args  []string          `json:"args"`
	Env   map[string]string `json:"env"`
	Cwd   string            `json:"cwd"`
	Stdin []string          `json:"stdin"`
}

func readRecord(t *testing.T, path string) record {
	t.Helper()
	var r record
	waitUntil(t, 10*time.Second, "fakeclaude record", func() bool {
		data, err := os.ReadFile(path)
		return err == nil && json.Unmarshal(data, &r) == nil
	})
	return r
}

// stdinTexts returns the text of every user message fakeclaude read.
func stdinTexts(r record) []string {
	var out []string
	for _, line := range r.Stdin {
		var m struct {
			Type    string `json:"type"`
			Message struct {
				Content []struct {
					Type string `json:"type"`
					Text string `json:"text"`
				} `json:"content"`
			} `json:"message"`
		}
		json.Unmarshal([]byte(line), &m)
		if m.Type == "user" && len(m.Message.Content) > 0 {
			out = append(out, m.Message.Content[0].Text)
		} else {
			out = append(out, m.Type)
		}
	}
	return out
}

func isAssistantText(text string) func(msg) bool {
	return func(e msg) bool {
		if e.str("type") != "assistant" {
			return false
		}
		message, _ := e["message"].(map[string]any)
		blocks, _ := message["content"].([]any)
		for _, b := range blocks {
			block, _ := b.(map[string]any)
			if block["type"] == "text" && block["text"] == text {
				return true
			}
		}
		return false
	}
}

func isToolUse(e msg) bool {
	message, _ := e["message"].(map[string]any)
	blocks, _ := message["content"].([]any)
	for _, b := range blocks {
		if block, _ := b.(map[string]any); block["type"] == "tool_use" {
			return true
		}
	}
	return false
}

func isResult(e msg) bool { return e.str("type") == "result" }

// seqOf returns the index of the first message matching pred in a job's processed messages.
func indexOf(ms []msg, pred func(msg) bool) int {
	for i, m := range ms {
		if pred(m) {
			return i
		}
	}
	return -1
}
