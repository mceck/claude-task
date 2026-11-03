// The Skills of a Task's Session and who activated them: the User with a slash command, the
// Agent with Claude Code's Skill tool (docs/specs/agents.md).
import { commandName } from '@claude-task/shared';
import type { SessionSkill, SkillUsedBy } from '@claude-task/shared';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { AppContext } from '../context';
import { comments } from '../db/schema';
import { loadTaskSession } from './view';

/** The Agent's Skill tool calls across the Session's Jobs, wherever they happen (subagents included). */
async function agentSkills(ctx: AppContext, sessionId: string): Promise<string[]> {
  const result = await ctx.db.execute<{ name: string }>(sql`
    select distinct coalesce(item.value->'input'->>'skill', item.value->'input'->>'command') as name
    from session_events se
    join jobs j on j.id = se.job_id
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(se.payload->'message'->'content') = 'array' then se.payload->'message'->'content' else '[]'::jsonb end
    ) item(value)
    where j.session_id = ${sessionId}
      and se.payload->>'type' = 'assistant'
      and item.value->>'type' = 'tool_use'
      and item.value->>'name' = 'Skill'`);
  return result.rows.map((row) => row.name).filter((name): name is string => typeof name === 'string' && name !== '');
}

/** The Skills the User invoked with a slash command in a Comment. */
async function userSkills(ctx: AppContext, taskId: string): Promise<Set<string>> {
  const rows = await ctx.db
    .select({ body: comments.body })
    .from(comments)
    .where(and(eq(comments.taskId, taskId), eq(comments.kind, 'user'), eq(comments.internal, false), isNull(comments.deletedAt)));
  const names = new Set<string>();
  for (const { body } of rows) {
    const name = commandName(body);
    if (name) names.add(name);
  }
  return names;
}

/**
 * Every Skill the Session offers — the Agent's Skills and the Worktree's own — with who used it.
 * A Skill the Agent activated but the catalog doesn't list (a bundled or plugin Skill) is included
 * too, so activation is never hidden. Used Skills come first, then alphabetical.
 */
export async function taskSessionSkills(ctx: AppContext, taskId: string): Promise<SessionSkill[]> {
  const session = await loadTaskSession(ctx.db, taskId);
  if (!session) return [];
  const commands = session.commands ?? [];
  const catalog = new Map<string, { name: string; description: string }>();
  for (const command of commands) {
    if (command.kind === 'skill') catalog.set(command.name, { name: command.name, description: command.description });
  }

  const [agentUsed, userUsed] = await Promise.all([agentSkills(ctx, session.id), userSkills(ctx, taskId)]);
  const agent = new Set(agentUsed);
  for (const name of agent) {
    if (catalog.has(name)) continue;
    const known = commands.find((command) => command.name === name);
    catalog.set(name, { name, description: known?.description ?? '' });
  }

  const skills = [...catalog.values()].map(({ name, description }) => {
    const usedBy: SkillUsedBy[] = [];
    if (userUsed.has(name)) usedBy.push('user');
    if (agent.has(name)) usedBy.push('agent');
    return { name, description, usedBy };
  });
  const rank = (skill: SessionSkill) => (skill.usedBy.length > 0 ? 0 : 1);
  return skills.sort((a, b) => rank(a) - rank(b) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
