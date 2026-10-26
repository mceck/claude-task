// A real git smart HTTP server for Git Proxy tests: `git http-backend` (the CGI shipped with
// git) over bare repositories on disk, behind Basic auth so upstream credentials are verified.
import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export interface GitUpstreamServer {
  baseUrl: string;
  username: string;
  password: string;
  root: string;
  /** Creates `<owner>/<name>.git` with one commit on `main`. */
  createRepository(owner: string, name: string): string;
  /** `git rev-parse` in a bare repository, null when the ref doesn't exist. */
  rev(owner: string, name: string, ref: string): string | null;
  close(): Promise<void>;
}

const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
/** Local-only git (no network): synchronous is fine. */
export const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: gitEnv, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const execFileAsync = promisify(execFile);
/** git that talks to the backend in this same process, so it must not block the event loop. */
export async function gitAsync(cwd: string, ...args: string[]): Promise<{ ok: boolean; output: string }> {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, { cwd, encoding: 'utf8', env: gitEnv, timeout: 60_000 });
    return { ok: true, output: `${stdout}${stderr}`.trim() };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    return { ok: false, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

export async function startGitUpstream(): Promise<GitUpstreamServer> {
  const root = await mkdtemp(path.join(tmpdir(), 'ct-upstream-'));
  const username = 'upstream-user';
  const password = 'upstream-secret';
  const backend = path.join(git(root, '--exec-path'), 'git-http-backend');
  const server = createServer((req, res) => {
    const auth = /^Basic (.+)$/.exec(req.headers.authorization ?? '')?.[1];
    if (!auth || Buffer.from(auth, 'base64').toString() !== `${username}:${password}`) {
      res.writeHead(401, { 'www-authenticate': 'Basic realm="upstream"' }).end();
      return;
    }
    const url = new URL(req.url!, 'http://upstream');
    const cgi = spawn(backend, [], {
      env: {
        PATH: process.env.PATH,
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: '1',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        REMOTE_USER: username,
        REQUEST_METHOD: req.method!,
        PATH_INFO: decodeURIComponent(url.pathname),
        QUERY_STRING: url.search.slice(1),
        CONTENT_TYPE: req.headers['content-type'] ?? '',
        ...(req.headers['content-length'] ? { CONTENT_LENGTH: req.headers['content-length'] } : {}),
        ...(req.headers['content-encoding'] ? { HTTP_CONTENT_ENCODING: req.headers['content-encoding'] } : {}),
        ...(req.headers['git-protocol'] ? { GIT_PROTOCOL: String(req.headers['git-protocol']) } : {}),
      },
    });
    req.pipe(cgi.stdin);
    let head = Buffer.alloc(0);
    let headersDone = false;
    cgi.stdout.on('data', (chunk: Buffer) => {
      if (headersDone) return void res.write(chunk);
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf('\r\n\r\n');
      if (end < 0) return;
      headersDone = true;
      let status = 200;
      const headers: Record<string, string> = {};
      for (const line of head.subarray(0, end).toString().split('\r\n')) {
        const [name, ...rest] = line.split(':');
        const value = rest.join(':').trim();
        if (name!.toLowerCase() === 'status') status = Number.parseInt(value, 10);
        else headers[name!.toLowerCase()] = value;
      }
      res.writeHead(status, headers);
      res.write(head.subarray(end + 4));
    });
    cgi.stdout.on('end', () => res.end());
    cgi.on('error', () => res.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    username,
    password,
    root,
    createRepository(owner, name) {
      const dir = path.join(root, owner, `${name}.git`);
      execFileSync('mkdir', ['-p', dir]);
      git(dir, 'init', '--bare', '-q', '-b', 'main');
      const work = path.join(root, `.seed-${owner.replace(/\//g, '_')}-${name}`);
      git(root, 'init', '-q', '-b', 'main', work);
      git(work, '-c', 'user.name=Seed', '-c', 'user.email=seed@example.com', 'commit', '-q', '--allow-empty', '-m', 'Initial commit');
      git(work, 'push', '-q', dir, 'main');
      return dir;
    },
    rev(owner, name, ref) {
      try {
        return git(path.join(root, owner, `${name}.git`), 'rev-parse', '--verify', '-q', ref);
      } catch {
        return null;
      }
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    },
  };
}
