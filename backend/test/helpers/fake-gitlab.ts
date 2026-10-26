// A minimal GitLab REST API v4 stand-in over HTTP, for the GitLab provider's contract tests.
import { createServer } from 'node:http';

export interface GitLabRequest {
  path: string;
  method: string;
  body: any;
  token: string;
}
export type GitLabOverride = (req: GitLabRequest) => { status?: number; body: unknown; headers?: Record<string, string> } | undefined;

export const gitlabProject = (id: number, namespace: string, path: string, extra: Record<string, unknown> = {}) => ({
  id,
  path,
  namespace: { full_path: namespace },
  default_branch: 'main',
  visibility: 'private',
  http_url_to_repo: `https://gitlab.example.com/${namespace}/${path}.git`,
  web_url: `https://gitlab.example.com/${namespace}/${path}`,
  permissions: { project_access: { access_level: 30 }, group_access: null },
  ...extra,
});

export async function startFakeGitLab(override: GitLabOverride = () => undefined) {
  const requests: GitLabRequest[] = [];
  const state = {
    tokens: new Map<string, { scopes: string[]; expires_at: string | null; revoked: boolean }>([
      ['glpat-valid', { scopes: ['api', 'write_repository'], expires_at: '2099-01-01', revoked: false }],
    ]),
    rotations: 0,
  };
  const server = createServer(async (req, res) => {
    let text = '';
    for await (const part of req) text += part;
    const request = { path: req.url!.replace(/^\/api\/v4/, ''), method: req.method!, body: text ? JSON.parse(text) : null, token: String(req.headers['private-token'] ?? '') };
    requests.push(request);
    const token = state.tokens.get(request.token);
    let result = override(request);
    if (!result) {
      if (!token || token.revoked) result = { status: 401, body: { message: '401 Unauthorized' } };
      else if (request.path === '/personal_access_tokens/self') result = { body: { active: true, ...token } };
      else if (request.path === '/personal_access_tokens/self/rotate' && request.method === 'POST') {
        token.revoked = true;
        const next = `glpat-rotated-${++state.rotations}`;
        const expires = request.body?.expires_at ?? '2026-11-02';
        state.tokens.set(next, { scopes: token.scopes, expires_at: expires, revoked: false });
        result = { body: { token: next, expires_at: expires } };
      } else if (request.path === '/user') result = { body: { id: 7, username: 'claude-task-bot', web_url: 'https://gitlab.example.com/claude-task-bot' } };
      else result = { status: 404, body: { message: '404 Not Found' } };
    }
    res.writeHead(result.status ?? 200, { 'content-type': 'application/json', ...result.headers });
    res.end(JSON.stringify(result.body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    state,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
