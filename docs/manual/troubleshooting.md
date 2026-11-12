[Manual](README.md) › Help

# Resolve common problems

Start with the message you see. For Agent failures, include the Task Key and relevant Job details when asking an Admin for help.

## Sign-in and passwords

| Message or symptom | What to do |
| --- | --- |
| **Invalid email or password** | Check the installation URL, email and password. Ask an Admin to check that your User is active or reset your password. |
| **Too many login attempts, try again later** | Stop retrying and wait for the login limit to clear. The limit uses a 15-minute window. |
| **Choose your password** | Replace your Temporary Password before opening other pages. |
| **The new passwords don’t match** | Enter the same new password in both new-password fields. |
| You are sent back to login | Sign in again. A reset, deactivation, password change elsewhere or inactivity may have ended your Login. |
| **Can’t reach the server** | Check your network and installation URL. Ask the operator to check the backend if the problem continues. |
| An administration page is missing | Members do not have administration access. Ask an Admin to perform the action. |

## Find or save work

| Message or symptom | What to do |
| --- | --- |
| A Task is missing from the Board | Clear filters and enable **Show closed**. Check that you opened the correct Project. |
| A Project is missing | Enable **Show archived** on Projects, or open its saved URL. |
| **Someone else changed this task** | Review the refreshed fields and reapply your intended edit. Check a retained description draft before saving over another User's work. |
| **A project with this key already exists** | Choose a different Project Key. Archived Projects also keep their Keys. |
| A Status cannot be removed | Keep at least one open-category and one closed-category Status; choose another Status to receive its Tasks. |
| **Files must be at most 25 MB** | Use a smaller file or share a suitable link. |
| **At most 10 files per comment** | Split the Attachments across Comments. |
| **An agent is working on this. Stop it, or close the task, before deleting.** | Stop the work and wait for the Job to exit, then retry deletion. |

## The Agent does not start

1. Check that an **Agent** is assigned.
2. Post a regular Comment. Assignment, Internal Notes and moving to In Progress do not start work.
3. Check the Task is not in a closed-category Status.
4. Read its Session indicator and Comment delivery badges.
5. Open **Workers**, select the Project's Worker and read its state, containers and **Queue**.

**Queued** work waits for the Worker to have a free container and for the Agent to be ready. An Admin must resolve a disabled Worker, a failed Build, unavailable containers or pending Extension changes. An Agent can run several Jobs at once; the Worker's cap, not the Agent, sets how many run in parallel.

If you see **waiting for retry**, open the Agent's **Jobs** tab and **Details** on the failed Job. Read the Setup Script output and diagnostics. Fix the cause, then click **Retry** on the Task or post a new regular Comment.

## Btw and Clear

- **`/btw` says the Agent has not started**: the Agent needs to have begun work on the Task. Send a regular Comment first, wait for the Agent to start, then ask.
- **`/btw` says another btw is still being answered**: wait for the current answer or its failure notice, then ask again.
- **`/btw` says the conversation was cleared**: a reply cannot continue a Btw from before a `/clear`. Send a new `/btw`.
- **A violet notice says the btw could not be answered**: the side conversation ended without an answer, for example because the Agent had just finished or its process stopped. Reply to try again, or send a new `/btw`.
- **`/clear` says there is nothing to clear**: the Task has no Agent, the Agent has not started, or the Task is closed.
- **The chat did not clear yet**: while the Agent works, **Clear pending** shows beside the Session indicator and the clear happens when its work ends.

## Worker and container problems

| Message or symptom | What to do |
| --- | --- |
| A Worker shows **Build failed** | Open its **Builds** tab and read the end of the log. Existing containers keep working on the previous image until a Build succeeds. |
| A Worker shows **Host offline** | Open **Workers** → **Hosts** and read the Host's connection error. Restore its Controller connection; work waits while no Runner is reachable. |
| **Host disconnected** | Docker actions wait for the Controller. Check its container and network on the Host, then retry after it reconnects. Connected Runners can keep processing Jobs. |
| A Worker shows **Offline** | With minimum 0 this is the resting state. A queued Comment starts a container. If work waits and nothing starts, an Admin checks the container, its Runner and the Host's backend URL (`AGENT_BACKEND_URL` for Local). |
| A Worker is **Disabled** | Its Queue keeps growing and its containers stop when idle. An Admin enables it again. |
| A slot shows **Stopped** | It starts when the minimum or work needs it. Use **Recreate when idle** for a planned replacement, not to force idle work. |
| A Task waits behind others | Reorder or remove entries in the Worker's **Queue**. The running Job always finishes first. |
| **Recreation is waiting for the current job to finish** | The new image or limits apply as soon as that container has no active Job. |
| A Project's Worker cannot change | Close every Task whose Session is started and open, then try again. The app lists them. For a Wiki, delete its started Chats first. |
| An Extension synchronization fails | Read the error on the Agent page or the Worker page. Fix the Skill name conflict, Plugin or marketplace, then wait for the automatic retry. |
| A Worker cannot be deleted | A Project, Wiki or Schedule still uses it. Move them to another Worker first; the app names them. |

## Remote Host problems

| Message or symptom | What to do |
| --- | --- |
| A new Host stays **disconnected** | Start its Controller with the token from **Connect the machine**. Check its backend URL, outbound network access and Controller logs. |
| **The backend URL must use https unless insecure connections are allowed** | Use an HTTPS URL, or enable **Allow insecure connections** for a trusted development connection and allow it in the Controller setup too. |
| The Host error asks you to **rebuild it from this version** | Use a clone at the backend's version and run `scripts/deploy.sh host` again, or rebuild and replace the Controller manually. |
| The Controller's token is refused | After token regeneration, copy the new token and replace the Controller with it. A deleted Host needs a new Host record and token. |
| **Local Host disabled (LOCAL_HOST=false)** | Ask the operator to enable local Docker, or move the remaining Workers to connected Remote Hosts after closing their started conversations. |
| A Worker's Host move lists Tasks | Close every listed Task's conversation and wait for active Jobs to end. For a Wiki, delete its started Chats. The move starts over with empty volumes. |
| A Host cannot be deleted | Move the named Workers to another Host first. |
| Cleanup shows pending Hosts | Their Controllers are disconnected. Results are added after reconnection; a newer Cleanup replaces the pending request. |

See [Remote Hosts](hosts.md) for connection, token replacement and move procedures.

## The Agent missed instructions

**Not delivered** includes a reason on hover, such as the Task being closed or the Agent being unassigned. Reopen or assign the Task as needed and post your instructions again. **Delivered** means the instructions were passed to the Agent; it does not mean the work is complete.

An Internal Note never reaches the Agent. Editing an already delivered Comment also does not update the Agent's copy. Post a correction as another regular Comment. After changing the Task's description or other supported fields, use **Notify agent** when offered.

## Questions and Surveys

- **"Someone answered first" or "This question was already answered by …" when sending an answer.** Another User answered the Question a moment before you, and their answer is the one the Agent receives. If you disagree, post a regular Comment.
- **"This survey is closed".** Every Expected Respondent had answered, or someone clicked **Send now**. The Agent already has the results; post a Comment to add something.
- **You can't edit your answer.** Answers to a Question are final. Post a regular Comment with the correction.
- **A Survey keeps waiting for someone who is away.** Click **Send now** to close it with the answers so far.
- **The Agent says the Task has no assignees for a Survey.** Assign the people who should answer, then ask again.
- **The Agent couldn't post a file.** It names the files it couldn't read, or says its environment didn't upload them in time. Ask it to check the path or try again.

## Runs

| Message or symptom | What to do |
| --- | --- |
| **This Run's transcript is no longer in memory** | The Agent's Job ended or the transcript reached its size limit. Its Timeline row keeps its status and error. Ask the Agent to repeat the work if you need the details. |
| A Run shows its tool calls but no text | The Agent's Claude Code version does not forward subagent text. The tool calls and the Timeline row are still complete. |
| A Background Command shows no output | Its output stays inside its Worker Container. The Run reports how the command ended; ask the Agent to read the command's log if you need more. |

## Credential, Git and setup failures

| Problem | Next action |
| --- | --- |
| System Comment says the Credential was rejected | Ask an Admin to check or replace it in **Credentials**, then send a new Comment. |
| Provider rate limit | Check the Agent's usage and Credential information. Agents sharing a Credential share limits; wait for access to recover. |
| Repository cannot be listed or reached | An Admin should verify Git Connection access and expiry. Check the selected Repository and Base Branch. |
| Setup Script fails | Review the Job's setup output, correct the Project's Setup Script or Agent environment, then Retry. |
| Pull request merged and the Task should move on | Merging never changes the Task's Status, whether from the app or on the code host. Move the Task to the intended Status yourself. |
| Worker disconnected or backend restarted | Allow recovery to complete and look for a recovery notice before posting duplicate work. |

## Schedule issues

| Problem | Next action |
| --- | --- |
| A Schedule starts no runs | Check that it is not paused, that its Agent is enabled and that its Worker is enabled. The history shows **Skipped** rows with the reason. |
| **previous run still active** | The last run has not finished. Open its Task to see what the Agent is doing, or wait for it to end. |
| **worker unavailable** | The Schedule's Worker is disabled. Enable it or choose another Worker in the Schedule's settings. |
| **missed** | The backend was down for longer than the Schedule's period. The next due time runs normally. |
| **Run now** says the agent is disabled or missing, or the Worker is disabled | Enable the Agent or choose another one, and enable the Worker or choose another one, in the Schedule's settings. |
| A Schedule cannot be deleted | An Agent is still working on one of its runs. Wait for it to finish, then retry. |
| **claude-task: this schedule is read-only** | The Schedule forbids pushes. Turn off **Read-only** in its settings if the Agent should push. |

## Native app and Wiki issues

| Problem | Next action |
| --- | --- |
| You cannot find phone navigation | Tap the teal app icon at the top left of **Projects** or **Wiki**, or swipe in from the left edge. Back from a Task returns toward those screens. |
| Extensions or Git Connections is missing | These entries are available to Admins in the drawer or desktop Settings hub while online. Ask an Admin if your role is Member. |
| Extension changes are pending | Check the Agents list for synchronization errors. Changes apply before the next Job once synchronization succeeds. |
| A catalog entry cannot be deleted | Remove its assignment from every Agent first, then retry deletion. |
| **Duplicate variable or header name** | Give each MCP header or environment variable a distinct name. Your form stays open. |
| Renaming a saved MCP secret requires a replacement | Enter the new secret for the renamed header or variable, or restore the original name to preserve the saved secret. |
| A Git Connection says **Environment · read-only** | Ask the installation operator to update it. Stored connections offer **Edit / rotate**. |
| Repository choice is locked | Close every non-closed Session in the Project, including pending and paused Sessions. The current Repository’s Base Branch stays editable. |


Use [Native app and notifications](native-app-and-notifications.md) to check connection status, pending Comments and phone permissions. Offline cached content can be read, but new server actions need a connection.

**Delete** on a Wiki's Chat removes that Chat for everyone. Its repository files and the other Chats remain. It is not a way to undo file changes or reset Git history. Each Chat has its own Agent; change it from the Chat header to continue the same conversation with another Agent. Changing the Wiki's Worker requires deleting every started Chat first.

## Related

- [Roles and limits](roles-and-limits.md): check permissions and accepted sizes.
- [Workers](workers.md): inspect capacity, Builds and container states.
- [Remote Hosts](hosts.md): inspect machine connections and manage tokens.
- [Installation and operations](installation-and-operations.md): operator configuration and recovery.

---

← [Glossary](glossary.md) · [Manual](README.md) →
