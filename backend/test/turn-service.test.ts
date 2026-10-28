import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import tls from 'node:tls';
import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const image = 'coturn/coturn:4.18.0-r0';
const secret = 'turn-service-test-secret-000000000000000000';
const mounts = ['-v', `${root}/deploy/turn/start.sh:/etc/coturn/start.sh:ro`, '-v', `${root}/deploy/turn/turnserver.conf:/etc/coturn/base.conf:ro`];

describe.runIf(process.env.TEST_TURN_DOCKER === '1')('additional TURN service', () => {
  it('requires a hostname with no Compose or startup-script fallback', () => {
    const compose = spawnSync('docker', ['compose', '-f', 'docker-compose.yml', '-f', 'docker-compose.turn.yml', 'config', '--quiet'], {
      cwd: root, encoding: 'utf8', env: { ...process.env, ADMIN_PASSWORD: 'local-test-password', SECRETS_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'), VOICE_TURN_HOST: '', VOICE_TURN_SECRET: secret, VOICE_TURN_EXTERNAL_IP: '203.0.113.5' },
    });
    expect(compose.status).not.toBe(0);
    expect(compose.stderr).toContain('VOICE_TURN_HOST');
    const start = spawnSync('docker', ['run', '--rm', '--entrypoint', '/bin/sh', ...mounts, image, '/etc/coturn/start.sh'], { encoding: 'utf8', timeout: 15_000 });
    expect(start.status).not.toBe(0);
    expect(start.stderr).toContain('VOICE_TURN_HOST');
  });

  it('fails clearly when TLS is enabled without certificate files', () => {
    const start = spawnSync('docker', ['run', '--rm', '--entrypoint', '/bin/sh', ...mounts,
      '-e', 'VOICE_TURN_HOST=relay.example.test', '-e', `VOICE_TURN_SECRET=${secret}`, '-e', 'VOICE_TURN_EXTERNAL_IP=203.0.113.5', '-e', 'VOICE_TURN_TLS_PORT=443', image, '/etc/coturn/start.sh'], { encoding: 'utf8', timeout: 15_000 });
    expect(start.status).not.toBe(0);
    expect(start.stderr).toContain('TURN TLS requires readable');
  });

  it('starts the production entrypoint with its mounted TLS certificate', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'task-turn-tls-'));
    const name = `task-turn-tls-${process.pid}`;
    chmodSync(dir, 0o755);
    try {
      execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=relay.example.test', '-addext', 'subjectAltName=DNS:relay.example.test', '-keyout', path.join(dir, 'privkey.pem'), '-out', path.join(dir, 'fullchain.pem')], { stdio: 'ignore' });
      chmodSync(path.join(dir, 'privkey.pem'), 0o644);
      writeFileSync(path.join(dir, '.test-only'), 'Temporary self-signed certificate for a local TLS handshake.');
      execFileSync('docker', ['run', '-d', '--name', name, '--read-only', '--cap-drop=ALL', '--cap-add=NET_BIND_SERVICE', '--security-opt=no-new-privileges:true', '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=16m', '--entrypoint', '/bin/sh', ...mounts,
        '-v', `${dir}:/certs:ro`, '-p', '127.0.0.1::5349/tcp', '-e', 'VOICE_TURN_HOST=relay.example.test', '-e', `VOICE_TURN_SECRET=${secret}`, '-e', 'VOICE_TURN_EXTERNAL_IP=203.0.113.5', '-e', 'VOICE_TURN_TLS_PORT=443', image, '/etc/coturn/start.sh'], { stdio: 'pipe' });
      const port = Number(execFileSync('docker', ['inspect', '--format', '{{(index (index .NetworkSettings.Ports "5349/tcp") 0).HostPort}}', name], { encoding: 'utf8' }).trim());
      const handshake = () => new Promise<boolean>((resolve) => {
        const socket = tls.connect({ host: '127.0.0.1', port, servername: 'relay.example.test', ca: readFileSync(path.join(dir, 'fullchain.pem')), minVersion: 'TLSv1.2' });
        socket.setTimeout(1000);
        socket.once('secureConnect', () => { resolve(socket.authorized); socket.destroy(); });
        socket.once('error', () => { resolve(false); socket.destroy(); });
        socket.once('timeout', () => { resolve(false); socket.destroy(); });
      });
      await expect.poll(handshake, { timeout: 10_000 }).toBe(true);
      const logs = execFileSync('docker', ['logs', name], { encoding: 'utf8' });
      expect(logs).not.toContain(secret);
    } finally {
      try { execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' }); } catch {}
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
