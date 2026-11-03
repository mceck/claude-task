// ClickUp sync (docs/specs/clickup.md): importing, polling and pushing Task Status.
import { ATTACHMENT_MAX_BYTES, deduceCategory, parseClickUpQuery, projectTopic } from '@claude-task/shared';
import type { Actor, Category, ProjectClickUp } from '@claude-task/shared';
import { and, asc, eq, inArray, isNotNull } from 'drizzle-orm';
import type { AfterCommit, AppContext } from '../context';
import { transact } from '../context';
import type { Executor } from '../db/client';
import { attachments, credentials, projects, statuses, tasks } from '../db/schema';
import { badRequest, notFound } from '../errors';
import { sanitizeFilename } from '../modules/comments/routes';
import { serializeProject } from '../modules/projects/service';
import { emitStatusesChanged, listStatuses } from '../modules/statuses/service';
import { createTask, emitTasksChanged, getTaskRow, moveTask, recordRevisions } from '../modules/tasks/service';
import type { RevisionChange } from '@claude-task/shared';
import { ClickUpError } from './client';
import type { ClickUpClient, ClickUpSource, ClickUpStatus, ClickUpTask } from './client';

const CLICKUP_ACTOR: Actor = { type: 'system', id: null, displayName: 'ClickUp' };

export interface Snapshot {
  statuses: ClickUpStatus[];
  tasks: ClickUpTask[];
}

export type LinkConfig = Pick<ProjectClickUp, 'credentialId' | 'teamId' | 'sourceType' | 'sourceId' | 'query'>;

export class ClickUpSync {
  private timer: NodeJS.Timeout | null = null;
  private readonly pending = new Map<string, Promise<unknown>>();
  /** Delays between the attempts of a Status push. */
  retryDelaysMs = [1000, 5000];
  constructor(private readonly ctx: AppContext) {}

  start() {
    this.timer = setInterval(() => void this.tick(), 5 * 60000);
    this.timer.unref();
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
  async settle() {
    await Promise.allSettled([...this.pending.values()]);
  }

  private once<T>(key: string, work: () => Promise<T>): Promise<T> {
    const existing = this.pending.get(key) as Promise<T> | undefined;
    if (existing) return existing;
    const promise = work().finally(() => this.pending.delete(key));
    this.pending.set(key, promise);
    return promise;
  }

  /** A client for a ClickUp token Credential. */
  async clientFor(credentialId: string): Promise<ClickUpClient> {
    const [row] = await this.ctx.db.select().from(credentials).where(eq(credentials.id, credentialId));
    if (!row || row.kind !== 'clickup_token') throw badRequest('Choose a ClickUp token');
    return this.ctx.clickup(this.ctx.config.secrets.decrypt(row.secretCiphertext));
  }

  /** Fetches the Statuses and every Task of a source. A ClickUp failure is a `400` with its message. */
  async fetch(link: LinkConfig): Promise<Snapshot> {
    try {
      const client = await this.clientFor(link.credentialId);
      const parsed = parseClickUpQuery(link.query);
      if (!parsed.ok) throw badRequest(parsed.error);
      const source: ClickUpSource = { type: link.sourceType, id: link.sourceId, teamId: link.teamId, query: parsed.params };
      const taskList = await client.tasks(source);
      const listIds = link.sourceType === 'list' ? [link.sourceId] : [...new Set(taskList.map((t) => t.listId).filter((x): x is string => !!x))];
      const byId = new Map<string, ClickUpStatus>();
      for (const listId of listIds) for (const s of await client.listStatuses(listId)) if (!byId.has(s.id)) byId.set(s.id, s);
      // A task whose status the Lists don't report (it can happen with Views) still needs a Status.
      for (const t of taskList) if (!byId.has(t.status.id)) byId.set(t.status.id, t.status);
      const all = [...byId.values()];
      // Two Lists can both have "To do": keep one Status per name.
      const names = new Set<string>();
      const unique = all.filter((s) => !names.has(s.name.toLowerCase()) && !!names.add(s.name.toLowerCase()));
      return { statuses: unique, tasks: taskList.map((t) => ({ ...t, status: canonical(t.status, unique) })) };
    } catch (err) {
      if (err instanceof ClickUpError) throw badRequest(err.message);
      throw err;
    }
  }

  /** Applies a snapshot inside the Project's transaction: Statuses first, then Tasks. Returns the Tasks whose attachments need syncing. */
  async apply(tx: Executor, after: AfterCommit, projectId: string, snapshot: Snapshot, opts: { ensureEntryAndExit?: boolean } = {}): Promise<ClickUpTask[]> {
    await tx.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).for('update');
    await reconcileStatuses(tx, after, projectId, snapshot.statuses, opts.ensureEntryAndExit === true);
    const local = await tx.select().from(statuses).where(eq(statuses.projectId, projectId));
    const byClickUp = new Map(local.filter((s) => s.clickupStatusId).map((s) => [s.clickupStatusId!, s]));
    const byName = new Map(local.map((s) => [s.name.toLowerCase(), s]));
    const target = (s: ClickUpStatus) => byClickUp.get(s.id) ?? byName.get(s.name.toLowerCase())!;

    const known = await tx.select().from(tasks).where(and(eq(tasks.projectId, projectId), isNotNull(tasks.clickupTaskId)));
    const byTask = new Map(known.map((t) => [t.clickupTaskId!, t]));
    const seen = new Set<string>();
    const changed: string[] = [];

    for (const ct of snapshot.tasks) {
      seen.add(ct.id);
      const status = target(ct.status);
      const row = byTask.get(ct.id);
      const title = ct.name.trim().slice(0, 500) || '(untitled)';
      const description = ct.description.slice(0, 100_000);
      if (!row) {
        const created = await createTask(tx, after, projectId, { title, description, statusId: status.id, priority: 'none', tagIds: [], assigneeIds: [] }, CLICKUP_ACTOR);
        await tx
          .update(tasks)
          .set({ clickupTaskId: ct.id, clickupUrl: ct.url, clickupLinked: true, clickupDescription: description, clickupSeenStatus: ct.status.id })
          .where(eq(tasks.id, created.id));
        continue;
      }
      const changes: RevisionChange[] = [];
      if (row.title !== title) changes.push({ field: 'title', before: row.title, after: title });
      if (!row.descriptionDetached && row.description !== description) changes.push({ field: 'description', before: row.description, after: description });
      const keepLocalStatus = row.clickupPushPending && row.clickupSeenStatus === ct.status.id;
      await tx
        .update(tasks)
        .set({
          clickupUrl: ct.url,
          clickupLinked: true,
          clickupDescription: description,
          ...(keepLocalStatus ? {} : { clickupSeenStatus: ct.status.id, clickupPushPending: false }),
          ...(changes.length > 0
            ? {
                ...(changes.some((c) => c.field === 'title') ? { title } : {}),
                ...(changes.some((c) => c.field === 'description') ? { description } : {}),
                version: row.version + 1,
                updatedAt: new Date(),
              }
            : {}),
        })
        .where(eq(tasks.id, row.id));
      if (changes.length > 0) {
        await recordRevisions(tx, after, CLICKUP_ACTOR, [{ taskId: row.id, version: row.version + 1, changes }]);
        changed.push(row.id);
      }
      if (!keepLocalStatus && row.statusId !== status.id) {
        await moveTask(tx, after, row.id, { statusId: status.id }, CLICKUP_ACTOR, { fromClickUp: true });
      }
      if (!keepLocalStatus && row.clickupError) {
        await tx.update(tasks).set({ clickupError: null }).where(eq(tasks.id, row.id));
        if (!changed.includes(row.id)) changed.push(row.id);
      }
    }

    const gone = known.filter((t) => t.clickupLinked && !seen.has(t.clickupTaskId!));
    if (gone.length > 0) {
      await tx
        .update(tasks)
        .set({ clickupLinked: false, clickupPushPending: false, clickupError: null })
        .where(inArray(tasks.id, gone.map((t) => t.id)));
      changed.push(...gone.map((t) => t.id));
    }
    if (changed.length > 0) await emitTasksChanged(tx, after, changed, 'task.updated');
    return snapshot.tasks.filter((t) => t.attachments.length > 0 || byTask.get(t.id));
  }

  /** Copies the attachments of ClickUp tasks into the Blob store and drops the ones ClickUp no longer has. Returns notes for the sync error. */
  async syncAttachments(projectId: string, clickupTasks: ClickUpTask[], client: ClickUpClient): Promise<string[]> {
    const notes: string[] = [];
    const rows = await this.ctx.db
      .select({ id: tasks.id, clickupTaskId: tasks.clickupTaskId })
      .from(tasks)
      .where(and(eq(tasks.projectId, projectId), isNotNull(tasks.clickupTaskId)));
    const taskId = new Map(rows.map((r) => [r.clickupTaskId!, r.id]));
    for (const ct of clickupTasks) {
      const id = taskId.get(ct.id);
      if (!id) continue;
      const existing = await this.ctx.db.select().from(attachments).where(and(eq(attachments.taskId, id), isNotNull(attachments.clickupAttachmentId)));
      const have = new Set(existing.map((a) => a.clickupAttachmentId));
      for (const att of ct.attachments) {
        if (have.has(att.id)) continue;
        if (att.size !== null && att.size > ATTACHMENT_MAX_BYTES) {
          notes.push(`"${att.title}" is too large to copy`);
          continue;
        }
        try {
          const { stream, contentType } = await client.download(att);
          const filename = sanitizeFilename(att.title);
          const type = att.contentType ?? contentType ?? 'application/octet-stream';
          const stored = await this.ctx.blobs.put(stream, { filename, contentType: type });
          if (stored.size > ATTACHMENT_MAX_BYTES) {
            await this.ctx.blobs.delete(stored.id);
            notes.push(`"${att.title}" is too large to copy`);
            continue;
          }
          await this.ctx.db.insert(attachments).values({ taskId: id, blobId: stored.id, clickupAttachmentId: att.id, filename, contentType: type, size: stored.size });
        } catch (err) {
          notes.push(`"${att.title}" could not be copied: ${err instanceof Error ? err.message : 'error'}`);
        }
      }
      const keep = new Set(ct.attachments.map((a) => a.id));
      for (const old of existing.filter((a) => !keep.has(a.clickupAttachmentId!))) {
        await this.ctx.db.delete(attachments).where(eq(attachments.id, old.id));
        await this.ctx.blobs.delete(old.blobId).catch(() => undefined);
      }
    }
    return notes;
  }

  /** The state of the link after a pass, stored on the Project. */
  private async recordPass(projectId: string, patch: { lastSyncedAt?: string; lastError: string | null }): Promise<void> {
    await transact(this.ctx, async (tx, after) => {
      const [p] = await tx.select().from(projects).where(eq(projects.id, projectId)).for('update');
      if (!p?.clickup) return;
      const [updated] = await tx
        .update(projects)
        .set({ clickup: { ...p.clickup, ...patch }, updatedAt: new Date() })
        .where(eq(projects.id, projectId))
        .returning();
      after.emit(projectTopic(projectId), { type: 'project.updated', project: serializeProject(updated!) });
    });
  }

  /** One pass over a Project; throws nothing, the outcome is stored on the link. */
  syncProject(projectId: string): Promise<void> {
    return this.once(`project:${projectId}`, async () => {
      const [project] = await this.ctx.db.select().from(projects).where(eq(projects.id, projectId));
      if (!project?.clickup) throw notFound('ClickUp link');
      const link = project.clickup;
      try {
        await this.pushPending(projectId);
        const snapshot = await this.fetch(link);
        const attachmentTasks = await transact(this.ctx, async (tx, after) => {
          const [current] = await tx.select().from(projects).where(eq(projects.id, projectId)).for('update');
          // The link changed while we were fetching: the next pass uses the new one.
          if (JSON.stringify(sourceOf(current?.clickup)) !== JSON.stringify(sourceOf(link))) return null;
          return this.apply(tx, after, projectId, snapshot);
        });
        if (!attachmentTasks) return;
        const notes = await this.syncAttachments(projectId, attachmentTasks, await this.clientFor(link.credentialId));
        await this.recordPass(projectId, { lastSyncedAt: new Date().toISOString(), lastError: notes.length > 0 ? notes.join('; ') : null });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'ClickUp sync failed';
        this.ctx.log.warn({ message, projectId }, 'ClickUp sync failed');
        await this.recordPass(projectId, { lastError: message }).catch(() => undefined);
      }
    });
  }

  tick(): Promise<void> {
    return this.once('tick', async () => {
      const rows = await this.ctx.db
        .select({ id: projects.id })
        .from(projects)
        .where(and(isNotNull(projects.clickup)))
        .orderBy(asc(projects.createdAt));
      for (const p of rows) {
        const [row] = await this.ctx.db.select({ archivedAt: projects.archivedAt }).from(projects).where(eq(projects.id, p.id));
        if (row && !row.archivedAt) await this.syncProject(p.id);
      }
    });
  }

  private async pushPending(projectId: string): Promise<void> {
    const rows = await this.ctx.db
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.projectId, projectId), eq(tasks.clickupPushPending, true), eq(tasks.clickupLinked, true)));
    for (const r of rows) await this.push(r.id);
  }

  /** Sends the Task's current Status to ClickUp, retrying a few times; a definitive failure is stored on the Task. */
  push(taskId: string): Promise<void> {
    return this.once(`push:${taskId}`, async () => {
      let lastError = 'ClickUp push failed';
      for (let round = 0; round < 5; round++) {
        let sentStatusId: string | null = null;
        for (let attempt = 0; attempt <= this.retryDelaysMs.length; attempt++) {
          try {
            const row = await getTaskRow(this.ctx.db, taskId);
            if (!row.clickupPushPending || !row.clickupLinked || !row.clickupTaskId) return;
            const [project] = await this.ctx.db.select().from(projects).where(eq(projects.id, row.projectId));
            if (!project?.clickup) return;
            const [status] = await this.ctx.db.select().from(statuses).where(eq(statuses.id, row.statusId));
            await (await this.clientFor(project.clickup.credentialId)).setStatus(row.clickupTaskId, status!.name);
            sentStatusId = status!.id;
            break;
          } catch (err) {
            lastError = err instanceof Error ? err.message : lastError;
            if (attempt < this.retryDelaysMs.length) await new Promise((r) => setTimeout(r, this.retryDelaysMs[attempt]));
          }
        }
        if (!sentStatusId) {
          await this.failPush(taskId, lastError);
          return;
        }
        // Moved again while we were sending: send the newer Status too.
        const done = await transact(this.ctx, async (tx, after) => {
          const row = await getTaskRow(tx, taskId, { lock: true });
          if (row.statusId !== sentStatusId) return false;
          const [status] = await tx.select().from(statuses).where(eq(statuses.id, row.statusId));
          await tx
            .update(tasks)
            .set({ clickupPushPending: false, clickupError: null, clickupSeenStatus: status?.clickupStatusId ?? row.clickupSeenStatus })
            .where(eq(tasks.id, taskId));
          await emitTasksChanged(tx, after, [taskId], 'task.updated');
          return true;
        });
        if (done) return;
      }
    });
  }

  private async failPush(taskId: string, message: string): Promise<void> {
    await transact(this.ctx, async (tx, after) => {
      await tx.update(tasks).set({ clickupPushPending: false, clickupError: message.slice(0, 500) }).where(eq(tasks.id, taskId));
      await emitTasksChanged(tx, after, [taskId], 'task.updated');
    }).catch((err) => this.ctx.log.warn({ err }, 'Could not record a ClickUp push failure'));
  }
}

function sourceOf(link: ProjectClickUp | null | undefined) {
  return link ? [link.credentialId, link.teamId, link.sourceType, link.sourceId, link.query] : null;
}

/** The kept status that stands for a task's status when two Lists share a name. */
function canonical(status: ClickUpStatus, unique: ClickUpStatus[]): ClickUpStatus {
  return unique.find((u) => u.id === status.id) ?? unique.find((u) => u.name.toLowerCase() === status.name.toLowerCase()) ?? status;
}

/** Creates, renames, recolors and reorders Statuses to match ClickUp's. Categories of existing Statuses are left alone. */
async function reconcileStatuses(tx: Executor, after: AfterCommit, projectId: string, wanted: ClickUpStatus[], ensureEntryAndExit: boolean): Promise<void> {
  const existing = await tx.select().from(statuses).where(eq(statuses.projectId, projectId));
  const sorted = [...wanted].sort((a, b) => a.orderindex - b.orderindex);
  const used = new Set<string>();
  for (const [position, cu] of sorted.entries()) {
    const match =
      existing.find((s) => s.clickupStatusId === cu.id && !used.has(s.id)) ??
      existing.find((s) => s.name.toLowerCase() === cu.name.toLowerCase() && !used.has(s.id));
    if (match) {
      used.add(match.id);
      const clash = existing.some((s) => s.id !== match.id && s.name.toLowerCase() === cu.name.toLowerCase());
      await tx
        .update(statuses)
        .set({ clickupStatusId: cu.id, color: cu.color, position, ...(clash ? {} : { name: cu.name }) })
        .where(eq(statuses.id, match.id));
    } else {
      const [created] = await tx
        .insert(statuses)
        .values({ projectId, name: cu.name, color: cu.color, category: deduceCategory(cu.type, cu.name), position, clickupStatusId: cu.id })
        .returning();
      used.add(created!.id);
    }
  }
  // Statuses ClickUp no longer has go after the mirrored ones; one still holding Tasks stays, an empty one goes.
  let next = sorted.length;
  for (const s of existing.filter((e) => !used.has(e.id))) {
    const [holder] = await tx.select({ id: tasks.id }).from(tasks).where(eq(tasks.statusId, s.id)).limit(1);
    if (holder) await tx.update(statuses).set({ position: next++ }).where(eq(statuses.id, s.id));
    else await tx.delete(statuses).where(eq(statuses.id, s.id));
  }
  if (ensureEntryAndExit) {
    const all = await listStatuses(tx, projectId);
    const set = (id: string, category: Category) => tx.update(statuses).set({ category }).where(eq(statuses.id, id));
    if (all.length > 0 && !all.some((s) => s.category === 'open')) await set(all[0]!.id, 'open');
    if (all.length > 1 && !all.some((s) => s.category === 'closed')) await set(all[all.length - 1]!.id, 'closed');
  }
  await emitStatusesChanged(tx, after, projectId);
}
