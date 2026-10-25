# Claude Task

A team board where tasks are worked by Claude Code agents. People and agents converse through task comments, and each task keeps one continuous agent session until it's closed.

## Language

### People

**User**:
A team member with a login to the app. Each User is either an Admin or a Member.
_Avoid_: account, person

**Admin**:
A User who also manages users, Agents, Credentials and project secrets.

**Member**:
A User who works with Projects and Tasks and assigns Agents, but doesn't manage Agents, Credentials or users.

**Login**:
A User's authenticated browser session, ended by logging out, a password reset, deactivation, or 30 days without activity. Changing your password ends your other Logins.
_Avoid_: session (that's the Agent's conversation on a Task)

### Board

**Project**:
A body of work tied to exactly one code repository, with its own Board, Statuses and Labels.
_Avoid_: workspace, list, repo

**Project Key**:
The short immutable uppercase code of a Project, used as the prefix of its Task Keys.

**Base Branch**:
The repository branch a Project's Task Branches start from and its pull requests target.

**Board**:
The kanban view of a Project, with one column per non-closed Status.

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

**Revision**:
A recorded change to a Task's fields, attributed to an Actor.
_Avoid_: history entry, audit log

**Actor**:
Whoever performed an action: a User, an Agent or the system.

### Conversation

**Comment**:
An entry in a Task's conversation, written by a User, an Agent or the system.
_Avoid_: message (a Message is what an Agent receives)

**Internal Note**:
A Comment between Users that is never delivered to the Agent.
_Avoid_: private comment, hidden comment

**Message**:
What an Agent receives in its Session: one or more Comments merged together, or a system notice such as a change notification.
_Avoid_: prompt, input

**Delivery**:
Whether a User's Comment has reached the Agent: queued, delivered, or not delivered (with a reason).

**Timeline**:
The chronological record of a Task: Comments, Revisions and the Agent's work, interleaved.
_Avoid_: feed, log, chat

**Agent Comment**:
A Comment holding the text an Agent wrote for humans during a Turn.

**Thinking**:
The Agent's reasoning shown on the Timeline next to its Agent Comment, collapsed by default.

**Activity**:
The record of an Agent's tool calls between two of its Agent Comments, collapsed by default.
_Avoid_: tool log, trace

**Turn Summary**:
The Timeline entry closing a Turn, with its duration, effort and outcome.

**System Comment**:
A Comment written by the platform itself, e.g. errors, resumes, notifications.

**Unseen Changes**:
Edits by Users to a Task made after its Agent last read it, which the Agent can be notified about on request.

### Agents

**Agent**:
A global, named Claude Code worker with its own environment, Credential and instructions, assignable to any Task in any Project.
_Avoid_: bot, assistant, worker

**Credential**:
A named Claude secret that an Agent authenticates with. Its rate limits are shared by every Agent using it.
_Avoid_: account, token, API key

**Agent Container**:
The one long-lived container in which an Agent works.
_Avoid_: sandbox, VM, environment

**Agent Volume**:
The persistent storage of an Agent Container, holding its repositories, Worktrees and Session transcripts.

**Base Image**:
The platform-provided image every Agent's environment is built on.

**Runner**:
The platform's process inside an Agent Container that carries out Jobs.
_Avoid_: daemon, worker, agent

**Worktree**:
The isolated checkout of a Task's repository inside an Agent Volume, on that Task's Task Branch.
_Avoid_: checkout, workspace, clone

**Task Branch**:
The branch dedicated to a Task, named after its Task Key and fixed once chosen.

**Setup Script**:
A Project-defined script that prepares a newly created Worktree (e.g. installing dependencies).

**Agent Instructions**:
Guidance given to every Agent working on a Project, on top of the repository's own conventions.

**Task Tools**:
The actions an Agent can take on Tasks from inside its Session: reading, editing and moving its own Task, reading other Tasks in the Project, creating new ones, and opening a pull request.

### Execution

**Assignment**:
Linking an Agent to a Task. It's the only trigger that starts an Agent's work, whatever the Task's Status.
_Avoid_: dispatch, scheduling

**Session**:
The single continuous Claude Code conversation between a Task and one Agent. It lasts until the Task is closed and resumes when the Task is reopened.
_Avoid_: conversation, chat, thread, run

**Job**:
One execution of an Agent on a Session, from start to exit. An Agent runs at most one Job at a time.
_Avoid_: run, execution, process

**Turn**:
One cycle in which the Agent works on the Messages it has received until it stops and hands control back. A Job contains one or more Turns.
_Avoid_: step, iteration

**Queue**:
The ordered list of pending work for one Agent.
_Avoid_: backlog (that's a Status name)

**Queue Entry**:
Pending work for one Task in an Agent's Queue: starting its Session, delivering its pending Messages, or resuming an interrupted Turn.

**Interrupt**:
Stopping the current Turn without ending the Session.
_Avoid_: cancel, kill (those end the Job)
