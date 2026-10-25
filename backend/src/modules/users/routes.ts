import { createUserBody, updateUserBody } from '@claude-task/shared';
import { asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { generateTemporaryPassword, hashPassword } from '../../auth/passwords';
import { deleteUserLogins } from '../../auth/logins';
import type { AppContext } from '../../context';
import { users } from '../../db/schema';
import { badRequest, notFound, parse } from '../../errors';
import { serializeUser } from './serialize';
import { lockActiveAdmins } from './service';

const params = z.object({ id: z.uuid() });

export function userRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/users', async () => {
    const rows = await ctx.db.select().from(users).orderBy(asc(users.displayName));
    return { users: rows.map(serializeUser) };
  });

  app.post('/users', { config: { auth: 'admin' } }, async (request, reply) => {
    const body = parse(createUserBody, request.body);
    const temporaryPassword = body.temporaryPassword ?? generateTemporaryPassword();
    const [user] = await ctx.db
      .insert(users)
      .values({
        email: body.email,
        displayName: body.displayName,
        role: body.role,
        passwordHash: await hashPassword(temporaryPassword),
        mustChangePassword: true,
      })
      .returning();
    return reply.status(201).send({ user: serializeUser(user!), temporaryPassword });
  });

  app.patch('/users/:id', { config: { auth: 'admin' } }, async (request) => {
    const { id } = parse(params, request.params);
    const body = parse(updateUserBody, request.body);
    const result = await ctx.db.transaction(async (tx) => {
      const admins = await lockActiveAdmins(tx);
      const [existing] = await tx.select().from(users).where(eq(users.id, id)).for('update');
      if (!existing) throw notFound('User');
      const stepsDown =
        existing.role === 'admin' && existing.active && (body.role === 'member' || body.active === false);
      if (stepsDown && !admins.some((a) => a !== id)) {
        throw badRequest('There must always be at least one active admin');
      }
      const [user] = await tx
        .update(users)
        .set({ ...body, updatedAt: new Date() })
        .where(eq(users.id, id))
        .returning();
      const deactivated = existing.active && body.active === false;
      if (deactivated) await deleteUserLogins(tx, id);
      return { user: user!, deactivated };
    });
    if (result.deactivated) ctx.hub.disconnect({ userId: id });
    return { user: serializeUser(result.user) };
  });

  app.post('/users/:id/reset-password', { config: { auth: 'admin' } }, async (request) => {
    const { id } = parse(params, request.params);
    const temporaryPassword = generateTemporaryPassword();
    const passwordHash = await hashPassword(temporaryPassword);
    const user = await ctx.db.transaction(async (tx) => {
      const [user] = await tx
        .update(users)
        .set({ passwordHash, mustChangePassword: true, updatedAt: new Date() })
        .where(eq(users.id, id))
        .returning();
      if (!user) throw notFound('User');
      await deleteUserLogins(tx, id);
      return user;
    });
    ctx.hub.disconnect({ userId: id });
    return { user: serializeUser(user), temporaryPassword };
  });
}
