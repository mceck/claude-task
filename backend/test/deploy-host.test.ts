import { useTestApp } from './helpers/app';
import { waitForHost } from './helpers/controller';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';

it('deploys a Controller with the entered URL and token and skips backend configuration', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ct-deploy-'));
  try {
    const calls = join(dir, 'calls');
    await writeFile(join(dir, 'sudo'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    await writeFile(join(dir, 'docker'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$DEPLOY_TEST_CALLS"\n', { mode: 0o755 });
    const child = spawn('bash', [resolve('../scripts/deploy.sh'), 'host'], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, DEPLOY_TEST_CALLS: calls } });
    let output = ''; child.stdout.on('data', (data) => { output += data; }); child.stderr.on('data', (data) => { output += data; });
    const finished = new Promise<number | null>((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
    child.stdin.end('http://backend.example\nfixture-token\ny\n');
    expect(await finished, output).toBe(0);
    const commands = await readFile(calls, 'utf8');
    expect(commands).toContain('build --target host-controller -t claude-task/host-controller .');
    expect(commands).toContain('rm -f claude-task-host-controller');
    expect(commands).toContain('-e CLAUDE_TASK_URL=http://backend.example -e CLAUDE_TASK_HOST_TOKEN=fixture-token -e CLAUDE_TASK_ALLOW_INSECURE=true');
    expect(commands).not.toContain('compose up');
    expect(output).toContain('Host Controller started');
  } finally { await rm(dir, { recursive: true, force: true }); }
});


describe.skipIf(process.env.HOST_DEPLOY_DOCKER !== '1')('Controller image deployment', () => {
  const app = useTestApp();
  it('starts the Controller through deploy.sh and connects its Host', { timeout: 180_000 }, async () => {
    const run = promisify(execFile);
    // This opt-in test owns the script's fixed container name; refuse to replace someone else's.
    const existing = await run('docker', ['ps', '-aq', '--filter', 'name=^claude-task-host-controller$']);
    expect(existing.stdout.trim(), 'the test needs the Controller container name to be unused').toBe('');
    const dir = await mkdtemp(join(tmpdir(), 'ct-host-machine-'));
    try {
      // Docker is already installed on this machine; the Linux service/group setup has no work to do.
      await writeFile(join(dir, 'sudo'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      const { host, token } = (await (await app.admin()).post('/hosts', { name: 'Real Controller', allowInsecure: true })).body;
      const child = spawn('bash', [resolve('../scripts/deploy.sh'), 'host'], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } });
      let output = ''; child.stdout.on('data', (data) => { output += data; }); child.stderr.on('data', (data) => { output += data; });
      const finished = new Promise<number | null>((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
      child.stdin.end(`${app.url.replace('127.0.0.1', 'host.docker.internal')}\n${token}\ny\n`);
      expect(await finished, output).toBe(0);
      expect((await waitForHost(app, host.id, 'connected')).controllerVersion).toMatch(/^1-/);
    } finally {
      await run('docker', ['rm', '-f', 'claude-task-host-controller']).catch(() => {});
      await rm(dir, { recursive: true, force: true });
    }
  });
});
