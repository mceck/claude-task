import type { User } from '@claude-task/shared';
import { API_PREFIX } from '@claude-task/shared';
import type { UserRow } from '../../auth/logins';

export function serializeUser(u: UserRow): User {
  return {
    id: u.id,
    email: u.email,
    displayName: u.displayName,
    avatarImageUrl: u.avatarBlobId ? `${API_PREFIX}/users/${u.id}/avatar?v=${u.avatarBlobId}` : null,
    role: u.role,
    active: u.active,
    mustChangePassword: u.mustChangePassword,
    createdAt: u.createdAt.toISOString(),
    updatedAt: u.updatedAt.toISOString(),
  };
}
