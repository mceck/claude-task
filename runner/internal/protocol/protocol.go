// Package protocol mirrors the Runner Protocol defined in shared/src/runner.ts.
package protocol

import "encoding/json"

const Version = 4

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
	// ReplayUserMessages asks for `--replay-user-messages`, under the same rule: the CLI echoes
	// each user message, with the `uuid` it was written with, when it reads it.
	ReplayUserMessages bool `json:"replayUserMessages"`
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
	AgentProfilePath   string            `json:"agentProfilePath"`
	Git                *GitSpec          `json:"git"`
	SetupScript        string            `json:"setupScript"`
	Env                map[string]string `json:"env"`
	ClaudeArgs         ClaudeArgs        `json:"claudeArgs"`
	InitialMessage     json.RawMessage   `json:"initialMessage"`
	InitialMessageID   string            `json:"initialMessageId"`
	Message            json.RawMessage   `json:"message"`
	MessageID          string            `json:"messageId"`
	AttachmentsToFetch []Attachment      `json:"attachmentsToFetch"`
	RepoPath           *string           `json:"repoPath"`
	RequestID          string            `json:"requestId"`
	URL                string            `json:"url"`
	Files              []UploadFile      `json:"files"`
	KeepProjects       []string          `json:"keepProjects"`
	KeepAgents         []string          `json:"keepAgents"`
}

// Outgoing message shapes (runner → backend). Job-scoped ones get jobId and seq from the runner.

type Hello struct {
	Type            string  `json:"type"`
	ProtocolVersion int     `json:"protocolVersion"`
	RunnerVersion   string  `json:"runnerVersion"`
	ClaudeVersion   string  `json:"claudeVersion"`
	ActiveJobID     *string `json:"activeJobId"`
}

// ProjectSkillFile is one skill or command of the Worktree in a job.project_skills.
type ProjectSkillFile struct {
	Name string `json:"name"`
	Head string `json:"head"`
}

// WorktreeFile is one uncommitted change in a worktree.status.result.
type WorktreeFile struct {
	Path   string `json:"path"`
	Status string `json:"status"`
}

// UserMessage is one stream-json user message; a non-empty id becomes its `uuid`, which the CLI's
// replay echoes when it reads the message.
func UserMessage(content json.RawMessage, id string) []byte {
	m := map[string]any{
		"type":    "user",
		"message": map[string]any{"role": "user", "content": content},
	}
	if id != "" {
		m["uuid"] = id
		m["session_id"] = ""
		m["parent_tool_use_id"] = nil
	}
	b, _ := json.Marshal(m)
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
