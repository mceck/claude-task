import { openPullRequest } from '../../src/git/service';
import { eq } from 'drizzle-orm';
import { jobs, tasks } from '../../src/db/schema';
import { FakeGitProvider } from '../../src/git/fake-provider';
// Test-only server: real API/DB + fake containers and controllable Runner WebSockets.
// This entry point is never included in the production bundle.
import { API_PREFIX, RUNNER_PROTOCOL_VERSION, RUNNER_WS_PATH } from '@claude-task/shared';
import type { BackendToRunner, RunnerToBackend } from '@claude-task/shared';
import WebSocket from 'ws';
import { FakeRuntime } from '../../src/agents/fake-runtime';
import { loadConfig } from '../../src/config';
import { createServer } from '../../src/server';

const config = loadConfig();
config.loginRateLimit.max = 1000;
const runtime = new FakeRuntime();
const git = new FakeGitProvider();
const gitlab = new FakeGitProvider('gitlab', '');
const server = await createServer(config, { runtime, git: FakeGitProvider.factory(() => ({ github: git, gitlab })) });
const runners = new Map<string, { socket: WebSocket; received: BackendToRunner[]; seqs: Map<string, number> }>();
runtime.onContainerCreated = (agentId, spec) => {
  const socket = new WebSocket(`ws://127.0.0.1:${config.port}${RUNNER_WS_PATH}`, { headers: { authorization: `Bearer ${spec.env.CLAUDE_TASK_RUNNER_TOKEN}` } });
  const runner = { socket, received: [] as BackendToRunner[], seqs: new Map<string, number>() };
  runners.set(agentId, runner);
  socket.on('open', () =>
    socket.send(
      JSON.stringify({
        type: 'hello',
        protocolVersion: RUNNER_PROTOCOL_VERSION,
        runnerVersion: 'e2e',
        claudeVersion: config.agents.claudeCodeVersion,
        activeJobId: null,
      } satisfies RunnerToBackend),
    ),
  );
  socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString()) as BackendToRunner;
    runner.received.push(message);
    if (message.type === 'job.start') sendJob(agentId, { type: 'job.accepted', jobId: message.jobId });
  });
  socket.on('error', (err) => server.app.log.warn(err));
};

function sendJob(agentId: string, message: Record<string, unknown> & { jobId: string }) {
  const runner = runners.get(agentId)!;
  const seq = (runner.seqs.get(message.jobId) ?? 0) + 1;
  runner.seqs.set(message.jobId, seq);
  runner.socket.send(JSON.stringify({ ...message, seq }));
  return seq;
}

server.app.get<{ Params: { id: string } }>(`${API_PREFIX}/__test/runners/:id`, async (request) => ({
  received: runners.get(request.params.id)?.received ?? [],
}));
server.app.post<{ Params: { id: string }; Body: { jobId: string; events?: Record<string, unknown>[]; exit?: boolean; failure?: string } }>(
  `${API_PREFIX}/__test/runners/:id`,
  async (request) => {
    const { id } = request.params;
    const { jobId, events = [], exit, failure } = request.body;
    for (const event of events) {
      const seq = sendJob(id, { type: 'job.event', jobId, line: JSON.stringify(event) });
      if (event.type === 'result') sendJob(id, { type: 'job.result', jobId, eventSeq: seq });
    }
    if (failure) sendJob(id, { type: 'job.failed', jobId, stage: 'setup', message: failure });
    if (exit) sendJob(id, { type: 'job.exited', jobId, exitCode: 0, signal: null });
    return { ok: true };
  },
);
server.app.post<{ Body: { message: string } }>(`${API_PREFIX}/__test/build-failure`, async (request) => {
  runtime.scriptBuild({ fail: request.body.message });
  return { ok: true };
});
server.app.post<{ Body: { protected: boolean } }>(`${API_PREFIX}/__test/git/protection`, async (request) => {
  git.protection.set('1', request.body.protected);
  return { ok: true };
});
server.app.post<{ Body: { taskId: string } }>(`${API_PREFIX}/__test/git/pull-request`, async (request) => {
  const [task] = await server.ctx.db.select().from(tasks).where(eq(tasks.id, request.body.taskId));
  const [job] = await server.ctx.db.select().from(jobs).where(eq(jobs.taskId, task!.id));
  git.branches.get('1')!.add(task!.branchName!);
  return openPullRequest(
    server.ctx,
    { taskId: task!.id, agentId: job!.agentId, jobId: job!.id, actor: { type: 'agent', id: job!.agentId, displayName: 'Git agent' } },
    { title: 'Fix', body: 'Test body', draft: true },
  );
});
server.app.post<{ Body: { provider: 'github' | 'gitlab'; repoId: string; branch: string } }>(`${API_PREFIX}/__test/git/branches`, async (request) => {
  const provider = request.body.provider === 'gitlab' ? gitlab : git;
  provider.branches.get(request.body.repoId)?.add(request.body.branch);
  return { ok: true };
});
server.app.post<{ Body: { taskId: string } }>(`${API_PREFIX}/__test/git/merge`, async (request) => {
  git.pullRequests.get('1')![0]!.state = 'merged';
  await server.ctx.gitSync.refreshTask(request.body.taskId, 0);
  return { ok: true };
});
await server.app.listen({ host: config.host, port: config.port });
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    for (const r of runners.values()) r.socket.terminate();
    void server.close().finally(() => process.exit(0));
  });
