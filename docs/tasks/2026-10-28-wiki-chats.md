---
status: done
---

# Wiki Chats: keep, browse and continue past conversations

## Specs

- [Wikis](../specs/wikis.md)
- [Agent sessions](../specs/agent-sessions.md)
- [Conversation](../specs/conversation.md)
- [Clients](../specs/clients.md)
- [Runner](../specs/runner.md)

## Problem Statement

A Wiki has a single conversation. Starting over with **Reset Chat** is the only way to get a clean Claude session, and it deletes everything: Comments, Agent work, Turns and stream events. Users lose the history of what was asked and answered, cannot look anything up in it, and cannot go back to an earlier conversation and keep talking to the Agent about it.

## Solution

A Wiki has any number of **Chats**, all open to every User. A User starts a **New Chat** whenever they want a clean Claude session; the previous Chats stay in a list next to the conversation, readable and continuable at any time. Each Chat has its own Claude conversation, so continuing an old Chat resumes it exactly where it stopped. A Chat can be renamed and permanently deleted. The Wiki's Repository, Worktree, Task Branch and pull request stay shared by all its Chats.

## User Stories

1. As a User, I want to start a New Chat in a Wiki, so that the Agent begins from a clean Claude session without me losing the previous conversation.
2. As a User, I want the Chat to exist only once I send its first Comment, so that no empty Chats pile up.
3. As a User, I want to see the list of a Wiki's Chats ordered by latest activity, so that I can find the one I need.
4. As a User, I want each Chat in the list to show its title, the time of its last Comment, an unread indicator and whether the Agent is working on it, so that I can tell them apart at a glance.
5. As a User, I want opening a Wiki to show its most recently active Chat, so that I land where the last conversation was.
6. As a User, I want to open an old Chat and read its full history, including the Agent's work, so that I can consult what was discussed.
7. As a User, I want to write in an old Chat and have the Agent continue that same Claude conversation, so that it remembers the context.
8. As a User, I want a Chat's title to come from its first Comment, so that I recognise it without naming it.
9. As a User, I want to rename a Chat, so that I can give it a meaningful name for everyone.
10. As a User, I want to delete a Chat permanently, with a confirmation, so that I can remove conversations that contain something that must not stay.
11. As a User, I want a deleted Chat to vanish at once for everyone who has it open, so that nobody keeps reading or writing in it.
12. As a User, I want deleting a Chat while the Agent is working on it to cancel that work and discard its output, so that nothing from the deleted Chat reappears.
13. As a User, I want every Wiki I already have to keep its current conversation as its first Chat, so that nothing is lost on upgrade.
14. As a User, I want a Chat run by a previous Agent to stay readable after the Wiki's Agent changed, so that I do not lose its history.
15. As a User, I want to be told why I cannot write in such a Chat and which Agent runs it, so that I know to reassign the Wiki to that Agent to continue it.
16. As a User, I want the Chat to continue after the Wiki goes back to its original Agent, so that reassigning is reversible.
17. As a User, I want a Chat whose Claude conversation is no longer available to keep working, restarting from its earlier Comments, so that an old Chat never becomes a dead end.
18. As a User, I want a note in the Chat when its conversation is lost, so that I know the Agent's memory is rebuilt from the Comments rather than the original conversation.
19. As a User following a Wiki, I want notifications for any of its Chats, and the notification to open the right Chat, so that I do not miss a reply.
20. As a User, I want unread positions and unsent Drafts and Internal Note flags to be kept per Chat, so that switching Chats does not mix them up.
21. As a User, I want two Chats of one Wiki to queue like any two pieces of work of an Agent, so that the Agent still does one thing at a time.
22. As a User, I want every Chat to share the Wiki's Repository, Task Branch and pull request, so that the Wiki stays one body of knowledge.
23. As a User of the Flutter app, I want the Chat list beside the conversation on wide windows and as a step before it on phones, so that navigation fits the screen.
24. As a User of the Flutter app, I want my cached Chats to be readable offline and to drop a Chat that was deleted while I was offline, so that the cache never shows deleted content.
25. As a User, I want deleting a Wiki to delete all its Chats, so that nothing remains in the app.
26. As an Agent, I want my Task Tools to act on the Chat my Job belongs to, so that my replies land in the right conversation.
27. As an Admin, I want Wikis, Agents and the Queue to keep working as before for everything that is not a Chat, so that Tasks are unaffected.

## Implementation Decisions

- **A Chat is a Task of the Wiki's Wiki Project.** Comments, Agent work, Turns, Sessions, Jobs, Queue Entries, read positions, Drafts, notifications and Task Tools already work per Task, so each Chat gets all of them without a new entity or a Chat reference on every record. The first Task of the Project (the backing Task) also carries what the Wiki shares: Task Branch, pull request and the Wiki's following. Ordinary Tasks are unaffected. (This replaces the first design, a Chat entity with a chat reference on every record, which would have touched every runtime path.)
- **Chats share one Worktree, Task Branch and pull request.** Worktree paths, the branch chosen at dispatch, the Git Proxy grant and `open_pull_request` all resolve to the backing Task for a Wiki's Chats.
- **A Chat's Agent is the Wiki's Agent when the Chat was created.** The Wiki's Agent now lives on the Wiki Project (its default Agent, backfilled by the migration from the backing Task). Changing it pauses the Sessions of Chats run by the previous Agent and wakes the new Agent's, without reassigning any Task. A User Comment in a Chat whose Agent is not the Wiki's is refused with `409` naming the Agent; an empty Chat takes the current Agent instead.
- **New Chat reserves the Wiki's empty Task** (one with no Comments), creating a Task only when there is none. A Chat is listed from its first Comment. Its title is that first User Comment (60 characters) unless renamed; a rename is stored on the Task and is never generated by Claude.
- **Delete Chat clears the Task** with the former Reset Chat rules (cancel and discard active Jobs, drop Queue Entries, delete Comments, Agent work, Revisions, Turns and events, new Claude session identity, chat generation + 1, reset event) and keeps the emptied Task for the next New Chat. The Claude transcript on the Agent Volume is not removed.
- **Wiki-wide choices.** The Wiki's name and description are mirrored on every Chat's Task; following and muting a Wiki's Task applies to every Task of the Wiki Project and new Chats start with the same choices; deleting a Wiki deletes all its Tasks and refuses (`409`) while any has an active Job.
- **API.** Chat list, New Chat, rename and delete under the Wiki; the Reset endpoint is removed. A Chat's id is its Task's id, so clients use the existing Task APIs and Task topic with it. The `wikis` topic carries a Wiki changed event on rename, deletion and every Comment in a Wiki's Chats.
- **Missing transcript.** The existing rule applies: the Session is marked not started with a System Comment, and the next Comment starts a new conversation seeded with the Chat's Comments.
- **Migration.** One column on Tasks for a renamed title, and the Wiki Project's default Agent set from its backing Task. Each existing Wiki's conversation is already its first Chat.
- **Glossary** (`docs/CONTEXT.md`) defines Chat, New Chat and Delete Chat; Reset Chat is gone.
- **Clients.** Web: the Chat list beside the open Chat, with New chat, Rename and Delete; opening a Wiki shows the latest Chat, or an empty composer. Flutter: the same, with the list beside the conversation on wide windows and successive screens on phones; a notification opens its Chat; cached Chats are read offline.

## Testing Decisions

- **Seam 1 (main): the backend public API** (HTTP, WebSocket and MCP) against real Postgres with the fake runner, fake `AgentRuntime` and fake `GitProvider`, in the existing Wikis and Sessions suites. It covers: implicit Chat creation on the first Comment; two Chats with separate Sessions, identities and Queue Entries on one Agent; resume per Chat; title and rename; Chat list payload; Delete Chat including a running Job, Queue Entries, Attachments, events and late output; reassignment pause, `409` and unpause; MCP tools scoped to the Job's Chat; missing-transcript recovery with the history Message and the System Comment; notifications carrying the Chat id; migration of an existing Wiki; unchanged behaviour for ordinary Tasks.
- **Seam 2: the Playwright suite** for one web flow: create a Chat, start another, switch, rename, delete.
- **Seam 3: the Flutter test suite** following the existing conversation and Wiki tests, for the Chat list layouts, per-Chat cache and disabled composer.
- Prior art: the former Wiki reset tests became Delete Chat tests; the existing Session, Queue and projection fixtures are reused.

## Acceptance Criteria

- [x] A Wiki can hold several Chats; New Chat starts a clean Claude conversation and keeps the others.
- [x] A Chat exists only after its first Comment; no empty Chats are stored.
- [x] The Chat list shows title, last activity, unread indicator and running state, ordered by latest activity, on web and Flutter.
- [x] Opening an old Chat shows its full history; a new Comment resumes that Chat's own Claude conversation in the shared Worktree.
- [x] Two Chats of one Wiki never run Jobs at once on the same Agent; their Queue Entries are separate.
- [x] Titles start as the first User Comment (60 characters) and can be renamed by any User.
- [x] Delete Chat removes everything of that Chat for everyone, cancels and discards its running Job, leaves other Chats, the Repository and the Task Branch untouched, and open clients drop it at once.
- [x] Reset Chat is gone from API, web and Flutter, replaced by New Chat and Delete Chat.
- [x] Reassigning the Wiki's Agent keeps Chats of the previous Agent readable, refuses writes with a clear `409`, and restores them when the Agent returns.
- [x] A Chat whose transcript is missing starts a new conversation from the Chat's earlier Comments with a System Comment, and keeps working.
- [x] Task Tools act on the Chat of their Job; notifications open the right Chat; follow and mute stay per Wiki.
- [x] Existing Wikis keep their conversation as their first Chat after migration; ordinary Tasks behave as before.
- [x] Specs are updated and `pnpm typecheck`, `pnpm test` and the Flutter tests pass.

## Out of Scope

- Chats for ordinary Tasks.
- Titles generated by Claude.
- Deleting Claude transcripts from the Agent Volume.
- One Task Branch, Worktree or pull request per Chat.
- Follow or mute per Chat, and searching across Chats.
- Moving a Chat to a different Agent.

## Further Notes

- Builds on the Wiki and Backing Task design recorded in [Wikis](../specs/wikis.md); it supersedes that spec's Reset Chat decisions.
- The explicit decision that "one Session per (Task, Agent)" holds for ordinary Tasks and becomes "one Session per Chat" for Wikis must be recorded in the Agent sessions spec.
