import { describe, expect, it } from 'vitest';
import { useTestApp } from './helpers/app';
import { assignAndStart, createAgent, createProject, createTask } from './helpers/fixtures';
import { Stream } from './helpers/stream';

describe('native commands in managed conversations', () => {
  const app = useTestApp();
  it('discovers commands from this session and omits commands that replace the managed conversation', async () => {
    const admin = await app.admin();
    const { agent, runner } = await createAgent(app, admin);
    const { project } = await createProject(admin);
    const task = await createTask(admin, project.id);
    await assignAndStart(admin, task.id, agent.id);
    const start = await runner.next('job.start');
    runner.accept(start.jobId);
    await runner.play(start.jobId, [
      { ...new Stream().init(), slash_commands: ['compact', 'context', 'mcp', 'project:deploy', 'clear', 'model', 'exit'] },
    ]);
    const commands = (await admin.get(`/tasks/${task.id}/session`)).body.session.commands;
    expect(commands.map((c: { name: string }) => c.name)).toEqual(['compact', 'context', 'mcp', 'project:deploy']);
    expect(commands.every((c: { kind: string }) => c.kind === 'claude')).toBe(true);
  });

  it("offers the Worktree's own skills and commands that the session loaded", async () => {
    const admin = await app.admin();
    const { agent, runner } = await createAgent(app, admin);
    const { project } = await createProject(admin);
    const task = await createTask(admin, project.id);
    await assignAndStart(admin, task.id, agent.id);
    const start = await runner.next('job.start');
    runner.accept(start.jobId);
    runner.sendJob({
      type: 'job.project_skills',
      jobId: start.jobId,
      files: [
        { name: 'deploy', head: '---\ndescription: Deploy the service\n---\n# Deploy\n' },
        { name: 'release', head: '# Release\n\nCut a release.\n' },
        { name: 'deploy', head: '---\ndescription: The command of the same name\n---\n' },
        { name: 'internal', head: '---\ndescription: Background knowledge\nuser-invocable: false\n---\n' },
        { name: 'broken', head: '---\ndescription: [unclosed\n---\n' },
        { name: 'unloaded', head: '---\ndescription: Not loaded by this CLI\n---\n' },
        { name: 'clear', head: '---\ndescription: Replaces the conversation\n---\n' },
      ],
    });
    await runner.drain();
    // Before the session reports what it loaded, every project skill is offered.
    const before = (await admin.get(`/tasks/${task.id}/session`)).body.session.commands;
    expect(before.filter((c: { kind: string }) => c.kind === 'skill').map((c: { name: string }) => c.name)).toEqual(['deploy', 'release', 'unloaded']);

    await runner.play(start.jobId, [{ ...new Stream().init(), slash_commands: ['compact', 'deploy', 'release', 'internal', 'clear'] }]);
    const commands = (await admin.get(`/tasks/${task.id}/session`)).body.session.commands;
    expect(commands).toEqual([
      { name: 'deploy', description: 'Deploy the service', kind: 'skill' },
      { name: 'release', description: 'Release', kind: 'skill' },
      { name: 'compact', description: expect.any(String), kind: 'claude' },
    ]);
  });

  it("reads the Worktree's Project Skills on request when no Job has reported them yet", async () => {
    const admin = await app.admin();
    const { agent, runner } = await createAgent(app, admin);
    const { project } = await createProject(admin);
    const task = await createTask(admin, project.id);
    await assignAndStart(admin, task.id, agent.id);
    await runner.next('job.start');

    // Opening the Session asks the Runner for the Worktree it created for that Job.
    await admin.get(`/tasks/${task.id}/session`);
    const request = await runner.next('project_skills.request');
    expect(request.worktreePath).toBeTruthy();
    runner.send({
      type: 'project_skills.result',
      requestId: request.requestId,
      files: [
        { name: 'deploy', head: '---\ndescription: Deploy the service\n---\n' },
        { name: 'internal', head: '---\ndescription: Background knowledge\nuser-invocable: false\n---\n' },
      ],
    });
    await expect
      .poll(async () => ((await admin.get(`/tasks/${task.id}/session`)).body.session.commands as { name: string }[]).map((c) => c.name))
      .toContain('deploy');
    // The Session keeps what it read: another load doesn't ask again.
    const asked = runner.messages('project_skills.request').length;
    await admin.get(`/tasks/${task.id}/session`);
    expect(runner.messages('project_skills.request')).toHaveLength(asked);
  });

  it('keeps commands and later comments in order, sends raw commands and renders local output exactly once', async () => {
    const admin = await app.admin();
    const { agent, runner } = await createAgent(app, admin);
    const { project } = await createProject(admin);
    const task = await createTask(admin, project.id);
    await assignAndStart(admin, task.id, agent.id);
    const first = await runner.next('job.start');
    runner.accept(first.jobId);
    const stream = new Stream();
    await runner.play(first.jobId, [stream.init()]);
    const command = await admin.post(`/tasks/${task.id}/comments`, { body: '/compact keep decisions' });
    const following = await admin.post(`/tasks/${task.id}/comments`, { body: 'Continue the implementation' });
    expect(command.body.comment.delivery.state).toBe('queued');
    expect(following.body.comment.delivery.state).toBe('queued');
    expect(runner.messages('job.input')).toHaveLength(0);
    await runner.play(first.jobId, [stream.text('First response'), stream.result()]);
    await runner.exit(first.jobId);
    await app.settle();
    const next = await runner.next('job.start', (m) => m.jobId !== first.jobId);
    expect(next.initialMessage).toEqual([{ type: 'text', text: '/compact keep decisions' }]);
    const queued = (await admin.get(`/agents/${agent.id}/queue`)).body.entries;
    expect(queued).toHaveLength(1);
    expect(queued[0].pendingMessages).toBe(1);
    runner.accept(next.jobId);
    await runner.play(next.jobId, [
      new Stream().init(),
      { type: 'system', subtype: 'local_command_output', content: 'Command completed locally' },
      { ...new Stream().result(), result: 'Command completed locally' },
    ]);
    await runner.exit(next.jobId);
    await app.settle();
    const last = await runner.next('job.start', (m) => m.jobId !== first.jobId && m.jobId !== next.jobId);
    expect(JSON.stringify(last.initialMessage)).toContain('Continue the implementation');
    expect(JSON.stringify(last.initialMessage)).not.toContain('/compact');
    const timeline = (await admin.get(`/tasks/${task.id}/timeline`)).body.items;
    expect(timeline.filter((i: { comment?: { body: string } }) => i.comment?.body === 'Command completed locally')).toHaveLength(1);
  });

  it('runs a first slash command natively, with the Task context in earlier blocks of the same message', async () => {
    const admin = await app.admin();
    const { agent, runner } = await createAgent(app, admin);
    const { project } = await createProject(admin);
    const task = await createTask(admin, project.id, { title: 'Initialize payment service' });
    await admin.post(`/tasks/${task.id}/comments`, { body: 'Use the existing billing tables' });
    await assignAndStart(admin, task.id, agent.id, '/init');
    const start = await runner.next('job.start');
    const blocks = start.initialMessage as { type: string; text?: string }[];
    expect(blocks.at(-1)).toEqual({ type: 'text', text: '/init' });
    const context = JSON.stringify(blocks.slice(0, -1));
    expect(context).toContain('Initialize payment service');
    expect(context).toContain('Use the existing billing tables');
    expect(context).not.toContain('/init');

    // The system prompt carries no Task context, so it stays the same on every Job of the Session.
    runner.accept(start.jobId);
    const stream = new Stream();
    await runner.play(start.jobId, [stream.init(), stream.text('CLAUDE.md created'), stream.result()]);
    await runner.exit(start.jobId);
    await app.settle();
    await admin.post(`/tasks/${task.id}/comments`, { body: 'Now add the refunds endpoint' });
    const next = await runner.next('job.start', (m) => m.jobId !== start.jobId);
    expect(next.mode).toBe('resume');
    expect(start.claudeArgs.appendSystemPrompt).not.toContain('Initialize payment service');
    expect(next.claudeArgs.appendSystemPrompt).toBe(start.claudeArgs.appendSystemPrompt);
  });
});
