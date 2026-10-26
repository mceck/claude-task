import { deviceRegistrationBody, readPositionBody, taskPreferenceBody } from '@claude-task/shared';
import { and, eq, gt, ne } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { currentUser } from '../auth/guard';
import { transact } from '../context';
import type { AppContext } from '../context';
import { logins, pushDevices } from '../db/schema';
import { forbidden, parse } from '../errors';
import { getProject } from '../modules/projects/service';
import { getTaskRow } from '../modules/tasks/service';
import { hashToken } from '../secrets';
import { advanceRead, preferences, setPreference } from './preferences';
import { idOrKey } from '../ids';

const params = z.object({ id: idOrKey });
export function notificationRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/notifications/status', async () => ({ configured: ctx.push.configured, provider: 'fcm' }));
  app.get('/projects/:id/task-preferences', async (request) => {
    const project = await getProject(ctx.db, parse(params, request.params).id);
    return { preferences: await preferences(ctx.db, currentUser(request).id, { projectId: project.id }) };
  });
  app.get('/tasks/:id/preferences', async (request) => {
    const task = await getTaskRow(ctx.db, parse(params, request.params).id);
    return { preference: (await preferences(ctx.db, currentUser(request).id, { taskId: task.id }))[0] };
  });
  app.patch('/tasks/:id/preferences', async (request) => {
    const body = parse(taskPreferenceBody, request.body);
    const task = await getTaskRow(ctx.db, parse(params, request.params).id);
    return { preference: await transact(ctx, (tx, after) => setPreference(tx, after, currentUser(request).id, task.id, body)) };
  });
  app.put('/tasks/:id/read-position', async (request) => {
    const { itemId } = parse(readPositionBody, request.body);
    const task = await getTaskRow(ctx.db, parse(params, request.params).id);
    return { preference: await transact(ctx, (tx, after) => advanceRead(tx, after, currentUser(request).id, task.id, itemId)) };
  });
  app.put('/notifications/devices', async (request, reply) => {
    const body = parse(deviceRegistrationBody, request.body);
    const userId = currentUser(request).id;
    await ctx.db.transaction(async (tx) => {
      // A registration left behind by a logged-out or expired Login (same phone, another User) is stale: replace it.
      const claimable = async (row: typeof pushDevices.$inferSelect | undefined, message: string) => {
        if (!row || row.userId === userId) return;
        const [live] = await tx.select({ id: logins.id }).from(logins).where(and(eq(logins.id, row.loginId), gt(logins.expiresAt, new Date())));
        if (live) throw forbidden(message);
        await tx.delete(pushDevices).where(eq(pushDevices.id, row.id));
      };
      const [existing] = await tx.select().from(pushDevices).where(eq(pushDevices.id, body.deviceId)).for('update');
      await claimable(existing, 'Device belongs to another User');
      const tokenHash = hashToken(body.token);
      const [tokenOwner] = await tx.select().from(pushDevices).where(eq(pushDevices.tokenHash, tokenHash)).for('update');
      await claimable(tokenOwner, 'Token belongs to another User');
      await tx.delete(pushDevices).where(and(eq(pushDevices.tokenHash, tokenHash), eq(pushDevices.userId, userId), ne(pushDevices.id, body.deviceId)));
      const record = { userId, loginId: request.auth!.loginId, platform: body.platform,
        tokenHash, tokenCiphertext: ctx.config.secrets.encrypt(body.token), updatedAt: new Date() };
      await tx.insert(pushDevices).values({ id: body.deviceId, ...record })
        .onConflictDoUpdate({ target: pushDevices.id, set: record });
    });
    return reply.status(204).send();
  });
  app.delete('/notifications/devices/:id', async (request, reply) => {
    const { id } = parse(z.object({ id: z.uuid() }), request.params);
    await ctx.db.delete(pushDevices).where(and(eq(pushDevices.id, id), eq(pushDevices.userId, currentUser(request).id)));
    return reply.status(204).send();
  });
}
