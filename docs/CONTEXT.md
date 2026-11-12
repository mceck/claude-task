# Claude Task

A team board where tasks are worked by Claude Code agents. People and agents converse through task comments, and each task keeps one continuous agent session until it's closed.

## Language

### People

**User**:
A team member with a login to the app. Each User is either an Admin or a Member.
_Translations_: Utente
_Avoid_: account, person

**Admin**:
A User who also manages users, Agents, Workers, Hosts, Credentials, Extensions, Git Connections and Project Environment Variables, and can permanently delete Projects.
_Translations_: Amministratore

**Member**:
A User who works with Projects, Tasks and Wikis, assigns Agents and chooses the Worker of a Project. Platform configuration is left to Admins.
_Translations_: Membro

**Login**:
A User's authenticated browser or app session, ended by logging out, a password reset, deactivation, or 30 days without activity. Changing your password ends your other Logins.
_Translations_: Accesso
_Avoid_: session (that's the Agent's conversation on a Task)

**Temporary Password**:
A password issued by an Admin, the CLI or the platform, which the User must replace before doing anything else.
_Translations_: Password temporanea
_Avoid_: invited (as a User state)

**Installation**:
One deployment of Claude Task, identified by its URL. The native app can sign in to several.
_Translations_: Installazione

### Board

**Project**:
A body of work with its own Board, Statuses and Tags, run on one Worker and optionally linked to one Repository.
_Translations_: Progetto
_Avoid_: workspace, list, repo

**Project Key**:
The short immutable uppercase code of a Project, used as the prefix of its Task Keys.
_Translations_: Chiave del progetto

**Project Kind**:
Whether a Project is an ordinary Project, a Wiki Project or a Schedule Project.
_Translations_: Tipo di progetto

**Archived Project**:
A Project hidden from the Projects list but kept intact.
_Translations_: Progetto archiviato
_Avoid_: archive (for closed Tasks; say closed)

**Base Branch**:
The repository branch a Project's Task Branches start from and its pull requests target.
_Translations_: Branch base

**Board**:
The kanban view of a Project, with one column per Status. Columns of `closed`-category Statuses are shown on request.
_Translations_: Board

**Board Write Access**:
A Project setting that lets its Agents act on every Task of the Project: editing and moving them, writing in their Conversations and starting other Agents. It never lets an Agent close a Task or make a User an Assignee.
_Translations_: Accesso in scrittura al Board
_Avoid_: agent permissions, agent mode, autonomy

**Status**:
A named step in a Project's workflow. Each Status belongs to one Category.
_Translations_: Stato
_Avoid_: column (that's how a Status looks on the Board), state

**Category**:
The fixed meaning of a Status, independent of its name: backlog, open, active, review, done or closed. `closed` ends the Session; `backlog` is only a label for the Board.
_Translations_: Categoria
_Avoid_: status type

**Task**:
A unit of work in a Project. It can be assigned to at most one Agent and to any number of Users.
_Translations_: Task
_Avoid_: ticket, issue, card (card is how a Task looks on the Board)

**Task Key**:
The readable identifier of a Task: its Project Key followed by a sequential number, e.g. `API-42`.
_Translations_: Chiave del task
_Avoid_: task id, task number

**Assignee**:
A User assigned to a Task. Linking an Agent to a Task is an Assignment.
_Translations_: Assegnatario

**Tag**:
A colored label scoped to one Project. A Task can carry several.
_Translations_: Tag
_Avoid_: label

**Priority**:
A Task's urgency: urgent, high, normal, low or none.
_Translations_: Priorità

**Revision**:
A recorded change to a Task's fields, attributed to an Actor.
_Translations_: Revisione
_Avoid_: history entry, audit log

**Actor**:
Whoever performed an action: a User, an Agent or the system.
_Translations_: Attore

### Schedule

**Schedule**:
A recurring job an Admin configures with a name, an Agent, a Worker, a cron expression, a time zone and an initial prompt, optionally tied to a Repository. At every due time it starts a Scheduled Run.
_Translations_: Pianificazione
_Avoid_: cron job, routine

**Schedule Project**:
The Project of kind `schedule` that carries one Schedule, hidden from the Projects list. Each Scheduled Run is a Task of it.
_Translations_: Progetto pianificazione

**Scheduled Run**:
One execution of a Schedule: a Task of its Schedule Project, started by the prompt posted as its first User Comment and closed as `Succeeded` or `Failed` when its Job ends.
_Translations_: Esecuzione pianificata
_Avoid_: job (a Job is one Turn of work), execution

**Skipped Run**:
A due time of a Schedule that did not start a Scheduled Run, recorded in its run history with the reason. It has no Task.
_Translations_: Esecuzione saltata

**Global Schedule**:
A Schedule without a Repository. Its Agent gets the global Task Tools to read and act on every board.
_Translations_: Pianificazione globale

**Read-only Schedule**:
A Schedule whose Jobs have every git push refused by the Git Proxy.
_Translations_: Pianificazione in sola lettura

### Wiki

**Wiki**:
A shared knowledge base kept in a Repository of Markdown files, including its own Skills and conventions, run on one Worker, with a default Agent for new Chats and Chats open to all Users.
_Translations_: Wiki

**Wiki Project**:
The Project of kind `wiki` that carries a Wiki, hidden from the Projects list.
_Translations_: Progetto Wiki

**Backing Task**:
The first Task of a Wiki Project. It holds what all of the Wiki's Chats share: the Task Branch, the pull request and the Wiki's following.
_Translations_: Task portante

**Chat**:
One of a Wiki's separate Conversations, held by one Task of its Wiki Project, with its own Session and its own Agent (the Wiki's default Agent when the Chat starts, changeable at any time). A Wiki has any number of Chats, all open to every User, and each can be continued independently. A Task of an ordinary Project has a single Conversation instead.
_Translations_: Chat
_Avoid_: thread, conversation (for a Wiki's Chat, say Chat)

**New Chat**:
Starting an empty Chat in a Wiki. Existing Chats are kept.
_Translations_: Nuova chat

**Delete Chat**:
Permanently clearing one Chat, with everything in it, for every User. The Wiki's Repository files are kept.
_Translations_: Elimina chat

**Conversation Generation**:
The count of a Task's Delete Chats, which lets clients spot a deletion they missed.
_Translations_: Generazione della conversazione
_Avoid_: chat generation

### Conversation

**Voice Room**:
The shared audio space of a Task, where Users talk to one another live.
_Translations_: Stanza vocale
_Avoid_: voice session (a Session is the Agent's conversation on a Task)

**Conversation**:
A Task's Comments and Agent output, as Users see and write them.
_Translations_: Conversazione
_Avoid_: chat, thread

**Comment**:
An entry in a Task's Conversation, written by a User, an Agent or the system.
_Translations_: Commento
_Avoid_: message (a Message is what an Agent receives)

**Internal Note**:
A Comment between Users that is never delivered to the Agent.
_Translations_: Nota interna
_Avoid_: private comment, hidden comment, internal chat

**Attachment**:
A file added to a Comment or to a Task's description.
_Translations_: Allegato

**Draft**:
An unsent Comment kept per Task, with its Internal Note flag and files.
_Translations_: Bozza

**Chat Dock**:
The row of Minimized Chats at the bottom of the web app. It belongs to the browser, not to the installation: another browser or another computer does not show it.
_Translations_: Dock delle chat
_Avoid_: minimized chats bar, docked chat

**Minimized Chat**:
A Conversation or a Wiki Chat kept in the Chat Dock, out of its page, so it can be read and answered from anywhere in the app. A conversation is either in the Dock or on a page, never both.
_Translations_: Chat minimizzata

**Message**:
What an Agent receives in its Session: one or more Comments merged together, or a system notice such as a Change Notice.
_Translations_: Messaggio
_Avoid_: prompt, input

**Delivery**:
Whether a User's Comment has reached the Agent: queued, delivered (written to the Agent's process, not read yet), handled (the Agent has read it), or not delivered (with a reason).
_Translations_: Consegna

**Scheduled Message**:
A Comment a User writes ahead of time for a chosen date and time. It stays off the Timeline until then, listed on its Task where any User with access can edit, cancel or send it now. When due it is published as an ordinary Comment by its author and follows the usual Delivery. It is published even when it cannot be delivered, and then shows why.
_Translations_: Messaggio pianificato
_Avoid_: delayed comment, queued comment (the Queue is the Agent's)

**Limit Resume**:
A Scheduled Message the platform creates for a Task whose Turn stopped at a Claude usage limit, due just after the limit resets. A Task has at most one pending; a new limit replaces it and a successful Turn before it is due cancels it. It is offered, or created directly when the Task's automatic resume is on, only when the limit reports a reset time.
_Translations_: Ripresa dopo limite
_Avoid_: retry (a Retry releases a Held Queue Entry)

**Automatic Resume**:
A Project setting, copied to each new Task as its own on/off switch, that makes the platform create the Limit Resume without asking.
_Translations_: Ripresa automatica

**Native Command**:
A Comment starting with `/name` that runs as a Claude Code command of its own.
_Translations_: Comando nativo
_Avoid_: chat command, session command, slash comment

**Btw**:
A side question a User asks with `/btw` about a Task's conversation. A forked, tool-less copy of the Session answers it from the conversation so far, while the Agent's own work carries on untouched.
_Translations_: Domanda laterale
_Avoid_: side chat, aside

**Btw Comment**:
A Comment that belongs to a Btw Thread: the User's question or the Agent's answer. It looks like an Internal Note with its own colour and, like one, is never delivered to the Agent.
_Translations_: Commento btw

**Btw Thread**:
The forked Claude conversation behind a Btw, continued by replying to its Comments. It sees the Session as it was when the Btw was asked and never changes it.
_Translations_: Filone btw

**Btw Job**:
A Job that only runs a Btw, queued when no Job of the Session is running.
_Translations_: Job btw

**Clear**:
The `/clear` command: it starts a fresh Claude conversation for the Task, keeping the Comments, the Worktree and the Task Branch, and leaves a Chat Cleared line in the conversation.
_Translations_: Pulizia della chat
_Avoid_: reset

**Chat Cleared line**:
The System Comment that marks where a Clear took effect.
_Translations_: Riga "chat pulita"

**Timeline**:
The chronological record of a Task: Comments, Revisions and the Agent's work, interleaved.
_Translations_: Cronologia
_Avoid_: feed, log, chat

**Timeline Filter**:
The viewer's choice of which Timeline entries to hide: Revisions and Agent Items. Each kind can be hidden on its own; hiding Agent Items keeps the Agent's streaming text, which is the Comment being written.
_Translations_: Filtro della cronologia
_Avoid_: changes toggle, visibility toggle

**Agent Comment**:
A Comment an Agent wrote for humans during a Turn: its text, or files, a Question or a Survey it posted.
_Translations_: Commento dell'agente

**Question**:
A Comment in which an Agent asks Users to choose among options. It stays open until the first User answers it, and the answer reaches the Agent as a Message.
_Translations_: Domanda
_Avoid_: poll, form, prompt

**Survey**:
A Comment in which an Agent, on a User's explicit request, collects answers from several Users. It reaches the Agent as one Message when every expected respondent has answered or someone closes it early.
_Translations_: Sondaggio
_Avoid_: poll, vote

**Expected Respondent**:
A User who was an Assignee of the Task when a Survey was created, and whose answer the Survey waits for.
_Translations_: Rispondente atteso

**Agent Item**:
An entry of the Agent's work on the Timeline that isn't a Comment: Thinking, Activity, a Run, a Turn Summary or a notice.
_Translations_: Elemento dell'agente

**Thinking**:
The Agent's reasoning shown on the Timeline next to its Agent Comment, collapsed by default.
_Translations_: Ragionamento

**Activity**:
The record of an Agent's tool calls between two of its Agent Comments, collapsed by default.
_Translations_: Attività
_Avoid_: tool log, trace

**Turn Summary**:
The Timeline entry closing a Turn, with its duration, effort and outcome.
_Translations_: Riepilogo del turno

**Context Usage**:
How much of the model's context window the Session's conversation fills after its latest Turn, such as `120.2K (53%)`: the prompt tokens of the Turn's last model call plus the reply it produced.
_Translations_: Uso del contesto
_Avoid_: token count, context length

**Live Turn Preview**:
The streamed text, Thinking and status of a running Turn, shown until the stored entries replace it.
_Translations_: Anteprima del turno in corso

**Run**:
A Subagent Run or a Background Command.
_Translations_: Esecuzione
_Avoid_: task, job

**Subagent Run**:
Work an Agent delegates to a Subagent during a Turn; its transcript is shown live only, while the Timeline keeps just how it ended.
_Translations_: Esecuzione del subagente
_Avoid_: task, subtask, child agent, delegation

**Background Command**:
A shell command an Agent leaves running in the background during a Turn; its output stays in the Worker Container, and the Timeline keeps just how it ended.
_Translations_: Comando in background
_Avoid_: background task, background job

**Active Run**:
A Subagent Run or Background Command that hasn't finished yet.
_Translations_: Esecuzione attiva
_Avoid_: running task, agent task

**System Comment**:
A Comment written by the platform itself, e.g. errors, resumes, notifications.
_Translations_: Commento di sistema

**Unseen Changes**:
Edits by Users to a Task made after its Agent last read it, which the Agent can be notified about on request.
_Translations_: Modifiche non viste

**Change Notice**:
The Message that Notify agent sends, listing the Unseen Changes.
_Translations_: Avviso di modifica

**Agent Change Notice**:
The notice opening the first Message a Session receives after its Agent changed, telling the new Agent who it is now and who worked before.
_Translations_: Avviso di cambio agente
_Avoid_: reassignment notice

### Notifications

**Follow**:
A User's choice to receive alerts for a Task.
_Translations_: Segui

**Mute**:
A User's choice to silence a Task's alerts while still following it.
_Translations_: Silenzia

**Read Position**:
The latest Timeline entry of a Task a User has read. A Task is unread while it has newer entries.
_Translations_: Posizione di lettura

**Notification Event**:
A completed Turn, failed Turn, failed Job, User mention or Schedule failure that alerts its recipients.
_Translations_: Evento di notifica

**Alert**:
The phone notification for a Notification Event: its Task, who it is from and an excerpt of what happened. Alerts of one Task stack together like the messages of one chat.
_Translations_: Avviso
_Avoid_: push, notification (alone)

**Device Registration**:
A phone's push token, tied to one Login.
_Translations_: Registrazione del dispositivo

### Agents

**Agent**:
A global, named Claude Code configuration (Credential, model, effort, permission mode, instructions, environment and Extensions), assignable to any Task in any Project and to any Wiki Chat. It has no container of its own: its Jobs run on the Worker of the Task's Project.
_Translations_: Agente
_Avoid_: bot, assistant

**Agent State**:
The summary of an Agent's condition: disabled, idle, or working with the number of its active Jobs and their Tasks.
_Translations_: Stato dell'agente

**Agent Profile**:
An Agent's own Claude Code configuration directory inside a Worker Volume, holding its Skills, Plugins and settings. Every Agent Profile of a Worker Volume shares the same Session transcripts, so any Agent can resume any Session.
_Translations_: Profilo dell'agente
_Avoid_: agent home, claude dir

**Agent Prompt**:
An Agent's own instructions, added to every Session it runs.
_Translations_: Prompt dell'agente
_Avoid_: system prompt (that's the whole composed prompt)

**Credential**:
A named Claude secret that an Agent authenticates with, sent as a Claude OAuth token, an Anthropic API key or an Anthropic auth token. Its rate limits are shared by every Agent using it.
_Translations_: Credenziale
_Avoid_: account, token, API key

**Agent Environment**:
Plain name/value variables an Agent applies to every Job, more specific than the Project's environment variables.
_Translations_: Ambiente dell'agente
_Avoid_: container env, secrets

### Workers

**Worker**:
A global, named execution environment an Admin configures: a Dockerfile, Development Services, CPU and memory limits per Worker Container, and a minimum and a cap of Worker Containers. Each Project runs on exactly one Worker, each Worker runs on exactly one Host, and the Worker starts and stops Worker Containers between its minimum and its cap to work its Queue.
_Translations_: Worker
_Avoid_: runtime, pool, environment, sandbox, remote worker (a remote machine is a Host)

**Host**:
A machine whose Docker daemon runs Worker Containers for the Installation: the Local Host, or a Remote Host. It can run any number of Workers.
_Translations_: Host
_Avoid_: Docker host, node, machine, server, remote worker, code host (that's GitHub or GitLab, reached through a Git Connection)

**Local Host**:
The Host whose Docker daemon the backend reaches directly. An Installation has one when the backend has access to a Docker daemon, and none otherwise.
_Translations_: Host locale

**Remote Host**:
A Host connected to the Installation through its Host Controller.
_Translations_: Host remoto

**Host Controller**:
The platform's process running on a Remote Host that carries out the backend's Docker work there: Builds, Worker Containers, logs and Cleanup.
_Translations_: Controller dell'host
_Avoid_: host agent, daemon, runner

**Host State**:
Whether a Host is connected or disconnected: for the Local Host, whether its Docker daemon answers; for a Remote Host, whether its Host Controller is connected.
_Translations_: Stato dell'host

**Host Token**:
The secret identifying one Remote Host's Host Controller to the backend, shown once when an Admin creates the Remote Host or regenerates it.
_Translations_: Token dell'host

**Worker Container**:
One running instance of a Worker, occupying one Worker Slot. It runs one Job at a time, for any Agent.
_Translations_: Container del Worker
_Avoid_: agent container, instance, replica

**Worker Slot**:
The stable number, from 1 to the Worker's cap, that identifies one Worker Container and its Service Volume. Slots from 1 to the minimum are always on.
_Translations_: Slot del Worker

**Worker Volume**:
The persistent storage shared by every Worker Container of one Worker, mounted as the agent user's home: Bare Clones, Worktrees, Session transcripts, Agent Profiles and installed tools.
_Translations_: Volume del Worker
_Avoid_: agent volume, shared volume

**Service Volume**:
The persistent storage of one Worker Slot, holding the data of its Development Services. It survives the Worker Container being stopped or recreated.
_Translations_: Volume dei servizi

**Worker State**:
The summary of a Worker's condition: disabled, host_offline (its Host is disconnected and none of its Runners is connected), building, build_failed, offline (no Worker Container running), idle or working (with the number of busy Worker Containers).
_Translations_: Stato del Worker

**Base Image**:
The platform-provided image every Worker Image is built on.
_Translations_: Immagine base

**Platform Version**:
The version of the Base Image a Worker builds on, made from the Worker's Claude Code version and the image recipe including the Runner. Workers on the same Claude Code version share one Platform Version.
_Translations_: Versione della piattaforma

**Worker Image**:
A Worker's own image, built from its Dockerfile on top of the Base Image. Every Worker Container of the Worker runs it.
_Translations_: Immagine del Worker
_Avoid_: agent image

**Build**:
One attempt to produce a Worker Image, with its log.
_Translations_: Build

**Cleanup**:
The removal of what the Installation's Workers no longer need from their Hosts and Worker Volumes: outdated images, leftovers of deleted Workers, Worker Slots left above the cap, and Bare Clones and Agent Profiles that no Project or Agent uses there any more.
_Translations_: Pulizia
_Avoid_: prune, garbage collection

**Development Service**:
A local database or tool (PostgreSQL, Redis, MySQL, Mailpit, RustFS/MinIO, Chrome) run inside a Worker Container, with its data in the slot's Service Volume.
_Translations_: Servizio di sviluppo
_Avoid_: services (alone)

**Runner**:
The platform's process inside a Worker Container that carries out Jobs.
_Translations_: Runner
_Avoid_: daemon, agent

**Runner Protocol**:
The versioned message contract between the Runner and the backend.
_Translations_: Protocollo del Runner

**Runner Token**:
The secret identifying one Worker Container's Runner to the backend.
_Translations_: Token del Runner

**Worktree**:
A Task's working directory inside its Worker's Worker Volume: an isolated checkout on its Task Branch when the Project has a Repository.
_Translations_: Worktree
_Avoid_: checkout, workspace, clone

**Bare Clone**:
The repository of one Project inside a Worker Volume, shared by that Project's Worktrees.
_Translations_: Clone bare

### Agent setup

**Task Branch**:
The branch dedicated to a Task, named after its Task Key and fixed once chosen.
_Translations_: Branch del task

**Setup Script**:
A Project-defined script that prepares a newly created Worktree (e.g. installing dependencies).
_Translations_: Script di setup

**Agent Instructions**:
Guidance given to every Agent working on a Project, on top of the repository's own conventions.
_Translations_: Istruzioni dell'agente

**Project Environment Variable**:
A variable a Project gives to every Job on its Tasks, plain or secret.
_Translations_: Variabile d'ambiente del progetto
_Avoid_: project secret (unless it is a secret one)

**Extension**:
An entry of the platform's shared catalog that Admins assign to Agents: a Skill, an MCP Server or a Plugin.
_Translations_: Estensione

**Skill**:
A Claude Code skill whose files the platform's catalog stores and installs for the Agents it's assigned to.
_Translations_: Skill

**Platform Skill**:
A Skill the platform ships itself, carrying the guidance on how an Agent works its Task and its workspace. Every Agent has it by default: it can be unassigned but not deleted, and its content follows the platform version.
_Translations_: Skill della piattaforma
_Avoid_: built-in skill, system skill

**Project Skill**:
A skill or command the repository itself carries in its `.claude/` directory, which `claude` loads in the Worktree next to the Agent's Skills. The platform only reads it to suggest it in the composer.
_Translations_: Skill del progetto
_Avoid_: local skill, repository skill

**MCP Server**:
An external tool server in the platform's catalog, made available to the Agents it's assigned to.
_Translations_: Server MCP

**Plugin**:
A Claude Code plugin from a marketplace, kept in the platform's catalog and installed into the Agent Profiles of the Agents it's assigned to. Unlike a catalog Skill, the platform stores only where to install it from, not its files.
_Translations_: Plugin

**Task Tools**:
The actions an Agent can take from inside its Session: reading and searching Tasks and Conversations, editing and moving its own Task, creating new ones, opening a pull request, and posting files, Questions and Surveys to its Task's Conversation. A global Schedule's Agent also gets the global Task Tools, which act on the Tasks of every Project.
_Translations_: Strumenti del task

### Execution

**Assignment**:
Linking an Agent to a Task. It doesn't start any work by itself: the Session stays `pending` until the first Comment is delivered to it, whatever the Task's Status. That is normally a User Comment; it can also be an Agent Comment written through the Task Tools, by another Agent with Board Write Access or by the Agent itself from a global Schedule.
_Translations_: Assegnazione
_Avoid_: dispatch, scheduling

**Session**:
The single continuous Claude Code conversation of a Task, or of a Wiki's Chat, whichever Agent works it. Changing the Agent resumes the same conversation with the new Agent's configuration. It lasts until the Task is closed (or the Chat deleted) and resumes when the Task is reopened.
_Translations_: Sessione
_Avoid_: conversation, thread

**Claude Session Identity**:
The id a Session's Claude Code conversation runs under. It starts equal to the Session and changes only when a Chat restarts from its history.
_Translations_: Identità della sessione Claude

**Job**:
One execution of a Session on a Worker Container, with the configuration of the Task's Agent at dispatch, from start to exit. A Worker Container, a Session and a Worktree each have at most one Job at a time; an Agent can have Jobs on any number of Worker Containers.
_Translations_: Job
_Avoid_: execution, process

**Job Token**:
The per-Job secret an Agent uses for Task Tools and the Git Proxy, valid only while its Job is active.
_Translations_: Token del Job

**Preparation Retry**:
The Runner's automatic second attempt at preparing a Worktree after a failure, at most three per Job, a few seconds apart. The Job, its Comments and its Queue Entry are the same: only the preparation repeats.
_Translations_: Nuovo tentativo di preparazione
_Avoid_: retry (a Retry releases a Held Queue Entry)

**Turn**:
One cycle in which the Agent works on the Messages it has received until it stops and hands control back. A Job contains one or more Turns.
_Translations_: Turno
_Avoid_: step, iteration

**Queue**:
The ordered list of pending work of one Worker, for the Tasks of every Project it runs, whatever their Agent.
_Translations_: Coda
_Avoid_: backlog (that's a Status name)

**Queue Entry**:
Pending work for one Task in its Worker's Queue: starting its Session, delivering its pending Messages, or resuming an interrupted Turn.
_Translations_: Voce della coda

**Held**:
A Queue Entry whose start failed. It stays in the Queue until a Retry or a new Comment.
_Translations_: Sospesa

**Retry**:
The action that releases a held Queue Entry.
_Translations_: Riprova

**Interrupt**:
Stopping the current Turn without ending the Session. Labelled "Stop" in the UI.
_Translations_: Interruzione
_Avoid_: cancel, kill (those end the Job)

**Interrupt and send**:
An Interrupt of the Agent's running Turn so it reads a User's Comment at once instead of after its current tool calls: a new Comment posted with it, or, from an empty composer, the User's own Comments still waiting. Ctrl/⌘+Enter in the composer.
_Translations_: Interrompi e invia
_Avoid_: send now (that is a Scheduled Message or Survey action), force send

### Git integration

**Repository**:
The code repository linked to a Project, on GitHub or GitLab, reached through one Git Connection. Several Projects may link the same Repository.
_Translations_: Repository
_Avoid_: repo (in user-facing copy)

**ClickUp Link**:
The optional connection of a Project to a ClickUp List or View, through a ClickUp token Credential. The Project's Statuses mirror ClickUp's, its matching tasks are imported as Tasks, and the Task Status syncs both ways.
_Translations_: Collegamento ClickUp
_Avoid_: integration

**Mirrored Status**:
A Status of a Project with a ClickUp Link, kept equal to a ClickUp status. Its name, color and place are managed by ClickUp; its Category is set in claude-task.
_Translations_: Stato rispecchiato

**Unlinked Task**:
A Task whose ClickUp task left the filter, was deleted or moved on ClickUp. It stays on the Board as a local Task and relinks if it returns.
_Translations_: Task scollegato

**Git Connection**:
A configured access to one code host: a GitHub App, or a GitLab instance with a token. There can be several Git Connections of any provider. Each Repository is reached through exactly one of them.
_Translations_: Connessione Git
_Avoid_: integration, provider (the provider is the kind of a Git Connection: GitHub or GitLab)

**Connection Secret**:
The private key or token a Git Connection authenticates with.
_Translations_: Segreto della connessione
_Avoid_: credential (a Credential is the Claude secret)

**Environment Connection**:
A Git Connection defined by the backend's environment instead of the UI. It's read-only.
_Translations_: Connessione d'ambiente

**GitHub App Installation**:
An organization's or user's grant allowing a GitHub Git Connection's App to access selected Repositories.
_Translations_: Installazione dell'app GitHub

**Git Proxy**:
The backend endpoint that Worker Containers use as their git remote. It admits only the active Job's Repository and forwards traffic to the provider with the Connection Secret, which stays in the backend.
_Translations_: Proxy Git
_Avoid_: mirror, gateway

**Git Credential Helper**:
The Runner's companion that hands git the Job Token when it talks to the Git Proxy.
_Translations_: Helper delle credenziali Git
_Avoid_: credential helper (alone)

**Push Policy**:
The Git Proxy's rule that an Agent may push only its own Task Branch (force pushes included), never other branches, tags or deletions.
_Translations_: Politica di push

**Commit Identity**:
The name and email an Agent's commits carry.
_Translations_: Identità dei commit

**Pull Request**:
A request to review and merge a Task Branch into its Project's Base Branch, called a merge request on GitLab. Its state is tracked separately from the Task's Status, and merging it never changes the Status.
_Translations_: Pull Request
_Avoid_: merge request (except in GitLab-facing UI copy)

**Base Branch Protection**:
The provider-side rules that keep the Connection Secret from pushing directly to the Base Branch. It's informational: the Push Policy already blocks Agents.
_Translations_: Protezione del branch base
