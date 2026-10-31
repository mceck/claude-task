import { randomUUID } from 'node:crypto';
import { taskTopic } from '@claude-task/shared';
import type { Actor, Wiki, WikiChat } from '@claude-task/shared';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { preferences } from '../../notifications/preferences';
import type { Executor } from '../../db/client';
import type { AfterCommit } from '../../context';
import {
  agentItems,
  agents,
  attachments,
  comments,
  jobs,
  projects,
  queueEntries,
  sessionEvents,
  sessions,
  taskActivity,
  taskPreferences,
  taskRevisions,
  tasks,
  turns,
} from '../../db/schema';
import { badRequest, conflict, notFound } from '../../errors';
import { ACTIVE_JOB_STATES, lockAgents } from '../agents/service';
import { pauseTaskSession, resumeTaskSession } from '../../sessions/lifecycle';
import { createTask, emitTasksChanged, updateTask } from '../tasks/service';

export async function listWikis(db: Executor, id?: string): Promise<Wiki[]> {
  const rows = await db
    .select({ project: projects, task: tasks })
    .from(projects)
    .innerJoin(tasks, and(eq(tasks.projectId, projects.id), eq(tasks.number, 1)))
    .where(and(eq(projects.kind, 'wiki'), id ? eq(projects.id, id) : undefined))
    .orderBy(asc(projects.name));
  return rows.map(({ project: p, task: t }) => ({
    id: p.id,
    name: p.name,
    description: p.description,
    repository: p.repository!,
    taskId: t.id,
    agentId: p.defaultAgentId,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  }));
}

export async function getWiki(db: Executor, id: string, lock = false): Promise<Wiki> {
  if (lock)
    await db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, id), eq(projects.kind, 'wiki')))
      .for('update');
  const [wiki] = await listWikis(db, id);
  if (!wiki) throw notFound('Wiki');
  return wiki;
}

/**
 * Delete Chat: clears one Chat's conversation for everyone. The Task stays behind, empty and unlisted,
 * for the next New Chat to reuse. The checkout and Git branch are kept, and Claude's identity is rotated.
 */
export async function clearChat(tx: Executor, after: AfterCommit, chatId: string): Promise<void> {
  const [task] = await tx.select().from(tasks).where(eq(tasks.id, chatId)).for('update');
  const allSessions = await tx.select().from(sessions).where(eq(sessions.taskId, chatId));
  await lockAgents(
    tx,
    allSessions.map((s) => s.agentId),
  );
  const active = await tx
    .select()
    .from(jobs)
    .where(and(eq(jobs.taskId, chatId), inArray(jobs.state, [...ACTIVE_JOB_STATES])))
    .for('update');
  // Active Jobs keep occupying their Agent until cancellation is acknowledged.
  // Their remaining output is discarded, including on reconnect and recovery.
  await tx
    .update(jobs)
    .set({ cancelRequested: true, discardOutput: true, projection: null, stderr: '', setupOutput: '' })
    .where(eq(jobs.taskId, chatId));
  for (const job of active) after.effect((c) => c.runners.send(job.agentId, { type: 'job.cancel', jobId: job.id }));
  await tx.delete(queueEntries).where(eq(queueEntries.taskId, chatId));
  const blobs = await tx
    .select({ blobId: attachments.blobId })
    .from(attachments)
    .innerJoin(comments, eq(comments.id, attachments.commentId))
    .where(eq(comments.taskId, chatId));
  await tx.delete(comments).where(eq(comments.taskId, chatId));
  await tx.delete(agentItems).where(eq(agentItems.taskId, chatId));
  await tx.delete(taskRevisions).where(eq(taskRevisions.taskId, chatId));
  await tx.delete(taskActivity).where(eq(taskActivity.taskId, chatId));
  const jobIds = tx.select({ id: jobs.id }).from(jobs).where(eq(jobs.taskId, chatId));
  await tx.delete(sessionEvents).where(inArray(sessionEvents.jobId, jobIds));
  await tx.delete(turns).where(eq(turns.taskId, chatId));
  await tx.update(taskPreferences).set({ readPosition: 0n }).where(eq(taskPreferences.taskId, chatId));
  for (const s of allSessions) {
    await tx
      .update(sessions)
      .set({
        claudeSessionId: randomUUID(),
        started: false,
        state: s.agentId === task!.agentId ? 'pending' : 'paused',
        lastSeenTaskVersion: 0,
        lastJobAt: null,
        closedAt: null,
        worktreeRemovalPending: false,
      })
      .where(eq(sessions.id, s.id));
  }
  await tx
    .update(tasks)
    .set({ version: sql`${tasks.version} + 1`, chatGeneration: sql`${tasks.chatGeneration} + 1`, updatedAt: new Date() })
    .where(eq(tasks.id, chatId));
  after.emit(taskTopic(chatId), { type: 'timeline.reset', taskId: chatId });
  await emitTasksChanged(tx, after, [chatId], 'task.updated');
  after.effect((c) => {
    c.scheduler.publishTask(chatId);
    for (const s of allSessions) c.scheduler.publishQueue(s.agentId, [chatId]);
  });
  for (const b of blobs) after.run(() => after.ctx.blobs.delete(b.blobId));
}

const TITLE_LENGTH = 60;
/** A Chat's title as the Chat list shows it: its rename, else the start of its first User Comment. */
export const chatTitle = (task: SQL) => sql`coalesce(${task}.chat_title,
  (select nullif(left(regexp_replace(btrim(c.body), '\\s+', ' ', 'g'), ${TITLE_LENGTH}), '') from comments c
    where c.task_id = ${task}.id and c.kind = 'user' and c.deleted_at is null
    order by c.created_at, c.id limit 1),
  'Chat')`;

/** A Wiki's Chats: its Tasks that hold a User Comment, most recently active first. */
export async function listChats(db: Executor, userId: string, wiki: Wiki): Promise<WikiChat[]> {
  const rows = await db.execute<{
    id: string;
    title: string;
    agentId: string | null;
    sessionState: WikiChat['sessionState'];
    running: boolean;
    createdAt: Date;
    lastActivityAt: Date;
  }>(sql`select t.id, t.agent_id as "agentId",
      ${chatTitle(sql`t`)} as title,
      (select s.state from sessions s where s.task_id = t.id and s.agent_id = t.agent_id) as "sessionState",
      exists (select 1 from jobs j where j.task_id = t.id and j.state in ('dispatched', 'running', 'finishing')) as running,
      a.first as "createdAt", a.last as "lastActivityAt"
    from tasks t
    join lateral (select min(created_at) filter (where kind = 'user') as first, max(created_at) as last from comments where task_id = t.id) a on a.first is not null
    where t.project_id = ${wiki.id}::uuid
    order by a.last desc, t.id`);
  // Mute only silences alerts: the Chat list still shows unread activity.
  const unread = new Map((await preferences(db, userId, { projectId: wiki.id })).map((p) => [p.taskId, p.unread]));
  return rows.rows.map((r) => ({
    id: r.id,
    wikiId: wiki.id,
    title: r.title,
    agentId: r.agentId,
    sessionState: r.sessionState,
    running: r.running,
    unread: unread.get(r.id) ?? false,
    createdAt: new Date(r.createdAt).toISOString(),
    lastActivityAt: new Date(r.lastActivityAt).toISOString(),
  }));
}

export async function getChat(db: Executor, userId: string, wiki: Wiki, chatId: string): Promise<WikiChat> {
  const chat = (await listChats(db, userId, wiki)).find((c) => c.id === chatId);
  if (!chat) throw notFound('Chat');
  return chat;
}

/**
 * New Chat: the Wiki's empty Task, created when the Wiki has none. A Chat enters the list with its first
 * Comment, so an unused one is handed out again instead of piling up.
 */
export async function reserveChat(tx: Executor, after: AfterCommit, wiki: Wiki, actor: Actor): Promise<string> {
  const empty = await tx.execute<{ id: string }>(sql`select t.id from tasks t
    where t.project_id = ${wiki.id}::uuid and not exists (select 1 from comments where task_id = t.id)
    order by (t.agent_id is not distinct from ${wiki.agentId}::uuid) desc, t.number limit 1`);
  let chatId = empty.rows[0]?.id;
  if (!chatId) {
    const task = await createTask(
      tx,
      after,
      wiki.id,
      { title: wiki.name, description: wiki.description, priority: 'none', tagIds: [], assigneeIds: [] },
      actor,
    );
    await updateTask(tx, after, task.id, { version: task.version, agentId: wiki.agentId }, actor);
    chatId = task.id;
  } else {
    // An empty Chat takes the Wiki's current Agent; New Chat must hand it out that way.
    const [task] = await tx.select().from(tasks).where(eq(tasks.id, chatId));
    if (task && task.agentId !== wiki.agentId)
      await updateTask(tx, after, task.id, { version: task.version, agentId: wiki.agentId }, actor);
  }
  // Following and muting belong to the Wiki: the Chat starts with the choices made on it.
  await tx.execute(sql`insert into task_preferences(user_id, task_id, following, muted, explicit_follow)
    select user_id, ${chatId}::uuid, following, muted, explicit_follow from task_preferences where task_id = ${wiki.taskId}::uuid
    on conflict (user_id, task_id) do update set following = excluded.following, muted = excluded.muted, explicit_follow = excluded.explicit_follow`);
  return chatId;
}

/**
 * A Chat belongs to the Agent that was the Wiki's when it was created. An empty Chat, or one whose Agent was
 * deleted, takes the current one; a Chat with a conversation can only continue with its own Agent, though
 * Internal Notes, which no Agent receives, are accepted in any Chat.
 */
export async function ensureChatAgent(tx: Executor, after: AfterCommit, task: typeof tasks.$inferSelect, actor: Actor, internal: boolean): Promise<void> {
  const [project] = await tx.select().from(projects).where(eq(projects.id, task.projectId));
  if (project?.kind !== 'wiki' || !project.defaultAgentId || task.agentId === project.defaultAgentId) return;
  const [used] = await tx.select({ id: comments.id }).from(comments).where(eq(comments.taskId, task.id)).limit(1);
  if (!used || !task.agentId) {
    const [fresh] = await tx.select({ version: tasks.version }).from(tasks).where(eq(tasks.id, task.id));
    await updateTask(tx, after, task.id, { version: fresh!.version, agentId: project.defaultAgentId }, actor);
    return;
  }
  if (internal) return;
  const [agent] = await tx.select({ name: agents.name }).from(agents).where(eq(agents.id, task.agentId));
  throw conflict(`This chat is run by ${agent?.name ?? 'another agent'}: assign the wiki back to that agent to continue it.`);
}

/** A reserved Chat as the New Chat call describes it: it is not listed until its first Comment. */
export function reservedChat(wikiId: string, task: typeof tasks.$inferSelect): WikiChat {
  return {
    id: task.id,
    wikiId,
    title: task.chatTitle ?? 'Chat',
    agentId: task.agentId,
    sessionState: null,
    running: false,
    unread: false,
    createdAt: task.createdAt.toISOString(),
    lastActivityAt: task.createdAt.toISOString(),
  };
}

/**
 * A new Wiki Agent pauses the Sessions of the Chats run by the previous one, which stay readable, and wakes
 * the Sessions of its own earlier Chats. Chats keep the Agent they were created with.
 */
export async function changeWikiAgent(tx: Executor, after: AfterCommit, wikiId: string, agentId: string): Promise<void> {
  const [agent] = await tx.select({ id: agents.id }).from(agents).where(eq(agents.id, agentId));
  if (!agent) throw badRequest('Unknown agent');
  const [project] = await tx.select().from(projects).where(eq(projects.id, wikiId));
  if (project!.defaultAgentId === agentId) return;
  await tx.update(projects).set({ defaultAgentId: agentId, updatedAt: new Date() }).where(eq(projects.id, wikiId));
  const chats = await tx.select().from(tasks).where(eq(tasks.projectId, wikiId)).orderBy(asc(tasks.id)).for('update');
  for (const chat of chats) {
    if (chat.agentId === agentId) await resumeTaskSession(tx, after, chat);
    else await pauseTaskSession(tx, after, chat);
  }
}
