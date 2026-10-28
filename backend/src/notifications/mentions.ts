import { isUserMentionPath } from '@claude-task/shared';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { sql } from 'drizzle-orm';
import type { Executor } from '../db/client';

type MarkdownNode = ReturnType<typeof fromMarkdown> | ReturnType<typeof fromMarkdown>['children'][number];

/** Parse Markdown so code, images, escaped links and ordinary @ text remain inert. */
export async function notifyMentions(db: Executor, taskId: string, commentId: string, body: string, authorId: string): Promise<void> {
  const ids = new Set<string>();
  function visit(node: MarkdownNode): void {
    if (node.type === 'link' && isUserMentionPath(node.url) && node.children[0]?.type === 'text' && node.children[0].value.startsWith('@')) {
      ids.add(node.url.slice('/users/'.length).toLowerCase());
    }
    if ('children' in node) node.children.forEach(visit);
  }
  visit(fromMarkdown(body));
  ids.delete(authorId.toLowerCase());
  if (!ids.size) return;
  const eventId = `mention:${commentId}`;
  await db.execute(sql`insert into notification_events(id, task_id, kind)
    values (${eventId}, ${taskId}::uuid, 'comment.mentioned') on conflict do nothing`);
  await db.execute(sql`insert into push_deliveries(event_id, user_id, device_id, token_hash)
    select ${eventId}, u.id, d.id, d.token_hash
    from users u join push_devices d on d.user_id = u.id join logins l on l.id = d.login_id
    left join task_preferences p on p.task_id = ${taskId}::uuid and p.user_id = u.id
    where u.id in (${sql.join([...ids].map(id => sql`${id}::uuid`), sql`, `)})
      and u.active and not u.must_change_password and l.expires_at > now() and not coalesce(p.muted, false)
    on conflict do nothing`);
}
