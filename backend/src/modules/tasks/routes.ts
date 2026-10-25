import { createTaskBody, listTasksQuery, moveTaskBody, timelineQuery, updateTaskBody } from '@claude-task/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { currentUser, userActor } from '../../auth/guard';
import { transact } from '../../context';
import type { AppContext } from '../../context';
import { parse } from '../../errors';
import { loadTimeline } from '../comments/service';
import { getProject } from '../projects/service';
import { createTask, deleteTask, getTaskRow, loadCards, loadTask, moveTask, updateTask } from './service';

const projectParams = z.object({ projectId: z.string().min(1).max(64) });
const params = z.object({ id: z.string().min(1).max(64) });

export function taskRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/projects/:projectId/tasks', async (request) => {
    const { projectId } = parse(projectParams, request.params);
    const q = parse(listTasksQuery, request.query);
    const project = await getProject(ctx.db, projectId);
    const tasks = await loadCards(ctx.db, {
      projectId: project.id,
      includeClosed: q.includeClosed === 'true',
      filter: { assignees: q.assignee, labels: q.label, priorities: q.priority, text: q.q ?? '' },
    });
    return { tasks };
  });

  app.post('/projects/:projectId/tasks', async (request, reply) => {
    const { projectId } = parse(projectParams, request.params);
    const body = parse(createTaskBody, request.body);
    const actor = userActor(currentUser(request));
    const task = await transact(ctx, async (tx, after) => {
      const project = await getProject(tx, projectId);
      return createTask(tx, after, project.id, body, actor);
    });
    return reply.status(201).send({ task });
  });

  app.get('/tasks/:id', async (request) => {
    const { id } = parse(params, request.params);
    const row = await getTaskRow(ctx.db, id);
    return { task: await loadTask(ctx.db, row.id) };
  });

  app.patch('/tasks/:id', async (request) => {
    const { id } = parse(params, request.params);
    const body = parse(updateTaskBody, request.body);
    const actor = userActor(currentUser(request));
    const task = await transact(ctx, (tx, after) => updateTask(tx, after, id, body, actor));
    return { task };
  });

  app.post('/tasks/:id/move', async (request) => {
    const { id } = parse(params, request.params);
    const body = parse(moveTaskBody, request.body);
    const actor = userActor(currentUser(request));
    const task = await transact(ctx, (tx, after) => moveTask(tx, after, id, body, actor));
    return { task };
  });

  app.delete('/tasks/:id', async (request, reply) => {
    const { id } = parse(params, request.params);
    await transact(ctx, async (tx, after) => {
      const { blobIds } = await deleteTask(tx, after, id);
      for (const blobId of blobIds) after.run(() => ctx.blobs.delete(blobId));
    });
    return reply.status(204).send();
  });

  app.get('/tasks/:id/timeline', async (request) => {
    const { id } = parse(params, request.params);
    const q = parse(timelineQuery, request.query);
    const row = await getTaskRow(ctx.db, id);
    return loadTimeline(ctx.db, row.id, q);
  });
}
