import { API_PREFIX, projectTopic, taskTopic } from '@claude-task/shared';
import type { Actor, Attachment, Comment, TimelineItem, TimelinePage } from '@claude-task/shared';
import { asc, eq, inArray, sql } from 'drizzle-orm';
import type { AfterCommit } from '../../context';
import type { Executor } from '../../db/client';
import { attachments, comments, taskRevisions } from '../../db/schema';
import { badRequest, forbidden, notFound } from '../../errors';
import type { UserRow } from '../../auth/logins';
import { actorResolver } from '../actors';
import { loadCard, serializeRevision } from '../tasks/service';
import type { TaskRow } from '../tasks/service';

type CommentRow = typeof comments.$inferSelect;
type AttachmentRow = typeof attachments.$inferSelect;

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

function serializeComment(c: CommentRow, author: Actor, files: AttachmentRow[]): Comment {
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
  };
}

async function loadComments(db: Executor, ids: string[]): Promise<Map<string, Comment>> {
  if (ids.length === 0) return new Map();
  const rows = await db.select().from(comments).where(inArray(comments.id, ids));
  const files = await db
    .select()
    .from(attachments)
    .where(inArray(attachments.commentId, ids))
    .orderBy(asc(attachments.position));
  const resolve = await actorResolver(
    db,
    rows.map((r) => ({ type: r.authorType, id: r.authorId })),
  );
  return new Map(
    rows.map((r) => [
      r.id,
      serializeComment(
        r,
        resolve({ type: r.authorType, id: r.authorId }),
        files.filter((f) => f.commentId === r.id),
      ),
    ]),
  );
}

async function loadComment(db: Executor, id: string): Promise<Comment> {
  const comment = (await loadComments(db, [id])).get(id);
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
  input: { body: string; internal: boolean; attachments: NewAttachment[] },
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
    })
    .returning();
  if (input.attachments.length > 0) {
    await tx.insert(attachments).values(input.attachments.map((a, position) => ({ ...a, position, commentId: row!.id })));
  }
  const comment = await loadComment(tx, row!.id);
  after.emit(taskTopic(task.id), { type: 'comment.created', comment });
  await emitCardRefresh(tx, after, task.id);
  return comment;
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
  const row = await getCommentRow(tx, commentId, true);
  if (row.deletedAt) return;
  const own = row.kind === 'user' && row.authorType === 'user' && row.authorId === user.id;
  if (!own && user.role !== 'admin') throw forbidden('You can only delete your own comments');
  await tx.update(comments).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(comments.id, row.id));
  const removed = await tx.delete(attachments).where(eq(attachments.commentId, row.id)).returning();
  for (const a of removed) after.run(() => removeBlob(a.blobId));
  after.emit(taskTopic(row.taskId), { type: 'comment.deleted', comment: await loadComment(tx, row.id) });
  await emitCardRefresh(tx, after, row.taskId);
}

export async function getAttachment(db: Executor, id: string) {
  const [row] = await db
    .select({ attachment: attachments, deletedAt: comments.deletedAt })
    .from(attachments)
    .innerJoin(comments, eq(comments.id, attachments.commentId))
    .where(eq(attachments.id, id));
  if (!row || row.deletedAt) throw notFound('Attachment');
  return row.attachment;
}

// Timeline

interface Cursor {
  /** Postgres timestamp text, which keeps microsecond precision. */
  t: string;
  k: 'comment' | 'revision';
  id: string;
}

const encodeCursor = (c: Cursor) => Buffer.from(JSON.stringify(c)).toString('base64url');

function decodeCursor(raw: string): Cursor {
  try {
    const c = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Cursor;
    if (typeof c.t === 'string' && (c.k === 'comment' || c.k === 'revision') && typeof c.id === 'string') return c;
  } catch {
    // fall through
  }
  throw badRequest('Invalid cursor');
}

/** Comments and Revisions of a Task, merged newest first. */
export async function loadTimeline(
  db: Executor,
  taskId: string,
  opts: { before?: string; limit: number },
): Promise<TimelinePage> {
  const cursor = opts.before ? decodeCursor(opts.before) : null;
  const page = await db.execute<{ kind: 'comment' | 'revision'; id: string; t: string }>(sql`
    select kind, id, t from (
      select 'comment' as kind, id, created_at, created_at::text as t from comments where task_id = ${taskId}
      union all
      select 'revision' as kind, id, created_at, created_at::text as t from task_revisions where task_id = ${taskId}
    ) items
    ${cursor ? sql`where (created_at, kind, id) < (${cursor.t}::timestamptz, ${cursor.k}, ${cursor.id}::uuid)` : sql``}
    order by created_at desc, kind desc, id desc
    limit ${opts.limit + 1}`);

  const rows = page.rows.slice(0, opts.limit);
  const commentMap = await loadComments(
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

  const items: TimelineItem[] = rows.map((r) =>
    r.kind === 'comment'
      ? { type: 'comment', id: r.id, createdAt: commentMap.get(r.id)!.createdAt, comment: commentMap.get(r.id)! }
      : { type: 'revision', id: r.id, createdAt: revisionMap.get(r.id)!.createdAt, revision: revisionMap.get(r.id)! },
  );
  const last = rows[rows.length - 1];
  return {
    items,
    nextCursor: page.rows.length > opts.limit && last ? encodeCursor({ t: last.t, k: last.kind, id: last.id }) : null,
  };
}
