import type { ProjectSkillFile, SkillCommand } from '@claude-task/shared';
import { and, desc, eq, isNotNull } from 'drizzle-orm';
import { parse as parseYaml } from 'yaml';
import type { AppContext } from '../context';
import { jobs, sessions, tasks } from '../db/schema';
import { SKILL_NAME } from '../modules/extensions/import-skills';

/** At most this many project skills are kept per Job. */
const MAX_SKILLS = 200;
const MAX_DESCRIPTION = 2000;

/**
 * The user-invocable skills and commands among the Worktree's files, as Claude Code reads them:
 * the frontmatter `description`, else the first paragraph. The first file of a name wins.
 */
export function projectSkills(files: unknown): SkillCommand[] {
  const result = new Map<string, SkillCommand>();
  for (const file of Array.isArray(files) ? (files as Partial<ProjectSkillFile>[]) : []) {
    if (result.size >= MAX_SKILLS) break;
    if (typeof file?.name !== 'string' || typeof file.head !== 'string' || !SKILL_NAME.test(file.name) || result.has(file.name)) continue;
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(file.head);
    let meta: unknown = null;
    try {
      meta = frontmatter ? parseYaml(frontmatter[1]!) : null;
    } catch {
      continue;
    }
    const fields = meta && typeof meta === 'object' ? (meta as Record<string, unknown>) : {};
    if (fields['user-invocable'] === false) continue;
    const body = frontmatter ? file.head.slice(frontmatter[0].length) : file.head;
    const paragraph = body.trim().split(/\r?\n\s*\r?\n/)[0] ?? '';
    const description =
      typeof fields.description === 'string' && fields.description.trim()
        ? fields.description.trim()
        : paragraph.replace(/^#+\s*/, '').replace(/\s+/g, ' ').trim();
    result.set(file.name, { name: file.name, description: description.slice(0, MAX_DESCRIPTION) || 'Run this project skill.' });
  }
  return [...result.values()];
}

/**
 * Asks the Session's Runner for its Worktree's Project Skills when no Job has reported them yet,
 * so a Worktree that already exists fills the composer before the Session's next Job. The answer
 * is stored and published, never awaited: the page showing the Session is already listening.
 * A Runner that is offline, or too old to know the request, leaves the Session as it was.
 */
export async function refreshProjectSkills(ctx: AppContext, taskId: string): Promise<void> {
  const [row] = await ctx.db
    .select({ id: sessions.id, agentId: sessions.agentId, worktreePath: sessions.worktreePath, skills: sessions.projectSkills })
    .from(tasks)
    .innerJoin(sessions, eq(sessions.id, tasks.currentSessionId))
    .where(eq(tasks.id, taskId));
  if (!row || row.skills) return;
  // A Session without a Job has no Worktree yet; the first Job reports the real set.
  const [latest] = await ctx.db
    .select({ id: jobs.id })
    .from(jobs)
    .where(eq(jobs.sessionId, row.id))
    .orderBy(desc(jobs.createdAt), desc(jobs.id))
    .limit(1);
  if (!latest) return;
  const [reported] = await ctx.db
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.sessionId, row.id), isNotNull(jobs.projectSkills)))
    .limit(1);
  if (reported) return;
  void ctx.skillRequests.request(row.agentId, row.worktreePath).then(async (files) => {
    if (!files?.length) return;
    await ctx.db.update(sessions).set({ projectSkills: projectSkills(files) }).where(eq(sessions.id, row.id));
    ctx.scheduler.publishTask(taskId);
  }).catch((err: unknown) => ctx.log.warn({ err, taskId }, 'could not read the Project Skills'));
}
