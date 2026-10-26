// Opt-in: real Docker with a built Base Image (AGENT_BASE_IMAGE=claude-task/agent-base:latest).
// The Agent Container's entrypoint hands the Runner token to the Runner and to nothing else.
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const image = process.env.AGENT_BASE_IMAGE;
const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8' }).trim();

describe.skipIf(!image)('Agent Container entrypoint (real Docker)', () => {
  it('gives the Runner token only to the Runner, not to PID 1, services or docker execs', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ct-entrypoint-'));
    const entrypoint = path.join(dir, 'entrypoint.sh');
    copyFileSync(path.join(import.meta.dirname, '../agent-base/entrypoint.sh'), entrypoint);
    chmodSync(entrypoint, 0o755);
    const runner = path.join(dir, 'runner.sh');
    writeFileSync(runner, '#!/bin/bash\necho "$CLAUDE_TASK_RUNNER_TOKEN" > /tmp/runner-token\nexec sleep 300\n', { mode: 0o755 });
    const id = docker(
      'run', '-d', '-e', 'CLAUDE_TASK_RUNNER_TOKEN=s3cret-token', '-e', 'CLAUDE_TASK_SERVICES=',
      '-v', `${entrypoint}:/usr/local/bin/claude-task-entrypoint:ro`, '-v', `${runner}:/usr/local/bin/claude-task-runner:ro`, image!,
    );
    try {
      for (let i = 0; i < 50 && !docker('exec', id, 'bash', '-c', 'cat /tmp/runner-token 2>/dev/null || true'); i++) await new Promise((r) => setTimeout(r, 200));
      expect(docker('exec', id, 'cat', '/tmp/runner-token')).toBe('s3cret-token');
      // The blank override is what the backend's execs (skills, plugins) send too.
      const exposed = docker('exec', '-e', 'CLAUDE_TASK_RUNNER_TOKEN=', id, 'bash', '-c',
        'for p in /proc/[0-9]*; do grep -qa s3cret-token $p/environ 2>/dev/null && tr "\\0" " " < $p/cmdline && echo; done; true');
      expect(exposed.split('\n').map((l) => l.trim()).filter(Boolean)).toEqual(['sleep 300']);
      expect(docker('exec', id, 'cat', '/proc/1/cmdline')).toContain('claude-task-entrypoint');
    } finally {
      docker('rm', '-f', id);
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
