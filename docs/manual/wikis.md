[Manual](README.md) › Team work

# Build and use a shared Wiki

A Wiki combines Markdown files in a Repository with a shared Conversation and one assigned Agent. Ask questions about your documentation or ask the Agent to update it. Every signed-in User can create, edit, reset and delete Wikis.

## Create a Wiki

Before you start, ask an Admin to configure a [Git Connection](git-repositories.md). Prepare a Repository containing your Markdown files and any Skills or `CLAUDE.md` instructions the Agent should follow.

1. Open **Wiki** in the sidebar.
2. Click **New wiki**.
3. Enter a **Name** and, optionally, a **Description** explaining the Wiki's purpose.
4. Choose an **Agent**.
5. Choose a **Repository**. Each choice includes its Git Connection's name.
6. Check **Base branch**. Selecting a Repository fills its default branch; you can choose another existing branch.
7. Click **Create wiki**. The Wiki opens with an empty Conversation.
8. Write your first Comment, for example, “Find the onboarding instructions and explain how a new colleague gets access.” Send it to start the Agent.

Assigning an Agent alone starts no work. Your first Comment starts its Session.

![A shared Wiki Conversation with its Repository link and Session controls](images/wikis/wiki.png)

## Ask questions and request changes

Use the composer as you would on a [Task](tasks-and-conversations.md). Comments, Attachments, **Internal chat**, streamed Agent output, Thinking and Activity work the same way. An Internal Note stays visible to Users and is never delivered to the Agent.

The Conversation is shared with everyone using the Wiki. The Agent reads and changes files in the Repository on a dedicated Task Branch. Ask it to commit, push and open a pull request when changes are ready for review. The header shows branch and pull request links once available. Review and merge on GitHub or GitLab.

Use **Stop** to interrupt a running Turn. If starting work failed, fix the reported problem and use **Retry**. See [Agent sessions and queues](agent-sessions-and-queues.md).

## Change the Wiki's settings

1. Open **Wiki settings**, the gear button in the header.
2. Change **Name**, **Description** or **Agent**.
3. Click **Save wiki**.

The Repository and Base Branch are fixed when you create the Wiki. Changing the Agent follows the same reassignment rules as Tasks: a different Agent uses its own Session.

## Start a fresh Conversation

1. Click **Reset chat**.
2. Read the confirmation, then confirm **Reset chat**.
3. Post a new Comment when you want the Agent to start again.

> **Warning:** Reset deletes the Conversation for every User, including Comments, Attachments attached to Comments and Agent output. Repository files, the Task Branch and any pull request are kept.

If the Agent was working, it stops first. Comments sent during that stop wait until the old process has ended. The next work uses a fresh Claude conversation in the existing working directory.

## Delete a Wiki

1. Stop any running Agent and wait for it to finish stopping.
2. Click **Delete wiki**, the trash button in the header.
3. Confirm **Delete wiki**.

Deletion removes the Wiki and its Conversation from the application. The remote Repository, its branch and pull request remain on the code host.

## Use Wikis on a phone

Tap the app icon in **Projects** or **Wiki** to open the navigation drawer, then choose an existing Wiki. Back from its Conversation opens the Wiki list; its app icon opens the drawer again, and **New wiki** starts another Wiki.

If the installation has no Wikis yet, create its first Wiki in the web app. It then appears in the phone drawer. Desktop native users can open the Wiki list directly from the Project rail.

## Related

- [Tasks and conversations](tasks-and-conversations.md): compose Comments, attach files and use Internal Notes.
- [Git repositories and pull requests](git-repositories.md): understand branches and review changes.
- [Native app and notifications](native-app-and-notifications.md): follow and mute a Wiki on your phone.

---

← [Agent sessions and queues](agent-sessions-and-queues.md) · [Git repositories and pull requests](git-repositories.md) →
