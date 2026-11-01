# Finding things on the board

The board is a database, not a filesystem: `grep` will never find a comment, a decision or a task. Search with the tools.

## How matching works

`list_tasks` (`text`) and `search_comments` (`query`) share one rule:

- The query is split on spaces, and **every word must appear**. For a task, a word may match the title, the description or the key. For a comment, all the words must be in the **same comment**.
- Each word is a **case-insensitive substring**: `migrat` matches "Migration" and "migrated". `%` and `_` are literal characters.
- **Accents are compared as typed**: `perche` does not match `perché`. Search with roots that stop before the accent (`perch`).
- There is no stemming, ranking or phrase search. Results are in board order for tasks and newest first for comments.
- **Closed tasks are left out.** Pass `status_category: "closed"` to search only closed tasks, which is where old decisions live. Two calls cover open and closed tasks.
- Internal notes and deleted comments never appear.

## Recipes

**Where did we decide X? Has anyone hit this error before?**
1. `search_comments` with 1 to 3 distinctive words: a file name, an identifier, a short error fragment.
2. Too many hits (`truncated: true`)? Add a word or filter by `status_category`. No hits? Drop a word, shorten the roots, then retry with `status_category: "closed"`.
3. `read_comments` on the best hit's `commentId` to read the discussion around it. Continue with the first or last id you got while `hasMoreBefore` or `hasMoreAfter` is true.
4. `get_task` on that task when you need its description, status or pull request.

**Is there already a task for this?**
`list_tasks` with `text` set to 2 or 3 words. Check `status_category: "closed"` too before you `create_task`.

**What changed on the board lately?**
`list_tasks` with `updated_since` (an ISO date), optionally with `status_category`.

**Whose task is it?**
`get_task` lists its user assignees. `list_tasks` with `assignee: "none"` finds tasks that nobody has.

**A long conversation**
Do not page `get_task` back from the end. Search a distinctive word, then `read_comments` around the hit. Use `comments_before` only when you really need the whole history.

## Mistakes to avoid

- Searching with a sentence: "the login fails after deploy" requires every word. Use `login deploy`.
- Searching with accented words, or with a whole long word when a root would do.
- Concluding "nothing found" without trying `status_category: "closed"`.
- Reading your own task with `get_task` at every turn: new messages already reach you. Read it when you need the current description, status or tags, or when you are told it changed.
