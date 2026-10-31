import { PROJECTS_TOPIC } from '@claude-task/shared';
import type { RealtimeEvent, Topic } from '@claude-task/shared';
import { sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import type { RealtimeHub } from './hub';

/** Events that can change a Project's unread or running indicators. */
const BOARD_EVENTS = new Set<RealtimeEvent['type']>(['task.created', 'task.updated', 'task.moved', 'task.deleted']);
const TIMELINE_EVENTS = new Set<RealtimeEvent['type']>(['comment.created', 'comment.deleted', 'revision.created', 'agent_item.created']);

/**
 * Announces on the Projects topic which Projects may show new indicators, at most once per Project per
 * window. Clients refetch the Projects list, where unread counts are computed for each User.
 */
export class ProjectActivity {
  private readonly projects = new Set<string>();
  private readonly tasks = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private last = 0;
  private stopped = false;

  constructor(private readonly hub: RealtimeHub, private readonly db: Db, private readonly onError: (err: unknown) => void, private readonly windowMs = 1000) {
    hub.watch((topic, event) => this.observe(topic, event));
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private observe(topic: Topic, event: RealtimeEvent): void {
    if (topic.startsWith('project:') && BOARD_EVENTS.has(event.type)) this.projects.add(topic.slice('project:'.length));
    else if (topic.startsWith('task:') && TIMELINE_EVENTS.has(event.type)) this.tasks.add(topic.slice('task:'.length));
    else return;
    this.schedule();
  }

  /** Flushes once the window since the last flush has passed. */
  private schedule(): void {
    if (this.stopped || this.timer) return;
    this.timer = setTimeout(() => void this.flush(), Math.max(0, this.last + this.windowMs - Date.now()));
    this.timer.unref?.();
  }

  private async flush(): Promise<void> {
    this.last = Date.now();
    const projects = [...this.projects];
    const tasks = [...this.tasks];
    this.projects.clear();
    this.tasks.clear();
    try {
      const ids = sql.join([...projects, ...tasks].map((id) => sql`${id}::uuid`), sql`, `);
      const rows = await this.db.execute<{ id: string }>(sql`select distinct p.id from projects p
        where p.kind = 'project' and (p.id in (${ids}) or p.id in (select t.project_id from tasks t where t.id in (${ids})))`);
      for (const { id } of rows.rows) this.hub.publish(PROJECTS_TOPIC, { type: 'project.activity', projectId: id });
    } catch (err) {
      this.onError(err);
    } finally {
      this.timer = null;
      if (this.projects.size || this.tasks.size) this.schedule();
    }
  }
}
