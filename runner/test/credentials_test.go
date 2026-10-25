package test

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type helperResult struct {
	output string
	err    error
}

func helper(t *testing.T, home, socket, input string) <-chan helperResult {
	t.Helper()
	done := make(chan helperResult, 1)
	go func() {
		cmd := exec.Command(credentialBin, "get")
		cmd.Env = append(isolatedEnv(home), "CLAUDE_TASK_GIT_SOCKET="+socket)
		cmd.Stdin = strings.NewReader(input)
		output, err := cmd.CombinedOutput()
		done <- helperResult{string(output), err}
	}()
	return done
}
func readHelper(t *testing.T, done <-chan helperResult) helperResult {
	t.Helper()
	select {
	case result := <-done:
		return result
	case <-time.After(5 * time.Second):
		t.Fatal("credential helper did not finish")
		return helperResult{}
	}
}
func credentialSetup(t *testing.T) (*backend, string, string, msg) {
	t.Helper()
	o := newOrigin(t)
	b := newBackend(t)
	dir, err := os.MkdirTemp("", "ct-credential-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	socket := filepath.Join(dir, "git.sock")
	config := filepath.Join(dir, "gitconfig")
	gitIn(t, o.home, dir, "config", "--file", config, "url."+o.url()+".insteadOf", "https://github.com/acme/example.git")
	home := startRunner(t, b, "CLAUDE_TASK_GIT_SOCKET="+socket, "GIT_CONFIG_GLOBAL="+config)
	b.waitHello(1)
	spec := o.spec("task/t-1")
	spec["cloneUrl"] = "https://github.com/acme/example.git"
	return b, home, socket, spec
}

const credentialInput = "protocol=https\nhost=github.com\npath=acme/example.git\n\n"

func grant(b *backend, req msg, value string, ttl time.Duration) {
	b.send(msg{"type": "git.token", "requestId": req.str("requestId"), "jobId": req.str("jobId"), "token": value, "expiresAt": time.Now().Add(ttl).UTC().Format(time.RFC3339)})
}

func TestCredentialHelperScopesAndClearsItsCache(t *testing.T) {
	b, home, socket, spec := credentialSetup(t)
	idle := readHelper(t, helper(t, home, socket, credentialInput))
	if idle.err == nil || !strings.Contains(idle.output, "no active task") {
		t.Fatalf("idle credentials: %q %v", idle.output, idle.err)
	}
	b.send(jobStart(jobOpts{id: "j1", git: spec, text: "go", env: map[string]string{"FAKE_CLAUDE_HANG": "1"}}))
	b.waitType("j1", "job.worktree_ready")
	if info, err := os.Stat(socket); err != nil || info.Mode().Perm() != 0600 {
		t.Fatal("credential socket must be private")
	}
	first := helper(t, home, socket, credentialInput)
	req := b.waitType("j1", "git.token_request")
	if req.str("repository") != "acme/example" {
		t.Fatalf("repository %v", req)
	}
	grant(b, req, "first-token", time.Hour)
	if result := readHelper(t, first); result.err != nil || result.output != "username=x-access-token\npassword=first-token\n\n" {
		t.Fatalf("credentials %q %v", result.output, result.err)
	}
	if result := readHelper(t, helper(t, home, socket, credentialInput)); result.err != nil || !strings.Contains(result.output, "password=first-token") {
		t.Fatalf("cached credentials %q", result.output)
	}
	for _, input := range []string{"protocol=https\nhost=github.com\npath=acme/other.git\n\n", "protocol=https\nhost=evil.test\npath=acme/example.git\n\n", "protocol=https\nhost=github.com\npath=acme/example/../other.git\n\n"} {
		if result := readHelper(t, helper(t, home, socket, input)); result.err == nil || strings.Contains(result.output, "password=") {
			t.Fatalf("out of scope credentials: %q", result.output)
		}
	}
	requests := 0
	for _, m := range b.jobMessages("j1") {
		if m.str("type") == "git.token_request" {
			requests++
		}
	}
	if requests != 1 {
		t.Fatalf("cached helper made %d backend requests", requests)
	}
	// A normal interrupt and end close the active Job, and credentials stop working.
	b.send(msg{"type": "job.interrupt", "jobId": "j1"})
	b.waitEvent("j1", "interrupted", isResult)
	b.send(msg{"type": "job.end", "jobId": "j1"})
	b.waitType("j1", "job.exited")
	if result := readHelper(t, helper(t, home, socket, credentialInput)); result.err == nil {
		t.Fatal("credentials leaked after the Job")
	}
	// The next Job in the same repository gets a new token, never the previous cache.
	b.send(jobStart(jobOpts{id: "j2", git: spec, text: "go", env: map[string]string{"FAKE_CLAUDE_HANG": "1"}}))
	b.waitType("j2", "job.worktree_ready")
	second := helper(t, home, socket, credentialInput)
	req = b.waitType("j2", "git.token_request")
	grant(b, req, "second-token", time.Hour)
	if result := readHelper(t, second); result.err != nil || !strings.Contains(result.output, "password=second-token") {
		t.Fatalf("next job credentials %q", result.output)
	}
	if remote := gitIn(t, home, filepath.Join(home, "repos/proj.git"), "config", "--get", "remote.origin.url"); remote != "https://github.com/acme/example.git" {
		t.Fatalf("credentials in remote: %q", remote)
	}
	b.send(msg{"type": "job.cancel", "jobId": "j2"})
	b.waitType("j2", "job.exited")
}

func TestCredentialHelperRefreshesNearExpiryAndReportsDenial(t *testing.T) {
	b, home, socket, spec := credentialSetup(t)
	b.send(jobStart(jobOpts{id: "j1", git: spec, text: "go", env: map[string]string{"FAKE_CLAUDE_HANG": "1"}}))
	b.waitType("j1", "job.worktree_ready")
	first := helper(t, home, socket, credentialInput)
	req := b.waitType("j1", "git.token_request")
	grant(b, req, "nearly-expired", 4*time.Minute)
	if result := readHelper(t, first); result.err != nil {
		t.Fatalf("initial token %s", result.output)
	}
	second := helper(t, home, socket, credentialInput)
	next := b.waitFor("refreshed token request", func(m msg) bool {
		return m.str("type") == "git.token_request" && m.str("requestId") != req.str("requestId")
	})
	b.send(msg{"type": "git.token", "jobId": "j1", "requestId": next.str("requestId"), "error": "installation revoked"})
	if result := readHelper(t, second); result.err == nil || strings.Contains(result.output, "password=") || !strings.Contains(result.output, "refused") {
		t.Fatalf("denial %q %v", result.output, result.err)
	}
	b.send(msg{"type": "job.cancel", "jobId": "j1"})
	b.waitType("j1", "job.exited")
	// store must never persist credentials or even need the socket.
	cmd := exec.Command(credentialBin, "store")
	cmd.Env = isolatedEnv(home)
	cmd.Stdin = strings.NewReader(fmt.Sprintf("password=%s\n\n", "never-persist"))
	if output, err := cmd.CombinedOutput(); err != nil || len(output) > 0 {
		t.Fatalf("store %q %v", output, err)
	}
}
