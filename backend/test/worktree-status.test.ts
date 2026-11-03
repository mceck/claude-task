import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { sessions } from '../src/db/schema';
import { useTestApp } from './helpers/app';
import type { ApiClient } from './helpers/client';
import { assignAndStart, createAgent, createProject, createTask } from './helpers/fixtures';
import { Stream } from './helpers/stream';

describe('a Task Worktree’s uncommitted changes', () => {
  const app = useTestApp();

  async function projectWithRepository(client: ApiClient, key: string) {
    const created = await client.post('/projects', {
      workerId: app.workerId,
      key,
      name: 'Changes',
      repository: { connectionId: 'env-github', providerRepoId: '1' },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    return created.body.project as { id: string };
  }

  it('reads them when the Changes dialog opens and keeps the last read for later', async () => {
    const admin = await app.admin();
    const { agent, runner } = await createAgent(app, admin);
    const project = await projectWithRepository(admin, 'CHGA');
    const task = await createTask(admin, project.id);
    await assignAndStart(admin, task.id, agent.id);
    const start = await runner.next('job.start');
    expect(start.git).not.toBeNull();

    const pending = admin.get(`/tasks/${task.id}/worktree-status`);
    const request = await runner.next('worktree.status.request');
    expect(request.worktreePath).toContain(task.key);
    runner.send({
      type: 'worktree.status.result',
      requestId: request.requestId,
      files: [
        { path: 'src/app.ts', status: 'modified' },
        { path: 'src/new.ts', status: 'untracked' },
      ],
      total: 2,
      truncated: false,
      error: null,
    });
    const read = await pending;
    expect(read.body.status).toEqual({
      live: true,
      reason: null,
      status: {
        capturedAt: expect.any(String),
        files: [
          { path: 'src/app.ts', status: 'modified' },
          { path: 'src/new.ts', status: 'untracked' },
        ],
        total: 2,
        truncated: false,
      },
    });

    // With no connected Runner the dialog shows the last read.
    await runner.close();
    await app.settle();
    const cached = await admin.get(`/tasks/${task.id}/worktree-status`);
    expect(cached.body.status).toMatchObject({
      live: false,
      reason: 'no-runner',
      status: { files: [{ path: 'src/app.ts', status: 'modified' }, { path: 'src/new.ts', status: 'untracked' }], total: 2 },
    });
  });

  it('reads the Worktree once more when its Job ends', async () => {
    const admin = await app.admin();
    const { agent, runner } = await createAgent(app, admin);
    const project = await projectWithRepository(admin, 'CHGB');
    const task = await createTask(admin, project.id);
    await assignAndStart(admin, task.id, agent.id);
    const start = await runner.next('job.start');
    runner.accept(start.jobId);
    await runner.play(start.jobId, [new Stream().init(), new Stream().result()]);
    await runner.exit(start.jobId);

    const request = await runner.next('worktree.status.request');
    runner.send({
      type: 'worktree.status.result',
      requestId: request.requestId,
      files: [{ path: 'README.md', status: 'deleted' }],
      total: 1,
      truncated: false,
      error: null,
    });
    // The answer is stored on the Session as soon as the Job's effect reads it.
    await expect
      .poll(async () => {
        const [row] = await app.server.ctx.db.select({ status: sessions.worktreeStatus }).from(sessions).where(eq(sessions.taskId, task.id));
        return row?.status?.files;
      })
      .toEqual([{ path: 'README.md', status: 'deleted' }]);

    await runner.close();
    await app.settle();
    const cached = await admin.get(`/tasks/${task.id}/worktree-status`);
    expect(cached.body.status).toMatchObject({ live: false, reason: 'no-runner', status: { files: [{ path: 'README.md', status: 'deleted' }] } });
  });

  it('explains when there is no Session or no Repository', async () => {
    const admin = await app.admin();
    const plain = await createProject(admin);
    const empty = await createTask(admin, plain.project.id);
    expect((await admin.get(`/tasks/${empty.id}/worktree-status`)).body.status).toEqual({ status: null, live: false, reason: 'no-session' });

    const { agent } = await createAgent(app, admin);
    await assignAndStart(admin, empty.id, agent.id);
    expect((await admin.get(`/tasks/${empty.id}/worktree-status`)).body.status).toEqual({ status: null, live: false, reason: 'no-repository' });
  });

  it('forgets the last read when a new Worktree replaces it', async () => {
    const admin = await app.admin();
    const { agent, runner } = await createAgent(app, admin);
    const project = await projectWithRepository(admin, 'CHGC');
    const task = await createTask(admin, project.id);
    await assignAndStart(admin, task.id, agent.id);
    const start = await runner.next('job.start');

    const pending = admin.get(`/tasks/${task.id}/worktree-status`);
    const request = await runner.next('worktree.status.request');
    runner.send({
      type: 'worktree.status.result',
      requestId: request.requestId,
      files: [{ path: 'old.ts', status: 'modified' }],
      total: 1,
      truncated: false,
      error: null,
    });
    expect((await pending).body.status).toMatchObject({ live: true, status: { files: [{ path: 'old.ts' }] } });

    runner.sendJob({ type: 'job.worktree_ready', jobId: start.jobId, created: true, remoteBranchMissing: false });
    await runner.drain();
    await runner.close();
    await app.settle();

    expect((await admin.get(`/tasks/${task.id}/worktree-status`)).body.status).toMatchObject({ status: null, live: false, reason: 'no-runner' });
  });
});
