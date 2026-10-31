import type { NotificationKind, PushAlert } from '@claude-task/shared';
import { sql } from 'drizzle-orm';
import type { Executor } from '../db/client';
import { chatTitle } from '../modules/wikis/service';
import { alertExcerpt } from './excerpt';

type AlertRow = {
  kind: NotificationKind;
  project_kind: string | null;
  task_key: string | null;
  task_title: string | null;
  wiki_name: string | null;
  chat_title: string | null;
  schedule_name: string | null;
  agent_name: string | null;
  author_name: string | null;
  body: string | null;
  files: number;
};

/** Records the Comment an event's Alert previews, once the Comment exists. */
export async function previewEvent(db: Executor, eventId: string, commentId: string): Promise<void> {
  await db.execute(sql`update notification_events set comment_id = ${commentId}::uuid where id = ${eventId}`);
}

/** The Alert of one Notification Event, from the current Task, Agent, author and Comment. */
export async function buildAlert(db: Executor, eventId: string): Promise<PushAlert | null> {
  const rows = await db.execute<AlertRow>(sql`select e.kind, p.kind as project_kind,
      p.key || '-' || t.number as task_key, t.title as task_title, p.name as wiki_name,
      case when p.kind = 'wiki' then ${chatTitle(sql`t`)} end as chat_title,
      s.name as schedule_name, a.name as agent_name, u.display_name as author_name,
      c.body, (select count(*)::int from attachments f where f.comment_id = c.id) as files
    from notification_events e
    left join tasks t on t.id = e.task_id
    left join projects p on p.id = t.project_id
    left join schedules s on s.id = e.schedule_id
    left join jobs j on e.kind in ('turn.completed', 'turn.failed', 'session.intervention') and j.id = split_part(e.id, ':', 2)::uuid
    left join agents a on a.id = j.agent_id
    left join comments c on c.id = e.comment_id and c.deleted_at is null
    left join users u on c.author_type = 'user' and u.id = c.author_id
    where e.id = ${eventId}`);
  const r = rows.rows[0];
  if (!r) return null;
  const title = r.project_kind === 'wiki'
    ? `${r.wiki_name} · ${r.chat_title}`
    : r.task_key ? `${r.task_key} · ${r.task_title}` : (r.schedule_name ?? 'Claude Task');
  const excerpt = r.body === null ? '' : alertExcerpt(r.body, r.files);
  const after = (lead: string) => (excerpt ? `${lead}: ${excerpt}` : lead);
  const agent = r.agent_name ?? 'The agent';
  switch (r.kind) {
    case 'turn.completed':
      return { title, sender: agent, senderKind: 'agent', text: excerpt || 'finished its turn.' };
    case 'turn.failed':
      return { title, sender: agent, senderKind: 'agent', text: after('turn failed') };
    case 'session.intervention':
      return { title, sender: agent, senderKind: 'agent', text: after('needs your attention') };
    case 'comment.mentioned':
      return { title, sender: r.author_name, senderKind: r.author_name ? 'user' : null, text: excerpt };
    case 'schedule.run_failed':
      return { title, sender: null, senderKind: null, text: `Schedule "${r.schedule_name}": run failed` };
    case 'schedule.blocked':
      return { title, sender: null, senderKind: null, text: `Schedule "${r.schedule_name}": keeps being skipped` };
  }
}
