[Manual](README.md) › Team work

# Build and use a shared Wiki

A Wiki combines Markdown files in a Repository with shared Chats, a default Agent and the Worker where its Agents run. A Chat is a separate Conversation with its own Agent, open to everyone: start as many as you like, and come back to any of them later. Ask questions about your documentation or ask the Agent to update it. Every signed-in User can create, edit and delete Wikis, and start, rename and delete their Chats.

## Create a Wiki

Before you start, ask an Admin to configure a [Git Connection](git-repositories.md) and a [Worker](workers.md). Prepare a Repository containing your Markdown files and any Skills or `CLAUDE.md` instructions the Agent should follow.

1. Open **Wiki** in the sidebar.
2. Click **New wiki**.
3. Enter a **Name** and, optionally, a **Description** explaining the Wiki's purpose.
4. Choose the **Worker** where its Agents run. Each Chat then gets its own Agent, starting from the default you choose.
5. Choose the **Default agent** for new Chats.
6. Choose a **Repository**. Each choice includes its Git Connection's name.
7. Check **Base branch**. Selecting a Repository fills its default branch; you can choose another existing branch.
8. Click **Create wiki**. The Wiki opens with an empty Chat, ready for your first Comment.
9. Write your first Comment, for example, “Find the onboarding instructions and explain how a new colleague gets access.” Send it to start the Agent.

Assigning an Agent alone starts no work. Your first Comment starts its Session. If no Worker exists yet, the form explains that an Admin creates one first.

![A Wiki with its list of Chats on the left and the open Chat on the right](images/wikis/wiki.png)

## Ask questions and request changes

Use the composer as you would on a [Task](tasks-and-conversations.md). Comments, Attachments, **Internal chat**, streamed Agent output, Thinking and Activity work the same way. An Internal Note stays visible to Users and is never delivered to the Agent.

Every Chat is shared with everyone using the Wiki. The Agent reads and changes files in the Repository on a dedicated Task Branch. Ask it to commit, push and open a pull request when changes are ready for review. The header shows branch and pull request links once available. Review and merge on GitHub or GitLab.

Use **Stop** to interrupt a running Turn in the open Chat. If starting work failed, fix the reported problem and use **Retry**. See [Agent sessions and queues](agent-sessions-and-queues.md).

When the Wiki's Worker stops an idle container to free resources, your next Comment starts one again. The first reply then waits for the container and its Development Services, which can take up to a minute. See [Workers](workers.md).

## Change the Wiki's settings

1. Open **Wiki settings**, the gear button in the header.
2. Change **Name**, **Description**, **Worker** or **Default agent**.
3. Click **Save wiki**.

The Repository and Base Branch are fixed when you create the Wiki. The Worker can change only while the Wiki has no started Chat, because the Chats' files and transcripts live on the old Worker. Otherwise the app asks you to delete those Chats first. When the change is accepted, the new Worker creates its own repository files on the next Job.

Changing the **Default agent** affects new Chats only. Existing Chats keep their Agent. To continue a Chat with another Agent, use the Agent selector in that Chat's header: the next Comment resumes the same conversation with the new Agent's configuration, and an Agent Change Notice names the previous one.

## Work with several Chats

The list on the left shows the Wiki's Chats, the most recently active first. Each row shows the Chat's title, when it last changed, a dot when it has Comments you have not read and a spinner while the Agent is working on it.

1. Click **New chat** to start a clean conversation. The Chat appears in the list when you send its first Comment, and its title is the start of that Comment.
2. Click a Chat in the list to read it. You can keep writing in any Chat; the Agent continues that Chat's own conversation, so it remembers what was said there.
3. Open a Chat's **Chat actions** menu (the three dots) and choose **Rename** to give it a better title. Everyone sees the new title.

All the Chats of a Wiki work in the same Repository, on the same Task Branch and the same pull request. A new Chat starts with the Wiki's default Agent; use the Agent selector in the Chat header to change it, and the conversation continues with the new Agent. Two Chats of the same Wiki never run at the same time, because they share a Worktree. A Chat you open later sees the files as they are now, which may have changed since you last wrote in it.

Use **Minimize chat** in a Chat's header to keep it at the bottom of the window while you read another Chat: the Chat leaves the page and returns to the Wikis list, and the Dock keeps it at hand. Opening it from the Dock brings it back to its page. See [Keep conversations at hand](tasks-and-conversations.md#keep-conversations-at-hand).

## Delete a Chat

1. Open the Chat's **Chat actions** menu and choose **Delete**.
2. Read the confirmation, then confirm.

> **Warning:** Deleting a Chat removes it for every User, including its Comments, Attachments and Agent output. You cannot get it back. Repository files, the Task Branch and any pull request are kept, and so are the other Chats.

If the Agent was working in that Chat, it stops first. Use this when a Chat holds something that must not stay, such as a secret pasted by mistake.

## Delete a Wiki

1. Stop any running Agent and wait for it to finish stopping.
2. Click **Delete wiki**, the trash button in the header.
3. Confirm **Delete wiki**.

Deletion removes the Wiki and all its Chats from the application. The remote Repository, its branch and pull request remain on the code host.

## Use Wikis on a phone

Tap the app icon in **Projects** or **Wiki** to open the navigation drawer, then choose an existing Wiki. It opens its list of Chats; open one to read it, or use **New chat**. Back from a Chat returns to the list of Chats, and back from there to the Wiki list; its app icon opens the drawer again, and **New wiki** starts another Wiki.

If the installation has no Wikis yet, create its first Wiki in the web app. It then appears in the phone drawer. Desktop native users can open the Wiki list directly from the Project rail.

## Related

- [Tasks and conversations](tasks-and-conversations.md): compose Comments, attach files and use Internal Notes.
- [Workers](workers.md): choose where a Wiki's Agents run and how much capacity it has.
- [Git repositories and pull requests](git-repositories.md): understand branches and review changes.
- [Native app and notifications](native-app-and-notifications.md): follow and mute a Wiki on your phone; a notification opens the right Chat.

---

← [Agent questions and files](agent-questions-and-files.md) · [Schedules](schedules.md) →
