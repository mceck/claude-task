---
status: done
---

# Worktree changes in the Task view

## Specs

- [Git integration](../specs/git-integration.md) (Worktrees in the Worker Volume, What Users see, API)
- [Runner](../specs/runner.md) (Runner Protocol, Preparing the Worktree)
- [Clients](../specs/clients.md) (Web app, Native app)

## Problem

The only way to see what an Agent left uncommitted in a Task's Worktree was to open a terminal in its Worker Container. Users reviewing a Task couldn't tell whether the work was committed and pushed or still sitting in the working tree, and a Task closed by mistake lost that information silently.

The Worktree lives in the Worker Volume, which only Worker Containers mount: the backend can't run `git status` in it. Project Skills already solve the same problem with a request to a Runner, so the same seam applies.

## Solution

- **Runner**: a new `worktree.status.request` / `worktree.status.result` pair, without a Job and without seq or ack, like `project_skills.request`. The Runner checks the path into the home, then runs `git status --porcelain=v2 -z --untracked-files=normal` with `GIT_OPTIONAL_LOCKS=0` and a 10-second limit, and answers at most 1000 files and 256 KiB of output, with `total` and `truncated`, or an error code (`not-found`, `not-a-worktree`, `failed`).
- **Backend**: `GET /tasks/:id/worktree-status` answers a live read when a Runner of the Project's Worker is connected, otherwise the read kept on the Session, plus whether it is live and why not (`no-session`, `no-repository`, `no-worktree`, `no-runner`, `error`). The last read is captured after every Job (when the Runner is still connected), kept in `sessions.worktree_status`, and cleared when the Worktree is removed or recreated.
- **Web**: a **Changes** item in the Task actions menu opens a dialog with the change count and one row per file: extension label, name, directory and status letter, plus when it was read.
- **Native app**: the same item in the Task's actions menu opens the same sheet.

## Decisions

- **A modal from the Task actions menu, not a section of the details panel.** The list is read on demand and can be long; a dialog keeps the Task view unchanged and is reachable from both layouts and from the native app.
- **Read when the dialog opens, nothing live.** The Worktree only changes while a Job runs, and the dialog is opened to look at the result. No polling, no events and no extra git commands per Turn.
- **Keep the last read on the Session.** A Worker's default minimum is 0, so its containers stop when idle and there is no Runner to ask. Without the stored read the dialog would be empty exactly when someone reviews finished work; with it, it shows the state at the end of the last Job and its time.
- **One status per file, following the editor convention.** `modified`, `added`, `deleted`, `renamed`, `copied`, `type-changed`, `untracked` (U) and `conflicted`, so the letters match what people know from VS Code.
- **Read-only git with optional locks off.** `git status` takes no lock and doesn't wait for a Job, so the dialog works while the Agent is running and never interferes with it.

## Acceptance criteria

- [x] A Runner answers `worktree.status.request` with the Worktree's uncommitted files, their statuses, the total and whether the list was cut.
- [x] Missing paths, plain directories and failed commands answer an error code, never a path outside the home.
- [x] `GET /tasks/:id/worktree-status` reads live when a Runner is connected and returns the stored read with `live: false` otherwise.
- [x] The stored read is refreshed after each Job and cleared when the Worktree is removed or recreated.
- [x] The web app and the native app show the Changes dialog from the Task actions menu, with its empty, unavailable and truncated states.
- [x] Backend tests cover the live read, the stored fallback, the job-end capture, the cleared read and the reasons; Runner tests cover statuses, the cap and the refused paths.
