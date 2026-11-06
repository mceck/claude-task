// Opt-in: the Docker part of a Cleanup against a real daemon (DOCKER_CLEANUP_TEST=1, pulls busybox).
// It removes every outdated claude-task/agent-base tag of the host, as a real Cleanup would.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { BASE_IMAGE, DEFAULT_CLAUDE_CODE_VERSION } from '@claude-task/shared';
import { describe, expect, it } from 'vitest';
import { DockerRuntime } from '../src/agents/docker-runtime';
import type { AgentsConfig } from '../src/config';

const enabled = process.env.DOCKER_CLEANUP_TEST === '1';
const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8' }).trim();
const ok = (...args: string[]) => {
  try {
    docker(...args);
    return true;
  } catch {
    return false;
  }
};

describe.skipIf(!enabled)('Cleanup on a real Docker daemon', () => {
  it('removes old Base Image tags, unused Worker Images and the labelled leftovers of unknown Workers', async () => {
    const installation = randomUUID();
    const known = randomUUID();
    const gone = randomUUID();
    const config = { dockerSocket: process.env.DOCKER_SOCKET ?? '/var/run/docker.sock' } as AgentsConfig;
    const runtime = new DockerRuntime(config, installation);
    docker('pull', '-q', 'busybox');
    const current = `${BASE_IMAGE}:${runtime.baseVersionFor(DEFAULT_CLAUDE_CODE_VERSION)}`;
    const hadCurrent = ok('image', 'inspect', current);
    const old = `${BASE_IMAGE}:cleanup-test-${known.slice(0, 8)}`;
    docker('tag', 'busybox', old);
    if (!hadCurrent) docker('tag', 'busybox', current);

    const repo = `claude-task/worker-${known}`;
    // One image per tag, like the Builds of a Worker.
    for (const tag of ['current', 'old', 'used']) {
      const scratch = docker('create', 'busybox', 'true');
      docker('commit', '--change', `LABEL build=${tag}`, scratch, `${repo}:${tag}`);
      docker('rm', scratch);
    }
    const user = docker('create', '--label', `claude-task.worker=${known}`, `${repo}:used`, 'true');
    const mine = ['--label', `claude-task.installation=${installation}`];
    const orphanVolume = docker('volume', 'create', ...mine, '--label', `claude-task.worker=${gone}`);
    const knownVolume = docker('volume', 'create', ...mine, '--label', `claude-task.worker=${known}`);
    const unlabelledVolume = docker('volume', 'create', '--label', `claude-task.worker=${gone}`);
    const orphanContainer = docker('create', ...mine, '--label', `claude-task.worker=${gone}`, 'busybox', 'true');
    try {
      const report = await runtime.cleanup({
        anyBuilding: false,
        workers: async () => [{ id: known, imageTag: `${repo}:current`, claudeCodeVersion: DEFAULT_CLAUDE_CODE_VERSION, building: false }],
      });
      expect(report.errors).toEqual([]);
      expect(report.removed).toMatchObject({ workerImages: 1, orphanContainers: 1, orphanVolumes: 1 });
      expect(report.removed.baseImages).toBeGreaterThanOrEqual(1);

      expect(ok('image', 'inspect', old)).toBe(false);
      expect(ok('image', 'inspect', current)).toBe(true);
      expect(ok('image', 'inspect', `${repo}:current`)).toBe(true);
      expect(ok('image', 'inspect', `${repo}:old`)).toBe(false);
      expect(ok('image', 'inspect', `${repo}:used`)).toBe(true);
      expect(ok('volume', 'inspect', orphanVolume)).toBe(false);
      expect(ok('volume', 'inspect', knownVolume)).toBe(true);
      expect(ok('volume', 'inspect', unlabelledVolume)).toBe(true);
      expect(ok('container', 'inspect', orphanContainer)).toBe(false);
    } finally {
      ok('rm', '-f', user, orphanContainer);
      ok('volume', 'rm', orphanVolume, knownVolume, unlabelledVolume);
      ok('rmi', `${repo}:current`, `${repo}:old`, `${repo}:used`, old);
      if (!hadCurrent) ok('rmi', current);
    }
  }, 120_000);
});
