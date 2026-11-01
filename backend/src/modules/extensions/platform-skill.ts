// The platform's own Skill: the `claude-task` playbook, seeded into the catalog at startup so its
// files follow the platform version instead of an import somebody remembered to run
// (docs/specs/agents.md#skills).
import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SkillFile } from '@claude-task/shared';
import { and, eq, sql } from 'drizzle-orm';
import type { AppContext } from '../../context';
import type { Executor } from '../../db/client';
import { skills } from '../../db/schema';
import { parse as parseYaml } from 'yaml';

export const PLATFORM_SKILL_NAME = 'claude-task';
const PLATFORM_SOURCE = 'platform';

/** The skill files live next to the backend sources in dev and next to the bundle in production. */
function skillDirectory(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const dev = here.endsWith(path.join('src', 'modules', 'extensions'));
  const root = dev ? path.resolve(here, '../../..') : path.resolve(here, '..');
  return path.join(root, 'skills', PLATFORM_SKILL_NAME);
}

interface PlatformSkill {
  description: string;
  userInvocable: boolean;
  files: SkillFile[];
  contentHash: string;
}

async function readPlatformSkill(): Promise<PlatformSkill> {
  const files: SkillFile[] = [];
  const walk = async (dir: string, rel: string): Promise<void> => {
    for (const name of (await readdir(dir)).sort()) {
      const full = path.join(dir, name);
      const stat = await lstat(full);
      if (stat.isSymbolicLink()) throw new Error(`The platform skill contains a symbolic link: ${child(rel, name)}`);
      if (stat.isDirectory()) await walk(full, child(rel, name));
      else if (stat.isFile())
        files.push({ path: child(rel, name), content: (await readFile(full)).toString('base64'), executable: !!(stat.mode & 0o111) });
      else throw new Error(`Unsupported file in the platform skill: ${child(rel, name)}`);
    }
  };
  await walk(skillDirectory(), '');
  const main = files.find((file) => file.path === 'SKILL.md');
  if (!main) throw new Error('The platform skill has no SKILL.md');
  const markdown = Buffer.from(main.content, 'base64').toString('utf8');
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown);
  let meta: Record<string, unknown> | null = null;
  try {
    meta = parseYaml(frontmatter?.[1] ?? '') as Record<string, unknown> | null;
  } catch {
    throw new Error('The platform skill has invalid frontmatter');
  }
  if (!meta || typeof meta.description !== 'string' || !meta.description.trim()) throw new Error('The platform skill has no description');
  return {
    description: meta.description.slice(0, 2000),
    userInvocable: meta['user-invocable'] !== false,
    files,
    contentHash: createHash('sha256').update(JSON.stringify(files)).digest('hex'),
  };
}

const child = (rel: string, name: string) => (rel ? `${rel}/${name}` : name);

/**
 * Inserts or updates the platform skill and keeps it assigned to every Agent the first time it
 * appears. An Agent that had it unassigned stays without it; a content change only bumps the
 * extensions revision of the Agents that have it, so their containers synchronize again.
 */
export async function seedPlatformSkill(ctx: AppContext): Promise<void> {
  let loaded: PlatformSkill;
  try {
    loaded = await readPlatformSkill();
  } catch (err) {
    ctx.log.error({ err }, 'could not read the platform skill');
    return;
  }
  const [existing] = await ctx.db.select().from(skills).where(eq(skills.name, PLATFORM_SKILL_NAME));
  if (existing && existing.source !== PLATFORM_SOURCE) {
    ctx.log.warn({ skillId: existing.id, source: existing.source }, 'a catalog skill already uses the platform skill name; leaving it alone');
    return;
  }
  if (!existing) {
    await ctx.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(skills)
        .values({ name: PLATFORM_SKILL_NAME, source: PLATFORM_SOURCE, ...loaded })
        .returning({ id: skills.id });
      await tx.execute(
        sql`insert into agent_skills (agent_id, skill_id) select a.id, ${row!.id}::uuid from agents a on conflict do nothing`,
      );
      await tx.execute(
        sql`update agents set extensions_revision = extensions_revision + 1 where id in (select agent_id from agent_skills where skill_id = ${row!.id}::uuid)`,
      );
    });
    ctx.log.info('seeded the platform skill and assigned it to every agent');
    return;
  }
  if (existing.contentHash === loaded.contentHash) return;
  await ctx.db.transaction(async (tx) => {
    await tx
      .update(skills)
      .set({ ...loaded, updatedAt: new Date() })
      .where(eq(skills.id, existing.id));
    await tx.execute(
      sql`update agents set extensions_revision = extensions_revision + 1 where id in (select agent_id from agent_skills where skill_id = ${existing.id}::uuid)`,
    );
  });
  ctx.log.info({ skillId: existing.id }, 'updated the platform skill');
}

/** A new Agent gets the platform skill unless the catalog does not carry it. */
export async function withDefaultSkills(db: Executor, skillIds: string[]): Promise<string[]> {
  const [row] = await db
    .select({ id: skills.id })
    .from(skills)
    .where(and(eq(skills.name, PLATFORM_SKILL_NAME), eq(skills.source, PLATFORM_SOURCE)));
  if (!row || skillIds.includes(row.id)) return skillIds;
  return [...skillIds, row.id];
}
