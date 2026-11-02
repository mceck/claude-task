import { SHARED_PROFILE_DIRS, agentProfilePath } from '@claude-task/shared';
import type { InstalledSkill } from '@claude-task/shared';
import { pack } from 'tar-stream';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The archive and script that bring one Agent Profile up to date: extracted in the Worker
 * Volume's home, then the script links the shared session data and publishes the Skills.
 */
export async function profileArchive(agentId: string, revision: number, skills: InstalledSkill[]): Promise<{ archive: Buffer; script: string }> {
  if (!UUID.test(agentId)) throw new Error('Invalid agent id');
  if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('Invalid skills revision');
  const profile = agentProfilePath(agentId);
  const root = `${profile}/.claude-task/skills/${revision}`;
  const tar = pack();
  const chunks: Buffer[] = [];
  const done = new Promise<void>((resolve, reject) => {
    tar.on('end', resolve);
    tar.on('error', reject);
  });
  tar.on('data', (chunk) => {
    chunks.push(Buffer.from(chunk as Uint8Array));
  });
  const directories = new Set<string>();
  const directory = (name: string) => {
    const parts = name.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const parent = parts.slice(0, i).join('/');
      if (!directories.has(parent)) {
        directories.add(parent);
        tar.entry({ name: parent, type: 'directory', uid: 1000, gid: 1000, mode: 0o755 });
      }
    }
  };
  directory(root);
  const names = new Set<string>();
  for (const skill of skills) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(skill.name) || names.has(skill.name)) throw new Error('Invalid or duplicate skill name');
    names.add(skill.name);
    for (const file of skill.files) {
      if (!file.path || file.path.split('/').some((s) => !s || s === '.' || s === '..') || /[\\\x00-\x1f]/.test(file.path))
        throw new Error('Invalid skill file path');
      directory(`${root}/${skill.name}/${file.path}`.split('/').slice(0, -1).join('/'));
      tar.entry(
        { name: `${root}/${skill.name}/${file.path}`, uid: 1000, gid: 1000, mode: file.executable ? 0o755 : 0o644 },
        Buffer.from(file.content, 'base64'),
      );
    }
  }
  // All interpolated shell literals contain only validated slugs, a uuid or an integer.
  const script = `set -eu
cd /home/agent
mkdir -p ${profile}/skills
# Every Agent Profile shares the Session transcripts and session data, so any Agent resumes any Session.
${SHARED_PROFILE_DIRS.map((dir) => `mkdir -p .claude-shared/${dir}
if [ -d ${profile}/${dir} ] && [ ! -L ${profile}/${dir} ]; then cp -a ${profile}/${dir}/. .claude-shared/${dir}/ && rm -rf ${profile}/${dir}; fi
ln -sfn /home/agent/.claude-shared/${dir} ${profile}/${dir}`).join('\n')}
store=/home/agent/${profile}/.claude-task/skills
${[...names]
  .map(
    (name) => `if [ -e ${profile}/skills/${name} ] || [ -L ${profile}/skills/${name} ]; then
  case "$(readlink ${profile}/skills/${name} || true)" in "$store/"*) ;; *) echo 'Skill name conflicts with an unmanaged skill: ${name}' >&2; exit 1;; esac
fi`,
  )
  .join('\n')}
${[...names].map((name) => `ln -sfn "$store/${revision}/${name}" ${profile}/skills/${name}`).join('\n')}
for entry in ${profile}/skills/*; do
  [ -L "$entry" ] || continue
  case "$(readlink "$entry")" in
    "$store/${revision}/"*) ;;
    "$store/"*) rm "$entry" ;;
  esac
done
for snapshot in "$store"/*; do
  [ -d "$snapshot" ] || continue
  [ "$snapshot" = "$store/${revision}" ] || rm -rf "$snapshot"
done
`;
  tar.finalize();
  await done;
  return { archive: Buffer.concat(chunks), script };
}
