import { mkdir, mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { importSkills } from '../src/modules/extensions/import-skills';
import { skillArchive } from '../src/agents/skill-files';
import { skillToken } from '@claude-task/shared';

describe('skills CLI integration', () => {
  it('imports a real skill including supporting files and executable mode with the pinned CLI', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ct-skill-source-'));
    try {
      await mkdir(path.join(dir, 'review', 'scripts'), { recursive: true });
      await writeFile(
        path.join(dir, 'review', 'SKILL.md'),
        '---\nname: review\ndescription: Review changes\nuser-invocable: false\n---\nRead scripts/check.sh\n',
      );
      const script = path.join(dir, 'review', 'scripts', 'check.sh');
      await writeFile(script, '#!/bin/sh\necho checked\n');
      await chmod(script, 0o755);
      const result = await importSkills(dir, ['review']);
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ name: 'review', description: 'Review changes', userInvocable: false });
      const file = result[0]!.files.find((f) => f.path === 'scripts/check.sh')!;
      expect(file.executable).toBe(true);
      expect(Buffer.from(file.content, 'base64').toString()).toContain('echo checked');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('rejects container paths escaping their skill directory', async () => {
    await expect(
      skillArchive(1, [{ name: 'review', files: [{ path: '../settings.json', content: '', executable: false }] }]),
    ).rejects.toThrow('Invalid skill file path');
    await expect(skillArchive(1, [{ name: '$(id)', files: [] }])).rejects.toThrow('Invalid or duplicate skill name');
  });
  it('recognizes slash tokens at the caret without completing URLs or file paths', () => {
    expect(skillToken('/re', 3)).toEqual({ start: 0, query: 're' });
    expect(skillToken('Please /rev later', 11)).toEqual({ start: 7, query: 'rev' });
    expect(skillToken('https://example.com', 8)).toBeNull();
    expect(skillToken('src/re', 6)).toBeNull();
  });
});
