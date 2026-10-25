// Agent Dockerfile rules, checked on save (backend) and while editing (frontend).

export const BASE_IMAGE = 'claude-task/agent-base';

export const DEFAULT_AGENT_DOCKERFILE = `FROM ${BASE_IMAGE}

# Install the toolchains your projects need, e.g.:
# USER root
# RUN apt-get update && apt-get install -y --no-install-recommends nodejs npm && rm -rf /var/lib/apt/lists/*

USER agent
`;

const FROM = /^FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+\S+)?\s*$/i;
const BASE_REF = new RegExp(`^${BASE_IMAGE.replace('/', '\\/')}(?::[\\w][\\w.-]{0,127})?(?:@sha256:[0-9a-f]{64})?$`);

/** Logical lines: comments and blank lines dropped, backslash continuations joined. */
function instructions(dockerfile: string): string[] {
  const out: string[] = [];
  let pending = '';
  for (const raw of dockerfile.split(/\r?\n/)) {
    const line = raw.trim();
    if (pending === '' && (line === '' || line.startsWith('#'))) continue;
    if (line.endsWith('\\')) {
      pending += `${line.slice(0, -1)} `;
      continue;
    }
    out.push((pending + line).trim());
    pending = '';
  }
  if (pending.trim()) out.push(pending.trim());
  return out;
}

/** The base image reference to rewrite, or an error message. */
export function checkAgentDockerfile(dockerfile: string): { ok: true; fromIndex: number } | { ok: false; error: string } {
  const lines = instructions(dockerfile);
  const fromIndex = lines.findIndex((l) => /^FROM\s/i.test(l));
  if (fromIndex < 0) return { ok: false, error: `The Dockerfile must start FROM ${BASE_IMAGE}` };
  // Only ARG may precede the first FROM.
  if (lines.slice(0, fromIndex).some((l) => !/^ARG\s/i.test(l))) {
    return { ok: false, error: 'Only ARG instructions may come before the first FROM' };
  }
  const m = FROM.exec(lines[fromIndex]!);
  if (!m || !BASE_REF.test(m[1]!)) return { ok: false, error: `The first FROM must be ${BASE_IMAGE} (any tag)` };
  return { ok: true, fromIndex };
}

/** Points the first FROM at the given base image tag, keeping everything else as written. */
export function pinAgentBase(dockerfile: string, tag: string): string {
  let done = false;
  return dockerfile
    .split(/\r?\n/)
    .map((line) => {
      if (done || !/^\s*FROM\s/i.test(line)) return line;
      done = true;
      return line.replace(/claude-task\/agent-base\S*/, `${BASE_IMAGE}:${tag}`);
    })
    .join('\n');
}
