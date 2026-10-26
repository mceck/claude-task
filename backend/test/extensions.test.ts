import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { skills, mcpServers } from '../src/db/schema';
import * as importer from '../src/modules/extensions/import-skills';
import { useTestApp } from './helpers/app';
import { assignAndStart, createAgent, createProject, createTask, createUser } from './helpers/fixtures';
import { Stream } from './helpers/stream';

const imported = (name = 'review', text = 'Review carefully', userInvocable = true): importer.ImportedSkill => ({
  name,
  description: 'Review code',
  userInvocable,
  contentHash: text,
  files: [
    { path: 'SKILL.md', content: Buffer.from(text).toString('base64'), executable: false },
    { path: 'scripts/check.sh', content: Buffer.from('#!/bin/sh\necho checked').toString('base64'), executable: true },
  ],
});
describe('shared skills and MCP catalog', () => {
  const app = useTestApp();
  afterEach(() => vi.restoreAllMocks());

  it('imports files, assigns skills, synchronizes without recreation, and preserves assignments on duplication', async () => {
    const admin = await app.admin();
    const cli = vi.spyOn(importer, 'importSkills').mockResolvedValue([imported(), imported('internal', 'Hidden', false)]);
    const response = await admin.post('/skills/import', { source: 'org/skills' });
    expect(response.status).toBe(201);
    expect(cli).toHaveBeenCalledWith('org/skills', ['*']);
    const entries = response.body.skills;
    expect(entries[0]).toMatchObject({ name: 'review', fileCount: 2 });
    expect(entries[0].files).toBeUndefined();
    const { agent } = await createAgent(app, admin, { body: { skillIds: entries.map((s: { id: string }) => s.id) }, connect: false });
    expect(agent.skillCommands).toEqual([{ name: 'review', description: 'Review code' }]);
    const before = app.runtime.containers.get(agent.id);
    expect(app.runtime.configuredSkills.get(agent.id)!.skills).toHaveLength(2);
    const changed = await admin.patch(`/agents/${agent.id}`, { skillIds: [] });
    expect(changed.status).toBe(200);
    await app.settle();
    expect(app.runtime.containers.get(agent.id)).toBe(before);
    expect(app.runtime.configuredSkills.get(agent.id)!.skills).toEqual([]);
    await admin.patch(`/agents/${agent.id}`, { skillIds: [entries[0].id] });
    const copy = await admin.post(`/agents/${agent.id}/duplicate`, {});
    expect(copy.body.agent.skillIds).toEqual([entries[0].id]);
    expect((await admin.delete(`/skills/${entries[0].id}`)).status).toBe(409);
    expect((await admin.patch(`/agents/${agent.id}`, { skillIds: [randomUUID()] })).status).toBe(400);
    expect((await admin.get(`/agents/${agent.id}`)).body.agent.skillIds).toEqual([entries[0].id]);
  });

  it('defers changes to a busy agent and dispatches the next job with new skills and MCP secrets', async () => {
    const admin = await app.admin();
    vi.spyOn(importer, 'importSkills').mockResolvedValue([imported()]);
    const skill = (await admin.post('/skills/import', { source: 'org/skills' })).body.skills[0];
    const remote = await admin.post('/mcp-servers', {
      name: 'search',
      type: 'http',
      url: 'https://mcp.example.com',
      headers: { Authorization: { value: 'Bearer top-secret-1234', secret: true } },
    });
    expect(remote.status).toBe(201);
    const stdio = await admin.post('/mcp-servers', {
      name: 'local',
      type: 'stdio',
      command: '/usr/local/bin/mcp-server',
      args: ['--read-only'],
      env: { TOKEN: { value: 'stdio-secret', secret: true } },
    });
    expect(stdio.status).toBe(201);
    const { agent, runner } = await createAgent(app, admin);
    const { project } = await createProject(admin);
    const task = await createTask(admin, project.id);
    await assignAndStart(admin, task.id, agent.id);
    const first = await runner.next('job.start');
    runner.accept(first.jobId);
    await runner.drain();
    const configured = app.runtime.configuredSkills.get(agent.id);
    await admin.patch(`/agents/${agent.id}`, { skillIds: [skill.id], mcpServerIds: [remote.body.mcpServer.id, stdio.body.mcpServer.id] });
    await app.settle();
    expect(app.runtime.configuredSkills.get(agent.id)).toBe(configured);
    expect((await admin.get(`/agents/${agent.id}`)).body.agent.extensionsPending).toBe(true);
    const stream = new Stream();
    await runner.play(first.jobId, [stream.init(), stream.result()]);
    await runner.exit(first.jobId);
    await app.settle();
    expect(app.runtime.configuredSkills.get(agent.id)!.skills[0]!.name).toBe('review');
    await admin.post(`/tasks/${task.id}/comments`, { body: '/review authentication' });
    const next = await runner.next('job.start', (m) => m.jobId !== first.jobId);
    expect(next.claudeArgs.appendSystemPrompt).not.toContain('/home/agent/.claude/skills/');
    expect(next.initialMessage).toEqual([{ type: 'text', text: '/review authentication' }]);
    const config = JSON.parse(next.claudeArgs.mcpConfig).mcpServers;
    expect(config.search.headers.Authorization).toBe('Bearer top-secret-1234');
    expect(config.local).toEqual({
      type: 'stdio',
      command: '/usr/local/bin/mcp-server',
      args: ['--read-only'],
      env: { TOKEN: 'stdio-secret' },
    });
    expect(config['claude-task'].headers.Authorization).toMatch(/^Bearer /);
    expect((await admin.get(`/agents/${agent.id}`)).body.agent.extensionsPending).toBe(false);
  });

  it('encrypts secrets, preserves redacted values on edit and restricts catalog changes to admins', async () => {
    const admin = await app.admin();
    const { client: member } = await createUser(app, admin);
    const response = await admin.post('/mcp-servers', {
      name: 'search',
      type: 'sse',
      url: 'https://example.com/sse',
      headers: { Authorization: { value: 'secret-value-9876', secret: true } },
    });
    const server = response.body.mcpServer;
    expect(server.headers.Authorization).toEqual({ value: null, secret: true, last4: '9876' });
    const [stored] = await app.server.ctx.db.select().from(mcpServers).where(eq(mcpServers.id, server.id));
    expect(JSON.stringify(stored)).not.toContain('secret-value');
    expect(stored!.headers.Authorization!.ciphertext).toBeTruthy();
    const { id: _id, updatedAt: _updated, headers: _headers, ...body } = server;
    expect(
      (
        await admin.put(`/mcp-servers/${server.id}`, {
          ...body,
          description: 'Updated',
          headers: { Authorization: { value: null, secret: true } },
        })
      ).status,
    ).toBe(200);
    const [updated] = await app.server.ctx.db.select().from(mcpServers).where(eq(mcpServers.id, server.id));
    expect(updated!.headers).toEqual(stored!.headers);
    expect((await member.get('/skills')).status).toBe(200);
    for (const response of await Promise.all([
      member.post('/skills/import', { source: 'org/repo' }),
      member.get('/mcp-servers'),
      member.post('/mcp-servers', body),
      member.put(`/mcp-servers/${server.id}`, body),
      member.delete(`/mcp-servers/${server.id}`),
    ]))
      expect(response.status).toBe(403);
    expect((await admin.post('/mcp-servers', { name: 'claude-task', type: 'http', url: 'https://example.com' })).status).toBe(400);
    expect((await admin.post('/skills/import', { source: '../private' })).status).toBe(400);
    expect((await admin.post('/skills/import', { source: 'org/repo', skills: ['--global'] })).status).toBe(400);
  });

  it('reimports in place and propagates updates to every assigned agent', async () => {
    const admin = await app.admin();
    const cli = vi.spyOn(importer, 'importSkills').mockResolvedValue([imported()]);
    const skill = (await admin.post('/skills/import', { source: 'org/repo' })).body.skills[0];
    const a = await createAgent(app, admin, { body: { skillIds: [skill.id] }, connect: false });
    const b = await createAgent(app, admin, { body: { skillIds: [skill.id] }, connect: false });
    const containers = [app.runtime.containers.get(a.agent.id), app.runtime.containers.get(b.agent.id)];
    cli.mockResolvedValue([imported('review', 'Updated instructions')]);
    const updated = await admin.post('/skills/import', { source: 'org/repo', skills: ['review'] });
    expect(updated.body.skills[0].id).toBe(skill.id);
    await app.settle();
    for (const [index, { agent }] of [a, b].entries()) {
      expect(app.runtime.containers.get(agent.id)).toBe(containers[index]);
      const file = app.runtime.configuredSkills.get(agent.id)!.skills[0]!.files[0]!;
      expect(Buffer.from(file.content, 'base64').toString()).toBe('Updated instructions');
    }
    expect(await app.server.ctx.db.select().from(skills)).toHaveLength(1);
  });
});

describe('plugin catalog', () => {
  const app = useTestApp();
  afterEach(() => vi.restoreAllMocks());

  it('validates entries, keeps duplicates out and restricts catalog changes to admins', async () => {
    const admin = await app.admin();
    const { client: member } = await createUser(app, admin);
    const fromSource = await admin.post('/plugins', { name: 'frontend-design', source: 'anthropics/claude-plugins-official', description: 'UI work' });
    expect(fromSource.status).toBe(201);
    expect(fromSource.body.plugin).toMatchObject({ name: 'frontend-design', source: 'anthropics/claude-plugins-official', description: 'UI work' });
    expect((await admin.post('/plugins', { name: 'superpowers@anthropic-plugin-directory' })).status).toBe(201);
    expect((await admin.post('/plugins', { name: 'frontend-design', source: 'anthropics/claude-plugins-official' })).status).toBe(409);
    for (const body of [
      { name: 'frontend-design' },
      { name: 'frontend-design@market', source: 'org/market' },
      { name: '--scope', source: 'org/market' },
      { name: 'a@b@c' },
      { name: 'tool', source: '../private' },
      { name: 'tool', source: 'https://user:pass@example.com/market.git' },
      { name: 'tool', source: '--marketplace' },
    ])
      expect((await admin.post('/plugins', body)).status, JSON.stringify(body)).toBe(400);
    const id = fromSource.body.plugin.id;
    expect((await member.get('/plugins')).body.plugins.map((p: { name: string }) => p.name)).toEqual(['frontend-design', 'superpowers@anthropic-plugin-directory']);
    for (const response of await Promise.all([
      member.post('/plugins', { name: 'other', source: 'org/market' }),
      member.put(`/plugins/${id}`, { name: 'other', source: 'org/market' }),
      member.post(`/plugins/${id}/update`, {}),
      member.delete(`/plugins/${id}`),
    ]))
      expect(response.status).toBe(403);
    const edited = await admin.put(`/plugins/${id}`, { name: 'frontend-design', source: 'anthropics/claude-plugins-official', description: 'Edited' });
    expect(edited.body.plugin.description).toBe('Edited');
    expect((await admin.delete(`/plugins/${id}`)).status).toBe(204);
    expect((await admin.delete(`/plugins/${id}`)).status).toBe(404);
  });

  it('installs assigned plugins without recreating the container, resynchronizes on update and copies them on duplication', async () => {
    const admin = await app.admin();
    const a = (await admin.post('/plugins', { name: 'frontend-design', source: 'anthropics/claude-plugins-official' })).body.plugin;
    const b = (await admin.post('/plugins', { name: 'superpowers@anthropic-plugin-directory' })).body.plugin;
    const { agent } = await createAgent(app, admin, { body: { pluginIds: [a.id, b.id] }, connect: false });
    expect(agent.pluginIds.sort()).toEqual([a.id, b.id].sort());
    expect(app.runtime.configuredPlugins.get(agent.id)).toEqual([
      { name: 'frontend-design', source: 'anthropics/claude-plugins-official' },
      { name: 'superpowers@anthropic-plugin-directory', source: '' },
    ]);
    const container = app.runtime.containers.get(agent.id);
    await admin.patch(`/agents/${agent.id}`, { pluginIds: [b.id] });
    await app.settle();
    expect(app.runtime.containers.get(agent.id)).toBe(container);
    expect(app.runtime.configuredPlugins.get(agent.id)).toEqual([{ name: 'superpowers@anthropic-plugin-directory', source: '' }]);

    const sync = vi.spyOn(app.runtime, 'configurePlugins');
    expect((await admin.post(`/plugins/${b.id}/update`, {})).status).toBe(204);
    await app.settle();
    expect(sync).toHaveBeenCalledWith(agent.id, [{ name: 'superpowers@anthropic-plugin-directory', source: '' }]);
    expect((await admin.post(`/plugins/${a.id}/update`, {})).status).toBe(204);
    await app.settle();
    expect(sync).toHaveBeenCalledTimes(1);

    const copy = await admin.post(`/agents/${agent.id}/duplicate`, {});
    expect(copy.body.agent.pluginIds).toEqual([b.id]);
    expect((await admin.delete(`/plugins/${b.id}`)).status).toBe(409);
    expect((await admin.patch(`/agents/${agent.id}`, { pluginIds: [randomUUID()] })).status).toBe(400);
  });

  it('holds dispatch while plugins fail to install and shows the error on the agent', async () => {
    const admin = await app.admin();
    const plugin = (await admin.post('/plugins', { name: 'missing', source: 'org/market' })).body.plugin;
    const { agent, runner } = await createAgent(app, admin);
    app.runtime.pluginFailure = 'Plugin missing: Plugin "missing" not found in marketplace "market".';
    await admin.patch(`/agents/${agent.id}`, { pluginIds: [plugin.id] });
    await app.settle();
    const failed = (await admin.get(`/agents/${agent.id}`)).body.agent;
    expect(failed).toMatchObject({ extensionsPending: true, extensionsError: app.runtime.pluginFailure });
    const { project } = await createProject(admin);
    const task = await createTask(admin, project.id);
    await assignAndStart(admin, task.id, agent.id);
    await app.settle();
    expect(runner.messages('job.start')).toHaveLength(0);

    app.runtime.pluginFailure = null;
    await app.server.ctx.scheduler.reconcile(agent.id);
    await runner.next('job.start');
    expect((await admin.get(`/agents/${agent.id}`)).body.agent).toMatchObject({ extensionsPending: false, extensionsError: null });
  });

  it('keeps Comments flowing while a slow plugin installation runs, and dispatches once it is done', async () => {
    const admin = await app.admin();
    const plugin = (await admin.post('/plugins', { name: 'slow', source: 'org/market' })).body.plugin;
    const { agent, runner } = await createAgent(app, admin);
    const { project } = await createProject(admin);
    const task = await createTask(admin, project.id);
    let release!: () => void;
    const installing = new Promise<void>((r) => (release = r));
    let started!: () => void;
    const began = new Promise<void>((r) => (started = r));
    const original = app.runtime.configurePlugins.bind(app.runtime);
    vi.spyOn(app.runtime, 'configurePlugins').mockImplementation(async (...args) => {
      started();
      await installing;
      return original(...args);
    });
    await admin.patch(`/agents/${agent.id}`, { pluginIds: [plugin.id] });
    await began;

    const posted = assignAndStart(admin, task.id, agent.id).then(() => 'posted');
    expect(await Promise.race([posted, new Promise((r) => setTimeout(() => r('blocked'), 1500))])).toBe('posted');
    expect(runner.messages('job.start')).toHaveLength(0);

    release();
    await app.settle();
    const start = await runner.next('job.start');
    expect(start.jobId).toBeTruthy();
  });
});
