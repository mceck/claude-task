import type { ProjectSkillFile, SkillCommand } from '@claude-task/shared';
import { parse as parseYaml } from 'yaml';
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
