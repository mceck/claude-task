import { eq } from 'drizzle-orm';
import type { AppContext } from '../context';
import { transact } from '../context';
import { projects, tasks } from '../db/schema';
import { getProject } from '../modules/projects/service';
import { getTaskRow } from '../modules/tasks/service';
import { rotateExpiringTokens } from './connections';
import { recordPullRequest, recheckProtection } from './service';

/** Polling is independent of Task Status and never changes Sessions. */
export class GitSync {
  private timer: NodeJS.Timeout | null = null;
  private readonly pending = new Map<string, Promise<void>>();
  constructor(private readonly ctx: AppContext) {}
  start() {
    this.timer = setInterval(() => void this.tick(), 5 * 60000);
    this.timer.unref();
    void this.tick();
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
  async settle() {
    await Promise.allSettled([...this.pending.values()]);
  }
  private once(key: string, work: () => Promise<void>): Promise<void> {
    const existing = this.pending.get(key);
    if (existing) return existing;
    const promise = work()
      .catch((err) => this.ctx.log.warn({ message: err instanceof Error ? err.message : 'Git sync failed' }, 'Git sync failed'))
      .finally(() => this.pending.delete(key));
    this.pending.set(key, promise);
    return promise;
  }
  refreshTask(taskId: string, maxAgeMs = 60000): Promise<void> {
    return this.once(`task:${taskId}`, async () => {
      const task = await getTaskRow(this.ctx.db, taskId);
      const p = await getProject(this.ctx.db, task.projectId);
      if (!p.repository || !task.pullRequest || Date.parse(task.pullRequest.checkedAt) > Date.now() - maxAgeMs) return;
      const git = await this.ctx.git.provider(p.repository.connectionId);
      const pr = { ...(await git.getPullRequest(p.repository, task.pullRequest.number)), checkedAt: new Date().toISOString() };
      await transact(this.ctx, async (tx, after) => {
        await tx.select({ id: projects.id }).from(projects).where(eq(projects.id, p.id)).for('share');
        const current = await getTaskRow(tx, taskId, { lock: true });
        const project = await getProject(tx, p.id);
        if (
          project.repository?.connectionId !== p.repository?.connectionId ||
          project.repository?.providerRepoId !== p.repository?.providerRepoId ||
          current.pullRequest?.number !== pr.number
        )
          return;
        // A newer check/open operation wins over a stale in-flight polling response.
        if (current.pullRequest.checkedAt !== task.pullRequest!.checkedAt) return;
        await recordPullRequest(tx, after, current, pr, { type: 'system', id: null, displayName: 'System' });
      });
    });
  }
  tick(): Promise<void> {
    return this.once('tick', async () => {
      await this.once('rotation', () => rotateExpiringTokens(this.ctx));
      const taskRows = await this.ctx.db.select({ id: tasks.id, pr: tasks.pullRequest }).from(tasks);
      for (const t of taskRows) if (t.pr?.state === 'open') await this.refreshTask(t.id, 0);
      const rows = await this.ctx.db.select({ id: projects.id, repository: projects.repository }).from(projects);
      for (const p of rows)
        if (p.repository && Date.parse(p.repository.protection.checkedAt) < Date.now() - 24 * 3600000)
          await this.once(`protection:${p.id}`, () => recheckProtection(this.ctx, p.id));
    });
  }
}
