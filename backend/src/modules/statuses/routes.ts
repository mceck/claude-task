import { createStatusBody, deleteStatusQuery, reorderStatusesBody, updateStatusBody } from '@claude-task/shared';
import { and, eq, max } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { currentUser, userActor } from '../../auth/guard';
import { transact } from '../../context';
import type { AppContext } from '../../context';
import { statuses } from '../../db/schema';
import { badRequest, notFound, parse } from '../../errors';
import { getBoardProject } from '../projects/service';
import { onStatusClosedChanged } from '../../sessions/lifecycle';
import { relocateStatusTasks } from '../tasks/service';
import { assertEntryAndExit, emitStatusesChanged, getStatus, listStatuses, serializeStatus } from './service';
import { idOrKey } from '../../ids';

const projectParams = z.object({ projectId: idOrKey });
const params = z.object({ id: z.uuid() });

export function statusRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/projects/:projectId/statuses', async (request) => {
    const { projectId } = parse(projectParams, request.params);
    const project = await getBoardProject(ctx.db, projectId);
    return { statuses: await listStatuses(ctx.db, project.id) };
  });

  app.post('/projects/:projectId/statuses', async (request, reply) => {
    const { projectId } = parse(projectParams, request.params);
    const body = parse(createStatusBody, request.body);
    const status = await transact(ctx, async (tx, after) => {
      // Every status change locks the project row, so invariant checks don't race.
      const project = await getBoardProject(tx, projectId, { lock: true });
      const [last] = await tx.select({ p: max(statuses.position) }).from(statuses).where(eq(statuses.projectId, project.id));
      const [status] = await tx
        .insert(statuses)
        .values({ ...body, projectId: project.id, position: (last?.p ?? -1) + 1 })
        .returning();
      await emitStatusesChanged(tx, after, project.id);
      return status!;
    });
    return reply.status(201).send({ status: serializeStatus(status) });
  });

  app.patch('/statuses/:id', async (request) => {
    const { id } = parse(params, request.params);
    const body = parse(updateStatusBody, request.body);
    return transact(ctx, async (tx, after) => {
      // Read it again under the Project lock: a concurrent change or deletion may have won.
      await getBoardProject(tx, (await getStatus(tx, id)).projectId, { lock: true });
      const existing = await getStatus(tx, id);
      // An empty edit changes nothing; returning it avoids Drizzle's "No values to set" error.
      if (Object.keys(body).length === 0) return { status: serializeStatus(existing) };
      if (body.category && body.category !== existing.category) {
        const all = await listStatuses(tx, existing.projectId);
        assertEntryAndExit(all.map((s) => (s.id === id ? body.category! : s.category)));
      }
      const [status] = await tx.update(statuses).set(body).where(eq(statuses.id, id)).returning();
      if (body.category && (body.category === 'closed') !== (existing.category === 'closed')) {
        await onStatusClosedChanged(tx, after, id, body.category === 'closed');
      }
      await emitStatusesChanged(tx, after, existing.projectId);
      return { status: serializeStatus(status!) };
    });
  });

  app.put('/projects/:projectId/statuses/order', async (request) => {
    const { projectId } = parse(projectParams, request.params);
    const body = parse(reorderStatusesBody, request.body);
    return transact(ctx, async (tx, after) => {
      const project = await getBoardProject(tx, projectId, { lock: true });
      const current = await listStatuses(tx, project.id);
      const ids = new Set(body.statusIds);
      if (ids.size !== body.statusIds.length || ids.size !== current.length || current.some((s) => !ids.has(s.id))) {
        throw badRequest('statusIds must list every status of the project exactly once');
      }
      for (const [position, statusId] of body.statusIds.entries()) {
        await tx.update(statuses).set({ position }).where(eq(statuses.id, statusId));
      }
      return { statuses: await emitStatusesChanged(tx, after, project.id) };
    });
  });

  app.delete('/statuses/:id', async (request, reply) => {
    const { id } = parse(params, request.params);
    const { targetStatusId } = parse(deleteStatusQuery, request.query);
    const actor = userActor(currentUser(request));
    await transact(ctx, async (tx, after) => {
      await getBoardProject(tx, (await getStatus(tx, id)).projectId, { lock: true });
      const existing = await getStatus(tx, id);
      if (targetStatusId === id) throw badRequest('Choose a different status for its tasks');
      const [target] = await tx
        .select()
        .from(statuses)
        .where(and(eq(statuses.id, targetStatusId), eq(statuses.projectId, existing.projectId)));
      if (!target) throw notFound('Target status');
      const remaining = (await listStatuses(tx, existing.projectId)).filter((s) => s.id !== id);
      assertEntryAndExit(remaining.map((s) => s.category));

      await relocateStatusTasks(tx, after, { fromStatusId: id, toStatusId: target.id, actor });
      await tx.delete(statuses).where(eq(statuses.id, id));
      await emitStatusesChanged(tx, after, existing.projectId);
    });
    return reply.status(204).send();
  });
}
