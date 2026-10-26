// Agent Dockerfile rules, checked on save (backend) and while editing (frontend).
import { AGENT_SERVICES } from './agents';
import type { AgentService } from './agents';

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

/** Pins the first FROM and optionally installs services before the custom instructions. */
export function pinAgentBase(dockerfile: string, tag: string, services?: AgentService[]): string {
  const lines = dockerfile.split(/\r?\n/);
  const start = lines.findIndex((line) => /^\s*FROM\s/i.test(line));
  if (start < 0) return dockerfile;
  let end = start;
  while (lines[end]!.trimEnd().endsWith('\\') && end < lines.length - 1) end++;
  let from = lines.slice(start, end + 1).join('\n').replace(/claude-task\/agent-base[^\s\\]*/, `${BASE_IMAGE}:${tag}`);
  if (services !== undefined) {
    const selected = AGENT_SERVICES.filter((service) => services.includes(service)).join(' ');
    from += `\nUSER root\nRUN /usr/local/bin/claude-task-install-services${selected ? ` ${selected}` : ''}\nENV CLAUDE_TASK_SERVICES="${selected}"\nUSER agent`;
  }
  lines.splice(start, end - start + 1, from);
  return lines.join('\n');
}
