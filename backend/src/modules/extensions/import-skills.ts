import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { parse as parseYaml } from 'yaml';
import type { SkillFile } from '@claude-task/shared';
import { badRequest } from '../../errors';

const run = promisify(execFile);
const require = createRequire(import.meta.url);
export const SKILL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;
export interface ImportedSkill {
  name: string;
  description: string;
  userInvocable: boolean;
  files: SkillFile[];
  contentHash: string;
}

/** Invoke the pinned CLI in a disposable project, never in the backend's or user's home. */
export async function importSkills(source: string, selected: string[]): Promise<ImportedSkill[]> {
  const dir = await mkdtemp(path.join(tmpdir(), 'claude-task-skills-'));
  try {
    try {
      await run(
        process.execPath,
        [require.resolve('skills/bin/cli.mjs'), 'add', source, '--skill', ...selected, '--agent', 'claude-code', '--copy', '--yes'],
        {
          cwd: dir,
          timeout: 120_000,
          maxBuffer: 2 * 1024 * 1024,
          env: {
            ...process.env,
            XDG_STATE_HOME: path.join(dir, '.state'),
            DISABLE_TELEMETRY: '1',
            DO_NOT_TRACK: '1',
            GIT_TERMINAL_PROMPT: '0',
            CI: '1',
          },
        },
      );
    } catch {
      throw badRequest('Skill import failed. Check the source, selected skill names and Git access.');
    }
    const root = path.join(dir, '.claude', 'skills');
    const names = await readdir(root).catch(() => [] as string[]);
    const imported: ImportedSkill[] = [];
    let bytes = 0,
      count = 0;
    for (const name of names.sort()) {
      if (!SKILL_NAME.test(name)) throw badRequest(`Unsupported skill directory name: ${name}`);
      const files: SkillFile[] = [];
      const walk = async (rel: string): Promise<void> => {
        const full = path.join(root, name, rel);
        const stat = await lstat(full);
        if (stat.isSymbolicLink()) throw badRequest('Skill files must not contain symbolic links');
        if (stat.isDirectory()) {
          for (const child of (await readdir(full)).sort()) await walk(path.posix.join(rel, child));
        } else if (stat.isFile()) {
          bytes += stat.size;
          count++;
          if (bytes > 10 * 1024 * 1024 || count > 1000) throw badRequest('Skills import exceeds 10 MB or 1000 files');
          files.push({ path: rel, content: (await readFile(full)).toString('base64'), executable: !!(stat.mode & 0o111) });
        } else throw badRequest('Unsupported skill file');
      };
      await walk('');
      const main = files.find((f) => f.path === 'SKILL.md');
      if (!main) throw badRequest(`Missing SKILL.md in ${name}`);
      const markdown = Buffer.from(main.content, 'base64').toString('utf8');
      const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown);
      let meta: Record<string, unknown>;
      try {
        meta = parseYaml(frontmatter?.[1] ?? '') as Record<string, unknown>;
      } catch {
        throw badRequest(`Invalid SKILL.md frontmatter in ${name}`);
      }
      if (!meta || typeof meta.description !== 'string' || !meta.description.trim())
        throw badRequest(`Missing skill description in ${name}`);
      imported.push({
        name,
        description: meta.description.slice(0, 2000),
        userInvocable: meta['user-invocable'] !== false,
        files,
        contentHash: createHash('sha256').update(JSON.stringify(files)).digest('hex'),
      });
    }
    if (!imported.length) throw badRequest('No skills found for the selected source and names');
    return imported;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
