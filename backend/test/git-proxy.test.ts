// The Git Proxy as Agents use it: the real `git` CLI against the backend, with a real
// `git http-backend` upstream behind the fake provider's Git Connection.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { useTestApp } from './helpers/app';
import { assignAndStart, createAgent, createProject, createTask } from './helpers/fixtures';
import { git, gitAsync, startGitUpstream } from './helpers/git-upstream';
import type { GitUpstreamServer } from './helpers/git-upstream';
import { Stream } from './helpers/stream';

const pkt = (s: string) => `${(Buffer.byteLength(s) + 4).toString(16).padStart(4, '0')}${s}`;
const ZERO = '0'.repeat(40);

describe('Git Proxy', () => {
  const app = useTestApp();
  let upstream: GitUpstreamServer;
  let work: string;
  beforeAll(async () => {
    upstream = await startGitUpstream();
  });
  afterAll(async () => {
    await upstream.close();
  });
  beforeEach(async () => {
    await rm(path.join(upstream.root, 'acme'), { recursive: true, force: true });
    upstream.createRepository('acme', 'example');
    upstream.createRepository('acme', 'other');
    app.git.upstream = { baseUrl: upstream.baseUrl, username: upstream.username, password: upstream.password };
    work = await mkdtemp(path.join(tmpdir(), 'ct-agent-'));
    return () => rm(work, { recursive: true, force: true });
  });

  async function running(opts: { otherProject?: boolean } = {}) {
    const admin = await app.admin();
    const { project } = await createProject(admin);
    expect((await admin.put(`/projects/${project.id}/repository`, { connectionId: 'env-github', providerRepoId: '1' })).status).toBe(200);
    const other = opts.otherProject ? (await createProject(admin)).project : null;
    if (other) await admin.put(`/projects/${other.id}/repository`, { connectionId: 'env-github', providerRepoId: '2' });
    const { agent, runner } = await createAgent(app, admin);
    const task = await createTask(admin, project.id, { title: 'Proxy work' });
    await assignAndStart(admin, task.id, agent.id);
    const start = await runner.next('job.start');
    runner.accept(start.jobId);
    await runner.play(start.jobId, [new Stream(start.sessionId).init()]);
    const proxy = (projectId: string) => `${app.url}/git/${projectId}.git`;
    const authed = (projectId: string, token = start.git!.token) => proxy(projectId).replace('http://', `http://claude-task:${token}@`);
    return { admin, project, other, runner, start, branch: start.git!.taskBranch, proxy, authed };
  }
  /** git as the Agent would run it, failing loudly with its stderr. */
  const run = (cwd: string, ...args: string[]) => gitAsync(cwd, '-c', 'user.name=Agent', '-c', 'user.email=agent@example.com', ...args);

  it('fetches but never pushes for the Jobs of a read-only Schedule', async () => {
    const admin = await app.admin();
    const { agent, runner } = await createAgent(app, admin);
    const created = await admin.post('/schedules', {
      name: 'Read only review',
      agentId: agent.id,
      cron: '0 3 * * *',
      prompt: 'Look at the code.',
      readOnly: true,
      repository: { connectionId: 'env-github', providerRepoId: '1' },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect((await admin.post(`/schedules/${created.body.schedule.id}/run`)).status).toBe(201);
    const start = await runner.next('job.start');
    runner.accept(start.jobId);
    await runner.play(start.jobId, [new Stream(start.sessionId).init()]);
    const url = `${app.url}/git/${created.body.schedule.projectId}.git`.replace('http://', `http://claude-task:${start.git!.token}@`);
    const repo = path.join(work, 'repo');
    expect((await run(work, 'clone', '-q', url, repo)).ok).toBe(true);
    const branch = start.git!.taskBranch;
    await run(repo, 'checkout', '-q', '-b', branch);
    await run(repo, 'commit', '-q', '--allow-empty', '-m', 'work');
    const pushed = await run(repo, 'push', 'origin', branch);
    expect(pushed.ok).toBe(false);
    expect(pushed.output).toContain('claude-task: this schedule is read-only');
    expect(upstream.rev('acme', 'example', `refs/heads/${branch}`)).toBeFalsy();
  });

  it('dispatches the proxy URL with the Job token, never a provider credential', async () => {
    const { project, start } = await running();
    expect(start.git).toMatchObject({ cloneUrl: `http://backend.test/git/${project.id}.git`, repositoryId: 'env-github/1' });
    expect(start.git!.token).toBe(JSON.parse(start.claudeArgs.mcpConfig).mcpServers['claude-task'].headers.Authorization.replace('Bearer ', ''));
    expect(JSON.stringify(start)).not.toContain(upstream.password);
  });

  it('clones, fetches and pushes the Task Branch, including force pushes', async () => {
    const { project, branch, authed } = await running();
    const repo = path.join(work, 'repo');
    expect((await run(work, 'clone', '-q', authed(project.id), repo)).ok).toBe(true);
    expect((await run(repo, 'checkout', '-q', '-b', branch)).ok).toBe(true);
    expect((await run(repo, 'commit', '-q', '--allow-empty', '-m', 'First')).ok).toBe(true);
    const pushed = await run(repo, 'push', '-q', 'origin', branch);
    expect(pushed.ok, pushed.output).toBe(true);
    expect(upstream.rev('acme', 'example', `refs/heads/${branch}`)).toBe(git(repo, 'rev-parse', 'HEAD'));
    expect((await run(repo, 'commit', '-q', '--amend', '--allow-empty', '-m', 'Rewritten')).ok).toBe(true);
    expect((await run(repo, 'push', '-q', '--force', 'origin', branch)).ok).toBe(true);
    expect(upstream.rev('acme', 'example', `refs/heads/${branch}`)).toBe(git(repo, 'rev-parse', 'HEAD'));
    expect((await run(repo, '-c', 'protocol.version=2', 'fetch', '-q', 'origin')).ok).toBe(true);
    expect((await run(repo, 'remote', 'get-url', 'origin')).output).not.toContain(upstream.password);
  });

  it.each([
    { what: 'the base branch', args: () => ['origin', 'HEAD:main'], ref: () => 'refs/heads/main' },
    { what: 'another branch', args: () => ['origin', 'HEAD:refs/heads/feature'], ref: () => 'refs/heads/feature' },
    { what: 'a tag', args: () => ['origin', 'v1'], ref: () => 'refs/tags/v1' },
    { what: 'the Task Branch with another branch', args: (b: string) => ['origin', b, 'HEAD:main'], ref: () => 'refs/heads/main' },
  ])('refuses pushing $what with a readable reason, leaving upstream unchanged', async ({ args, ref }) => {
    const { project, branch, authed } = await running();
    const repo = path.join(work, 'repo');
    await run(work, 'clone', '-q', authed(project.id), repo);
    await run(repo, 'checkout', '-q', '-b', branch);
    await run(repo, 'commit', '-q', '--allow-empty', '-m', 'Sneaky');
    await run(repo, 'tag', 'v1');
    const before = upstream.rev('acme', 'example', ref());
    const main = upstream.rev('acme', 'example', 'refs/heads/main');
    const result = await run(repo, 'push', ...args(branch));
    expect(result.ok).toBe(false);
    expect(result.output).toContain(`claude-task: only ${branch} can be pushed`);
    expect(upstream.rev('acme', 'example', ref())).toBe(before);
    expect(upstream.rev('acme', 'example', 'refs/heads/main')).toBe(main);
    expect(upstream.rev('acme', 'example', `refs/heads/${branch}`)).toBeNull();
  });

  it('refuses deleting the Task Branch', async () => {
    const { project, branch, authed } = await running();
    const repo = path.join(work, 'repo');
    await run(work, 'clone', '-q', authed(project.id), repo);
    await run(repo, 'checkout', '-q', '-b', branch);
    await run(repo, 'commit', '-q', '--allow-empty', '-m', 'Work');
    await run(repo, 'push', '-q', 'origin', branch);
    const result = await run(repo, 'push', 'origin', '--delete', branch);
    expect(result.ok).toBe(false);
    expect(result.output).toContain('claude-task: only');
    expect(upstream.rev('acme', 'example', `refs/heads/${branch}`)).toBe(git(repo, 'rev-parse', 'HEAD'));
  });

  it('applies the Push Policy to gzip-encoded commands too', async () => {
    const { project, branch, start } = await running();
    const head = upstream.rev('acme', 'example', 'refs/heads/main')!;
    const body = gzipSync(Buffer.from(`${pkt(`${head} ${ZERO.replace(/0$/, '1')} refs/heads/main\0report-status side-band-64k\n`)}0000`));
    const res = await fetch(`${app.url}/git/${project.id}.git/git-receive-pack`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`claude-task:${start.git!.token}`).toString('base64')}`,
        'content-type': 'application/x-git-receive-pack-request',
        'content-encoding': 'gzip',
      },
      body,
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('unpack ok');
    expect(text).toContain(`ng refs/heads/main claude-task: only ${branch} can be pushed`);
  });

  it('refuses a malformed packet that only names the Task Branch, without contacting upstream', async () => {
    const { project, branch, start } = await running();
    // The well-formed-upstream server is gone: a forwarded malformed push would be a 502.
    app.git.upstream = { baseUrl: 'http://127.0.0.1:1', username: 'x', password: 'x' };
    const res = await fetch(`${app.url}/git/${project.id}.git/git-receive-pack`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`claude-task:${start.git!.token}`).toString('base64')}`,
        'content-type': 'application/x-git-receive-pack-request',
      },
      body: `${pkt(`${branch}\n`)}0000`,
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(`ng ${branch} claude-task: only ${branch} can be pushed`);
  });

  it('refuses an endless gzip body that never yields commands, without waiting for its end', async () => {
    const { project, start } = await running();
    // A gzip header with FCOMMENT set, then a comment that never ends: gunzip yields nothing.
    const header = Buffer.from([0x1f, 0x8b, 0x08, 0x10, 0, 0, 0, 0, 0, 0xff]);
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent === 0) controller.enqueue(header);
        sent += 1;
        controller.enqueue(new Uint8Array(64 * 1024).fill(0x61));
        if (sent > 512) controller.close();
      },
    });
    const res = await fetch(`${app.url}/git/${project.id}.git/git-receive-pack`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`claude-task:${start.git!.token}`).toString('base64')}`,
        'content-type': 'application/x-git-receive-pack-request',
        'content-encoding': 'gzip',
      },
      body,
      duplex: 'half',
    } as RequestInit).catch(() => null);
    // Refused with a 400, or the connection closed under the still-sending client.
    if (res) expect(res.status).toBe(400);
    expect(sent).toBeLessThan(512);
  });

  it('answers git requests sent with another content type instead of hanging', async () => {
    const { project, start } = await running();
    const head = upstream.rev('acme', 'example', 'refs/heads/main')!;
    for (const service of ['git-receive-pack', 'git-upload-pack']) {
      const res = await fetch(`${app.url}/git/${project.id}.git/${service}`, {
        method: 'POST',
        headers: { authorization: `Basic ${Buffer.from(`claude-task:${start.git!.token}`).toString('base64')}`, 'content-type': 'text/plain' },
        body: `${pkt(`${head} ${head} refs/heads/main\0report-status\n`)}0000`,
        signal: AbortSignal.timeout(3000),
      });
      expect(res.status).toBe(415);
    }
  });

  it('refuses a push from a shallow clone with the readable reason', async () => {
    const { project, branch, authed } = await running();
    const seed = path.join(work, 'seed');
    await run(work, 'clone', '-q', authed(project.id), seed);
    for (const m of ['one', 'two']) await run(seed, 'commit', '-q', '--allow-empty', '-m', m);
    await run(seed, 'checkout', '-q', '-b', branch);
    expect((await run(seed, 'push', '-q', 'origin', branch)).ok).toBe(true);
    const repo = path.join(work, 'repo');
    expect((await run(work, 'clone', '-q', '--depth', '1', '--branch', branch, authed(project.id), repo)).ok).toBe(true);
    await run(repo, 'commit', '-q', '--allow-empty', '-m', 'Sneaky');
    const result = await run(repo, 'push', 'origin', 'HEAD:refs/heads/feature');
    expect(result.ok).toBe(false);
    expect(result.output).toContain(`claude-task: only ${branch} can be pushed`);
  });

  it('streams protocol v2 requests with gzip bodies to upstream', async () => {
    const { project, start } = await running();
    const body = gzipSync(Buffer.from(`${pkt('command=ls-refs\n')}0001${pkt('peel\n')}0000`));
    const res = await fetch(`${app.url}/git/${project.id}.git/git-upload-pack`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`x:${start.git!.token}`).toString('base64')}`,
        'content-type': 'application/x-git-upload-pack-request',
        'content-encoding': 'gzip',
        'git-protocol': 'version=2',
      },
      body,
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('refs/heads/main');
  });

  it('challenges missing credentials and refuses other Projects, unknown and finished Jobs', async () => {
    const { project, other, runner, start, proxy, authed } = await running({ otherProject: true });
    const refs = (url: string, auth?: string) =>
      fetch(`${url}/info/refs?service=git-upload-pack`, auth ? { headers: { authorization: `Basic ${Buffer.from(auth).toString('base64')}` } } : {});
    const anonymous = await refs(proxy(project.id));
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get('www-authenticate')).toContain('Basic');
    expect((await refs(proxy(project.id), 'claude-task:not-a-token')).status).toBe(401);
    expect((await refs(proxy(other!.id), `claude-task:${start.git!.token}`)).status).toBe(403);
    expect((await refs(proxy(project.id), `claude-task:${start.git!.token}`)).status).toBe(200);
    expect((await run(work, 'clone', '-q', authed(other!.id), path.join(work, 'other'))).output).toContain('no active task for this repository');
    await runner.play(start.jobId, [new Stream().result()]);
    expect((await refs(proxy(project.id), `claude-task:${start.git!.token}`)).status).toBe(200);
    await runner.exit(start.jobId);
    const after = await refs(proxy(project.id), `claude-task:${start.git!.token}`);
    expect(after.status).toBe(403);
    expect(await after.text()).toContain('no active task for this repository');
  });

  it('serves the Job token while the Job is still only dispatched', async () => {
    const admin = await app.admin();
    const { project } = await createProject(admin);
    expect((await admin.put(`/projects/${project.id}/repository`, { connectionId: 'env-github', providerRepoId: '1' })).status).toBe(200);
    const { agent, runner } = await createAgent(app, admin);
    const task = await createTask(admin, project.id, { title: 'Fetching at once' });
    await assignAndStart(admin, task.id, agent.id);
    const start = await runner.next('job.start');
    // The Runner sends `job.accepted` and fetches the Worktree without waiting for the backend to
    // process it, so the first fetch can reach the proxy while the Job still reads as dispatched.
    const res = await fetch(`${app.url}/git/${project.id}.git/info/refs?service=git-upload-pack`, {
      headers: { authorization: `Basic ${Buffer.from(`claude-task:${start.git!.token}`).toString('base64')}` },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('refs/heads/main');
  });

  it('reports upstream credential failures without leaking anything', async () => {
    const { project, authed } = await running();
    app.git.upstream = { baseUrl: upstream.baseUrl, username: upstream.username, password: 'wrong' };
    const result = await run(work, 'clone', '-q', authed(project.id), path.join(work, 'repo'));
    expect(result.ok).toBe(false);
    expect(result.output).toContain('502');
    expect(result.output).not.toContain(upstream.password);
  });
});
