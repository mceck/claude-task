// Searching and reading a Project's Conversations for the Task Tools. Internal Notes and deleted
// Comments are never visible to an Agent, and closed Tasks are out of scope unless asked for.
import { taskKey } from '@claude-task/shared';
import type { Category } from '@claude-task/shared';
import { and, asc, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { Executor } from '../../db/client';
import { attachments, comments, projects, statuses, tasks } from '../../db/schema';
import { actorResolver } from '../actors';
import { likePattern, searchWords, snippetAround } from './text';

const SNIPPET = 250;

export interface CommentHit {
  project: string;
  task: { key: string; title: string; status: string; category: Category };
  commentId: string;
  author: string;
  kind: string;
  createdAt: string;
  snippet: string;
  attachments: string[];
}

export interface CommentEntry {
  id: string;
  author: string;
  kind: string;
  createdAt: string;
  body: string;
  attachments: string[];
}

/** One Comment of the Conversation: the fields both tools need, resolved to names. */
interface CommentRow {
  id: string;
  authorType: 'user' | 'agent' | 'system';
  authorId: string | null;
  kind: string;
  body: string;
  createdAt: Date;
}

async function attachmentNames(db: Executor, ids: string[]): Promise<Map<string, string[]>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ commentId: attachments.commentId, filename: attachments.filename })
    .from(attachments)
    .where(inArray(attachments.commentId, ids))
    .orderBy(asc(attachments.position));
  const names = new Map<string, string[]>();
  for (const row of rows) {
    if (!row.commentId) continue;
    names.set(row.commentId, [...(names.get(row.commentId) ?? []), row.filename]);
  }
  return names;
}

async function withAuthors(db: Executor, rows: CommentRow[]) {
  const resolve = await actorResolver(
    db,
    rows.map((row) => ({ type: row.authorType, id: row.authorId })),
  );
  const files = await attachmentNames(db, rows.map((row) => row.id));
  return rows.map((row) => ({
    id: row.id,
    author: resolve({ type: row.authorType, id: row.authorId }).displayName,
    kind: row.kind,
    createdAt: row.createdAt.toISOString(),
    body: row.body,
    attachments: files.get(row.id) ?? [],
  }));
}

/** Comments whose body contains every word, newest first. */
export async function searchComments(
  db: Executor,
  input: { projectId: string; query: string; statusCategory?: Category; limit: number },
): Promise<CommentHit[]> {
  const words = searchWords(input.query);
  if (words.length === 0) return [];
  const conditions: SQL[] = [
    eq(tasks.projectId, input.projectId),
    eq(comments.internal, false),
    isNull(comments.deletedAt),
    input.statusCategory ? eq(statuses.category, input.statusCategory) : ne(statuses.category, 'closed'),
    ...words.map((word) => sql`lower(${comments.body}) like ${likePattern(word)} escape '!'`),
  ];
  const rows = await db
    .select({
      id: comments.id,
      authorType: comments.authorType,
      authorId: comments.authorId,
      kind: comments.kind,
      body: comments.body,
      createdAt: comments.createdAt,
      taskId: tasks.id,
      taskNumber: tasks.number,
      taskTitle: tasks.title,
      projectKey: projects.key,
      statusName: statuses.name,
      category: statuses.category,
    })
    .from(comments)
    .innerJoin(tasks, eq(tasks.id, comments.taskId))
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .innerJoin(statuses, eq(statuses.id, tasks.statusId))
    .where(and(...conditions))
    .orderBy(desc(comments.createdAt), desc(comments.id))
    .limit(input.limit);
  if (rows.length === 0) return [];
  const resolved = await withAuthors(db, rows);
  return rows.map((row, i) => ({
    project: row.projectKey,
    task: {
      key: taskKey(row.projectKey, row.taskNumber),
      title: row.taskTitle,
      status: row.statusName,
      category: row.category,
    },
    commentId: row.id,
    author: resolved[i]!.author,
    kind: row.kind,
    createdAt: row.createdAt.toISOString(),
    snippet: snippetAround(row.body, words, SNIPPET),
    attachments: resolved[i]!.attachments,
  }));
}

export interface CommentWindow {
  projectId: string;
  task: { key: string; title: string };
  comments: CommentEntry[];
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
}

/**
 * The Conversation around one Comment: `before` Comments before it and `after` after it, in
 * chronological order. Returns null when the Comment does not exist, is internal or is deleted.
 */
export async function readComments(
  db: Executor,
  input: { commentId: string; before: number; after: number },
): Promise<CommentWindow | null> {
  const [anchor] = await db
    .select({
      id: comments.id,
      authorType: comments.authorType,
      authorId: comments.authorId,
      kind: comments.kind,
      body: comments.body,
      createdAt: comments.createdAt,
      // Compared as text: the driver would truncate the microseconds, making a Comment look newer than itself.
      createdAtText: sql<string>`${comments.createdAt}::text`,
      taskId: tasks.id,
      taskNumber: tasks.number,
      taskTitle: tasks.title,
      projectId: projects.id,
      projectKey: projects.key,
    })
    .from(comments)
    .innerJoin(tasks, eq(tasks.id, comments.taskId))
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .where(and(eq(comments.id, input.commentId), eq(comments.internal, false), isNull(comments.deletedAt)));
  if (!anchor) return null;

  const visible = and(eq(comments.taskId, anchor.taskId), eq(comments.internal, false), isNull(comments.deletedAt));
  // Tuple comparison keeps the order stable and the microseconds intact.
  const older = sql`(${comments.createdAt}, ${comments.id}) < (${anchor.createdAtText}::timestamptz, ${anchor.id}::uuid)`;
  const newer = sql`(${comments.createdAt}, ${comments.id}) > (${anchor.createdAtText}::timestamptz, ${anchor.id}::uuid)`;
  const fields = {
    id: comments.id,
    authorType: comments.authorType,
    authorId: comments.authorId,
    kind: comments.kind,
    body: comments.body,
    createdAt: comments.createdAt,
  };
  const [before, after] = await Promise.all([
    input.before > 0
      ? db
          .select(fields)
          .from(comments)
          .where(and(visible, older))
          .orderBy(desc(comments.createdAt), desc(comments.id))
          .limit(input.before + 1)
      : Promise.resolve([]),
    input.after > 0
      ? db.select(fields).from(comments).where(and(visible, newer)).orderBy(asc(comments.createdAt), asc(comments.id)).limit(input.after + 1)
      : Promise.resolve([]),
  ]);
  const hasMoreBefore = before.length > input.before;
  const hasMoreAfter = after.length > input.after;
  const rows = [...before.slice(0, input.before).reverse(), anchor, ...after.slice(0, input.after)];
  const resolved = await withAuthors(db, rows);
  return {
    projectId: anchor.projectId,
    task: { key: taskKey(anchor.projectKey, anchor.taskNumber), title: anchor.taskTitle },
    comments: resolved.map(({ id, author, kind, createdAt, body, attachments }) => ({ id, author, kind, createdAt, body, attachments })),
    hasMoreBefore,
    hasMoreAfter,
  };
}
