import { API_PREFIX, CSRF_HEADER } from '@claude-task/shared';
import type { ApiErrorBody } from '@claude-task/shared';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly body: unknown,
  ) {
    super(message);
  }
}

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

/** Called on a 401 from any request, including writes that have no Query mutation. */
let unauthorizedHandler: (() => void) | null = null;
export function setUnauthorizedHandler(handler: (() => void) | null): void {
  unauthorizedHandler = handler;
}

export async function api<T>(method: Method, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  let payload: BodyInit | undefined;
  if (method !== 'GET') headers[CSRF_HEADER] = '1';
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${API_PREFIX}${path}`, { method, headers, body: payload, credentials: 'same-origin' });
  if (res.status === 204) return undefined as T;
  const data = res.headers.get('content-type')?.includes('application/json') ? await res.json() : null;
  if (!res.ok) {
    if (res.status === 401 && path !== '/auth/me') unauthorizedHandler?.();
    const err = (data as ApiErrorBody | null)?.error;
    throw new ApiError(res.status, err?.code ?? 'error', err?.message ?? res.statusText, data);
  }
  return data as T;
}

export const get = <T>(path: string) => api<T>('GET', path);
export const post = <T>(path: string, body?: unknown) => api<T>('POST', path, body);
export const patch = <T>(path: string, body?: unknown) => api<T>('PATCH', path, body);
export const put = <T>(path: string, body?: unknown) => api<T>('PUT', path, body);
export const del = <T = void>(path: string) => api<T>('DELETE', path);

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    const details = (err.body as ApiErrorBody | null)?.error?.details;
    if (Array.isArray(details) && details[0]?.message) {
      return `${err.message}: ${details.map((d: { path?: string[]; message: string }) => `${d.path?.join('.') || ''} ${d.message}`.trim()).join(', ')}`;
    }
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}
