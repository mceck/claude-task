import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { Stream } from '../../backend/test/helpers/stream';
import { HEADERS as headers, createProject, createTask, login, replay, seedAgent, waitForStart } from './helpers';

test('shows how full the conversation context is beside the Session chip', async ({ page }) => {
  await login(page.request);
  const agent = await seedAgent(page.request, 'Context agent');
  const project = await createProject(page.request);
  const task = await createTask(page.request, project, 'Long conversation');
  await page.request.patch(`/api/v1/tasks/${task.id}`, { headers, data: { version: 1, agentId: agent.id } });
  await page.request.post(`/api/v1/tasks/${task.id}/comments`, { headers, data: { body: 'Please get started.' } });
  const start = await waitForStart(page.request, agent.id, task.id);
  const stream = new Stream(start.sessionId);
  await replay(page.request, agent.id, start.jobId, [
    stream.init(),
    // A tool call, so the Board card shows the tool count beside the context.
    stream.toolUse('toolu_1', 'Bash', { command: 'ls' }),
    stream.toolResult('toolu_1', 'ok'),
    {
      type: 'assistant',
      message: {
        id: `msg_${randomUUID()}`,
        type: 'message',
        role: 'assistant',
        model: stream.model,
        content: [{ type: 'text', text: 'Working on it.' }],
        // The last model call: 120,252 tokens of prompt plus reply.
        usage: { input_tokens: 2, cache_read_input_tokens: 120_000, cache_creation_input_tokens: 100, output_tokens: 150 },
      },
      parent_tool_use_id: null,
      session_id: stream.sessionId,
      uuid: randomUUID(),
    },
    // The result's own usage spans the whole Turn; the context comes from the message above.
    stream.result({ modelUsage: { [stream.model]: { contextWindow: 200_000 } } }),
  ], true);

  await page.goto(`/t/${task.key}`);
  // The header chip and, in the open details panel, the same value as a property.
  const chips = page.getByLabel('Context: 120.3K of 200K tokens (60%)');
  await expect(chips.first()).toBeVisible();
  await expect(chips.first()).toContainText('120.3K (60%)');
  await expect(page.getByText('Context', { exact: true })).toBeVisible();

  // The Board card repeats the figure just left of its tool call count.
  await page.goto(`/p/${project.key}`);
  const card = page.getByRole('article', { name: task.key });
  const context = card.getByTestId('task-context');
  const tools = card.getByTestId('task-tool-calls');
  await expect(context).toContainText('120.3K (60%)');
  await expect(tools).toBeVisible();
  const [contextBox, toolsBox] = await Promise.all([context.boundingBox(), tools.boundingBox()]);
  expect(contextBox!.x).toBeLessThan(toolsBox!.x);
});
