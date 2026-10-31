import { userTopic } from '@claude-task/shared';
import type { TaskPreference } from '@claude-task/shared';
import { sql } from 'drizzle-orm';
import type { Executor } from '../db/client';
import type { AfterCommit } from '../context';
import { badRequest } from '../errors';

/**
 * The newest Timeline entry that can be unread for a User: their own Revisions never are, since
 * moving or editing a Task from the Board happens with its conversation closed and nothing was missed.
 */
export const latestUnreadPosition = (userId: string) => sql`(select max(x.position) from task_activity x
  where x.task_id = t.id and not exists (select 1 from task_revisions r
    where r.id = x.item_id and r.actor_type = 'user' and r.actor_id = ${userId}::uuid))`;

export async function preferences(db: Executor, userId: string, filter: { taskId?: string; projectId?: string }): Promise<TaskPreference[]> {
  const result = await db.execute<{
    taskId: string; following: boolean; muted: boolean; readPosition: string; latestPosition: string; unread: boolean;
    unreadComments: number;
  }>(sql`select t.id as "taskId", coalesce(p.following, false) as following,
    coalesce(p.muted, false) as muted, coalesce(p.read_position, 0)::text as "readPosition",
    coalesce(a.latest, 0)::text as "latestPosition",
    -- A Task in a closed Status has no unread state: closing it settles the conversation.
    (s.category <> 'closed' and coalesce(a.latest, 0) > coalesce(p.read_position, 0)) as unread,
    (case when s.category = 'closed' then 0 else
      (select count(*)::int from task_activity u join comments c on c.id = u.item_id
        where u.task_id = t.id and c.task_id = t.id
          and u.position > coalesce(p.read_position, 0) and c.deleted_at is null) end) as "unreadComments"
    from tasks t join statuses s on s.id = t.status_id
    left join task_preferences p on p.task_id = t.id and p.user_id = ${userId}::uuid
    left join lateral (select ${latestUnreadPosition(userId)} as latest) a on true
    where ${filter.taskId ? sql`t.id = ${filter.taskId}::uuid` : sql`t.project_id = ${filter.projectId}::uuid`}`);
  return result.rows;
}

export async function emitPreference(db: Executor, after: AfterCommit, userId: string, taskId: string): Promise<TaskPreference> {
  const [preference] = await preferences(db, userId, { taskId });
  after.emit(userTopic(userId), { type: 'task.preference', preference: preference! });
  return preference!;
}

/** Explicit unfollow and mute persist. Automatic following never overwrites either. */
export async function autoFollow(db: Executor, after: AfterCommit, taskId: string, userIds: string[]): Promise<void> {
  const targets = await preferenceTargets(db, taskId);
  for (const userId of [...new Set(userIds)].sort()) {
    for (const id of targets) {
      const changed = await db.execute(sql`insert into task_preferences(user_id, task_id, following)
        values (${userId}::uuid, ${id}::uuid, true)
        on conflict(user_id, task_id) do update set following = true
        where not task_preferences.explicit_follow and not task_preferences.following returning user_id`);
      if (changed.rows.length) await emitPreference(db, after, userId, id);
    }
  }
}

/** Following a Wiki's Chat is following the Wiki, so every Task of its Wiki Project is a target. */
async function preferenceTargets(db: Executor, taskId: string): Promise<string[]> {
  const targets = await db.execute<{ id: string }>(sql`select t.id from tasks t
    where t.id = ${taskId}::uuid or t.project_id = (select p.id from tasks s join projects p on p.id = s.project_id
      where s.id = ${taskId}::uuid and p.kind = 'wiki')
    order by t.id`);
  return targets.rows.map((r) => r.id);
}

/** Following and muting a Wiki's Chat applies to the whole Wiki, so every Task of its Wiki Project changes. */
export async function setPreference(db: Executor, after: AfterCommit, userId: string, taskId: string, patch: { following?: boolean; muted?: boolean }): Promise<TaskPreference> {
  for (const id of await preferenceTargets(db, taskId)) {
    await db.execute(sql`insert into task_preferences(user_id, task_id, following, muted, explicit_follow)
      values (${userId}::uuid, ${id}::uuid, ${patch.following ?? false}, ${patch.muted ?? false}, ${patch.following !== undefined})
      on conflict(user_id, task_id) do update set
        following = ${patch.following !== undefined ? sql`${patch.following}` : sql`task_preferences.following`},
        muted = ${patch.muted !== undefined ? sql`${patch.muted}` : sql`task_preferences.muted`},
        explicit_follow = task_preferences.explicit_follow or ${patch.following !== undefined}`);
    if (id !== taskId) await emitPreference(db, after, userId, id);
  }
  return emitPreference(db, after, userId, taskId);
}

export async function advanceRead(db: Executor, after: AfterCommit, userId: string, taskId: string, itemId: string): Promise<TaskPreference> {
  const entry = await db.execute<{ position: string }>(sql`select position::text from task_activity where task_id = ${taskId}::uuid and item_id = ${itemId}::uuid`);
  if (!entry.rows[0]) throw badRequest('The read position must identify a persisted entry in this Task');
  await db.execute(sql`insert into task_preferences(user_id, task_id, following, read_position)
    values (${userId}::uuid, ${taskId}::uuid, false, ${entry.rows[0].position}::bigint)
    on conflict(user_id, task_id) do update set read_position = greatest(task_preferences.read_position, excluded.read_position)`);
  return emitPreference(db, after, userId, taskId);
}
