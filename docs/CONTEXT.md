# Claude Task

A team board where tasks are worked by Claude Code agents. People and agents converse through task comments, and each task keeps one continuous agent session until it's closed.

## Language

### People

**User**:
A team member with a login to the app. Each User is either an Admin or a Member.
_Avoid_: account, person

**Admin**:
A User who also manages users, Agents, Credentials, Extensions, Git Connections and Project Environment Variables, and can permanently delete Projects.

**Member**:
A User who works with Projects, Tasks and Wikis and assigns Agents. Platform configuration is left to Admins.

**Login**:
A User's authenticated browser or app session, ended by logging out, a password reset, deactivation, or 30 days without activity. Changing your password ends your other Logins.
_Avoid_: session (that's the Agent's conversation on a Task)

**Temporary Password**:
A password issued by an Admin, the CLI or the platform, which the User must replace before doing anything else.
_Avoid_: invited (as a User state)

**Installation**:
One deployment of Claude Task, identified by its URL. The native app can sign in to several.

### Board

**Project**:
A body of work with its own Board, Statuses and Tags, optionally linked to one Repository.
_Avoid_: workspace, list, repo

**Project Key**:
The short immutable uppercase code of a Project, used as the prefix of its Task Keys.

**Project Kind**:
Whether a Project is an ordinary Project or a Wiki Project.

**Archived Project**:
A Project hidden from the Projects list but kept intact.
_Avoid_: archive (for closed Tasks; say closed)

**Base Branch**:
The repository branch a Project's Task Branches start from and its pull requests target.

**Board**:
The kanban view of a Project, with one column per Status. Columns of `closed`-category Statuses are shown on request.

**Status**:
A named step in a Project's workflow. Each Status belongs to one Category.
_Avoid_: column (that's how a Status looks on the Board), state

**Category**:
The fixed meaning of a Status, independent of its name: open, active, review, done or closed. Only `closed` has an effect on Agents: it ends the Session.
_Avoid_: status type

**Task**:
A unit of work in a Project. It can be assigned to at most one Agent and to any number of Users.
_Avoid_: ticket, issue, card (card is how a Task looks on the Board)

**Task Key**:
The readable identifier of a Task: its Project Key followed by a sequential number, e.g. `API-42`.
_Avoid_: task id, task number

**Assignee**:
A User assigned to a Task. Linking an Agent to a Task is an Assignment.

**Tag**:
A colored label scoped to one Project. A Task can carry several.
_Avoid_: label

**Priority**:
A Task's urgency: urgent, high, normal, low or none.

**Revision**:
A recorded change to a Task's fields, attributed to an Actor.
_Avoid_: history entry, audit log

**Actor**:
Whoever performed an action: a User, an Agent or the system.

### Wiki

**Wiki**:
A shared knowledge base kept in a Repository of Markdown files, including its own Skills and conventions, with one assigned Agent and a Conversation open to all Users.

**Wiki Project**:
The Project of kind `wiki` that carries a Wiki, hidden from the Projects list.

**Backing Task**:
The single Task of a Wiki Project, whose Conversation and Session are the Wiki's.

**Reset Chat**:
Clearing a Wiki's Conversation for every User and starting a fresh Claude conversation on the next Comment, while preserving its Repository files.

**Conversation Generation**:
The count of a Task's Reset Chats, which lets clients spot a reset they missed.
_Avoid_: chat generation

### Conversation

**Voice Room**:
The shared audio space of a Task, where Users talk to one another live.
_Avoid_: voice session (a Session is the Agent's conversation on a Task)

**Conversation**:
A Task's Comments and Agent output, as Users see and write them.
_Avoid_: chat, thread

**Comment**:
An entry in a Task's Conversation, written by a User, an Agent or the system.
_Avoid_: message (a Message is what an Agent receives)

**Internal Note**:
A Comment between Users that is never delivered to the Agent.
_Avoid_: private comment, hidden comment, internal chat

**Attachment**:
A file added to a Comment or to a Task's description.

**Draft**:
An unsent Comment kept per Task, with its Internal Note flag and files.

**Message**:
What an Agent receives in its Session: one or more Comments merged together, or a system notice such as a Change Notice.
_Avoid_: prompt, input

**Delivery**:
Whether a User's Comment has reached the Agent: queued, delivered, or not delivered (with a reason).

**Native Command**:
A Comment starting with `/name` that runs as a Claude Code command of its own.
_Avoid_: chat command, session command, slash comment

**Timeline**:
The chronological record of a Task: Comments, Revisions and the Agent's work, interleaved.
_Avoid_: feed, log, chat

**Agent Comment**:
A Comment an Agent wrote for humans during a Turn: its text, or files, a Question or a Survey it posted.

**Question**:
A Comment in which an Agent asks Users to choose among options. It stays open until the first User answers it, and the answer reaches the Agent as a Message.
_Avoid_: poll, form, prompt

**Survey**:
A Comment in which an Agent, on a User's explicit request, collects answers from several Users. It reaches the Agent as one Message when every expected respondent has answered or someone closes it early.
_Avoid_: poll, vote

**Expected Respondent**:
A User who was an Assignee of the Task when a Survey was created, and whose answer the Survey waits for.

**Agent Item**:
An entry of the Agent's work on the Timeline that isn't a Comment: Thinking, Activity, a Turn Summary or a notice.

**Thinking**:
The Agent's reasoning shown on the Timeline next to its Agent Comment, collapsed by default.

**Activity**:
The record of an Agent's tool calls between two of its Agent Comments, collapsed by default.
_Avoid_: tool log, trace

**Turn Summary**:
The Timeline entry closing a Turn, with its duration, effort and outcome.

**Live Turn Preview**:
The streamed text, Thinking and status of a running Turn, shown until the stored entries replace it.

**System Comment**:
A Comment written by the platform itself, e.g. errors, resumes, notifications.

**Unseen Changes**:
Edits by Users to a Task made after its Agent last read it, which the Agent can be notified about on request.

**Change Notice**:
The Message that Notify agent sends, listing the Unseen Changes.

### Notifications

**Follow**:
A User's choice to receive alerts for a Task.

**Mute**:
A User's choice to silence a Task's alerts while still following it.

**Read Position**:
The latest Timeline entry of a Task a User has read. A Task is unread while it has newer entries.

**Notification Event**:
A completed Turn, failed Turn, failed Job or User mention that alerts its recipients.

**Device Registration**:
A phone's push token, tied to one Login.

### Agents

**Agent**:
A global, named Claude Code worker with its own environment, Credential and instructions, assignable to any Task in any Project.
_Avoid_: bot, assistant, worker

**Agent State**:
The summary of an Agent's condition: disabled, building, build_failed, offline, idle or working.

**Agent Prompt**:
An Agent's own instructions, added to every Session it runs.
_Avoid_: system prompt (that's the whole composed prompt)

**Credential**:
A named Claude secret that an Agent authenticates with. Its rate limits are shared by every Agent using it.
_Avoid_: account, token, API key

**Agent Container**:
The one long-lived container in which an Agent works.
_Avoid_: sandbox, VM, environment

**Agent Volume**:
The persistent storage of an Agent Container, holding its repositories, Worktrees, Session transcripts, installed tools, Skills and Development Service data.

**Base Image**:
The platform-provided image every Agent's environment is built on.

**Platform Version**:
The version of the Base Image, made from the pinned Claude Code version and the image recipe including the Runner.

**Agent Image**:
An Agent's own image, built from its Dockerfile on top of the Base Image.

**Build**:
One attempt to produce an Agent Image, with its log.

**Development Service**:
A local database or tool (PostgreSQL, Redis, MySQL, Mailpit, RustFS/MinIO, Chrome) run inside an Agent Container.
_Avoid_: services (alone)

**Runner**:
The platform's process inside an Agent Container that carries out Jobs.
_Avoid_: daemon, worker, agent

**Runner Protocol**:
The versioned message contract between the Runner and the backend.

**Runner Token**:
The secret identifying one Agent Container's Runner to the backend.

**Worktree**:
A Task's working directory inside an Agent Volume: an isolated checkout on its Task Branch when the Project has a Repository.
_Avoid_: checkout, workspace, clone

**Bare Clone**:
The repository of one Project inside an Agent Volume, shared by that Project's Worktrees.

**Task Branch**:
The branch dedicated to a Task, named after its Task Key and fixed once chosen.

**Setup Script**:
A Project-defined script that prepares a newly created Worktree (e.g. installing dependencies).

**Agent Instructions**:
Guidance given to every Agent working on a Project, on top of the repository's own conventions.

**Project Environment Variable**:
A variable a Project gives to every Job on its Tasks, plain or secret.
_Avoid_: project secret (unless it is a secret one)

**Extension**:
An entry of the platform's shared catalog that Admins assign to Agents: a Skill, an MCP Server or a Plugin.

**Skill**:
A Claude Code skill whose files the platform's catalog stores and installs for the Agents it's assigned to.

**MCP Server**:
An external tool server in the platform's catalog, made available to the Agents it's assigned to.

**Plugin**:
A Claude Code plugin from a marketplace, kept in the platform's catalog and installed into the Agent Containers of the Agents it's assigned to. Unlike a catalog Skill, the platform stores only where to install it from, not its files.

**Task Tools**:
The actions an Agent can take from inside its Session: reading, editing and moving its own Task, reading other Tasks in the Project, creating new ones, opening a pull request, and posting files, Questions and Surveys to its Task's Conversation.

### Execution

**Assignment**:
Linking an Agent to a Task. It doesn't start any work by itself: the Session stays `pending` until the first User Comment on the Task, whatever the Task's Status.
_Avoid_: dispatch, scheduling

**Session**:
The single continuous Claude Code conversation between a Task and one Agent. It lasts until the Task is closed and resumes when the Task is reopened.
_Avoid_: conversation, chat, thread, run

**Claude Session Identity**:
The id a Session's Claude Code conversation runs under. It starts equal to the Session and changes on Reset Chat.

**Job**:
One execution of an Agent on a Session, from start to exit. An Agent runs at most one Job at a time.
_Avoid_: run, execution, process

**Job Token**:
The per-Job secret an Agent uses for Task Tools and the Git Proxy, valid only while its Job is active.

**Turn**:
One cycle in which the Agent works on the Messages it has received until it stops and hands control back. A Job contains one or more Turns.
_Avoid_: step, iteration

**Queue**:
The ordered list of pending work for one Agent.
_Avoid_: backlog (that's a Status name)

**Queue Entry**:
Pending work for one Task in an Agent's Queue: starting its Session, delivering its pending Messages, or resuming an interrupted Turn.

**Held**:
A Queue Entry whose start failed. It stays in the Queue until a Retry or a new Comment.

**Retry**:
The action that releases a held Queue Entry.

**Interrupt**:
Stopping the current Turn without ending the Session. Labelled "Stop" in the UI.
_Avoid_: cancel, kill (those end the Job)

### Git integration

**Repository**:
The code repository linked to a Project, on GitHub or GitLab, reached through one Git Connection. Several Projects may link the same Repository.
_Avoid_: repo (in user-facing copy)

**Git Connection**:
A configured access to one code host: a GitHub App, or a GitLab instance with a token. There can be several Git Connections of any provider. Each Repository is reached through exactly one of them.
_Avoid_: integration, provider (the provider is the kind of a Git Connection: GitHub or GitLab)

**Connection Secret**:
The private key or token a Git Connection authenticates with.
_Avoid_: credential (a Credential is the Claude secret)

**Environment Connection**:
A Git Connection defined by the backend's environment instead of the UI. It's read-only.

**GitHub App Installation**:
An organization's or user's grant allowing a GitHub Git Connection's App to access selected Repositories.

**Git Proxy**:
The backend endpoint that Agent Containers use as their git remote. It admits only the active Job's Repository and forwards traffic to the provider with the Connection Secret, which stays in the backend.
_Avoid_: mirror, gateway

**Git Credential Helper**:
The Runner's companion that hands git the Job Token when it talks to the Git Proxy.
_Avoid_: credential helper (alone)

**Push Policy**:
The Git Proxy's rule that an Agent may push only its own Task Branch (force pushes included), never other branches, tags or deletions.

**Commit Identity**:
The name and email an Agent's commits carry.

**Pull Request**:
A request to review and merge a Task Branch into its Project's Base Branch, called a merge request on GitLab. Its state is independent of the Task's Status.
_Avoid_: merge request (except in GitLab-facing UI copy)

**Base Branch Protection**:
The provider-side rules that keep the Connection Secret from pushing directly to the Base Branch. It's informational: the Push Policy already blocks Agents.
