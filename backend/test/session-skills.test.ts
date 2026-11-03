import { describe, expect, it } from 'vitest';
import { useTestApp } from './helpers/app';
import { assignAndStart, createAgent, createProject, createTask } from './helpers/fixtures';
import { Stream } from './helpers/stream';

describe('the Skills a Task’s Session offers', () => {
  const app = useTestApp();

  async function startedTask(opts: { slashCommands: string[] }) {
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
        { name: 'deploy', head: '---\ndescription: Deploy the service\n---\n' },
        { name: 'review', head: '---\ndescription: Review changes\n---\n' },
        { name: 'unused', head: '---\ndescription: Not used\n---\n' },
      ],
    });
    await runner.play(start.jobId, [{ ...new Stream().init(), slash_commands: ['compact', ...opts.slashCommands] }]);
    return { admin, runner, task, start };
  }

  it('lists the Session’s Skills with who activated them, used ones first', async () => {
    const { admin, runner, task, start } = await startedTask({ slashCommands: ['deploy', 'review', 'unused'] });
    // The Agent activates `deploy` with Claude Code's Skill tool.
    await runner.play(start.jobId, [new Stream().toolUse('toolu_1', 'Skill', { skill: 'deploy' })]);
    // The User activates `review` with a slash command.
    await admin.post(`/tasks/${task.id}/comments`, { body: '/review please' });

    const res = await admin.get(`/tasks/${task.id}/skills`);
    expect(res.status).toBe(200);
    expect(res.body.skills).toEqual([
      { name: 'deploy', description: 'Deploy the service', usedBy: ['agent'] },
      { name: 'review', description: 'Review changes', usedBy: ['user'] },
      { name: 'unused', description: 'Not used', usedBy: [] },
    ]);
  });

  it('includes a Skill the Agent used that the catalog does not list', async () => {
    const { admin, runner, task, start } = await startedTask({ slashCommands: ['deploy'] });
    await runner.play(start.jobId, [new Stream().toolUse('toolu_1', 'Skill', { skill: 'plugin:review' })]);

    const res = await admin.get(`/tasks/${task.id}/skills`);
    expect(res.body.skills).toEqual([
      { name: 'plugin:review', description: '', usedBy: ['agent'] },
      { name: 'deploy', description: 'Deploy the service', usedBy: [] },
    ]);
  });

  it('answers an empty list without a Session', async () => {
    const admin = await app.admin();
    const { project } = await createProject(admin);
    const task = await createTask(admin, project.id);
    expect((await admin.get(`/tasks/${task.id}/skills`)).body).toEqual({ skills: [] });
  });
});
