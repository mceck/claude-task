import { createTaskBody, listTasksQuery, moveTaskBody, timelineQuery, updateTaskBody } from '@claude-task/shared';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { tasks } from '../../db/schema';
import { z } from 'zod';
import { currentUser, userActor } from '../../auth/guard';
import { transact } from '../../context';
import type { AppContext } from '../../context';
import { notFound, parse } from '../../errors';
import { loadTimeline } from '../comments/service';
import { assertBoardTask, getBoardProject } from '../projects/service';
import { createTask, deleteTask, getTaskRow, loadCards, loadTask, moveTask, updateTask } from './service';
import { idOrKey } from '../../ids';

const projectParams = z.object({ projectId: idOrKey });
const params = z.object({ id: idOrKey });

export function taskRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/projects/:projectId/tasks', async (request) => {
    const { projectId } = parse(projectParams, request.params);
    const q = parse(listTasksQuery, request.query);
    const project = await getBoardProject(ctx.db, projectId);
    const tasks = await loadCards(ctx.db, {
      projectId: project.id,
      includeClosed: q.includeClosed === 'true',
      filter: { assignees: q.assignee, tags: q.tag, priorities: q.priority, text: q.q ?? '' },
    });
    return { tasks };
  });

  app.post('/projects/:projectId/tasks', async (request, reply) => {
    const { projectId } = parse(projectParams, request.params);
    const body = parse(createTaskBody, request.body);
    const actor = userActor(currentUser(request));
    const task = await transact(ctx, async (tx, after) => {
      const project = await getBoardProject(tx, projectId);
      return createTask(tx, after, project.id, body, actor);
    });
    return reply.status(201).send({ task });
  });

  app.get('/tasks/:id', async (request) => {
    const { id } = parse(params, request.params);
    const row = await getTaskRow(ctx.db, id);
    await ctx.gitSync.refreshTask(row.id);
    return { task: await loadTask(ctx.db, row.id) };
  });

  app.patch('/tasks/:id', async (request) => {
    const { id } = parse(params, request.params);
    const body = parse(updateTaskBody, request.body);
    const actor = userActor(currentUser(request));
    const task = await transact(ctx, async (tx, after) => {
      await assertBoardTask(tx, (await getTaskRow(tx, id)).projectId);
      return updateTask(tx, after, id, body, actor);
    });
    return { task };
  });

  app.post('/tasks/:id/move', async (request) => {
    const { id } = parse(params, request.params);
    const body = parse(moveTaskBody, request.body);
    const actor = userActor(currentUser(request));
    const task = await transact(ctx, async (tx, after) => {
      await assertBoardTask(tx, (await getTaskRow(tx, id)).projectId);
      return moveTask(tx, after, id, body, actor);
    });
    return { task };
  });

  app.delete('/tasks/:id', async (request, reply) => {
    const { id } = parse(params, request.params);
    await transact(ctx, async (tx, after) => {
      await assertBoardTask(tx, (await getTaskRow(tx, id)).projectId);
      const { blobIds } = await deleteTask(tx, after, id);
      for (const blobId of blobIds) after.run(() => ctx.blobs.delete(blobId));
    });
    return reply.status(204).send();
  });

  app.get('/tasks/:id/timeline', async (request) => {
    const { id } = parse(params, request.params);
    const q = parse(timelineQuery, request.query);
    return ctx.db.transaction(async (tx) => {
      const found = await getTaskRow(tx, id);
      // Reset Chat deletes every projection. Keep the owner locked while loading
      // the page so its items and generation describe the same conversation.
      const [row] = await tx.select().from(tasks).where(eq(tasks.id, found.id)).for('key share');
      if (!row) throw notFound('Task');
      return { ...(await loadTimeline(tx, row.id, q)), chatGeneration: row.chatGeneration };
    });
  });
}
