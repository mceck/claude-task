import { Readable } from 'node:stream';
import { ClickUpError } from '../../src/clickup/client';
import type { ClickUpAttachment, ClickUpClient, ClickUpClientFactory, ClickUpSource, ClickUpStatus, ClickUpTask } from '../../src/clickup/client';

export const CU_STATUSES: ClickUpStatus[] = [
  { id: 's1', name: 'to do', color: '#d3d3d3', type: 'open', orderindex: 0 },
  { id: 's2', name: 'in progress', color: '#4194f6', type: 'custom', orderindex: 1 },
  { id: 's3', name: 'in review', color: '#a875ff', type: 'custom', orderindex: 2 },
  { id: 's4', name: 'complete', color: '#6bc950', type: 'custom', orderindex: 3 },
  { id: 's5', name: 'closed', color: '#808080', type: 'closed', orderindex: 4 },
];

/** An in-memory ClickUp: one List with Statuses, Tasks and attachment bytes. */
export class FakeClickUp {
  statuses: ClickUpStatus[] = CU_STATUSES.map((s) => ({ ...s }));
  tasks: ClickUpTask[] = [];
  files = new Map<string, string>();
  statusPushes: { taskId: string; status: string }[] = [];
  failSetStatus = false;
  failFetch: string | null = null;
  tokens: string[] = [];
  lastSource: ClickUpSource | null = null;

  task(id: string, status: string, extra: Partial<ClickUpTask> = {}): ClickUpTask {
    const s = this.statuses.find((x) => x.name === status)!;
    const t: ClickUpTask = { id, name: `Task ${id}`, description: `About ${id}`, status: s, url: `https://app.clickup.com/t/${id}`, listId: 'L1', attachments: [], ...extra };
    this.tasks.push(t);
    return t;
  }

  attachment(id: string, title: string, content: string): ClickUpAttachment {
    this.files.set(id, content);
    return { id, title, url: `https://files.test/${id}`, size: content.length, contentType: 'text/plain' };
  }

  factory: ClickUpClientFactory = (token) => {
    this.tokens.push(token);
    const self = this;
    const client: ClickUpClient = {
      async teams() { return [{ id: 'T1', name: 'Workspace' }]; },
      async spaces() { return [{ id: 'SP1', name: 'Space' }]; },
      async lists() { return [{ id: 'L1', name: 'Sprint' }]; },
      async views() { return [{ id: 'V1', name: 'My view' }]; },
      async listStatuses() { return self.statuses; },
      async tasks(source) {
        self.lastSource = source;
        if (self.failFetch) throw new ClickUpError(self.failFetch, 401);
        return self.tasks;
      },
      async setStatus(taskId, status) {
        if (self.failSetStatus) throw new ClickUpError('ClickUp answered 500', 500);
        self.statusPushes.push({ taskId, status });
        const task = self.tasks.find((t) => t.id === taskId);
        const s = self.statuses.find((x) => x.name === status);
        if (task && s) task.status = s;
      },
      async download(att) { return { stream: Readable.from([Buffer.from(self.files.get(att.id) ?? '')]), contentType: 'text/plain' }; },
    };
    return client;
  };
}
