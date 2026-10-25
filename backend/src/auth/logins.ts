// Logins: a User's authenticated browser sessions, stored server-side.
// (Not to be confused with a Session, the agent conversation of Spec 02.)
import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, inArray, ne, sql } from 'drizzle-orm';
import type { FastifyReply } from 'fastify';
import type { Executor } from '../db/client';
import { logins, users } from '../db/schema';

export const LOGIN_COOKIE = 'ct_login';
export const LOGIN_IDLE_MS = 30 * 24 * 60 * 60 * 1000;
/** Don't write last_seen (or re-send the cookie) on every request. */
const TOUCH_INTERVAL_MS = 60 * 1000;

export type UserRow = typeof users.$inferSelect;

export interface LoginInfo {
  loginId: string;
  user: UserRow;
  /** The expiry was just pushed forward, so the cookie should be re-sent too. */
  extended: boolean;
}

const hashToken = (token: string) => createHash('sha256').update(token).digest('base64url');

/** The cookie lives as long as the server-side Login: 30 days from the last activity. */
export function setLoginCookie(reply: FastifyReply, token: string, secure: boolean): void {
  reply.setCookie(LOGIN_COOKIE, token, {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    maxAge: LOGIN_IDLE_MS / 1000,
  });
}

export async function createLogin(db: Executor, userId: string): Promise<{ token: string; loginId: string }> {
  const token = randomBytes(32).toString('base64url');
  const loginId = hashToken(token);
  await db.insert(logins).values({
    id: loginId,
    userId,
    expiresAt: new Date(Date.now() + LOGIN_IDLE_MS),
  });
  return { token, loginId };
}

/** Resolves a cookie token to a live Login of an active user, extending its expiry. */
export async function resolveLogin(db: Executor, token: string): Promise<LoginInfo | null> {
  const loginId = hashToken(token);
  const [row] = await db
    .select({ login: logins, user: users })
    .from(logins)
    .innerJoin(users, eq(users.id, logins.userId))
    .where(and(eq(logins.id, loginId), gt(logins.expiresAt, sql`now()`), eq(users.active, true)));
  if (!row) return null;
  const extended = Date.now() - row.login.lastSeenAt.getTime() > TOUCH_INTERVAL_MS;
  if (extended) {
    await db
      .update(logins)
      .set({ lastSeenAt: new Date(), expiresAt: new Date(Date.now() + LOGIN_IDLE_MS) })
      .where(eq(logins.id, loginId));
  }
  return { loginId, user: row.user, extended };
}

export async function deleteLogin(db: Executor, loginId: string): Promise<void> {
  await db.delete(logins).where(eq(logins.id, loginId));
}

/** Deletes a user's Logins (optionally keeping one) and returns the deleted ids. */
export async function deleteUserLogins(db: Executor, userId: string, keep?: string): Promise<string[]> {
  const deleted = await db
    .delete(logins)
    .where(keep ? and(eq(logins.userId, userId), ne(logins.id, keep)) : eq(logins.userId, userId))
    .returning({ id: logins.id });
  return deleted.map((d) => d.id);
}

export async function purgeExpiredLogins(db: Executor): Promise<void> {
  const expired = db.select({ id: logins.id }).from(logins).where(sql`${logins.expiresAt} <= now()`);
  await db.delete(logins).where(inArray(logins.id, expired));
}
