import { expect, it } from 'vitest';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { DockerTunnel } from '../src/hosts/tunnel';
import { DockerRuntime } from '../src/agents/docker-runtime';
import { containerName } from '../src/agents/runtime';
import { loadConfig } from '../src/config';

it.skipIf(process.env.HOST_TUNNEL_DOCKER !== '1')('runs DockerRuntime over the Go Controller and a real Docker daemon', { timeout: 120_000 }, async () => {
  const run = promisify(execFile);
  const dir = await mkdtemp(join(tmpdir(), 'ct-real-host-'));
  const binary = join(dir, 'controller');
  await run('go', ['build', '-o', binary, './cmd/host-controller'], { cwd: resolve('../runner') });
  const socket = process.env.DOCKER_SOCKET ?? (await run('docker', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'])).stdout.trim().replace(/^unix:\/\//, '');
  const wss = new WebSocketServer({ port: 0 }); await once(wss, 'listening');
  const accepted = once(wss, 'connection');
  const child = spawn(binary, { env: { ...process.env, CLAUDE_TASK_URL: `http://127.0.0.1:${(wss.address() as { port: number }).port}`, CLAUDE_TASK_HOST_TOKEN: 'fixture', CLAUDE_TASK_ALLOW_INSECURE: 'true', DOCKER_SOCKET: socket } });
  let diagnostics = ''; child.stderr.on('data', (data) => { diagnostics += data; });
  let stage = 'hello';
  const [connection] = await accepted;
  connection.on('close', (code: number, reason: Buffer) => { diagnostics += ` WS close ${code} ${reason}`; });
  const tunnel = new DockerTunnel(connection);
  const hello = JSON.parse((await once(connection, 'message'))[0].toString()); expect(hello.protocolVersion).toBe(1);
  const docker = tunnel.createClient();
  const workerId = randomUUID();
  const config = loadConfig({ DATABASE_URL: 'postgres://unused/test', SECRETS_MASTER_KEY: Buffer.alloc(32).toString('base64') });
  const runtime = new DockerRuntime(config.agents, randomUUID(), undefined, docker);
  const volume = `ct-tunnel-${workerId}`;
  try {
    stage = 'volume';
    await docker.createVolume({ Name: volume });
    stage = 'build';
    const image = await runtime.buildWorkerImage({ workerId, buildId: randomUUID(), dockerfile: 'FROM busybox\nCMD ["sh", "-c", "echo tunnel-logs; sleep 60"]\n' }, () => {});
    stage = 'container';
    await runtime.createContainer(workerId, 1, { image: image.imageTag, env: {}, cpuLimit: null, memoryMb: null });
    expect((await runtime.inspect(workerId, 1)).state).toBe('running');
    const exec = await docker.getContainer(containerName(workerId, 1)).exec({ Cmd: ['sh', '-c', 'echo tunnel-exec'], AttachStdout: true, AttachStderr: true, Tty: true });
    const output = await exec.start({ hijack: true, Tty: true });
    const chunks: Buffer[] = []; for await (const chunk of output) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString().trim()).toBe('tunnel-exec');
    expect(await runtime.logs(workerId, 1, 100)).toContain('tunnel-logs');
    await runtime.stopContainer(workerId, 1); await runtime.removeWorker(workerId);
    expect((await runtime.inspect(workerId, 1)).state).toBe('missing');
  } catch (err) { await new Promise((resolve) => setTimeout(resolve, 200)); throw new Error(`${stage}: ${(err as Error).message}; Controller: ${diagnostics}`); } finally {
    await runtime.removeWorker(workerId).catch(() => {});
    await docker.getVolume(volume).remove().catch(() => {});
    const closed = once(child, 'exit'); child.kill('SIGTERM'); await closed;
    tunnel.close(); wss.close(); await rm(dir, { recursive: true, force: true });
  }
});
