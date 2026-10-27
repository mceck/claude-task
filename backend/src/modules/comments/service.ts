import { autoFollow } from '../../notifications/preferences';
import { API_PREFIX, projectTopic, taskTopic } from '@claude-task/shared';
import type { Actor, Attachment, Comment, Question, QuestionItem, QuestionKind, Survey, TimelineItem, TimelinePage } from '@claude-task/shared';
import { and, asc, eq, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import type { AfterCommit } from '../../context';
import type { Executor } from '../../db/client';
import { agentItems, attachments, comments, queueEntries, questions, surveyResponses, taskRevisions, tasks } from '../../db/schema';
import { lockAgents } from '../agents/service';
import { dropIfEmpty } from '../../sessions/queue';
import { serializeAgentItem } from '../../projection/apply';
import { badRequest, forbidden, notFound } from '../../errors';
import type { UserRow } from '../../auth/logins';
import { actorResolver } from '../actors';
import { deliverComment } from '../../sessions/lifecycle';
import { loadCard, serializeRevision } from '../tasks/service';
import type { TaskRow } from '../tasks/service';

type CommentRow = typeof comments.$inferSelect;
type AttachmentRow = typeof attachments.$inferSelect;
type QuestionRow = typeof questions.$inferSelect;
type ResponseRow = typeof surveyResponses.$inferSelect;

/** The structured part of a new Question or Survey. */
export interface NewQuestion {
  kind: QuestionKind;
  items: QuestionItem[];
  /** The Expected Respondents of a Survey; empty for a Question. */
  expectedRespondentIds: string[];
}

export interface NewAttachment {
  blobId: string;
  filename: string;
  contentType: string;
  size: number;
}

function serializeAttachment(a: AttachmentRow): Attachment {
  return {
    id: a.id,
    commentId: a.commentId,
    filename: a.filename,
    contentType: a.contentType,
    size: a.size,
    url: `${API_PREFIX}/attachments/${a.id}`,
  };
}

function serializeQuestion(q: QuestionRow, user: (id: string | null) => Actor | null): Question {
  return {
    items: q.items,
    state: q.state === 'answered' ? 'answered' : 'open',
    answer: q.answer ?? null,
    answeredBy: user(q.answeredBy),
    answeredAt: q.answeredAt?.toISOString() ?? null,
  };
}

function serializeSurvey(q: QuestionRow, responses: ResponseRow[], user: (id: string | null) => Actor | null): Survey {
  return {
    items: q.items,
    state: q.state === 'closed' ? 'closed' : 'open',
    expectedRespondents: q.expectedRespondentIds.map((id) => user(id)!),
    responses: responses.map((r) => ({ user: user(r.userId)!, answers: r.answers, updatedAt: r.updatedAt.toISOString() })),
    closedBy: user(q.closedBy),
    closedAt: q.closedAt?.toISOString() ?? null,
  };
}

function serializeComment(
  c: CommentRow,
  author: Actor,
  files: AttachmentRow[],
  structured: { question: Question | null; survey: Survey | null } = { question: null, survey: null },
): Comment {
  const deleted = c.deletedAt !== null;
  return {
    id: c.id,
    taskId: c.taskId,
    kind: c.kind,
    author,
    body: deleted ? '' : c.body,
    internal: c.internal,
    attachments: deleted ? [] : files.map(serializeAttachment),
    editedAt: c.editedAt?.toISOString() ?? null,
    deletedAt: c.deletedAt?.toISOString() ?? null,
    createdAt: c.createdAt.toISOString(),
    delivery: c.deliveryState === 'none' ? null : { state: c.deliveryState, reason: c.deliveryReason, jobId: c.deliveredInJobId },
    question: deleted ? null : structured.question,
    survey: deleted ? null : structured.survey,
    answersCommentId: c.answersCommentId,
  };
}

export async function loadCommentsById(db: Executor, ids: string[]): Promise<Map<string, Comment>> {
  if (ids.length === 0) return new Map();
  const rows = await db.select().from(comments).where(inArray(comments.id, ids));
  const files = await db
    .select()
    .from(attachments)
    .where(inArray(attachments.commentId, ids))
    .orderBy(asc(attachments.position));
  const questionRows = await db.select().from(questions).where(inArray(questions.commentId, ids));
  const responses = questionRows.some((q) => q.kind === 'survey')
    ? await db
        .select()
        .from(surveyResponses)
        .where(inArray(surveyResponses.commentId, questionRows.map((q) => q.commentId)))
        .orderBy(asc(surveyResponses.createdAt), asc(surveyResponses.userId))
    : [];
  const userIds = questionRows.flatMap((q) => [q.answeredBy, q.closedBy, ...q.expectedRespondentIds]).concat(responses.map((r) => r.userId));
  const resolve = await actorResolver(db, [
    ...rows.map((r) => ({ type: r.authorType, id: r.authorId })),
    ...userIds.filter((id): id is string => !!id).map((id) => ({ type: 'user' as const, id })),
  ]);
  const user = (id: string | null) => (id ? resolve({ type: 'user', id }) : null);
  return new Map(
    rows.map((r) => {
      const q = questionRows.find((f) => f.commentId === r.id);
      const structured = {
        question: q?.kind === 'question' ? serializeQuestion(q, user) : null,
        survey: q?.kind === 'survey' ? serializeSurvey(q, responses.filter((x) => x.commentId === r.id), user) : null,
      };
      return [r.id, serializeComment(r, resolve({ type: r.authorType, id: r.authorId }), files.filter((f) => f.commentId === r.id), structured)];
    }),
  );
}

export async function loadComment(db: Executor, id: string): Promise<Comment> {
  const comment = (await loadCommentsById(db, [id])).get(id);
  if (!comment) throw notFound('Comment');
  return comment;
}

async function getCommentRow(db: Executor, id: string, lock = false): Promise<CommentRow> {
  const query = db.select().from(comments).where(eq(comments.id, id));
  const [row] = await (lock ? query.for('update') : query);
  if (!row) throw notFound('Comment');
  return row;
}

/** The comment count on the card changes with every comment create/delete. */
async function emitCardRefresh(db: Executor, after: AfterCommit, taskId: string) {
  const card = await loadCard(db, taskId);
  after.emit(projectTopic(card.projectId), { type: 'task.updated', task: card });
}

export async function createUserComment(
  tx: Executor,
  after: AfterCommit,
  task: TaskRow,
  input: { body: string; internal: boolean; attachments: NewAttachment[]; answersCommentId?: string },
  author: Actor,
): Promise<Comment> {
  if (input.body.trim() === '' && input.attachments.length === 0) {
    throw badRequest('A comment needs a body or an attachment');
  }
  const [row] = await tx
    .insert(comments)
    .values({
      taskId: task.id,
      kind: 'user',
      authorType: author.type,
      authorId: author.id,
      body: input.body,
      internal: input.internal,
      answersCommentId: input.answersCommentId ?? null,
    })
    .returning();
  if (input.attachments.length > 0) {
    await tx.insert(attachments).values(input.attachments.map((a, position) => ({ ...a, position, commentId: row!.id })));
  }
  if (author.type === 'user' && author.id) await autoFollow(tx, after, task.id, [author.id]);
  await deliverComment(tx, after, task, row!);
  const comment = await loadComment(tx, row!.id);
  after.emit(taskTopic(task.id), { type: 'comment.created', comment });
  await emitCardRefresh(tx, after, task.id);
  return comment;
}

/**
 * An Agent Comment posted through a Task Tool (files, a Question or a Survey), as opposed to the
 * ones projected from its stream. Returns the new Comment's id.
 */
export async function createAgentComment(
  tx: Executor,
  after: AfterCommit,
  input: {
    taskId: string;
    agentId: string;
    jobId: string;
    body: string;
    attachments: NewAttachment[];
    question?: NewQuestion;
  },
): Promise<string> {
  const [row] = await tx
    .insert(comments)
    .values({
      taskId: input.taskId,
      kind: 'agent',
      authorType: 'agent',
      authorId: input.agentId,
      jobId: input.jobId,
      body: input.body,
      createdAt: sql`clock_timestamp()`,
    })
    .returning({ id: comments.id });
  if (input.attachments.length > 0) {
    await tx.insert(attachments).values(input.attachments.map((a, position) => ({ ...a, position, commentId: row!.id })));
  }
  if (input.question) await tx.insert(questions).values({ commentId: row!.id, ...input.question });
  after.effect((ctx) => ctx.scheduler.publishComments([row!.id], 'created'));
  return row!.id;
}

/** Only the author edits a Comment; the internal flag can't change after posting. */
export async function updateComment(
  tx: Executor,
  after: AfterCommit,
  commentId: string,
  body: string,
  user: UserRow,
): Promise<Comment> {
  const row = await getCommentRow(tx, commentId, true);
  if (row.deletedAt) throw notFound('Comment');
  if (row.kind !== 'user' || row.authorType !== 'user' || row.authorId !== user.id) {
    throw forbidden('You can only edit your own comments');
  }
  if (row.answersCommentId) throw forbidden('An answer to a question is final: post a new comment instead');
  if (row.body === body) return loadComment(tx, row.id);
  await tx
    .update(comments)
    .set({ body, editedAt: new Date(), updatedAt: new Date() })
    .where(eq(comments.id, row.id));
  const comment = await loadComment(tx, row.id);
  after.emit(taskTopic(row.taskId), { type: 'comment.updated', comment });
  return comment;
}

/** Soft delete: the Comment stays on the Timeline as deleted, its attachments go away. */
export async function deleteComment(
  tx: Executor,
  after: AfterCommit,
  commentId: string,
  user: UserRow,
  removeBlob: (blobId: string) => Promise<void>,
): Promise<void> {
  // A queued Comment changes its Agent's Queue: lock the Agent first, as the dispatcher does.
  const peek = await getCommentRow(tx, commentId);
  const [entry] = peek.queueEntryId
    ? await tx.select({ agentId: queueEntries.agentId }).from(queueEntries).where(eq(queueEntries.id, peek.queueEntryId))
    : [];
  if (entry) await lockAgents(tx, [entry.agentId]);
  const row = await getCommentRow(tx, commentId, true);
  if (row.deletedAt) return;
  const own = row.kind === 'user' && row.authorType === 'user' && row.authorId === user.id;
  if (!own && user.role !== 'admin') throw forbidden('You can only delete your own comments');
  await tx.update(comments).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(comments.id, row.id));
  if (row.queueEntryId) await dropIfEmpty(tx, after, row.queueEntryId);
  const removed = await tx.delete(attachments).where(eq(attachments.commentId, row.id)).returning();
  for (const a of removed) after.run(() => removeBlob(a.blobId));
  after.emit(taskTopic(row.taskId), { type: 'comment.deleted', comment: await loadComment(tx, row.id) });
  await emitCardRefresh(tx, after, row.taskId);
}

export async function getAttachment(db: Executor, id: string) {
  const [row] = await db
    .select({ attachment: attachments, deletedAt: comments.deletedAt })
    .from(attachments)
    .leftJoin(comments, eq(comments.id, attachments.commentId))
    .where(eq(attachments.id, id));
  if (!row || row.deletedAt) throw notFound('Attachment');
  return row.attachment;
}

/** Description uploads per Task; older ones the description no longer links to are removed first. */
export const TASK_ATTACHMENT_LIMIT = 100;
const ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000;

/** Deletes the Task's description uploads that the current description does not link to and are past the grace period. Returns their blob ids. */
export async function pruneTaskAttachments(db: Executor, taskId: string): Promise<string[]> {
  const [task] = await db.select({ description: tasks.description }).from(tasks).where(eq(tasks.id, taskId));
  const stale = await db
    .select({ id: attachments.id, blobId: attachments.blobId })
    .from(attachments)
    .where(and(eq(attachments.taskId, taskId), isNotNull(attachments.taskId), lt(attachments.createdAt, new Date(Date.now() - ORPHAN_GRACE_MS))));
  const orphans = stale.filter((a) => !(task?.description ?? '').includes(a.id));
  if (orphans.length === 0) return [];
  await db.delete(attachments).where(inArray(attachments.id, orphans.map((a) => a.id)));
  return orphans.map((a) => a.blobId);
}

/** Stores files uploaded for a Task's description; the editor links them by URL. */
export async function createTaskAttachments(db: Executor, taskId: string, files: NewAttachment[]): Promise<Attachment[]> {
  const [{ count }] = (await db.execute<{ count: number }>(sql`select count(*)::int as count from attachments where task_id = ${taskId}::uuid`)).rows as [{ count: number }];
  if (count + files.length > TASK_ATTACHMENT_LIMIT) throw badRequest(`A Task can hold at most ${TASK_ATTACHMENT_LIMIT} description files`);
  const rows = await db
    .insert(attachments)
    .values(files.map((f, position) => ({ ...f, position, taskId })))
    .returning();
  return rows.map(serializeAttachment);
}

// Timeline

interface Cursor {
  /** Postgres timestamp text, which keeps microsecond precision. */
  t: string;
  k: 'comment' | 'revision' | 'agent';
  id: string;
}

const encodeCursor = (c: Cursor) => Buffer.from(JSON.stringify(c)).toString('base64url');

function decodeCursor(raw: string): Cursor {
  try {
    const c = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Cursor;
    if (
      typeof c.t === 'string' &&
      ['comment', 'revision', 'agent'].includes(c.k) &&
      typeof c.id === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(c.id)
    )
      return c;
  } catch {
    // fall through
  }
  throw badRequest('Invalid cursor');
}

/** Comments, Revisions and the Agent's items of a Task, merged newest first. */
export async function loadTimeline(
  db: Executor,
  taskId: string,
  opts: { before?: string; limit: number },
): Promise<TimelinePage> {
  const cursor = opts.before ? decodeCursor(opts.before) : null;
  const page = await db.execute<{ kind: Cursor['k']; id: string; t: string }>(sql`
    select kind, id, t from (
      select 'comment' as kind, id, created_at, created_at::text as t from comments where task_id = ${taskId}
      union all
      select 'revision' as kind, id, created_at, created_at::text as t from task_revisions where task_id = ${taskId}
      union all
      select 'agent' as kind, id, created_at, created_at::text as t from agent_items where task_id = ${taskId}
    ) items
    ${cursor ? sql`where (created_at, kind, id) < (${cursor.t}::timestamptz, ${cursor.k}, ${cursor.id}::uuid)` : sql``}
    order by created_at desc, kind desc, id desc
    limit ${opts.limit + 1}`);

  const rows = page.rows.slice(0, opts.limit);
  const commentMap = await loadCommentsById(
    db,
    rows.filter((r) => r.kind === 'comment').map((r) => r.id),
  );
  const revisionIds = rows.filter((r) => r.kind === 'revision').map((r) => r.id);
  const revisionRows = revisionIds.length
    ? await db.select().from(taskRevisions).where(inArray(taskRevisions.id, revisionIds))
    : [];
  const resolve = await actorResolver(
    db,
    revisionRows.map((r) => ({ type: r.actorType, id: r.actorId })),
  );
  const revisionMap = new Map(
    revisionRows.map((r) => [r.id, serializeRevision(r, resolve({ type: r.actorType, id: r.actorId }))]),
  );

  const agentIds = rows.filter((r) => r.kind === 'agent').map((r) => r.id);
  const agentMap = new Map(
    (agentIds.length ? await db.select().from(agentItems).where(inArray(agentItems.id, agentIds)) : []).map((r) => [r.id, serializeAgentItem(r)]),
  );

  const items: TimelineItem[] = rows.map((r) => {
    if (r.kind === 'comment') return { type: 'comment', id: r.id, createdAt: commentMap.get(r.id)!.createdAt, comment: commentMap.get(r.id)! };
    if (r.kind === 'agent') return { type: 'agent', id: r.id, createdAt: agentMap.get(r.id)!.createdAt, item: agentMap.get(r.id)! };
    return { type: 'revision', id: r.id, createdAt: revisionMap.get(r.id)!.createdAt, revision: revisionMap.get(r.id)! };
  });
  const pageIds = items.map((i) => i.id);
  const positions = pageIds.length
    ? await db.execute<{ item_id: string; position: string }>(sql`select item_id, position::text from task_activity
        where task_id = ${taskId} and item_id in (${sql.join(pageIds.map((id) => sql`${id}::uuid`), sql`, `)})`)
    : { rows: [] };
  const positionMap = new Map(positions.rows.map((r) => [r.item_id, r.position]));
  const last = rows[rows.length - 1];
  return {
    items: items.map((item) => ({ ...item, readPosition: positionMap.get(item.id) ?? '0' })),
    nextCursor: page.rows.length > opts.limit && last ? encodeCursor({ t: last.t, k: last.kind, id: last.id }) : null,
  };
}
