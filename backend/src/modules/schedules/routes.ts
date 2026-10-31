import { createScheduleBody, updateScheduleBody } from '@claude-task/shared';
import type { ProjectRepository } from '@claude-task/shared';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { currentUser } from '../../auth/guard';
import { transact } from '../../context';
import type { AppContext } from '../../context';
import { badRequest, parse } from '../../errors';
import { resolveRepository } from '../../git/service';
import { createSchedule, deleteSchedule, getSchedule, listSchedules, loadRuns, runNow, updateSchedule } from './service';

const params = z.object({ id: z.uuid() });
const admin = { config: { auth: 'admin' as const } };

export function scheduleRoutes(app: FastifyInstance, ctx: AppContext): void {
  /** Checks the Repository with its provider and its Git Connection, which is locked against deletion. */
  async function checkConnection(tx: Parameters<Parameters<typeof transact>[1]>[0], repository: ProjectRepository | null): Promise<void> {
    if (!repository) return;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`git-connection:${repository.connectionId}`}))`);
    if (!(await ctx.git.find(repository.connectionId, tx))) throw badRequest('Choose an existing Git Connection');
  }

  app.get('/schedules', async () => ({ schedules: await listSchedules(ctx.db) }));

  app.post('/schedules', admin, async (request, reply) => {
    const body = parse(createScheduleBody, request.body);
    const repository = body.repository ? await resolveRepository(ctx, body.repository) : null;
    const schedule = await transact(ctx, async (tx, after) => {
      await checkConnection(tx, repository);
      return createSchedule(tx, after, { ...body, repository }, currentUser(request).id);
    });
    return reply.status(201).send({ schedule });
  });

  app.get('/schedules/:id', async (request) => {
    const { id } = parse(params, request.params);
    return { schedule: await getSchedule(ctx.db, id) };
  });

  app.patch('/schedules/:id', admin, async (request) => {
    const { id } = parse(params, request.params);
    const body = parse(updateScheduleBody, request.body);
    const { repository: requested, ...rest } = body;
    const repository = requested === undefined ? undefined : requested === null ? null : await resolveRepository(ctx, requested);
    return transact(ctx, async (tx, after) => {
      await checkConnection(tx, repository ?? null);
      return { schedule: await updateSchedule(tx, after, id, { ...rest, ...(repository !== undefined ? { repository } : {}) }) };
    });
  });

  app.delete('/schedules/:id', admin, async (request, reply) => {
    const { id } = parse(params, request.params);
    const blobIds = await transact(ctx, (tx, after) => deleteSchedule(tx, after, id));
    for (const blobId of blobIds) await ctx.blobs.delete(blobId);
    return reply.status(204).send();
  });

  app.post('/schedules/:id/run', admin, async (request, reply) => {
    const { id } = parse(params, request.params);
    const run = await transact(ctx, (tx, after) => runNow(tx, after, id));
    return reply.status(201).send({ run });
  });

  app.get('/schedules/:id/runs', async (request) => {
    const { id } = parse(params, request.params);
    await getSchedule(ctx.db, id);
    return { runs: await loadRuns(ctx.db, { scheduleId: id }) };
  });
}
