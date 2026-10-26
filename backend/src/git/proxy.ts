// The Git Proxy (ADR 0006): Agent Containers' only way to their Repository. Git smart HTTP is
// streamed to the provider with the Git Connection's credential, which never leaves the backend.
import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import zlib from 'node:zlib';
import type { ProjectRepository } from '@claude-task/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../context';
import { jobs, projects, tasks } from '../db/schema';
import { hashToken } from '../secrets';

const SERVICES = new Set(['git-upload-pack', 'git-receive-pack']);
const IDLE_MS = 5 * 60_000;
/** The ref-update commands sit before the pack; anything larger isn't a real push. */
const COMMANDS_CAP = 64 * 1024;
const REQUEST_HEADERS = ['content-type', 'accept', 'accept-encoding', 'content-encoding', 'content-length', 'git-protocol', 'user-agent'];
const RESPONSE_HEADERS = ['content-type', 'cache-control', 'content-encoding', 'expires', 'pragma'];
const ZERO = /^0+$/;

interface Grant {
  jobId: string;
  agentId: string;
  projectId: string;
  repository: ProjectRepository;
  branchName: string | null;
}
interface Command {
  oldId: string;
  newId: string;
  ref: string;
}

export function gitProxyRoutes(app: FastifyInstance, ctx: AppContext): void {
  // Leave git request bodies unread: the proxy streams them (no body limit, no parsing).
  app.addContentTypeParser(['application/x-git-upload-pack-request', 'application/x-git-receive-pack-request'], (_request, _payload, done) => done(null));

  app.get('/:repo/info/refs', async (request, reply) => {
    const service = (request.query as { service?: string }).service ?? '';
    if (!SERVICES.has(service)) return deny(reply, 403, 'Only smart HTTP git is supported');
    const grant = await authorize(ctx, request, reply);
    if (grant) await forward(ctx, request, reply, grant, `/info/refs?service=${service}`, service, null);
  });
  app.post('/:repo/git-upload-pack', async (request, reply) => {
    const grant = await authorize(ctx, request, reply);
    if (grant) await forward(ctx, request, reply, grant, '/git-upload-pack', 'git-upload-pack', request.raw);
  });
  app.post('/:repo/git-receive-pack', async (request, reply) => {
    const grant = await authorize(ctx, request, reply);
    if (!grant) return;
    let head: Awaited<ReturnType<typeof readCommands>>;
    try {
      head = await readCommands(request.raw, request.headers['content-encoding'] === 'gzip');
    } catch {
      return deny(reply, 400, 'Malformed push request');
    }
    const allowed = `refs/heads/${grant.branchName}`;
    const refused = !grant.branchName || head.commands.some((c) => c.ref !== allowed || ZERO.test(c.newId));
    if (refused) {
      // Push Policy: the whole push is rejected and upstream is never contacted.
      // Drain the pack (git sends it all before reading the answer); it may already be read.
      if (!request.raw.readableEnded) await new Promise((resolve) => request.raw.once('end', resolve).once('error', resolve).resume());
      const reason = grant.branchName ? `claude-task: only ${grant.branchName} can be pushed` : 'claude-task: this task has no branch yet';
      ctx.log.info({ ...logScope(grant), service: 'git-receive-pack', refs: head.commands.map((c) => c.ref), refused: true }, 'git proxy push refused');
      return reply
        .header('content-type', 'application/x-git-receive-pack-result')
        .header('cache-control', 'no-cache')
        .send(rejection(head.commands, reason, head.capabilities.has('side-band-64k')));
    }
    const body = Readable.from(replay(head.raw, request.raw));
    await forward(ctx, request, reply, grant, '/git-receive-pack', 'git-receive-pack', body, head.commands);
  });
}

function deny(reply: FastifyReply, status: number, message: string) {
  if (status === 401) reply.header('www-authenticate', 'Basic realm="claude-task"');
  return reply.status(status).type('text/plain').send(`${message}\n`);
}
const logScope = (g: Grant) => ({ agentId: g.agentId, jobId: g.jobId, projectId: g.projectId });

/** Basic auth whose password is the Job token, for an active Job of that very Project. */
async function authorize(ctx: AppContext, request: FastifyRequest, reply: FastifyReply): Promise<Grant | null> {
  const projectId = /^([0-9a-f-]{36})\.git$/i.exec((request.params as { repo: string }).repo)?.[1];
  if (!projectId) {
    await deny(reply, 404, 'Repository not found');
    return null;
  }
  const basic = /^Basic\s+(.+)$/i.exec(request.headers.authorization ?? '')?.[1];
  const decoded = basic ? Buffer.from(basic, 'base64').toString() : '';
  const token = decoded.slice(decoded.indexOf(':') + 1);
  if (!basic || !decoded.includes(':') || !token) {
    await deny(reply, 401, 'Authentication required');
    return null;
  }
  const [row] = await ctx.db
    .select({ jobId: jobs.id, agentId: jobs.agentId, state: jobs.state, projectId: tasks.projectId, branchName: tasks.branchName, repository: projects.repository })
    .from(jobs)
    .innerJoin(tasks, eq(tasks.id, jobs.taskId))
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .where(eq(jobs.tokenHash, hashToken(token)));
  if (!row) {
    await deny(reply, 401, 'Authentication required');
    return null;
  }
  // Like Spec 03's token grants: only an accepted Job, still running or finishing its Turn.
  if (!['running', 'finishing'].includes(row.state) || row.projectId !== projectId.toLowerCase() || !row.repository) {
    await deny(reply, 403, 'no active task for this repository');
    return null;
  }
  return { jobId: row.jobId, agentId: row.agentId, projectId: row.projectId, repository: row.repository, branchName: row.branchName };
}

async function forward(
  ctx: AppContext,
  request: FastifyRequest,
  reply: FastifyReply,
  grant: Grant,
  path: string,
  service: string,
  body: Readable | null,
  commands?: Command[],
): Promise<void> {
  const started = Date.now();
  let upstream;
  try {
    const git = await ctx.git.provider(grant.repository.connectionId);
    upstream = await git.gitUpstream(grant.repository);
  } catch (err) {
    ctx.log.warn({ ...logScope(grant), service, message: err instanceof Error ? err.message : 'unknown' }, 'git proxy upstream unavailable');
    return void (await deny(reply, 502, 'The Git Connection is not available; check its configuration'));
  }
  const target = new URL(`${upstream.url.replace(/\/+$/, '')}${path}`);
  const headers: Record<string, string> = { authorization: `Basic ${Buffer.from(`${upstream.username}:${upstream.password}`).toString('base64')}` };
  for (const name of REQUEST_HEADERS) {
    const value = request.headers[name];
    if (typeof value === 'string') headers[name] = value;
  }
  let bytesIn = 0;
  let bytesOut = 0;
  const log = (status: number | null, error?: string) =>
    ctx.log.info({ ...logScope(grant), service, refs: commands?.map((c) => c.ref), status, bytesIn, bytesOut, ms: Date.now() - started, error }, 'git proxy');

  reply.hijack();
  const res = reply.raw;
  const out = (target.protocol === 'https:' ? https : http).request(target, { method: request.method, headers });
  const fail = (status: number, message: string) => {
    if (res.headersSent) return void res.destroy();
    res.writeHead(status, { 'content-type': 'text/plain' }).end(`${message}\n`);
  };
  out.setTimeout(IDLE_MS, () => out.destroy(new Error('idle timeout')));
  // A client that goes away aborts the upstream request.
  res.on('close', () => {
    if (!res.writableFinished) out.destroy();
  });
  const done = new Promise<void>((resolve) => {
    out.on('response', (answer) => {
      const status = answer.statusCode ?? 502;
      if (status >= 300) {
        answer.resume();
        // Credentials and provider messages stay out of the reply and the logs.
        log(status, 'upstream refused');
        fail(502, status === 401 || status === 403 || status === 404 ? 'the Git Connection could not access this repository; check its configuration' : 'the Git provider failed');
        return resolve();
      }
      const forwarded: Record<string, string> = {};
      for (const name of RESPONSE_HEADERS) {
        const value = answer.headers[name];
        if (typeof value === 'string') forwarded[name] = value;
      }
      res.writeHead(status, forwarded);
      answer.on('data', (chunk: Buffer) => (bytesOut += chunk.length));
      pipeline(answer, res)
        .then(() => log(status))
        .catch(() => log(status, 'response aborted'))
        .finally(resolve);
    });
    out.on('error', (err) => {
      log(null, err.message);
      fail(502, 'the Git provider could not be reached');
      resolve();
    });
  });
  if (body) {
    body.on('data', (chunk: Buffer) => (bytesIn += chunk.length));
    pipeline(body, out).catch(() => out.destroy());
  } else out.end();
  await done;
}

/** Replays the bytes read for the Push Policy, then the rest of the request. */
async function* replay(head: Buffer[], rest: Readable) {
  for (const chunk of head) yield chunk;
  if (!rest.readableEnded) for await (const chunk of rest) yield chunk as Buffer;
}

/** pkt-lines up to the first flush, or null while incomplete. */
function pktLines(data: Buffer): string[] | null {
  const lines: string[] = [];
  for (let offset = 0; ; ) {
    if (data.length < offset + 4) return null;
    const length = Number.parseInt(data.subarray(offset, offset + 4).toString(), 16);
    if (Number.isNaN(length) || (length > 0 && length < 4)) throw new Error('bad pkt-line');
    if (length === 0) return lines;
    if (data.length < offset + length) return null;
    lines.push(data.subarray(offset + 4, offset + length).toString('latin1'));
    offset += length;
  }
}

/** Reads the ref-update commands at the start of a receive-pack request, keeping the raw bytes. */
function readCommands(source: Readable, gzip: boolean): Promise<{ raw: Buffer[]; commands: Command[]; capabilities: Set<string> }> {
  return new Promise((resolve, reject) => {
    const raw: Buffer[] = [];
    let plain = Buffer.alloc(0);
    let settled = false;
    const gunzip = gzip ? zlib.createGunzip() : null;
    const stop = () => {
      settled = true;
      source.off('data', onData).off('end', onEnd).off('error', onError);
      source.pause();
      gunzip?.destroy();
    };
    const onError = (err: Error) => {
      if (settled) return;
      stop();
      reject(err);
    };
    const onPlain = (chunk: Buffer, ended = false) => {
      if (settled) return;
      plain = Buffer.concat([plain, chunk]);
      let lines: string[] | null;
      try {
        lines = pktLines(plain);
      } catch (err) {
        return onError(err as Error);
      }
      if (!lines) {
        if (ended || plain.length > COMMANDS_CAP) onError(new Error('incomplete push commands'));
        return;
      }
      stop();
      try {
        resolve({ raw, ...parseCommands(lines) });
      } catch (err) {
        reject(err);
      }
    };
    const onData = (chunk: Buffer) => {
      raw.push(chunk);
      if (gunzip) gunzip.write(chunk);
      else onPlain(chunk);
    };
    const onEnd = () => {
      if (gunzip) gunzip.end();
      else onPlain(Buffer.alloc(0), true);
    };
    gunzip?.on('data', (chunk: Buffer) => onPlain(chunk));
    gunzip?.on('end', () => onPlain(Buffer.alloc(0), true));
    gunzip?.on('error', onError);
    source.on('data', onData).on('end', onEnd).on('error', onError);
  });
}
function parseCommands(lines: string[]): { commands: Command[]; capabilities: Set<string> } {
  const commands: Command[] = [];
  let capabilities = new Set<string>();
  for (const [index, line] of lines.entries()) {
    const [text, caps] = line.replace(/\n$/, '').split('\0');
    if (index === 0 && caps !== undefined) capabilities = new Set(caps.split(' ').filter(Boolean));
    if (text!.startsWith('shallow ')) continue;
    const match = /^([0-9a-f]{40}|[0-9a-f]{64}) ([0-9a-f]{40}|[0-9a-f]{64}) (\S+)$/.exec(text!);
    // Push certificates and anything unexpected can't be checked, so they're refused as a ref.
    commands.push(match ? { oldId: match[1]!, newId: match[2]!, ref: match[3]! } : { oldId: '', newId: '', ref: text!.slice(0, 200) || '(unknown)' });
  }
  return { commands, capabilities };
}

function pkt(data: string | Buffer): Buffer {
  const payload = typeof data === 'string' ? Buffer.from(data) : data;
  return Buffer.concat([Buffer.from((payload.length + 4).toString(16).padStart(4, '0')), payload]);
}
/** A receive-pack `report-status` rejecting every command, so git prints a readable reason. */
function rejection(commands: Command[], reason: string, sideband: boolean): Buffer {
  const status = Buffer.concat([pkt('unpack ok\n'), ...commands.map((c) => pkt(`ng ${c.ref} ${reason}\n`)), Buffer.from('0000')]);
  if (!sideband) return status;
  const packets: Buffer[] = [];
  for (let i = 0; i < status.length; i += 65515) packets.push(pkt(Buffer.concat([Buffer.from([1]), status.subarray(i, i + 65515)])));
  return Buffer.concat([...packets, Buffer.from('0000')]);
}
