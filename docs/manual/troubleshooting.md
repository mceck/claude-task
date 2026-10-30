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
5. Open **Agents** and inspect the Agent's Queue and state.

**Queued** work waits for the Agent to be ready and free. An Admin must resolve disabled Agents, build failures, unavailable containers or pending configuration changes. An Agent handles only one Job at a time.

If you see **waiting for retry**, open the Agent's **Work & queue** and inspect **Recent jobs** → **Details**. Read the Setup Script output and diagnostics. Fix the cause, then click **Retry** on the Task or post a new regular Comment.

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

## Credential, Git and setup failures

| Problem | Next action |
| --- | --- |
| System Comment says the Credential was rejected | Ask an Admin to check or replace it in **Credentials**, then send a new Comment. |
| Provider rate limit | Check the Agent's usage and Credential information. Agents sharing a Credential share limits; wait for access to recover. |
| Repository cannot be listed or reached | An Admin should verify Git Connection access and expiry. Check the selected Repository and Base Branch. |
| Setup Script fails | Review the Job's setup output, correct the Project's Setup Script or Agent environment, then Retry. |
| Pull request merged on the code host but Task still in the same Status | Only the in-app **Merge** action advances the Task. Move the Task to the intended Status yourself. |
| Agent disconnected or backend restarted | Allow recovery to complete and look for a recovery notice before posting duplicate work. |

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

**Delete** on a Wiki's Chat removes that Chat for everyone. Its repository files and the other Chats remain. It is not a way to undo file changes or reset Git history. A Chat run by an earlier Agent is read-only until the Wiki is assigned back to that Agent.

## Related

- [Roles and limits](roles-and-limits.md): check permissions and accepted sizes.
- [Installation and operations](installation-and-operations.md): operator configuration and recovery.

---

← [Glossary](glossary.md) · [Manual](README.md) →
