// Package protocol mirrors the Runner Protocol defined in shared/src/runner.ts.
package protocol

import "encoding/json"

const Version = 3

type GitSpec struct {
	CloneURL     string `json:"cloneUrl"`
	BaseBranch   string `json:"baseBranch"`
	TaskBranch   string `json:"taskBranch"`
	BranchExists bool   `json:"branchExists"`
	RepoPath     string `json:"repoPath"`
	CommitName   string `json:"commitName"`
	CommitEmail  string `json:"commitEmail"`
	// Token is the Git Proxy password (the Job token); the credential helper serves it.
	Token string `json:"token"`
	// RepositoryID identifies the linked Repository. The Git Proxy URL is the same for every
	// Repository of a Project, so a change is detected by this, not by the URL.
	RepositoryID string `json:"repositoryId"`
}

type ClaudeArgs struct {
	Model              *string `json:"model"`
	Effort             *string `json:"effort"`
	PermissionMode     string  `json:"permissionMode"`
	AppendSystemPrompt string  `json:"appendSystemPrompt"`
	MCPConfig          string  `json:"mcpConfig"`
	// DisallowedTools are passed as one `--disallowedTools <name>` each.
	DisallowedTools []string `json:"disallowedTools"`
	// ForwardSubagentText asks for `--forward-subagent-text`, which the Runner adds only when the
	// `claude` it is about to start has it (dependency: a repository can override the version).
	ForwardSubagentText bool `json:"forwardSubagentText"`
}

type Attachment struct {
	URL  string `json:"url"`
	Path string `json:"path"`
}

// UploadFile is one path of a job.upload: relative to the Worktree, or absolute.
type UploadFile struct {
	Path string `json:"path"`
}

// UploadManifestEntry reports one requested path of an upload, in request order.
type UploadManifestEntry struct {
	Path  string `json:"path"`
	Error string `json:"error,omitempty"`
}

// Incoming is any backend → runner message; only the fields of its type are set.
type Incoming struct {
	Type               string            `json:"type"`
	JobID              string            `json:"jobId"`
	Seq                int64             `json:"seq"`
	SessionID          string            `json:"sessionId"`
	Mode               string            `json:"mode"`
	ResumeInterrupted  bool              `json:"resumeInterrupted"`
	WorktreePath       string            `json:"worktreePath"`
	Git                *GitSpec          `json:"git"`
	SetupScript        string            `json:"setupScript"`
	Env                map[string]string `json:"env"`
	ClaudeArgs         ClaudeArgs        `json:"claudeArgs"`
	InitialMessage     json.RawMessage   `json:"initialMessage"`
	Message            json.RawMessage   `json:"message"`
	AttachmentsToFetch []Attachment      `json:"attachmentsToFetch"`
	RepoPath           *string           `json:"repoPath"`
	RequestID          string            `json:"requestId"`
	URL                string            `json:"url"`
	Files              []UploadFile      `json:"files"`
}

// Outgoing message shapes (runner → backend). Job-scoped ones get jobId and seq from the runner.

type Hello struct {
	Type            string  `json:"type"`
	ProtocolVersion int     `json:"protocolVersion"`
	RunnerVersion   string  `json:"runnerVersion"`
	ClaudeVersion   string  `json:"claudeVersion"`
	ActiveJobID     *string `json:"activeJobId"`
}

func UserMessage(content json.RawMessage) []byte {
	b, _ := json.Marshal(map[string]any{
		"type":    "user",
		"message": map[string]any{"role": "user", "content": content},
	})
	return append(b, '\n')
}

func InterruptRequest(requestID string) []byte {
	b, _ := json.Marshal(map[string]any{
		"type":       "control_request",
		"request_id": requestID,
		"request":    map[string]any{"subtype": "interrupt"},
	})
	return append(b, '\n')
}
