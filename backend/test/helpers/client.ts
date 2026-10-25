import { API_PREFIX, CSRF_HEADER } from '@claude-task/shared';

export interface ApiResponse<T = any> {
  status: number;
  body: T;
  headers: Headers;
}

export interface RequestOptions {
  body?: unknown;
  form?: FormData;
  headers?: Record<string, string>;
  /** Send the CSRF header (default true). */
  csrf?: boolean;
}

/** A browser-like client: keeps the session cookie and sends the CSRF header. */
export class ApiClient {
  cookie: string | null = null;

  constructor(readonly baseUrl: string) {}

  async request<T = any>(method: string, path: string, opts: RequestOptions = {}): Promise<ApiResponse<T>> {
    const headers: Record<string, string> = { ...opts.headers };
    if (opts.csrf !== false) headers[CSRF_HEADER] = '1';
    if (this.cookie) headers.cookie = this.cookie;
    let body: RequestInit['body'];
    if (opts.form) body = opts.form;
    else if (opts.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(opts.body);
    }
    const res = await fetch(`${this.baseUrl}${API_PREFIX}${path}`, { method, headers, body });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const [name, value] = pair!.split('=');
      if (name !== 'ct_login') continue;
      this.cookie = value ? `${name}=${value}` : null;
    }
    const type = res.headers.get('content-type') ?? '';
    const parsed = type.includes('application/json') ? await res.json() : res.status === 204 ? null : await res.arrayBuffer();
    return { status: res.status, body: parsed as T, headers: res.headers };
  }

  get<T = any>(path: string, opts?: RequestOptions) {
    return this.request<T>('GET', path, opts);
  }
  post<T = any>(path: string, body?: unknown, opts?: RequestOptions) {
    return this.request<T>('POST', path, { ...opts, body });
  }
  patch<T = any>(path: string, body?: unknown, opts?: RequestOptions) {
    return this.request<T>('PATCH', path, { ...opts, body });
  }
  put<T = any>(path: string, body?: unknown, opts?: RequestOptions) {
    return this.request<T>('PUT', path, { ...opts, body });
  }
  delete<T = any>(path: string, opts?: RequestOptions) {
    return this.request<T>('DELETE', path, opts);
  }

  async login(email: string, password: string): Promise<ApiResponse> {
    const res = await this.post('/auth/login', { email, password });
    if (res.status !== 200) throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
    return res;
  }
}
