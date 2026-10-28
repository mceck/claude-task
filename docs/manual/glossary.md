[Manual](README.md) › Reference

# Understand the terms

These are the terms you will meet while using Claude Task.

| Term | Meaning |
| --- | --- |
| User | A team member who can sign in, with the Member or Admin role. |
| Admin | A User who can manage platform configuration and access. |
| Login | Your authenticated access from a browser or native app. |
| Installation | One deployment of Claude Task at its own URL. |
| Project | A body of work with its own Board, Statuses and Tags. |
| Project Key | The permanent uppercase prefix of a Project's Task Keys. |
| Board | A Project's Tasks arranged in columns by Status. |
| Status | A named step in the workflow, such as Todo or Done. |
| Category | The meaning of a Status: open, active, review, done or closed. |
| Task | A unit of work with a description, assignments and Conversation. |
| Task Key | A readable Task identifier, such as `PORTAL-1`. |
| Assignee | A User responsible for a Task. |
| Tag | A colored label belonging to a Project. |
| Revision | A recorded change to Task fields and who made it. |
| Conversation | The Comments and Agent output on a Task or Wiki. |
| Comment | Text or files posted by a User, Agent or the system. |
| Internal Note | A Comment marked Internal chat, visible to Users and never delivered to Agents. |
| Attachment | A file added to a Comment or Task description, by a User or an Agent. |
| Question | A multiple-choice question an Agent asks in the Conversation. The first User who answers decides, and the answer reaches the Agent as a Message. |
| Survey | A set of multiple-choice items an Agent uses to collect answers from several Users, on request. Its results reach the Agent in one Message. |
| Expected Respondent | A User assigned to the Task when a Survey was created; the Survey closes by itself once all of them have answered. |
| Delivery | Whether a Comment is queued, delivered or not delivered to the Agent. |
| Timeline | Comments, Revisions and Agent work shown together in time order. |
| Agent | A named Claude Code worker with its own instructions and environment. |
| Default Agent | A Project’s Agent choice assigned to new Tasks when enabled. The first regular Comment starts work. |
| Assignment | Linking an Agent to a Task; a regular Comment starts its work. |
| Session | One Agent's continuing Claude Code conversation on one Task. |
| Job | A period when an Agent runs work for a Session. |
| Turn | A cycle of Agent work ending when it hands control back. |
| Queue | An Agent's ordered list of waiting work. |
| Held | Waiting work whose start failed and needs Retry or a new Comment. |
| Credential | Named Claude authentication used by one or more Agents. |
| Extension | A shared Skill, MCP Server or Plugin assigned to Agents. |
| Development Service | A local database or tool available inside an Agent Container. |
| Worktree | The Task's separate working directory inside an Agent's storage. |
| Setup Script | Project commands that prepare a newly created Worktree. |
| Agent Instructions | Project guidance supplied to Agents working on its Tasks. |
| Repository | The GitHub or GitLab repository linked to a Project or Wiki. |
| Git Connection | Configured access to a GitHub App or GitLab instance. |
| Base Branch | The branch Task Branches start from and pull requests target. |
| Task Branch | The branch dedicated to one Task's changes. |
| Pull Request | A proposal to merge the Task Branch into the Base Branch; called a merge request on GitLab. |
| Wiki | Shared repository-backed knowledge with Chats open to everyone. |
| Chat | One of a Wiki's separate Conversations with its Agent. A Wiki can have many, and each can be continued later. |
| New Chat | Start a clean Chat in a Wiki without losing the others. |
| Delete Chat | Remove one Chat for everyone, keeping the repository files. |
| Follow | Choose to receive alerts for a Task or Wiki. |
| Mute | Silence alerts while keeping your follow choice. |
| Unread | The Task has newer Timeline entries than your read position. |

## Related

- [Agent sessions and queues](agent-sessions-and-queues.md): see how Sessions, Jobs and Turns fit together.
- [Projects and boards](projects-and-boards.md): use Statuses and Categories.

---

← [Roles and limits](roles-and-limits.md) · [Troubleshooting](troubleshooting.md) →
