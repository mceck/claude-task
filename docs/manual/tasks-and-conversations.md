[Manual](README.md) › Team work

# Work on a Task with your team and Agent

A Task combines the work to do, its Conversation and the Agent's activity. Every signed-in User can edit and comment on any Task.

## Open and arrange a Task

Click a card on a Board. Use **Open full page** to open it as a page, or use **Task actions** → **Copy link** to share its permanent `/t/WEB-1` link.

![A Task showing its Conversation, composer and details panel](images/tasks-and-conversations/task.png)

The Conversation occupies the main panel by default, with Task details beside it. Use **Focus details** or **Focus activity** to choose the main panel. **Hide details**, **Show details**, **Hide activity** and **Show activity** control the other panel. This layout preference is remembered in your browser.

## Keep conversations at hand

Use **Minimize chat** in a Task's header, or in a Wiki Chat's header, to keep the conversation at the bottom of the window while you work elsewhere. The conversation leaves its page: a Task opened over the Board closes its dialog, a Task page returns to its Board, and a Wiki Chat returns to the Wikis list.

![Minimized chats at the bottom of a Board](images/tasks-and-conversations/chat-dock.png)

The newest conversation sits by the bottom-right corner. Click its bar to open or collapse it: the three most recent open, and older ones stay as title bars. **Open full page** takes a conversation back to its page and out of the Dock; **Close** removes it. A bar shows the Agent's avatar and state, the title, the Task Key or the Wiki's name, and a dot when there is something unread.

An open conversation works like the page: Comments, the Active Runs bar, the Agent's live text and the composer, with Drafts and the read position shared. A collapsed one takes no room and marks nothing as read. The Dock stays above the composer of the page you are on, so you can still write there.

The Dock remembers up to six conversations in your browser, survives reloads, and is cleared when you sign in or out. On windows narrower than 768 pixels it is hidden and **Minimize chat** is not offered.

## Describe and assign the work

1. Edit the title at the top. Press Enter or click outside to save; Escape restores the previous title.
2. Set **Status**, **Priority**, **Assignees**, **Agent** and **Tags** in the details panel. Choices save immediately.
3. Click the **Description** text or **Edit** to update it. Use the formatting toolbar or Markdown shortcuts.
4. Click outside the description or press Escape to finish editing and save it.

You can assign several Users and one Agent. User assignees identify the people responsible for the Task. Assigning an Agent prepares its Session; post a regular Comment to start its work.

A Project can have a **Default agent**, configured in its web **Settings** → **Agents**. New Tasks inherit that Agent when it is enabled. A disabled or removed default leaves new Tasks unassigned. Existing Tasks keep their assignment. In the native creation form, choosing another Agent assigns that Agent to the new Task. Your first regular Comment starts work in every case.

The Tag picker can create and apply a new Tag while you type. Tags belong to the Project.

If **Someone else changed this task** appears, the Task has refreshed and your conflicting change was not saved. Review the new value before editing again. A conflicting description draft stays available, with options to save it over the other edit or **discard your changes**.

Under the description, **Attachments** lists every file of the Task, newest first: files uploaded from the description editor and files attached to any Comment, by people or by the Agent. Each row shows an image thumbnail where available, the file name, its size, who uploaded it (or **Description**) and when. Click an image to open it in a new tab, or another file to download it. The list appears with the first upload, in the web app and in the native app's Task details.

## Send a Comment

1. Write in the Comment editor below the Conversation.
2. Leave **Internal chat** off when the Agent should receive it.
3. Click **Comment** or press Enter. Use Shift+Enter for a new line.

Comments support Markdown. Attach files with **Attach**, drag them into the composer, or paste them. You can send a file without text. Each Comment accepts up to 10 files, up to 25 MB each. Images preview in the Conversation; other files can be downloaded.

An unsent web draft, including its files and Internal chat choice, survives closing and reopening the Task in the current page. Reloading the page or logging out clears it.

### Keep a discussion among Users

Turn on **Internal chat**, write the Internal Note, then click **Send**. Every User can see it. Agents never receive it or its files. Its lock, dashed border and **Internal chat** label distinguish it from regular Comments.

The Internal Note choice cannot be changed after posting.

In the native app, use the speech-bubble icon beside Attach to switch to Internal chat. Its tooltip reads **Comment · switch to Internal chat**. Internal mode shows a lock icon, **Hidden from the Agent…**, and the tooltip **Internal chat · switch to Comment**. Switching modes keeps your text, files and focus. See [native Conversations](native-app-and-notifications.md#join-the-conversation) for sending and keyboard controls.

### Check whether the Agent received it

| Badge | Meaning |
| --- | --- |
| **Queued** | Waiting for the Agent to take the work. |
| **Delivered** | Passed to the Agent, which may still be working. |
| **Not delivered** | It will not be sent in this delivery. Hover over the badge for the reason. |

Comments on a Task that has never had an Agent have no delivery badge. They are included in the opening context after an Agent is assigned and a new Comment starts its work. Internal Notes are always excluded.

## Correct or remove a Comment

Open **Comment actions** on your own Comment, select **Edit**, change the text, then click **Save**. Use **Cancel** to leave it unchanged.

An edit to a queued Comment changes what the Agent receives. An edit to a delivered Comment changes only what Users see. Post another Comment when you need to correct instructions already delivered.

Choose **Delete** from Comment actions and confirm to remove your Comment and its files. A deletion notice remains on the Timeline. Deleting a queued Comment withdraws it; deleting one already delivered does not remove it from the Agent's memory. Admins can delete any Comment, but can edit only their own.

## Read activity and tell the Agent about edits

The Timeline combines Comments, the Agent's work and recorded field changes called Revisions. Click **Changes** to show or hide Revisions; they start hidden. Use **Load older activity** for earlier entries. Expand **Thinking** or an Activity group to inspect the Agent's work.

New output stays in view while you are at the bottom. Scroll up to read older activity without being pulled back down. Reaching the latest entry in a visible browser tab marks it read across your clients.

When **Notify agent** appears after you change the title, description, priority or Tags, click it to send the changes the Agent has not seen. It is available for an existing idle or running Session. Editing a field by itself does not deliver those changes to the Agent.

Type `/` to see the Agent's available commands and Skills. Use arrow keys and Enter or Tab to choose a suggestion, then finish and post the Comment. Native commands at the start of a Comment wait until the current Turn ends.

## Review code changes

The Task's details show its branch and Pull Request when available. For an open, non-draft Pull Request, use the merge action after checking the changes. The app asks you to confirm **Merge** and applies the code host's own review and check requirements. The merge advances the Task to the next Status when there is one, and never closes the Task. See [Git repositories and pull requests](git-repositories.md#review-and-merge-changes) for web and native controls.

## Delete a Task

Choose **Task actions** → **Delete task** and confirm **Delete task**. Its Comments, Attachments and history are deleted. Stop active Agent work or close the Task before deleting it.

## Related

- [Agent sessions and queues](agent-sessions-and-queues.md): start, stop and retry Agent work.
- [Native app and notifications](native-app-and-notifications.md): follow and mute Tasks and receive phone alerts.

---

← [Projects and boards](projects-and-boards.md) · [Agent sessions and queues](agent-sessions-and-queues.md) →
