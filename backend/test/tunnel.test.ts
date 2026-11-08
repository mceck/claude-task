import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { DockerTunnel } from '../src/hosts/tunnel';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
async function harness() {
  const dir = await mkdtemp(join(tmpdir(), 'ct-tunnel-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const server = createServer((req, res) => {
    if (req.url === '/version') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ Version: '27.test' })); }
    else if (req.url?.startsWith('/build')) { req.resume(); req.on('end', () => { res.write('{"stream":"building"}\n'); res.end('{"stream":"done"}\n'); }); }
    else if (req.url?.startsWith('/containers/large/logs')) { res.end(Buffer.alloc(8 * 1024 * 1024, 97)); }
    else { /* a request held open until the tunnel drops */ }
  });
  server.on('upgrade', (req, socket, head) => {
    socket.write('HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n');
    let remaining = Number(req.headers['content-length'] ?? 0);
    const echo = (data: Buffer) => { const skipped = Math.min(remaining, data.length); remaining -= skipped; if (data.length > skipped) socket.write(data.subarray(skipped)); };
    echo(head); socket.on('data', echo);
  });
  server.listen(join(dir, 'docker.sock')); await once(server, 'listening');
  const wss = new WebSocketServer({ port: 0 }); await once(wss, 'listening');
  const accepted = once(wss, 'connection');
  const controller = new WebSocket(`ws://127.0.0.1:${(wss.address() as { port: number }).port}`);
  await once(controller, 'open');
  const [backend] = await accepted;
  const streams = new Map<number, ReturnType<typeof connect>>();
  controller.on('message', (raw) => {
    const frame = Buffer.from(raw as Buffer); const op = frame[0]; const id = frame.readUInt32BE(1); const data = frame.subarray(5);
    const send = (kind: number, payload = Buffer.alloc(0)) => { const h = Buffer.alloc(5); h[0] = kind; h.writeUInt32BE(id, 1); if (controller.readyState === controller.OPEN) controller.send(Buffer.concat([h, payload])); };
    if (op === 1) {
      const socket = connect(join(dir, 'docker.sock')); streams.set(id, socket);
      socket.on('data', (chunk) => send(2, chunk)); socket.on('end', () => send(3)); socket.on('error', (err) => send(4, Buffer.from(err.message))); socket.on('close', () => { send(4); streams.delete(id); });
    } else if (op === 2) streams.get(id)?.write(data);
    else if (op === 3) streams.get(id)?.end();
    else if (op === 4) streams.get(id)?.destroy();
  });
  const tunnel = new DockerTunnel(backend);
  const docker = tunnel.createClient();
  cleanups.push(async () => { tunnel.close(); controller.terminate(); for (const socket of streams.values()) socket.destroy(); server.closeAllConnections(); server.close(); wss.close(); });
  return { docker, controller };
}
describe('Docker through the Host tunnel', () => {
  it('carries a JSON request and a streamed build context and output', async () => {
    const { docker } = await harness();
    expect((await docker.version()).Version).toBe('27.test');
    const result = await docker.buildImage(Readable.from([Buffer.alloc(256 * 1024)]), { t: 'test' });
    const chunks: Buffer[] = []; for await (const chunk of result) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString()).toBe('{"stream":"building"}\n{"stream":"done"}\n');
  });
  it('carries both directions of a hijacked exec connection', async () => {
    const { docker } = await harness();
    const stream = await docker.getExec('test').start({ hijack: true, stdin: true });
    const reply = once(stream, 'data'); stream.write('hello exec');
    expect((await reply)[0].toString()).toBe('hello exec'); stream.destroy();
  });
  it('delivers a large response to a slow reader under backpressure', async () => {
    const { docker } = await harness();
    const stream = await docker.getContainer('large').logs({ stdout: true, stderr: true, follow: true });
    let length = 0;
    for await (const chunk of stream) { length += chunk.length; await new Promise((resolve) => setTimeout(resolve, 1)); }
    expect(length).toBe(8 * 1024 * 1024);
  });
  it('fails an in-flight Docker call when the Controller drops', async () => {
    const { docker, controller } = await harness();
    const pending = docker.info();
    await new Promise((resolve) => setTimeout(resolve, 20)); controller.terminate();
    await expect(pending).rejects.toThrow('Host disconnected');
  });
});
