import { CSRF_HEADER } from '@claude-task/shared';
import type { Actor } from '@claude-task/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppContext } from '../context';
import { forbidden, unauthorized } from '../errors';
import { LOGIN_COOKIE, resolveLogin, setLoginCookie } from './logins';
import type { LoginInfo, UserRow } from './logins';

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Who may call the route. Defaults to `user`. */
    auth?: 'public' | 'user' | 'admin';
    /** Reachable while the user still has to change a temporary password. */
    allowPendingPasswordChange?: boolean;
  }
  interface FastifyRequest {
    auth: LoginInfo | null;
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Authentication, role checks and CSRF defense for every route in `app`. */
export function installGuard(app: FastifyInstance, ctx: AppContext): void {
  app.decorateRequest('auth', null);
  app.addHook('onRequest', async (request, reply) => {
    const config = request.routeOptions.config;
    if (!SAFE_METHODS.has(request.method) && request.headers[CSRF_HEADER] === undefined) {
      throw forbidden(`Missing ${CSRF_HEADER} header`, 'csrf');
    }
    const level = config.auth ?? 'user';
    if (level === 'public') return;

    const token = request.cookies[LOGIN_COOKIE];
    const login = token ? await resolveLogin(ctx.db, token) : null;
    if (!login) throw unauthorized();
    request.auth = login;
    // Keep the browser cookie in step with the sliding server-side expiry.
    if (login.extended) setLoginCookie(reply, token!, ctx.config.cookieSecure);
    if (login.user.mustChangePassword && !config.allowPendingPasswordChange) {
      throw forbidden('You must change your password first', 'password_change_required');
    }
    if (level === 'admin' && login.user.role !== 'admin') throw forbidden('Admins only');
  });
}

export function currentUser(request: FastifyRequest): UserRow {
  if (!request.auth) throw unauthorized();
  return request.auth.user;
}

export function userActor(user: UserRow): Actor {
  return { type: 'user', id: user.id, displayName: user.displayName };
}
