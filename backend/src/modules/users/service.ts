import { and, asc, count, eq, sql } from 'drizzle-orm';
import { generateTemporaryPassword, hashPassword } from '../../auth/passwords';
import type { UserRow } from '../../auth/logins';
import type { Executor } from '../../db/client';
import { users } from '../../db/schema';

export function findUserByEmail(db: Executor, email: string): Promise<UserRow | undefined> {
  return db
    .select()
    .from(users)
    .where(eq(sql`lower(${users.email})`, email.trim().toLowerCase()))
    .then((rows) => rows[0]);
}

/** On first boot with ADMIN_EMAIL/ADMIN_PASSWORD set, creates that admin. */
export async function bootstrapAdmin(
  db: Executor,
  admin: { email: string; password: string; displayName: string } | null,
): Promise<boolean> {
  if (!admin) return false;
  const [row] = await db.select({ n: count() }).from(users);
  if ((row?.n ?? 0) > 0) return false;
  await db.insert(users).values({
    email: admin.email,
    displayName: admin.displayName,
    passwordHash: await hashPassword(admin.password),
    role: 'admin',
  });
  return true;
}

export interface CreateOrPromoteResult {
  user: UserRow;
  created: boolean;
  /** Set when the password was generated and must be shown to the operator. */
  generatedPassword: string | null;
}

/**
 * Recovery path for the CLI: creates an admin, or promotes and reactivates an
 * existing user. A given password replaces the existing one.
 */
export async function createOrPromoteAdmin(
  db: Executor,
  input: { email: string; password?: string; displayName?: string },
): Promise<CreateOrPromoteResult> {
  const existing = await findUserByEmail(db, input.email);
  if (existing) {
    const [user] = await db
      .update(users)
      .set({
        role: 'admin',
        active: true,
        updatedAt: new Date(),
        ...(input.password ? { passwordHash: await hashPassword(input.password), mustChangePassword: false } : {}),
        ...(input.displayName ? { displayName: input.displayName } : {}),
      })
      .where(eq(users.id, existing.id))
      .returning();
    return { user: user!, created: false, generatedPassword: null };
  }
  const generatedPassword = input.password ? null : generateTemporaryPassword();
  const [user] = await db
    .insert(users)
    .values({
      email: input.email.trim(),
      displayName: input.displayName ?? input.email.split('@')[0]!,
      passwordHash: await hashPassword(input.password ?? generatedPassword!),
      role: 'admin',
      mustChangePassword: generatedPassword !== null,
    })
    .returning();
  return { user: user!, created: true, generatedPassword };
}

/**
 * Locks every active admin row, always in id order, so concurrent role/activation changes
 * serialize instead of deadlocking. Call it before locking the target user.
 */
export async function lockActiveAdmins(db: Executor): Promise<string[]> {
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.role, 'admin'), eq(users.active, true)))
    .orderBy(asc(users.id))
    .for('update');
  return rows.map((r) => r.id);
}
