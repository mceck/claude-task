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

  it('runs a first slash command natively while supplying the Task context in the system prompt', async () => {
    const admin = await app.admin();
    const { agent, runner } = await createAgent(app, admin);
    const { project } = await createProject(admin);
    const task = await createTask(admin, project.id, { title: 'Initialize payment service' });
    await assignAndStart(admin, task.id, agent.id, '/init');
    const start = await runner.next('job.start');
    expect(start.initialMessage).toEqual([{ type: 'text', text: '/init' }]);
    expect(start.claudeArgs.appendSystemPrompt).toContain('Initialize payment service');
  });
});
