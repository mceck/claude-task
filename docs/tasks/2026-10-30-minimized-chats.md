---
status: in-progress
---

# Minimized Chats: the Chat Dock

## Specs

- [Clients](../specs/clients.md)
- [Conversation](../specs/conversation.md)
- [Wikis](../specs/wikis.md)

The manual page [Tasks and conversations](../manual/tasks-and-conversations.md) gains a section on keeping conversations at hand.

## Problem Statement

Conversations are pages: reading a Task means leaving the Board, reading a Wiki Chat means leaving the Chat list. People who work across several Tasks and Chats lose their place every time they switch, and an Agent's answer that arrives while they are elsewhere is only visible through an unread dot.

## Solution

The Chat Dock keeps conversations at the bottom of the window, like a chat app. A **Minimize chat** control in the Task view and in a Wiki Chat moves the conversation into the Dock and leaves its page: the Board dialog closes, a Task page returns to its Board and a Wiki Chat returns to the Wikis list. The Dock shows up to six conversations in cards from the bottom-right corner; the three most recent are open, older ones stay as title bars, and a conversation is either in the Dock or on a page, never both. The whole feature is in the web app: no API, no backend state.

## User Stories

1. As a User reading the Board, I want to keep a few conversations open at the bottom, so that I can follow them without leaving the Board.
2. As a User, I want to minimize a Task or a Wiki Chat from its header, so that moving it to the Dock is one click.
3. As a User, I want the conversation to leave its page when I minimize it, so that the same chat is never shown twice.
4. As a User, I want to open a Dock panel back into its full page, so that I can work with the Task details or the Wiki's Chat list.
5. As a User, I want to collapse a panel to its title bar, so that I can keep it at hand without it taking the screen.
6. As a User, I want each bar to show the Agent's avatar and state, the title, the Project and Task Key (the Wiki name and Chat Key) and an unread dot — collapsed too — so that I can tell what needs me without opening it.
7. As a User, I want an open Dock panel to be the same conversation as the page — Timeline, Active Runs, live text, composer, Drafts — so that what I can do in one I can do in the other.
8. As a User, I want reading in an open panel to clear the unread state everywhere, and a collapsed panel to mark nothing, so that the indicators stay honest.
9. As a User, I want the Dock to survive a reload, so that an accidental refresh doesn't lose the chats I was keeping.
10. As a User, I want the Dock to sit above the composer of the page I am on, so that I can still write there.
11. As a User on a narrow window, I want the Dock to stay out of the way, so that the page keeps its room.
12. As a User, I want a deleted Task or Wiki Chat to close its panel, so that no ghost conversation stays on screen.
13. As a User switching accounts in the same browser, I want the previous User's Dock cleared, so that no conversation leaks.

## Implementation Decisions

### Clients (web app only)

- The Dock lives in the `Layout`, above the Voice Bar and inside the main column, so it follows navigation and is available on every page except a forced password change.
- Panels are 300–380 px wide, adapting to the room left by the sidebar; the newest sits nearest the corner. Up to 6 entries are kept; the 3 most recent are open at up to 470 px (60% of the window height), the rest collapse to 50 px bars.
- Below 768 px the Dock is hidden and **Minimize chat** is not offered; the entries stay stored.
- Each panel reuses `TaskActivity`, so the conversation, its Drafts, the Live Turn, Active Runs and the read position are the same components as the page. Revisions are hidden, as the Task view hides them by default.
- A panel subscribes to the conversation's Task topic and to the Agents topic, plus the Wikis topic for a Wiki Chat; it reuses the page's queries. The unread dot comes from the User's Task Preferences for a Task, and from the Chat list for a Wiki Chat.
- The Dock publishes and reads a `--chat-composer-height` CSS variable: a page's conversation composer measures itself, and the Dock sits above it, so the panel never covers the page's own composer. The Dock's own conversations do not publish.
- Opening a page for a conversation removes it from the Dock, whether from the Dock's **Open full page**, a Board card, a link or the browser's back button. Minimizing closes the page's copy.
- Deleting the Task closes a Task panel through the Task's `task.removed` event or a `404`. A Wiki Chat is cleared rather than deleted, so a panel stores the Task's Conversation Generation when it is minimized and closes when a Delete Chat raises it; the live `timeline.reset` event closes it at once.
- The Dock is stored per browser in `localStorage` with the theme and the Task layout: entries, order and which panels are collapsed. It is cleared on sign-in and logout, like Drafts.
- Toast notifications move to the top right to leave the bottom-right corner to the Dock.
- No backend change, no shared type, no native app: the native app already reaches a Task or Chat in one tap.

## Testing Decisions

- **Web (Playwright)**, at the public seam: minimize a Task from the Board dialog and restore it; the Dock survives a reload; collapse and expand; open the full page and see the Dock empty; minimize from the Task page and land on the Board; remove a panel with **Close**; minimize a Wiki Chat and land on the Wikis list; Delete Chat elsewhere closes its panel; **Minimize chat** is absent below 768 px. Prior art: `frontend/e2e/board.spec.ts`, `frontend/e2e/wikis.spec.ts`.

## Acceptance Criteria

- [x] A Task and a Wiki Chat each offer **Minimize chat** in their header, between the task actions and the close button.
- [x] Minimizing leaves the conversation's page as described and shows it in the Dock.
- [x] A conversation is either in the Dock or on a page: opening its page from anywhere takes it out of the Dock.
- [x] The Dock keeps up to six conversations, shows the three most recent open and the older ones as bars, with the newest nearest the bottom-right corner.
- [x] A bar shows the Agent's state, the title, the Project and Task Key (the Wiki name and Chat Key) even while collapsed, and an unread dot; clicking it opens or collapses the panel.
- [x] The empty space around the bars, above a collapsed one included, takes no clicks away from the page.
- [x] An open panel is the same conversation as the page, advances the read position while at the bottom, and its composer works; a collapsed panel does not mark anything read.
- [x] The Dock sits above the page's own composer and above the Voice Bar.
- [x] Below 768 px the Dock is hidden and the control is not offered, while the stored entries survive.
- [x] Entries, order and open/collapsed state survive a reload and are cleared on sign-in and logout.
- [x] Deleting a Task or a Wiki Chat (or its Wiki) closes its panel, live and after a reload.
- [x] Toasts appear in the top right.
- [x] `docs/specs/clients.md`, `docs/CONTEXT.md` and the manual describe the Dock.

## Out of Scope

- A Dock in the native app.
- Sharing the Dock across devices, browsers or Users, or putting it in the address.
- Dragging or resizing panels, and reordering them by hand.
- Minimizing from the Projects list or the Agents pages (only Task and Wiki Chat conversations exist).
- Notifications or sounds for unread activity in the Dock.

## Further Notes

- The per-browser list is capped at the six most recent; a seventh closes the oldest rather than silently overcrowding the row.
- The Dock shows the conversations that fit at the current width; the oldest stored ones come back when the window widens.
