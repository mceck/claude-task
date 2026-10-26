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

// proxyURL stands in for the backend's Git Proxy; git rewrites it to the local bare origin.
const proxyURL = "http://backend.test:3000/git/proj.git"

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
	gitIn(t, o.home, dir, "config", "--file", config, "url."+o.url()+".insteadOf", proxyURL)
	home := startRunner(t, b, "CLAUDE_TASK_GIT_SOCKET="+socket, "GIT_CONFIG_GLOBAL="+config)
	b.waitHello(1)
	spec := o.spec("task/t-1")
	spec["cloneUrl"] = proxyURL
	return b, home, socket, spec
}

const credentialInput = "protocol=http\nhost=backend.test:3000\npath=git/proj.git\n\n"

func withToken(spec msg, token string) msg {
	copied := msg{}
	for k, v := range spec {
		copied[k] = v
	}
	copied["token"] = token
	return copied
}

func TestCredentialHelperServesOnlyTheActiveJobsProxyURL(t *testing.T) {
	b, home, socket, spec := credentialSetup(t)
	idle := readHelper(t, helper(t, home, socket, credentialInput))
	if idle.err == nil || !strings.Contains(idle.output, "no active task") {
		t.Fatalf("idle credentials: %q %v", idle.output, idle.err)
	}
	b.send(jobStart(jobOpts{id: "j1", git: withToken(spec, "first-job-token"), text: "go", env: map[string]string{"FAKE_CLAUDE_HANG": "1"}}))
	b.waitType("j1", "job.worktree_ready")
	if info, err := os.Stat(socket); err != nil || info.Mode().Perm() != 0600 {
		t.Fatal("credential socket must be private")
	}
	if result := readHelper(t, helper(t, home, socket, credentialInput)); result.err != nil || result.output != "username=claude-task\npassword=first-job-token\n\n" {
		t.Fatalf("credentials %q %v", result.output, result.err)
	}
	if result := readHelper(t, helper(t, home, socket, "protocol=http\nhost=BACKEND.test:3000\npath=/git/proj\n\n")); result.err != nil || !strings.Contains(result.output, "password=first-job-token") {
		t.Fatalf("equivalent URL %q %v", result.output, result.err)
	}
	for _, input := range []string{
		"protocol=http\nhost=evil.test:3000\npath=git/proj.git\n\n",
		"protocol=http\nhost=backend.test:3001\npath=git/proj.git\n\n",
		"protocol=http\nhost=backend.test\npath=git/proj.git\n\n",
		"protocol=https\nhost=backend.test:3000\npath=git/proj.git\n\n",
		"protocol=http\nhost=backend.test:3000\npath=git/other.git\n\n",
		"protocol=http\nhost=backend.test:3000\npath=git/proj.git/../other.git\n\n",
		"protocol=http\nhost=backend.test:3000\n\n",
		"protocol=https\nhost=github.com\npath=acme/example.git\n\n",
	} {
		if result := readHelper(t, helper(t, home, socket, input)); result.err == nil || strings.Contains(result.output, "password=") {
			t.Fatalf("out of scope credentials for %q: %q", input, result.output)
		}
	}
	// A normal interrupt and end close the active Job, and credentials stop working.
	b.send(msg{"type": "job.interrupt", "jobId": "j1"})
	b.waitEvent("j1", "interrupted", isResult)
	b.send(msg{"type": "job.end", "jobId": "j1"})
	b.waitType("j1", "job.exited")
	if result := readHelper(t, helper(t, home, socket, credentialInput)); result.err == nil || strings.Contains(result.output, "password=") {
		t.Fatalf("credentials leaked after the Job: %q", result.output)
	}
	// The next Job serves its own token, never the previous one.
	b.send(jobStart(jobOpts{id: "j2", git: withToken(spec, "second-job-token"), text: "go", env: map[string]string{"FAKE_CLAUDE_HANG": "1"}}))
	b.waitType("j2", "job.worktree_ready")
	if result := readHelper(t, helper(t, home, socket, credentialInput)); result.err != nil || result.output != "username=claude-task\npassword=second-job-token\n\n" {
		t.Fatalf("next job credentials %q %v", result.output, result.err)
	}
	if remote := gitIn(t, home, filepath.Join(home, "repos/proj.git"), "config", "--get", "remote.origin.url"); remote != proxyURL {
		t.Fatalf("credentials in remote: %q", remote)
	}
	b.send(msg{"type": "job.cancel", "jobId": "j2"})
	b.waitType("j2", "job.exited")
	for _, id := range []string{"j1", "j2"} {
		for _, m := range b.jobMessages(id) {
			if strings.HasPrefix(m.str("type"), "git.") {
				t.Fatalf("the Runner asked the backend for Git credentials: %v", m)
			}
		}
	}
}

func TestCredentialHelperDeniesAJobWithoutAToken(t *testing.T) {
	b, home, socket, spec := credentialSetup(t)
	b.send(jobStart(jobOpts{id: "j1", git: spec, text: "go", env: map[string]string{"FAKE_CLAUDE_HANG": "1"}}))
	b.waitType("j1", "job.worktree_ready")
	if result := readHelper(t, helper(t, home, socket, credentialInput)); result.err == nil || strings.Contains(result.output, "password=") {
		t.Fatalf("credentials without a token: %q", result.output)
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
