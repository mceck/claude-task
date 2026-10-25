import { changePasswordBody, loginBody } from '@claude-task/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context';
import { users } from '../db/schema';
import { badRequest, HttpError, parse, unauthorized } from '../errors';
import { findUserByEmail } from '../modules/users/service';
import { serializeUser } from '../modules/users/serialize';
import { currentUser } from './guard';
import { burnPasswordCheck, hashPassword, verifyPassword } from './passwords';
import { AttemptLimiter } from './rate-limit';
import {
  createLogin,
  deleteLogin,
  deleteUserLogins,
  resolveLogin,
  LOGIN_COOKIE,
  setLoginCookie,
} from './logins';

export function authRoutes(app: FastifyInstance, ctx: AppContext): void {
  const limiter = new AttemptLimiter(ctx.config.loginRateLimit);

  app.post('/auth/login', { config: { auth: 'public' } }, async (request, reply) => {
    const body = parse(loginBody, request.body);
    const email = body.email.toLowerCase();
    const keys = [`ip:${request.ip}`, `email:${email}`];
    const wait = Math.max(...keys.map((k) => limiter.retryAfter(k)));
    if (wait > 0) {
      reply.header('retry-after', String(wait));
      throw new HttpError(429, 'rate_limited', 'Too many login attempts, try again later');
    }

    const user = await findUserByEmail(ctx.db, email);
    const valid = user ? await verifyPassword(user.passwordHash, body.password) : await burnPasswordCheck(body.password).then(() => false);
    if (!user || !valid || !user.active) {
      for (const k of keys) limiter.fail(k);
      throw unauthorized('Invalid email or password');
    }
    limiter.reset(`email:${email}`);
    const { token } = await createLogin(ctx.db, user.id);
    setLoginCookie(reply, token, ctx.config.cookieSecure);
    return { user: serializeUser(user) };
  });

  app.post('/auth/logout', { config: { auth: 'public' } }, async (request, reply) => {
    const token = request.cookies[LOGIN_COOKIE];
    const login = token ? await resolveLogin(ctx.db, token) : null;
    if (login) {
      await deleteLogin(ctx.db, login.loginId);
      ctx.hub.disconnect({ loginIds: [login.loginId] });
    }
    reply.clearCookie(LOGIN_COOKIE, { path: '/' });
    return reply.status(204).send();
  });

  app.get('/auth/me', { config: { allowPendingPasswordChange: true } }, async (request) => {
    return { user: serializeUser(currentUser(request)) };
  });

  app.post('/auth/password', { config: { allowPendingPasswordChange: true } }, async (request) => {
    const body = parse(changePasswordBody, request.body);
    const user = currentUser(request);
    if (!(await verifyPassword(user.passwordHash, body.currentPassword))) {
      throw badRequest('Current password is wrong');
    }
    if (body.newPassword === body.currentPassword) {
      throw badRequest('The new password must be different');
    }
    const passwordHash = await hashPassword(body.newPassword);
    const { updated, endedLogins } = await ctx.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(users)
        .set({ passwordHash, mustChangePassword: false, updatedAt: new Date() })
        .where(eq(users.id, user.id))
        .returning();
      // Other devices must log in again with the new password.
      const endedLogins = await deleteUserLogins(tx, user.id, request.auth!.loginId);
      return { updated: updated!, endedLogins };
    });
    ctx.hub.disconnect({ loginIds: endedLogins });
    return { user: serializeUser(updated) };
  });
}
