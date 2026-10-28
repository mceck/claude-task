// Opt-in real TURN fixture. Production policy remains unchanged; the local peer exception is test-only.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dgram from 'node:dgram';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dir = mkdtempSync(path.join(tmpdir(), 'claude-task-turn-e2e-'));
const name = `claude-task-turn-e2e-${process.pid}`;
const secret = 'voice-turn-browser-test-secret-000000000000000000';
const port = 3479;
const host = process.env.VOICE_TURN_E2E_HOST;
if (!host) throw new Error('VOICE_TURN_E2E_HOST is required by the local TURN fixture');
const config = readFileSync(path.join(root, 'deploy/turn/turnserver.conf'), 'utf8')
  .replace('min-port=30000', 'min-port=30200').replace('max-port=30199', 'max-port=30399')
  + `\nallowed-peer-ip=${host}\n`;
writeFileSync(path.join(dir, 'turnserver.conf'), config, { mode: 0o644 });
const cleanup = () => {
  try { execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' }); } catch {}
  rmSync(dir, { recursive: true, force: true });
};
process.on('exit', cleanup);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => process.exit(0));
execFileSync('docker', [
  'run', '-d', '--name', name, '--read-only', '--cap-drop=ALL', '--cap-add=NET_BIND_SERVICE', '--security-opt=no-new-privileges:true',
  '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=16m',
  '-p', `${host}:${port}:3478/udp`, '-p', `${host}:${port}:3478/tcp`,
  '-p', `${host}:30200-30399:30200-30399/udp`,
  '-e', `VOICE_TURN_HOST=${host}`, '-e', `VOICE_TURN_SECRET=${secret}`, '-e', `VOICE_TURN_EXTERNAL_IP=${host}`,
  '-v', `${root}/deploy/turn/start.sh:/etc/coturn/start.sh:ro`, '-v', `${dir}/turnserver.conf:/etc/coturn/base.conf:ro`,
  '--entrypoint', '/bin/sh', 'coturn/coturn:4.18.0-r0', '/etc/coturn/start.sh',
], { stdio: 'pipe' });

async function ready() {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    const transaction = randomBytes(12);
    const request = Buffer.alloc(20);
    request.writeUInt16BE(1, 0); request.writeUInt32BE(0x2112a442, 4); transaction.copy(request, 8);
    const timer = setTimeout(() => { socket.close(); resolve(false); }, 500);
    socket.on('message', (response) => {
      if (response.length < 20 || response.readUInt16BE(0) !== 0x0101 || !response.subarray(8, 20).equals(transaction)) return;
      clearTimeout(timer); socket.close(); resolve(true);
    });
    socket.on('error', () => { clearTimeout(timer); socket.close(); resolve(false); });
    socket.send(request, port, host);
  });
}
let running = false;
for (let attempt = 0; attempt < 60; attempt++) {
  if (await ready()) { running = true; break; }
  await new Promise((resolve) => setTimeout(resolve, 250));
}
if (!running) {
  try { process.stderr.write(execFileSync('docker', ['logs', name], { encoding: 'utf8' })); } catch {}
  throw new Error('TURN fixture did not answer STUN');
}
createServer((_req, res) => { res.writeHead(200); res.end('TURN ready'); }).listen(34790, '127.0.0.1');
