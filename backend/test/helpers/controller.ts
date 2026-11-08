import { HOST_CONTROLLER_PATH, HOST_PROTOCOL_VERSION } from '@claude-task/shared';
import { WebSocket } from 'ws';
import type { TestApp } from './app';

export async function connectController(app: TestApp, token: string, hello: Record<string, unknown> = {}, autoPong = true): Promise<WebSocket> {
  const socket = new WebSocket(app.url.replace(/^http/, 'ws') + HOST_CONTROLLER_PATH, { headers: { authorization: `Bearer ${token}` }, autoPong });
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('unexpected-response', (_request, response) => { response.resume(); reject(new Error(`Controller rejected: ${response.statusCode}`)); });
    socket.once('error', reject);
  });
  socket.send(JSON.stringify({ type: 'hello', protocolVersion: HOST_PROTOCOL_VERSION, controllerVersion: 'test-1', backendUrl: 'https://backend.example', ...hello }));
  return socket;
}
export async function waitForHost(app: TestApp, id: string, state: string): Promise<any> {
  const admin = await app.admin();
  for (let i = 0; i < 100; i++) {
    const { host } = (await admin.get(`/hosts/${id}`)).body;
    if (host?.state === state) return host;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Host did not become ${state}`);
}
