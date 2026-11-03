import { clickUpLinkBody, projectTopic, updateClickUpLinkBody } from '@claude-task/shared';
import type { ClickUpOption } from '@claude-task/shared';
import { and, asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { currentUser, userActor } from '../auth/guard';
import { transact } from '../context';
import type { AppContext } from '../context';
import { credentials, projects, tasks } from '../db/schema';
import { badRequest, parse } from '../errors';
import { idOrKey } from '../ids';
import { getBoardProject, serializeProject } from '../modules/projects/service';
import { emitTasksChanged, getTaskRow, loadTask, recordRevisions } from '../modules/tasks/service';

const projectParams = z.object({ id: idOrKey });
const taskParams = z.object({ id: idOrKey });
const pickerQuery = z.object({
  credentialId: z.uuid(),
  teamId: z.string().min(1).max(50).optional(),
  spaceId: z.string().min(1).max(50).optional(),
});

/** ClickUp links: the pickers of the "New project" dialog and the actions on a linked Project and its Tasks. */
export function clickupRoutes(app: FastifyInstance, ctx: AppContext): void {
  // Any User can pick a ClickUp token; the secret never leaves the backend.
  app.get('/clickup/credentials', async () => {
    const rows = await ctx.db.select().from(credentials).where(eq(credentials.kind, 'clickup_token')).orderBy(asc(credentials.name));
    return { credentials: rows.map((c) => ({ id: c.id, name: c.name, last4: c.secretLast4 })) };
  });

  const picker = (path: string, load: (client: Awaited<ReturnType<typeof ctx.clickupSync.clientFor>>, q: z.infer<typeof pickerQuery>) => Promise<ClickUpOption[]>) =>
    app.get(path, async (request) => {
      const q = parse(pickerQuery, request.query);
      return { options: await load(await ctx.clickupSync.clientFor(q.credentialId), q) };
    });
  picker('/clickup/teams', (c) => c.teams());
  picker('/clickup/spaces', (c, q) => (q.teamId ? c.spaces(q.teamId) : Promise.reject(badRequest('teamId is required'))));
  picker('/clickup/lists', (c, q) => (q.spaceId ? c.lists(q.spaceId) : Promise.reject(badRequest('spaceId is required'))));
  picker('/clickup/views', (c, q) => (q.teamId ? c.views(q.teamId) : Promise.reject(badRequest('teamId is required'))));

  // Changing the link (token, source, query) re-syncs at once.
  app.patch('/projects/:id/clickup', async (request) => {
    const { id } = parse(projectParams, request.params);
    const body = parse(updateClickUpLinkBody, request.body);
    const project = await getBoardProject(ctx.db, id);
    if (!project.clickup) throw badRequest('This project is not linked to ClickUp');
    const next = { ...project.clickup, ...body, query: body.query ?? project.clickup.query };
    await ctx.clickupSync.fetch(next);
    await transact(ctx, async (tx, after) => {
      const [updated] = await tx
        .update(projects)
        .set({ clickup: { ...next, lastError: null }, updatedAt: new Date() })
        .where(eq(projects.id, project.id))
        .returning();
      after.emit(projectTopic(project.id), { type: 'project.updated', project: serializeProject(updated!) });
    });
    await ctx.clickupSync.syncProject(project.id);
    return { project: serializeProject(await getBoardProject(ctx.db, project.id)) };
  });

  app.delete('/projects/:id/clickup', async (request) => {
    const { id } = parse(projectParams, request.params);
    return transact(ctx, async (tx, after) => {
      const project = await getBoardProject(tx, id, { lock: true });
      if (!project.clickup) throw badRequest('This project is not linked to ClickUp');
      const [updated] = await tx.update(projects).set({ clickup: null, updatedAt: new Date() }).where(eq(projects.id, project.id)).returning();
      const linked = await tx
        .update(tasks)
        .set({ clickupLinked: false, clickupPushPending: false, clickupError: null })
        .where(and(eq(tasks.projectId, project.id), eq(tasks.clickupLinked, true)))
        .returning({ id: tasks.id });
      after.emit(projectTopic(project.id), { type: 'project.updated', project: serializeProject(updated!) });
      if (linked.length > 0) await emitTasksChanged(tx, after, linked.map((t) => t.id), 'task.updated');
      return { project: serializeProject(updated!) };
    });
  });

  app.post('/projects/:id/clickup/sync', async (request) => {
    const { id } = parse(projectParams, request.params);
    const project = await getBoardProject(ctx.db, id);
    if (!project.clickup) throw badRequest('This project is not linked to ClickUp');
    await ctx.clickupSync.syncProject(project.id);
    return { project: serializeProject(await getBoardProject(ctx.db, project.id)) };
  });

  // Puts ClickUp's description back and reattaches it to the sync.
  app.post('/tasks/:id/clickup/restore-description', async (request) => {
    const { id } = parse(taskParams, request.params);
    const actor = userActor(currentUser(request));
    return transact(ctx, async (tx, after) => {
      const row = await getTaskRow(tx, id, { lock: true });
      if (!row.clickupTaskId || !row.descriptionDetached) throw badRequest('The description is already in sync with ClickUp');
      const description = row.clickupDescription ?? '';
      await tx
        .update(tasks)
        .set({ description, descriptionDetached: false, version: row.version + 1, updatedAt: new Date() })
        .where(eq(tasks.id, row.id));
      if (description !== row.description) {
        await recordRevisions(tx, after, actor, [
          { taskId: row.id, version: row.version + 1, changes: [{ field: 'description', before: row.description, after: description }] },
        ]);
      }
      await emitTasksChanged(tx, after, [row.id], 'task.updated');
      return { task: await loadTask(tx, row.id) };
    });
  });

  app.post('/tasks/:id/clickup/retry', async (request) => {
    const { id } = parse(taskParams, request.params);
    const row = await getTaskRow(ctx.db, id);
    if (!row.clickupLinked || !row.clickupTaskId) throw badRequest('This task is not linked to ClickUp');
    await ctx.db.update(tasks).set({ clickupPushPending: true, clickupError: null }).where(eq(tasks.id, row.id));
    await ctx.clickupSync.push(row.id);
    return { task: await loadTask(ctx.db, row.id) };
  });

}
