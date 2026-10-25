// Package protocol mirrors the Runner Protocol defined in shared/src/runner.ts.
package protocol

import "encoding/json"

const Version = 1

type GitSpec struct {
	CloneURL     string `json:"cloneUrl"`
	BaseBranch   string `json:"baseBranch"`
	TaskBranch   string `json:"taskBranch"`
	BranchExists bool   `json:"branchExists"`
	RepoPath     string `json:"repoPath"`
	CommitName   string `json:"commitName"`
	CommitEmail  string `json:"commitEmail"`
}

type ClaudeArgs struct {
	Model              *string `json:"model"`
	Effort             *string `json:"effort"`
	PermissionMode     string  `json:"permissionMode"`
	AppendSystemPrompt string  `json:"appendSystemPrompt"`
	MCPConfig          string  `json:"mcpConfig"`
}

type Attachment struct {
	URL  string `json:"url"`
	Path string `json:"path"`
}

// Incoming is any backend → runner message; only the fields of its type are set.
type Incoming struct {
	RequestID          string            `json:"requestId"`
	Token              string            `json:"token"`
	ExpiresAt          string            `json:"expiresAt"`
	Error              string            `json:"error"`
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
