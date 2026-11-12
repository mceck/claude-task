[Manual](README.md) › Reference

# Understand the terms

These are the terms you will meet while using Claude Task.

| Term | Meaning |
| --- | --- |
| User | A team member who can sign in, with the Member or Admin role. |
| Admin | A User who can manage platform configuration and access. |
| Btw | A side question asked with `/btw`, answered from a copy of the Agent's conversation without interrupting its work. Its Comments have their own colour and never reach the Agent. |
| Clear | The `/clear` command: the Agent starts a fresh conversation, while every Comment stays and a line marks the moment. |
| Login | Your authenticated access from a browser or native app. |
| Installation | One deployment of Claude Task at its own URL. |
| Project | A body of work with its own Board, Statuses and Tags. |
| Project Key | The permanent uppercase prefix of a Project's Task Keys. |
| Board | A Project's Tasks arranged in columns by Status. |
| Status | A named step in the workflow, such as Todo or Done. |
| Category | The meaning of a Status: backlog, open, active, review, done or closed. |
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
| Chat Dock | The row of Minimized Chats at the bottom of the web app, kept in your browser. |
| Minimized Chat | A Conversation or Wiki Chat kept in the Chat Dock, out of its page, so you can read and answer it from anywhere. |
| Agent | A named Claude Code configuration: Credential, model, instructions, environment and Extensions. Its Jobs run on Workers. |
| Default Agent | A Project’s Agent choice assigned to new Tasks when enabled. The first regular Comment starts work. |
| Worker | A Docker execution environment with a Dockerfile, Development Services, limits and a number of Worker Containers. Every Project, Wiki and Schedule runs on one Worker. |
| Host | The machine whose Docker daemon runs a Worker's containers, images and volumes. |
| Local Host | The backend's own Docker machine, named Local. |
| Remote Host | Another machine connected to the backend by a Host Controller. |
| Host Controller | The process you run on a Remote Host; it connects outward to let the backend manage Docker there. |
| Host Token | The one-time secret used to connect one Remote Host's Controller. |
| Worker Container | One running container of a Worker, one per Worker Slot. It runs one Job at a time for any Agent. |
| Worker Slot | A numbered place in a Worker, from 1 to its cap. It keeps its own Development Service data. |
| Worker Image | The image built from a Worker's Dockerfile on top of the platform Base Image. |
| Base Image | The platform image `claude-task/agent-base`, with Claude Code, the Runner, mise and the `agent` user. |
| Worker Volume | The storage shared by every Worker Container of a Worker: repositories, Worktrees, Claude transcripts, Agent Profiles and installed tools. |
| Service Volume | The storage of one Worker Slot's Development Services, kept across container restarts. |
| Agent Profile | An Agent's own Claude Code configuration directory inside a Worker Volume, holding its Skills, Plugins and settings. |
| Build | One attempt to build a Worker Image from its Dockerfile, with a log and an outcome. |
| Worker State | The status shown for a Worker: idle, working, offline, host offline, building, build failed or disabled. |
| Assignment | Linking an Agent to a Task; a regular Comment starts its work. |
| Session | One continuing Claude Code conversation on one Task or Wiki Chat, whichever Agent works it. |
| Job | A period when an Agent runs work for a Session in a Worker Container. |
| Turn | A cycle of Agent work ending when it hands control back. |
| Queue | A Worker's ordered list of waiting work. |
| Held | Waiting work whose start failed and needs Retry or a new Comment. |
| Run | A piece of work the Agent hands off while its Turn continues: a Subagent Run or a Background Command, listed in the bar above the composer. |
| Subagent Run | A Run in which a subagent works on part of the Agent's task. Read its text and tool calls live from the bar. |
| Background Command | A Run in which a command keeps going after the Agent has moved on; its entry reports how it ended. |
| Credential | Named Claude authentication used by one or more Agents. |
| Extension | A shared Skill, MCP Server or Plugin assigned to Agents. |
| Development Service | A local database or tool available inside a Worker Container. |
| Worktree | The Task's separate working directory inside a Worker Volume. |
| Setup Script | Project commands that prepare a newly created Worktree. |
| Agent Instructions | Project guidance supplied to Agents working on its Tasks. |
| Repository | The GitHub or GitLab repository linked to a Project or Wiki. |
| Git Connection | Configured access to a GitHub App or GitLab instance. |
| Base Branch | The branch Task Branches start from and pull requests target. |
| Task Branch | The branch dedicated to one Task's changes. |
| Pull Request | A proposal to merge the Task Branch into the Base Branch; called a merge request on GitLab. |
| Schedule | An Agent's recurring work, set by an Admin with a cron expression, a time zone and a prompt. |
| Scheduled Run | One execution of a Schedule: a Task that closes as Succeeded or Failed when the Agent's first Job ends. |
| Skipped run | A due time of a Schedule that started no run, shown in its history with the reason. |
| Global Schedule | A Schedule without a Repository, whose Agent works on the boards. |
| Read-only Schedule | A Schedule whose Agent cannot push to the Repository. |
| Wiki | Shared repository-backed knowledge with Chats open to everyone. |
| Chat | One of a Wiki's separate Conversations with its Agent. A Wiki can have many, and each can be continued later. |
| New Chat | Start a clean Chat in a Wiki without losing the others. |
| Delete Chat | Remove one Chat for everyone, keeping the repository files. |
| Follow | Choose to receive alerts for a Task or Wiki. |
| Mute | Silence alerts while keeping your follow choice. |
| Unread | The Task has newer Timeline entries than your read position. |

## Related

- [Agent sessions and queues](agent-sessions-and-queues.md): see how Sessions, Jobs and Turns fit together.
- [Workers](workers.md): see how Worker Containers, Slots and Volumes fit together.
- [Remote Hosts](hosts.md): see how machines and Controllers relate to Workers.
- [Projects and boards](projects-and-boards.md): use Statuses and Categories.

---

← [Roles and limits](roles-and-limits.md) · [Troubleshooting](troubleshooting.md) →
