import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { BackendToRunner, Comment, JobStartMessage, UploadManifestEntry } from '@claude-task/shared';
import { describe, expect, it } from 'vitest';
import { useTestApp } from './helpers/app';
import type { TestApp } from './helpers/app';
import { assignAgent, assignAndStart, comment, createAgent, createProject, createTask, createUser, statusByName, moveToStatus, timeline } from './helpers/fixtures';
import { FakeRunner } from './helpers/runner';
import { Stream } from './helpers/stream';
import { WsTestClient } from './helpers/ws';

type UploadRequest = Extract<BackendToRunner, { type: 'job.upload' }>;

async function mcpClient(app: TestApp, start: JobStartMessage): Promise<Client> {
  const server = JSON.parse(start.claudeArgs.mcpConfig).mcpServers['claude-task'];
  const url = new URL(server.url.replace('http://backend.test', app.url));
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: server.headers } }));
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const res = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
  const text = res.content[0]!.text;
  return { isError: res.isError ?? false, text, json: res.isError ? null : JSON.parse(text) };
}

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4d90000000049454e44ae426082', 'hex');

/** Plays the Runner's side of `job.upload`: the manifest, then one part per successful entry. */
async function upload(
  app: TestApp,
  agentId: string,
  request: UploadRequest,
  entries: (UploadManifestEntry & { file?: { name: string; type: string; data: Buffer } })[],
  token = FakeRunner.token(app, agentId),
): Promise<number> {
  const form = new FormData();
  form.append('manifest', JSON.stringify(entries.map(({ path, error }) => ({ path, ...(error ? { error } : {}) }))));
  for (const e of entries) if (e.file) form.append('file', new Blob([e.file.data], { type: e.file.type }), e.file.name);
  const res = await fetch(request.url.replace('http://backend.test', app.url), { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: form });
  return res.status;
}

async function setup(app: TestApp, opts: { assignees?: string[]; agentName?: string } = {}) {
  const admin = await app.admin();
  const bundle = await createProject(admin, { name: 'Payments' });
  const { agent, runner } = await createAgent(app, admin, { name: opts.agentName ?? 'Ada Bot' });
  const task = await createTask(admin, bundle.project.id, { title: 'Fix login', assigneeIds: opts.assignees ?? [] });
  await assignAndStart(admin, task.id, agent.id);
  const start = await runner.next('job.start');
  runner.accept(start.jobId);
  await runner.drain();
  return { admin, bundle, agent, runner, task, start, client: await mcpClient(app, start) };
}

/** Ends the running Turn so the Agent is idle and the next Comment starts a new Job. */
async function finishTurn(runner: FakeRunner, start: JobStartMessage) {
  const s = new Stream(start.sessionId);
  await runner.play(start.jobId, [s.init(), s.result()]);
  await runner.next('job.end', (m) => m.jobId === start.jobId);
  await runner.exit(start.jobId);
}

const texts = (blocks: { type: string; text?: string }[] | null) => (blocks ?? []).map((b) => b.text ?? '').join('\n');

const DB_ITEM = {
  header: 'Database',
  question: 'Which database should we use?',
  options: [
    { label: 'Postgres', description: 'Already in production' },
    { label: 'MySQL', description: 'The team knows it' },
  ],
};

async function commentsOf(admin: Awaited<ReturnType<TestApp['admin']>>, taskId: string): Promise<Comment[]> {
  return (await timeline(admin, taskId)).flatMap((i) => (i.type === 'comment' ? [i.comment] : []));
}

describe('Conversation tools (MCP)', () => {
  const app = useTestApp({ agents: { uploadTimeoutMs: 1000 } });

  it('job.start disallows AskUserQuestion and tells the Agent how to ask and show files', async () => {
    const { start, client } = await setup(app);
    expect(start.claudeArgs.disallowedTools).toEqual(['AskUserQuestion']);
    expect(start.claudeArgs.appendSystemPrompt).toContain('ask_question');
    expect(start.claudeArgs.appendSystemPrompt).toContain('send_files');
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(['send_files', 'ask_question', 'create_survey']));
    // Surveys are for explicit requests only: the tool says so itself.
    expect(tools.find((t) => t.name === 'create_survey')!.description).toContain('ONLY when a human explicitly asked');
  });

  it('send_files posts the files the Runner uploads as an Agent Comment', async () => {
    const { admin, agent, runner, task, start, client } = await setup(app);
    const pending = call(client, 'send_files', { paths: ['shots/login.png', '/tmp/report.txt'], caption: 'The **login** page' });
    const request = await runner.next('job.upload');
    expect(request).toMatchObject({ jobId: start.jobId, files: [{ path: 'shots/login.png' }, { path: '/tmp/report.txt' }] });
    expect(
      await upload(app, agent.id, request, [
        { path: 'shots/login.png', file: { name: 'login.png', type: 'image/png', data: PNG } },
        { path: '/tmp/report.txt', file: { name: 'report.txt', type: 'text/plain', data: Buffer.from('all green') } },
      ]),
    ).toBe(204);
    const result = await pending;
    expect(result.isError, result.text).toBe(false);
    expect(result.json.files).toEqual(['login.png', 'report.txt']);
    await app.settle();

    const posted = (await commentsOf(admin, task.id)).find((c) => c.id === result.json.posted)!;
    expect(posted).toMatchObject({ kind: 'agent', body: 'The **login** page', author: { type: 'agent', id: agent.id }, delivery: null });
    expect(posted.attachments.map((a) => [a.filename, a.contentType, a.size])).toEqual([
      ['login.png', 'image/png', PNG.length],
      ['report.txt', 'text/plain', 9],
    ]);
    const download = await admin.get(posted.attachments[1]!.url.replace('/api/v1', ''));
    expect(download.status).toBe(200);
  });

  it('posts nothing and names each file that could not be read', async () => {
    const { admin, agent, runner, task, client } = await setup(app);
    const pending = call(client, 'send_files', { paths: ['ok.txt', 'missing.png'] });
    const request = await runner.next('job.upload');
    await upload(app, agent.id, request, [
      { path: 'ok.txt', file: { name: 'ok.txt', type: 'text/plain', data: Buffer.from('fine') } },
      { path: 'missing.png', error: 'not found' },
    ]);
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(result.text).toContain('missing.png: not found');
    expect(result.text).not.toContain('ok.txt:');
    expect((await commentsOf(admin, task.id)).filter((c) => c.kind === 'agent')).toEqual([]);
  });

  it('fails when the Runner does not upload in time, and refuses the late upload', async () => {
    const { agent, runner, client } = await setup(app);
    const pending = call(client, 'send_files', { paths: ['slow.txt'] });
    const request = await runner.next('job.upload');
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(result.text).toContain('did not upload them within');
    expect(await upload(app, agent.id, request, [{ path: 'slow.txt', file: { name: 'slow.txt', type: 'text/plain', data: Buffer.from('x') } }])).toBe(404);
  });

  it('accepts an upload only from the Runner it asked', async () => {
    const { admin, agent, runner, client } = await setup(app);
    const other = await createAgent(app, admin, { name: 'Other Bot' });
    const pending = call(client, 'send_files', { paths: ['a.txt'] });
    const request = await runner.next('job.upload');
    const file = { name: 'a.txt', type: 'text/plain', data: Buffer.from('a') };
    expect(await upload(app, agent.id, request, [{ path: 'a.txt', file }], FakeRunner.token(app, other.agent.id))).toBe(404);
    expect(await upload(app, agent.id, request, [{ path: 'a.txt', file }])).toBe(204);
    expect((await pending).isError).toBe(false);
  });

  it('refuses an upload whose manifest names other paths', async () => {
    const { agent, runner, client } = await setup(app);
    const pending = call(client, 'send_files', { paths: ['a.txt'] });
    const request = await runner.next('job.upload');
    expect(await upload(app, agent.id, request, [{ path: '/etc/other', file: { name: 'other', type: 'text/plain', data: Buffer.from('x') } }])).toBe(400);
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(result.text).toContain('inconsistent upload');
  });

  it('posts nothing when the Task was closed while the files were collected', async () => {
    const { admin, agent, bundle, runner, task, client } = await setup(app);
    const pending = call(client, 'send_files', { paths: ['a.txt'] });
    const request = await runner.next('job.upload');
    await moveToStatus(admin, task.id, statusByName(bundle, 'Closed').id);
    await upload(app, agent.id, request, [{ path: 'a.txt', file: { name: 'a.txt', type: 'text/plain', data: Buffer.from('a') } }]);
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(result.text).toContain('job ended');
    expect((await commentsOf(admin, task.id)).filter((c) => c.kind === 'agent')).toEqual([]);
  });

  it('fails at once when the Runner is not connected', async () => {
    const { runner, client } = await setup(app);
    await runner.close();
    const result = await call(client, 'send_files', { paths: ['a.txt'] });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('not connected');
  });

  it('ask_question posts a Question with a readable body and tells the Agent to end its Turn', async () => {
    const { admin, task, client } = await setup(app);
    const result = await call(client, 'ask_question', { questions: [DB_ITEM, { header: 'Extras', question: 'What else?', options: [{ label: 'Redis' }, { label: 'Search' }], multiSelect: true }] });
    expect(result.isError, result.text).toBe(false);
    expect(result.json.next).toContain('End your turn');
    await app.settle();
    const question = (await commentsOf(admin, task.id)).find((c) => c.id === result.json.posted)!;
    expect(question.kind).toBe('agent');
    expect(question.question).toMatchObject({ state: 'open', answer: null, answeredBy: null });
    expect(question.question!.items[1]).toMatchObject({ header: 'Extras', multiSelect: true, options: [{ label: 'Redis', description: '' }, { label: 'Search', description: '' }] });
    expect(question.survey).toBeNull();
    expect(question.body).toContain('**Database**: Which database should we use?');
    expect(question.body).toContain('- **Postgres**: Already in production');
  });

  it('refuses invalid items', async () => {
    const { client } = await setup(app);
    const duplicate = await call(client, 'ask_question', { questions: [{ ...DB_ITEM, options: [{ label: 'A' }, { label: 'a' }] }] });
    expect(duplicate.isError).toBe(true);
    expect(duplicate.text).toContain('same label');
    const other = await call(client, 'ask_question', { questions: [{ ...DB_ITEM, options: [{ label: 'A' }, { label: 'Other' }] }] });
    expect(other.text).toContain('"Other"');
    const tooLong = await call(client, 'ask_question', { questions: [{ ...DB_ITEM, header: 'Way too long header' }] });
    expect(tooLong.isError).toBe(true);
  });

  it('create_survey needs Assignees, who become its Expected Respondents', async () => {
    const { client } = await setup(app);
    const refused = await call(client, 'create_survey', { questions: [DB_ITEM] });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('no assignees');

    const admin = await app.admin();
    const mia = await createUser(app, admin, { displayName: 'Mia' });
    const withAssignees = await setup(app, { assignees: [mia.user.id], agentName: 'Bea Bot' });
    const created = await call(withAssignees.client, 'create_survey', { questions: [DB_ITEM] });
    expect(created.isError, created.text).toBe(false);
    expect(created.json.expectedRespondents).toEqual(['Mia']);
  });
});

describe('Answering Questions and Surveys', () => {
  const app = useTestApp();

  async function askQuestion(opts: { assignees?: string[] } = {}) {
    const ctx = await setup(app, opts);
    const result = await call(ctx.client, 'ask_question', { questions: [DB_ITEM, { header: 'Extras', question: 'What else?', options: [{ label: 'Redis' }, { label: 'Search' }], multiSelect: true }] });
    expect(result.isError, result.text).toBe(false);
    return { ...ctx, questionId: result.json.posted as string };
  }

  it('the first answer closes the Question and reaches the Agent quoting it', async () => {
    const { admin, runner, start, task, questionId } = await askQuestion();
    await finishTurn(runner, start);
    const mia = await createUser(app, admin, { displayName: 'Mia' });
    const events = await WsTestClient.connect(app.url, mia.client.cookie);
    await events.subscribe(`task:${task.id}`);

    const res = await mia.client.post(`/comments/${questionId}/answer`, {
      answers: [{ selected: ['Postgres'], other: null }, { selected: ['Redis'], other: 'Elasticsearch later' }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.question.question).toMatchObject({ state: 'answered', answeredBy: { displayName: 'Mia' }, answer: [{ selected: ['Postgres'], other: null }, { selected: ['Redis'], other: 'Elasticsearch later' }] });
    expect(res.body.answer).toMatchObject({ kind: 'user', author: { displayName: 'Mia' }, answersCommentId: questionId, delivery: { state: 'queued' } });
    expect(res.body.answer.body).toContain('**Database**: Which database should we use?\n→ Postgres');
    expect(res.body.answer.body).toContain('→ Redis; Other: "Elasticsearch later"');

    const next = await runner.next('job.start', (m) => m.jobId !== start.jobId);
    const message = texts(next.initialMessage);
    expect(message).toContain('[Comment by Mia');
    expect(message).toContain('Answer to your question from');
    expect(message).toContain('→ Postgres');

    await events.next('comment.updated', (e) => e.comment.id === questionId && e.comment.question?.state === 'answered');
    await events.next('comment.created', (e) => e.comment.answersCommentId === questionId);
    events.close();
  });

  it('a second answer gets 409 and names who answered', async () => {
    const { admin, questionId } = await askQuestion();
    const mia = await createUser(app, admin, { displayName: 'Mia' });
    const luca = await createUser(app, admin, { displayName: 'Luca' });
    const body = { answers: [{ selected: ['Postgres'] }, { selected: ['Search'] }] };
    const [a, b] = await Promise.all([mia.client.post(`/comments/${questionId}/answer`, body), luca.client.post(`/comments/${questionId}/answer`, body)]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const loser = a.status === 409 ? a : b;
    expect(loser.body.error.message).toMatch(/already answered by (Mia|Luca)/);
  });

  it('keeps the answer final: its Comment cannot be edited', async () => {
    const { admin, questionId } = await askQuestion();
    const res = await admin.post(`/comments/${questionId}/answer`, { answers: [{ selected: ['Postgres'] }, { selected: ['Redis'] }] });
    const edit = await admin.patch(`/comments/${res.body.answer.id}`, { body: 'MySQL after all' });
    expect(edit.status).toBe(403);
  });

  it('validates each answer against its item', async () => {
    const { admin, questionId } = await askQuestion();
    const post = (answers: unknown) => admin.post(`/comments/${questionId}/answer`, { answers });
    expect((await post([{ selected: ['Postgres'] }])).status).toBe(400);
    expect((await post([{ selected: ['Oracle'] }, { selected: ['Redis'] }])).body.error.message).toContain('"Oracle" is not an option');
    expect((await post([{ selected: ['Postgres', 'MySQL'] }, { selected: ['Redis'] }])).body.error.message).toContain('single answer');
    expect((await post([{ selected: [], other: '  ' }, { selected: ['Redis'] }])).body.error.message).toContain('Choose an option');
    expect((await post([{ selected: [], other: 'SQLite' }, { selected: ['Redis', 'Search'] }])).status).toBe(201);
  });

  it('stays open after a free Comment, and the answer is not delivered once the Task is closed', async () => {
    const { admin, bundle, runner, start, task, questionId } = await askQuestion();
    await comment(admin, task.id, 'Let us discuss it first');
    await finishTurn(runner, start);
    await moveToStatus(admin, task.id, statusByName(bundle, 'Closed').id);
    const res = await admin.post(`/comments/${questionId}/answer`, { answers: [{ selected: ['MySQL'] }, { selected: ['Redis'] }] });
    expect(res.status).toBe(201);
    expect(res.body.answer.delivery).toMatchObject({ state: 'not_delivered', reason: 'task closed' });
  });

  it('a Survey takes one changeable answer per User and closes when every Expected Respondent answered', async () => {
    const admin = await app.admin();
    const mia = await createUser(app, admin, { displayName: 'Mia' });
    const luca = await createUser(app, admin, { displayName: 'Luca' });
    const { runner, start, task, client } = await setup(app, { assignees: [mia.user.id, luca.user.id] });
    const created = await call(client, 'create_survey', { questions: [DB_ITEM] });
    const surveyId = created.json.posted as string;
    await finishTurn(runner, start);
    // Expected Respondents are fixed when the Survey is created.
    const current = (await admin.get(`/tasks/${task.id}`)).body.task;
    await admin.patch(`/tasks/${task.id}`, { version: current.version, assigneeIds: [mia.user.id] });

    const respond = (c: typeof admin, selected: string[], other: string | null = null) => c.put(`/comments/${surveyId}/response`, { answers: [{ selected, other }] });
    let res = await respond(mia.client, ['MySQL']);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    res = await respond(mia.client, ['Postgres']);
    res = await respond(admin, [], 'SQLite');
    expect(res.body.comment.survey).toMatchObject({
      state: 'open',
      responses: [
        { user: { displayName: 'Mia' }, answers: [{ selected: ['Postgres'], other: null }] },
        { user: { displayName: 'Ada Admin' }, answers: [{ selected: [], other: 'SQLite' }] },
      ],
    });
    expect(res.body.comment.survey.expectedRespondents.map((a: { displayName: string }) => a.displayName).sort()).toEqual(['Luca', 'Mia']);
    expect(await runner.none('job.start', (m) => m.type === 'job.start' && m.jobId !== start.jobId)).toBe(true);

    res = await respond(luca.client, ['Postgres']);
    expect(res.body.comment.survey).toMatchObject({ state: 'closed', closedBy: null });
    expect((await respond(mia.client, ['MySQL'])).status).toBe(409);

    const next = await runner.next('job.start', (m) => m.jobId !== start.jobId);
    const message = texts(next.initialMessage);
    expect(message).toContain('Every expected respondent answered.');
    expect(message).toContain('- Postgres: 2 (Mia, Luca)');
    expect(message).toContain('- MySQL: 0');
    expect(message).toContain('- Other from Ada Admin: "SQLite"');
    const results = (await commentsOf(admin, task.id)).at(-1)!;
    expect(results).toMatchObject({ kind: 'system', body: 'Survey closed: every expected respondent answered.', delivery: { state: 'delivered' } });
  });

  it('delivers Survey results to the same Agent when it is assigned again', async () => {
    const admin = await app.admin();
    const mia = await createUser(app, admin, { displayName: 'Mia' });
    const { runner, start, task, client, agent } = await setup(app, { assignees: [mia.user.id] });
    const surveyId = (await call(client, 'create_survey', { questions: [DB_ITEM] })).json.posted as string;
    await finishTurn(runner, start);

    await assignAgent(admin, task.id, null);
    const closed = await mia.client.put(`/comments/${surveyId}/response`, { answers: [{ selected: ['Postgres'], other: null }] });
    expect(closed.status).toBe(200);
    const results = (await commentsOf(admin, task.id)).at(-1)!;
    expect(results.delivery).toMatchObject({ state: 'not_delivered' });

    await assignAgent(admin, task.id, agent.id);
    const next = await runner.next('job.start', (m) => m.jobId !== start.jobId);
    const message = texts(next.initialMessage);
    expect(message).toContain('Survey results');
    expect(message).toContain('- Postgres: 1 (Mia)');
  });

  it('Send now closes a Survey early and lists who did not answer', async () => {
    const admin = await app.admin();
    const mia = await createUser(app, admin, { displayName: 'Mia' });
    const luca = await createUser(app, admin, { displayName: 'Luca' });
    const { runner, start, client } = await setup(app, { assignees: [mia.user.id, luca.user.id] });
    const surveyId = (await call(client, 'create_survey', { questions: [DB_ITEM] })).json.posted as string;
    await finishTurn(runner, start);
    await mia.client.put(`/comments/${surveyId}/response`, { answers: [{ selected: ['MySQL'] }] });
    const res = await luca.client.post(`/comments/${surveyId}/close`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.comment.survey).toMatchObject({ state: 'closed', closedBy: { displayName: 'Luca' } });
    expect((await luca.client.post(`/comments/${surveyId}/close`)).status).toBe(409);
    const message = texts((await runner.next('job.start', (m) => m.jobId !== start.jobId)).initialMessage);
    expect(message).toContain('Luca closed it early.');
    expect(message).toContain('- MySQL: 1 (Mia)');
    expect(message).toContain('Expected respondents who did not answer: Luca.');
  });

  it('Send now works without any answer', async () => {
    const admin = await app.admin();
    const mia = await createUser(app, admin, { displayName: 'Mia' });
    const { runner, start, client } = await setup(app, { assignees: [mia.user.id] });
    const surveyId = (await call(client, 'create_survey', { questions: [DB_ITEM] })).json.posted as string;
    await finishTurn(runner, start);
    expect((await admin.post(`/comments/${surveyId}/close`)).status).toBe(200);
    const message = texts((await runner.next('job.start', (m) => m.jobId !== start.jobId)).initialMessage);
    expect(message).toContain('Answers: 0.');
    expect(message).toContain('Expected respondents who did not answer: Mia.');
  });

  it('answers each kind only through its own endpoint', async () => {
    const { admin, questionId } = await askQuestion();
    expect((await admin.put(`/comments/${questionId}/response`, { answers: [{ selected: ['Postgres'] }, { selected: ['Redis'] }] })).status).toBe(400);
    expect((await admin.post(`/comments/${questionId}/close`)).status).toBe(400);
    expect((await admin.post(`/comments/00000000-0000-4000-8000-000000000000/answer`, { answers: [{ selected: ['x'] }] })).status).toBe(404);
  });

  it('a newly assigned Agent reads the Question and its answer in the conversation', async () => {
    const { admin, runner, start, task, questionId } = await askQuestion();
    // Answered mid-turn: written to the running Job.
    await admin.post(`/comments/${questionId}/answer`, { answers: [{ selected: ['Postgres'] }, { selected: ['Search'] }] });
    expect(texts((await runner.next('job.input')).message)).toContain('→ Postgres');
    await finishTurn(runner, start);
    const other = await createAgent(app, admin, { name: 'Bea Bot' });
    await assignAgent(admin, task.id, other.agent.id);
    await comment(admin, task.id, 'Take over please');
    const message = texts((await other.runner.next('job.start')).initialMessage);
    expect(message).toContain('**Database**: Which database should we use?');
    expect(message).toContain('→ Postgres');
  });
});
