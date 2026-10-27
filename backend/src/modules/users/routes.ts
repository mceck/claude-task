import { createUserBody, updateUserBody, USER_AVATAR_MAX_BYTES, USER_AVATAR_TYPES } from '@claude-task/shared';
import { asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { generateTemporaryPassword, hashPassword } from '../../auth/passwords';
import { deleteUserLogins } from '../../auth/logins';
import { currentUser } from '../../auth/guard';
import type { AppContext } from '../../context';
import { users } from '../../db/schema';
import { badRequest, forbidden, notFound, parse } from '../../errors';
import { receiveAvatar } from '../avatar';
import { serializeUser } from './serialize';
import { lockActiveAdmins } from './service';

const params = z.object({ id: z.uuid() });

export function userRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/users/:id/avatar', async (request, reply) => {
    const { id } = parse(params, request.params);
    const [user] = await ctx.db.select().from(users).where(eq(users.id, id));
    if (!user) throw notFound('User');
    const blob = user.avatarBlobId ? await ctx.blobs.get(user.avatarBlobId) : null;
    if (!blob) throw notFound('Avatar');
    return reply
      .header('content-type', blob.metadata.contentType)
      .header('content-length', String(blob.metadata.size))
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'; sandbox")
      .header('cache-control', 'private, max-age=31536000, immutable')
      .send(blob.stream);
  });

  for (const method of ['PUT', 'DELETE'] as const) {
    app.route({
      method,
      url: '/users/:id/avatar',
      handler: async (request) => {
        const { id } = parse(params, request.params);
        const actor = currentUser(request);
        if (actor.id !== id && actor.role !== 'admin') throw forbidden('Only the User or an Admin can change this avatar');
        const [existing] = await ctx.db.select({ id: users.id }).from(users).where(eq(users.id, id));
        if (!existing) throw notFound('User');
        const blobId = method === 'PUT'
          ? await receiveAvatar(ctx, request, USER_AVATAR_MAX_BYTES, USER_AVATAR_TYPES)
          : null;
        const result = await ctx.db.transaction(async (tx) => {
          const [before] = await tx.select().from(users).where(eq(users.id, id)).for('update');
          if (!before) throw notFound('User');
          const [user] = await tx.update(users).set({ avatarBlobId: blobId, updatedAt: new Date() }).where(eq(users.id, id)).returning();
          return { before, user: user! };
        }).catch(async (err) => {
          if (blobId) await ctx.blobs.delete(blobId);
          throw err;
        });
        if (result.before.avatarBlobId) await ctx.blobs.delete(result.before.avatarBlobId);
        return { user: serializeUser(result.user) };
      },
    });
  }

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
