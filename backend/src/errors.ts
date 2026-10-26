import type { ZodType } from 'zod';

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    /** Extra top-level fields for the response body (e.g. the current Task on 409). */
    readonly extra?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new HttpError(400, 'bad_request', message, details);
export const unauthorized = (message = 'Not logged in') => new HttpError(401, 'unauthorized', message);
export const forbidden = (message = 'Not allowed', code = 'forbidden') => new HttpError(403, code, message);
export const notFound = (what = 'Resource') => new HttpError(404, 'not_found', `${what} not found`);
export const conflict = (message: string, extra?: Record<string, unknown>) =>
  new HttpError(409, 'conflict', message, undefined, extra);

export function parse<T>(schema: ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new HttpError(400, 'validation_failed', 'Invalid request', result.error.issues);
  }
  return result.data;
}

const UNIQUE_MESSAGES: Record<string, string> = {
  users_email_unique: 'A user with this email already exists',
  projects_key_unique: 'A project with this key already exists',
  statuses_name_unique: 'A status with this name already exists in the project',
  tags_name_unique: 'A tag with this name already exists in the project',
  credentials_name_unique: 'A credential with this name already exists',
  agents_name_unique: 'An agent with this name already exists',
  project_env_vars_name_unique: 'This variable already exists in the project',
};

/** Turns Postgres constraint errors into client errors; returns null for anything else. */
export function fromDatabaseError(err: unknown): HttpError | null {
  const e = findPgError(err);
  if (!e) return null;
  if (e.code === '23505') {
    return conflict(UNIQUE_MESSAGES[e.constraint ?? ''] ?? 'Already exists');
  }
  if (e.code === '23503') return badRequest('Refers to something that does not exist');
  // Deadlock or serialization failure: nothing was written, the client can simply retry.
  if (e.code === '40P01' || e.code === '40001') {
    return new HttpError(409, 'retry', 'The request clashed with a concurrent change; please retry');
  }
  if (e.code === '22P02') return badRequest('Malformed identifier');
  return null;
}

function findPgError(err: unknown): { code: string; constraint?: string } | null {
  // Drizzle wraps driver errors, so look through the cause chain.
  for (let cur: unknown = err, depth = 0; cur && depth < 5; cur = (cur as { cause?: unknown }).cause, depth++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) {
      return cur as { code: string; constraint?: string };
    }
  }
  return null;
}
