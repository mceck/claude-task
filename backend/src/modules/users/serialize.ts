import type { User } from '@claude-task/shared';
import type { UserRow } from '../../auth/logins';

export function serializeUser(u: UserRow): User {
  return {
    id: u.id,
    email: u.email,
    displayName: u.displayName,
    role: u.role,
    active: u.active,
    mustChangePassword: u.mustChangePassword,
    createdAt: u.createdAt.toISOString(),
    updatedAt: u.updatedAt.toISOString(),
  };
}
