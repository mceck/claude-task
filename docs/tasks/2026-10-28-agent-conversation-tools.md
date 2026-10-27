---
status: done
---

# Agent conversation tools: files, Questions and Surveys

## Specs

- [Conversation](../specs/conversation.md) (Question, Survey, answers, Agent files on the Timeline)
- [Agent sessions](../specs/agent-sessions.md) (the new Task Tools, system prompt, `AskUserQuestion` disabled)
- [Runner](../specs/runner.md) (`job.upload` and the upload endpoint, Runner Protocol 3)
- [Clients](../specs/clients.md) (Question and Survey cards on web and native)

## Problem Statement

An Agent can talk to people only through its text, which becomes Agent Comments. It cannot show what it sees or makes: a screenshot taken with Playwright, a chart, a generated report or a log stays inside its container unless someone asks it to commit the file somewhere. When it needs a decision, it writes a question in prose and people answer in prose. Answers are ambiguous ("the second one"), they come from several people at once, and on a phone it takes typing to reply. When a User wants the team's opinion collected ("ask everyone which option they prefer"), the Agent has no way to wait for several answers: the first reply starts its next Turn.

## Solution

Agents get three new Task Tools:

- **`send_files`** posts files from the Agent Container as an Agent Comment with Attachments and an optional caption. Images show inline like the ones Users attach.
- **`ask_question`** posts a **Question**: one to four multiple-choice items, each single or multiple choice, always with a free-text "Other". The Agent then ends its Turn. The first User who answers closes the Question, and the answer reaches the Agent as a Message that quotes the question.
- **`create_survey`** posts a **Survey**, but only when a User explicitly asked for one. It has the same items, and every User can answer it and change their answer while it is open. It closes by itself once every **Expected Respondent** (the Task's Assignees when the Survey was created) has answered, or earlier when anyone presses "Send now". The Agent then receives all the results in one Message.

Questions and Surveys can carry files too ("which mockup do you prefer?"). Both the web app and the native app show them as interactive cards, and their Markdown body keeps them readable in older app versions. Claude Code's built-in `AskUserQuestion` is disabled, since nobody could answer it in a headless Job.

## User Stories

1. As a Member, I want an Agent to post screenshots it took while testing, so that I can see the result without checking out the branch.
2. As a Member, I want images an Agent posts shown inline in the conversation, so that I see them at a glance like the ones my teammates post.
3. As a Member, I want non-image files an Agent posts (logs, reports, CSVs) offered as downloads, so that I can open them locally.
4. As a Member, I want an Agent's files to come with a short caption, so that I know what I'm looking at.
5. As a Member, I want an Agent's files to appear on the Timeline where it posted them, between what it wrote before and after, so that the conversation reads in order.
6. As an Agent, I want to post a file by giving its path in my container, relative to my working directory or absolute, so that I don't have to move or encode it.
7. As an Agent, I want a clear tool error naming each file that could not be posted (missing, not a regular file, too large), so that I can fix the path and try again.
8. As an Agent, I want nothing posted when one of the files fails, so that I don't leave half a message behind.
9. As a Member, I want an Agent that needs a decision to ask it as a multiple-choice Question, so that I can answer with a tap.
10. As a Member, I want each option to have a short label and a description, so that I understand the trade-off before choosing.
11. As a Member, I want an "Other" field on every item, so that I can give an answer the Agent didn't think of.
12. As a Member, I want Questions with up to four items answered together, so that the Agent gets every decision it needs in one go.
13. As a Member, I want multiple-choice items where I can pick several options, so that I can answer "both A and C".
14. As a Member, I want to see who answered a Question and what they chose, so that the team knows the decision.
15. As a Member who answers a Question a moment after a teammate, I want to be told it was already answered and see their answer, so that two conflicting answers never reach the Agent.
16. As a Member, I want my answer delivered to the Agent with the question it answers, so that the Agent understands it even if it arrives hours later.
17. As a Member, I want my answer to behave like any Comment (queued, delivered, not delivered with a reason), so that I know whether the Agent got it.
18. As a Member, I want a Question to stay answerable after someone wrote a free Comment, so that I can still record the decision with the buttons.
19. As a Member, I want the Question's files (e.g. mockups) shown above its options, so that I choose with the material in front of me.
20. As a Member, I want to answer a Question from my phone, so that a push notification is enough to unblock the Agent.
21. As a Member, I want to ask the Agent to run a Survey of the team, so that it collects everyone's opinion before acting.
22. As an Assignee, I want a Survey to show which Expected Respondents have answered and who is still missing, so that I know whether it's waiting on me.
23. As a Member who is not an Assignee, I want to answer a Survey too, so that my opinion counts even if I'm not an Expected Respondent.
24. As a Member, I want to change my Survey answer while it's open, so that I can change my mind after the discussion.
25. As a Member, I want to see the answers so far with names, so that the team can discuss openly.
26. As a Member, I want a Survey to close by itself once every Expected Respondent has answered, so that the Agent resumes without anyone pressing a button.
27. As a Member, I want to press "Send now" to close a Survey early, so that one absent teammate doesn't block the Agent.
28. As a Member, I want to see who closed a Survey, or that it closed because everyone answered, so that the outcome is traceable.
29. As an Agent, I want the Survey results in one Message (counts per option with names, "Other" texts, missing Expected Respondents, who closed it), so that I can act on the whole picture.
30. As an Agent asked to run a Survey on a Task without Assignees, I want a tool error explaining why, so that I can ask people to assign themselves or fall back to a Question.
31. As an Agent, I want the tool to tell me to end my Turn after asking, so that I don't keep working on a guess.
32. As an Agent, I want `AskUserQuestion` unavailable, so that I don't try a tool that can never be answered here.
33. As an Agent newly assigned to a Task, I want earlier Questions, answers, Surveys and files in the conversation I receive, so that I know what was decided.
34. As a Member using an older native app, I want Questions and Surveys shown as readable text, so that I can at least answer in a Comment.
35. As a Member, I want Question and Survey cards updated live on every client, so that I never answer a stale card.
36. As a Member on a Wiki, I want the Wiki's Agent to post files and ask Questions too, so that the Wiki conversation works like a Task's.

## Implementation Decisions

**Task Tools (MCP server `claude-task`)**

- `send_files`: `paths` (1 to 10 strings), `caption` (optional Markdown, up to 100,000 characters). It creates an Agent Comment (kind `agent`, author the Agent, `jobId` the Job) whose body is the caption and whose Attachments are the files. It returns the Comment id and the stored file names.
- `ask_question`: `questions` (1 to 4 items) and optional `paths` (0 to 10). An item mirrors `AskUserQuestion`: `header` (1 to 12 characters), `question` (1 to 2,000 characters, Markdown), `options` (2 to 4, each with `label` of 1 to 60 characters, unique within the item ignoring case, and `description` of up to 300 characters), and `multiSelect` (boolean, default false). The UI adds "Other" itself; an option labelled "Other" is refused. On success the tool returns "Question posted. End your turn now; the answer will arrive as a new message."
- `create_survey`: same inputs as `ask_question`. It is refused when the Task has no Assignees ("This task has no assignees to answer a survey: ask people to assign themselves, or use ask_question"). Its description says to use it only when a human explicitly asked for a survey or for several people's opinions. On success it returns the Expected Respondents' names and tells the Agent the results arrive in one Message, so it should end its Turn unless it has other work.
- All three run the file upload (below) when `paths` is not empty, before creating anything. When any file fails, nothing is created, the uploaded blobs are deleted and the tool error lists each failed path with its reason.
- All three work in Wiki Sessions too. `create_survey` follows the same Assignees rule.
- The platform section of the system prompt replaces "If you need clarification, ask in text and end your turn" with: use `ask_question` for decisions with clear options (otherwise ask in text), then end the Turn; use `send_files` to show screenshots or files to humans; use `create_survey` only when a human explicitly asks to collect several people's answers.

**Disabling `AskUserQuestion`**

- `ClaudeArgs` gains `disallowedTools: string[]`. The backend always sends `['AskUserQuestion']`, and the Runner passes it as `--disallowedTools AskUserQuestion` (one value per tool).

**File upload from the Agent Container (Runner Protocol 3)**

- New backend → Runner message `{ type: 'job.upload', jobId, requestId, url, files: [{ path }] }`. It is not seq'd, because it is a request and not part of the Job's event stream. `url` is `‹backend›/api/v1/runner/uploads/‹requestId›`.
- The Runner resolves each path against the Job's Worktree, or uses it as given when absolute. It follows symlinks and requires a regular file of at most 25 MB. It answers with one `multipart/form-data` POST to `url` using the runner token. The first part is a `manifest` JSON field `[{ path, error? }]`, in request order, followed by one `file` part per successful entry, in order, with its base name and content type (from the extension, otherwise sniffed from the first 512 bytes, otherwise `application/octet-stream`). Failed entries are reported in the manifest. The Runner sends no other reply.
- The backend keeps an in-memory registry of pending uploads (`requestId` → Agent, Job, file count, resolver, deadline). `POST /api/v1/runner/uploads/:requestId` accepts only the runner token of the Agent the request was sent to, while the request is pending. It streams the files into the Blob store with the 25 MB limit and resolves the waiting tool call. An unknown or expired `requestId` gets `404`, and nothing is stored.
- The tool call waits at most 60 seconds. When the Runner is not connected, or the Job is no longer active, the tool fails at once with a message saying so. On timeout the request is dropped and the tool error says the files could not be collected.
- `RUNNER_PROTOCOL_VERSION` becomes 3. The Go `protocol` package mirrors the new message and `ClaudeArgs.disallowedTools`.

**Data model**

- New table for the structured part of a Question or Survey, one row per Comment: Comment id (primary key, cascade), kind (`question`, `survey`), items (jsonb, as validated above), state (`open`, `answered`, `closed`), Expected Respondent User ids (uuid array, empty for a Question), the Question's answer (jsonb), answered-by User, answered-at, answer Comment id, closed-by User (null when it closed because everyone answered), closed-at, result Comment id.
- New table for Survey responses: Comment id plus User id (primary key), answers (jsonb), created at, updated at. Cascades with the Comment and the User.
- `comments` gains `answers_comment_id`, set on the User Comment that answers a Question.
- An answer (for both kinds) is one entry per item, in item order: `{ selected: string[] /* option labels */, other: string | null }`. A single-choice item needs exactly one of: one selected label, or a non-blank `other`. A multiple-choice item needs at least one selected label or a non-blank `other`. Labels must exist in the item. `other` is up to 2,000 characters.

**Shared types**

- `Comment` gains `question: Question | null`, `survey: Survey | null` and `answersCommentId: string | null`.
- `Question`: `items`, `state` (`open` | `answered`), `answer` (`QuestionAnswer[] | null`), `answeredBy` (Actor | null), `answeredAt`.
- `Survey`: `items`, `state` (`open` | `closed`), `expectedRespondents` (Actor[]), `responses` (`{ user: Actor; answers: QuestionAnswer[]; updatedAt }[]`, in first-answer order), `closedBy` (Actor | null), `closedAt`.
- New zod bodies in `shared` for the answer and response requests.

**Comment bodies (what old clients and other Agents read)**

- The Question or Survey Comment's body is Markdown that the backend generates from the items: each item's header in bold, its question, and its options as a list with descriptions. A Survey also gets a closing line saying answers are collected in the app. Clients that understand the structured fields show the card instead of this body. Through `renderComments` it is also what a newly assigned Agent reads.
- The answer Comment's body is the text the Agent receives: "Answer to your question from ‹ISO time›:", then for each item `**header**: question` and `→ label, label; Other: "text"`.

**HTTP API**

- `POST /comments/:id/answer` `{ answers }`: Question only. In one transaction it locks the Question row, requires `open` (otherwise `409` "This question was already answered by ‹name›"), validates the answers (`400` with the reason), records answered-by, answered-at and the answer, and creates the answer User Comment (author the answering User, non-internal, `answers_comment_id` set) through the same path as `createUserComment`. That path covers auto-follow, `deliverComment` and the card refresh. It emits `comment.updated` for the Question and `comment.created` for the answer. A Survey gets `400`; a deleted or missing Comment gets `404`. It answers `201` with both Comments.
- `PUT /comments/:id/response` `{ answers }`: Survey only. It locks the Survey row, requires `open` (`409` "This survey is closed"), validates, and upserts the caller's response. When every Expected Respondent now has a response, it closes the Survey in the same transaction (see below). It emits `comment.updated`. It answers `200` with the Survey Comment.
- `POST /comments/:id/close`: Survey only, any signed-in User. It requires `open` (`409` otherwise) and closes the Survey with closed-by = caller. Zero responses is allowed.
- Closing a Survey posts a System Comment that carries the results as its notice Message. The body is "Survey closed: every expected respondent answered." or "‹Name› closed the survey early." The notice Message has each item's question, each option with its count and the names that chose it, the "Other" texts with names, the Expected Respondents who did not answer, and who closed it. It is delivered through `deliverComment` like a Notify agent notice, but without changing the Agent's last-read Task version. The result Comment id is stored on the Survey.
- Answering and responding require a signed-in active User. Expected Respondents who were deactivated are still expected, so such a Survey closes only with "Send now".

**Clients**

- Web: `CommentItem` renders a `QuestionCard` when `comment.question` is set and a `SurveyCard` when `comment.survey` is set, in place of the Markdown body. Attachments stay below as today. Add the shadcn `radio-group` and `checkbox` components (`pnpm dlx shadcn@latest add radio-group checkbox`).
  - The Question card has one block per item (radio or checkboxes, plus an "Other" text field) and a single "Send answer" button, enabled once every item is valid. When answered, it shows the choices read-only and "Answered by ‹name› · ‹time›".
  - On `409`, the card shows the error and refreshes from the response or the realtime event.
  - The Survey card shows the items with the caller's own selection (editable while open), "Save answer" or "Update answer", the results so far per option with names, "‹n›/‹m› expected answered" with the missing names, and "Send now". Once closed it shows the final results and who closed it.
  - An answer Comment (`answersCommentId`) renders compactly as "answered the question" with a link that scrolls to the Question.
- Native app: the same two cards in `_CommentView`, built from the app's own widgets (`ChoiceChipX` for multiple choice, `Segmented` or a list of selectable rows for single choice, `AppButton`), using `TaskController` methods `answerQuestion`, `respondToSurvey` and `closeSurvey`.
  - These actions need a connection. When offline they show an error and keep the selection.
  - Agent image Attachments use the existing `AttachmentTile`.
  - `TimelineEntry` gets getters for `question`, `survey` and `answersCommentId`.
- Both clients refresh the cards from `comment.updated` events. No new event types are needed.

## Testing Decisions

- **Backend public API with the fake Runner** (most coverage), extending the `mcp.test.ts` style: an MCP client built from the Job's `mcpConfig`, and the test acting as the Runner for `job.upload` by posting to the upload endpoint with the runner token.
  - `send_files` covers: success with images and other files, missing file reported in the manifest, Runner disconnected, timeout (short configurable timeout in tests), wrong runner token and expired `requestId` (`404`), and all-or-nothing behaviour.
  - Question tests (new `questions.test.ts`): creation and body, answer validation, first-answer-wins under two concurrent requests (one `201`, one `409`), the answer Comment's Delivery when the Agent is idle, running, unassigned or closed, the Message text written to the Runner, and realtime `comment.updated`/`comment.created`.
  - Survey tests: no Assignees error, Expected Respondents snapshot unaffected by later assignment changes, upsert of responses, non-Expected Respondent answers, auto-close on the last Expected Respondent, "Send now" with zero and partial responses, `409` after close, and the results notice Message content.
  - `job.start` carries `disallowedTools: ['AskUserQuestion']` and the new system prompt lines.
  - Prior art: `mcp.test.ts`, `comments.test.ts`, the Notify agent tests in `sessions.test.ts`.
- **Runner as a black box** (`runner/test`): `job.upload` against the fake backend uploads relative and absolute paths with the right names and content types, and reports missing, directory and oversized files in the manifest. `--disallowedTools AskUserQuestion` appears in the `claude` args. Prior art: `runner_test.go`, `harness_test.go`.
- **Playwright**: in two browsers, a Question created through the e2e runner's MCP config is answered in one browser and shows as answered in the other. A Survey on a Task with two Assignees: one responds, the other's "Send now" closes it and the results notice appears. Prior art: `agents.spec.ts` (fake runner via `/__test/runners`), `board.spec.ts` (two browsers).
- **Flutter**: controller tests for answer, response and close (including `409` and offline), and widget tests for both cards in their open and closed states. Prior art: `controller_test.dart`, `widget_test.dart` with `FakeApi` and `FakeLive`.

## Acceptance Criteria

- [x] `send_files` posts an Agent Comment with the files as Attachments and the caption as body, at the point of the call on the Timeline; images preview inline on web and native.
- [x] Files are collected through `job.upload` and the runner upload endpoint, relative to the Worktree or absolute, up to 10 files of 25 MB each; any failure posts nothing and returns a per-path error.
- [x] The tool fails immediately when the Runner is disconnected and after 60 seconds without an upload.
- [x] `ask_question` validates the item schema, posts a Question with a readable Markdown body and optional files, and tells the Agent to end its Turn.
- [x] The first answer wins; a concurrent or later answer gets `409`; the answer cannot be changed.
- [x] The answer is a User Comment by the answering User, quoting the question, with normal Delivery (including to a newly assigned Agent, and not delivered without an Agent or with the Task closed).
- [x] A Question stays open until answered, whatever else is said in the conversation.
- [x] `create_survey` refuses a Task without Assignees and records the Assignees at creation as Expected Respondents.
- [x] Any User can respond to an open Survey and change their response; responses are visible to everyone with names.
- [x] A Survey closes by itself when every Expected Respondent has responded, or with "Send now" by any User; then a System Comment delivers the results to the Agent in one Message.
- [x] `AskUserQuestion` is disallowed in every Job and the system prompt describes the three new tools.
- [x] Runner Protocol version 3 is implemented on both sides.
- [x] Web and native app show interactive Question and Survey cards, live-updated through `comment.updated`.
- [x] Specs (Conversation, Agent sessions, Runner, Clients) describe the new behaviour; `pnpm typecheck`, `pnpm test`, the Runner tests, `pnpm test:e2e` and the Flutter tests pass (except the `compact Task list on desktop` golden, which already fails on the base commit).

## Out of Scope

- Mentions and notifications addressed to a specific User (a later task). Questions and Surveys notify followers only through the existing `turn.completed` event.
- Showing `TodoWrite` as a live checklist on the Task.
- Free-text-only, numeric, date or conditional items; more than 4 items or 4 options.
- Anonymous Surveys, or results hidden until close.
- Answering Questions or Surveys offline in the native app (queued answers).
- Intercepting Claude Code's native `AskUserQuestion` through the stream-json permission protocol (rejected: it would keep the Job and its Agent busy until a human answers).

## Further Notes

- There are unrelated staged changes on `main` (agent-base, dispatch, messages, specs) at the time of writing. Keep this work's commits separate from them.
- The native app needs Flutter 3.41.7's `dart format` (see the memory note) to avoid reformatting the whole app.
