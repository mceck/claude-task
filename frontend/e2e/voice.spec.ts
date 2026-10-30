import { expect, test } from '@playwright/test';
import type { APIRequestContext, Browser, BrowserContext, Page } from '@playwright/test';
import { createProject, createTask, login } from './helpers';

test.use({ permissions: ['microphone'], launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] } });
const headers = { 'x-claude-task': '1' };

async function otherUser(browser: Browser, admin: APIRequestContext): Promise<BrowserContext> {
  const context = await browser.newContext({ baseURL: 'http://localhost:5174', permissions: ['microphone'] });
  const email = `voice-${crypto.randomUUID()}@example.com`;
  const result = await admin.post('/api/v1/users', { headers, data: { email, displayName: 'Bea Voice', role: 'member' } });
  expect(result.status()).toBe(201);
  const { temporaryPassword } = await result.json();
  await login(context.request, email, temporaryPassword);
  const changed = await context.request.post('/api/v1/auth/password', { headers, data: { currentPassword: temporaryPassword, newPassword: 'voice-test-password' } });
  expect(changed.status()).toBe(200);
  return context;
}

async function inspectMedia(page: Page, transport?: 'udp' | 'tcp' | 'all') {
  await page.addInitScript((transport) => {
    const root = window as unknown as { voicePeers: RTCPeerConnection[]; voiceStreams: MediaStream[]; voiceIceErrors: unknown[] };
    root.voicePeers = []; root.voiceStreams = []; root.voiceIceErrors = [];
    const NativePeer = window.RTCPeerConnection;
    window.RTCPeerConnection = class extends NativePeer {
      constructor(config?: RTCConfiguration) {
        const selected = transport ? {
          ...config,
          iceTransportPolicy: 'relay' as const,
          iceServers: (config?.iceServers ?? []).map((server) => ({
            ...server,
            urls: (Array.isArray(server.urls) ? server.urls : [server.urls]).filter((url) => url.startsWith('turn:') && (transport === 'all' || url.endsWith(`?transport=${transport}`))),
          })).filter((server) => server.urls.length > 0),
        } : config;
        super(selected); root.voicePeers.push(this);
        this.addEventListener('icecandidateerror', (event) => root.voiceIceErrors.push({ code: event.errorCode, text: event.errorText, url: event.url }));
      }

    };
    const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      const stream = await capture(constraints); root.voiceStreams.push(stream); return stream;
    };
  }, transport);
}
async function receivedAudio(page: Page) {
  return page.evaluate(async () => {
    const { voicePeers } = window as unknown as { voicePeers: RTCPeerConnection[] };
    let bytes = 0;
    for (const peer of voicePeers) {
      if (peer.connectionState === 'closed') continue;
      (await peer.getStats()).forEach((report) => { if (report.type === 'inbound-rtp' && report.kind === 'audio') bytes += Number(report.bytesReceived ?? 0); });
    }
    return bytes;
  });
}

test('a failed room snapshot leaves Join voice available', async ({ page }) => {
  await login(page.request);
  const project = await createProject(page.request);
  const task = await createTask(page.request, project, 'Voice with a bad snapshot');
  await page.route(`**/tasks/${task.id}/voice`, (route) =>
    route.fulfill({ status: 500, json: { error: { code: 'internal', message: 'Room snapshot failed' } } }),
  );
  await page.goto(`/t/${task.key}`);
  const room = page.getByRole('region', { name: 'Task Voice Room' });
  await expect(room.getByText('Room unavailable. Try again.')).toBeVisible({ timeout: 10_000 });
  await expect(room.getByRole('button', { name: 'Join voice' })).toBeEnabled();
});

test('direct audio works across Users, stays active during navigation and releases on leave', async ({ page, browser }) => {
  await login(page.request);
  const project = await createProject(page.request, 'Voice project');
  const task = await createTask(page.request, project, 'Discuss implementation');
  const context = await otherUser(browser, page.request);
  const bea = await context.newPage();
  try {
    await Promise.all([inspectMedia(page), inspectMedia(bea)]);
    await Promise.all([page.goto(`/t/${task.key}`), bea.goto(`/t/${task.key}`)]);
    await page.getByRole('button', { name: 'Join voice', exact: true }).click();
    await expect(bea.getByRole('region', { name: 'Task Voice Room' })).toContainText('Ada Admin');
    await bea.getByRole('button', { name: 'Join voice', exact: true }).click();
    const controls = page.getByRole('region', { name: 'Voice controls' });
    await expect(controls.getByText('connected', { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => receivedAudio(page), { timeout: 15_000 }).toBeGreaterThan(0);
    await expect.poll(() => receivedAudio(bea), { timeout: 15_000 }).toBeGreaterThan(0);
    await page.getByRole('button', { name: 'Mute microphone', exact: true }).click();
    await expect(bea.getByRole('region', { name: 'Task Voice Room' })).toContainText('Ada Admin (muted)');
    expect(await page.evaluate(() => (window as unknown as { voiceStreams: MediaStream[] }).voiceStreams.at(-1)!.getAudioTracks()[0]!.enabled)).toBe(false);
    await page.getByRole('button', { name: 'Silence incoming audio', exact: true }).click();
    expect(await page.locator('audio[data-voice-peer]').evaluateAll((els) => els.every((el) => (el as HTMLAudioElement).muted))).toBe(true);
    // A client-side route change preserves the microphone and the same peer.
    await page.getByRole('link', { name: 'Projects', exact: true }).click();
    await expect(controls).toContainText(task.key);
    await expect(controls.getByText('connected', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Leave voice', exact: true }).click();
    await expect(controls).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => (window as unknown as { voiceStreams: MediaStream[] }).voiceStreams.every((s) => s.getTracks().every((t) => t.readyState === 'ended')))).toBe(true);
    await expect(bea.getByRole('region', { name: 'Task Voice Room' })).toContainText('1/6');
    await bea.getByRole('button', { name: 'Leave voice', exact: true }).click();
  } finally { await context.close(); }
});

test('moving to another tab requires confirmation and closes the previous microphone', async ({ page, context }) => {
  await login(page.request);
  const project = await createProject(page.request);
  const task = await createTask(page.request, project, 'Move voice');
  const next = await context.newPage();
  await Promise.all([inspectMedia(page), inspectMedia(next)]);
  await Promise.all([page.goto(`/t/${task.key}`), next.goto(`/t/${task.key}`)]);
  await page.getByRole('button', { name: 'Join voice', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Leave voice' })).toBeVisible();
  await next.getByRole('button', { name: 'Join voice', exact: true }).click();
  await expect(next.getByRole('alertdialog')).toContainText('Transfer voice participation?');
  await next.getByRole('button', { name: 'Transfer', exact: true }).click();
  await expect(next.getByRole('button', { name: 'Leave voice' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Voice controls' })).toContainText('Voice moved');
  await expect.poll(() => page.evaluate(() => (window as unknown as { voiceStreams: MediaStream[] }).voiceStreams.every((s) => s.getTracks().every((t) => t.readyState === 'ended')))).toBe(true);
  await next.getByRole('button', { name: 'Leave voice' }).click();
});

test('a failed peer is visible and retryable without leaving the room', async ({ page, browser }) => {
  await login(page.request);
  const project = await createProject(page.request);
  const task = await createTask(page.request, project, 'Unreachable peer');
  const context = await otherUser(browser, page.request);
  const bea = await context.newPage();
  try {
    // Keep the media API real, but model a network that never completes ICE.
    await page.addInitScript(() => {
      const NativePeer = window.RTCPeerConnection;
      window.RTCPeerConnection = class extends NativePeer {
        override async setRemoteDescription() { throw new DOMException('Network unreachable', 'OperationError'); }
      };
    });
    await Promise.all([page.goto(`/t/${task.key}`), bea.goto(`/t/${task.key}`)]);
    await page.getByRole('button', { name: 'Join voice', exact: true }).click();
    await bea.getByRole('button', { name: 'Join voice', exact: true }).click();
    const controls = page.getByRole('region', { name: 'Voice controls' });
    await expect(controls.getByText('unavailable', { exact: true })).toBeVisible({ timeout: 25_000 });
    await expect(controls).toContainText('Some people cannot hear you');
    await controls.getByRole('button', { name: 'Retry connection to Bea Voice' }).click();
    await expect(controls).toContainText('2/6');
    await controls.getByRole('button', { name: 'Leave voice' }).click();
  } finally { await context.close(); }
});

for (const relayOnly of [false, true]) {
  test(`six Users establish all fifteen ${relayOnly ? 'TURN relay' : 'direct'} audio links`, async ({ page, browser }) => {
  test.skip(relayOnly && process.env.VOICE_TURN_E2E !== '1', 'Enable VOICE_TURN_E2E=1 for the real coturn fixture');
  test.setTimeout(60_000);
  await login(page.request);
  const project = await createProject(page.request);
  const task = await createTask(page.request, project, 'Six-person room');
  const contexts: BrowserContext[] = [];
  const pages = [page];
  try {
    for (let i = 0; i < 5; i++) {
      const context = await otherUser(browser, page.request);
      contexts.push(context); pages.push(await context.newPage());
    }
    for (const participant of pages) {
      await inspectMedia(participant, relayOnly ? 'all' : undefined);
      await participant.goto(`/t/${task.key}`);
      await participant.getByRole('button', { name: 'Join voice', exact: true }).click();
      await expect(participant.getByRole('button', { name: 'Leave voice' })).toBeVisible();
    }
    for (const participant of pages) {
      await expect(participant.getByRole('region', { name: 'Voice controls' }).getByText('connected', { exact: true })).toHaveCount(5, { timeout: 20_000 });
      await expect.poll(() => participant.evaluate(async () => {
        const peers = (window as unknown as { voicePeers: RTCPeerConnection[] }).voicePeers.filter((p) => p.connectionState !== 'closed');
        let received = 0;
        for (const peer of peers) (await peer.getStats()).forEach((report) => { if (report.type === 'inbound-rtp' && report.kind === 'audio' && report.bytesReceived > 0) received++; });
        return received;
      }), { timeout: 15_000 }).toBe(5);
    }
    await page.getByRole('button', { name: 'Leave voice' }).click();
  } catch (error) {
    for (const participant of pages) {
      console.log('Six-user ICE diagnostics', await participant.evaluate(() => {
        const root = window as unknown as { voicePeers: RTCPeerConnection[]; voiceIceErrors: unknown[] };
        return { errors: root.voiceIceErrors, states: root.voicePeers.map((p) => p.connectionState) };
      }));
    }
    throw error;
  } finally { await Promise.all(contexts.map((context) => context.close())); }
});
}

test('a delayed initial snapshot cannot erase newer live room presence', async ({ page, browser }) => {
  await login(page.request);
  const project = await createProject(page.request);
  const task = await createTask(page.request, project, 'Fresh presence');
  const context = await otherUser(browser, page.request);
  const bea = await context.newPage();
  let release!: () => void, captured!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { captured = resolve; });
  await page.route(`**/api/v1/tasks/${task.id}/voice`, async (route) => {
    const response = await route.fetch();
    captured();
    await gate;
    await route.fulfill({ response });
  });
  try {
    await page.goto(`/t/${task.key}`);
    await started;
    await bea.goto(`/t/${task.key}`);
    await bea.getByRole('button', { name: 'Join voice', exact: true }).click();
    const room = page.getByRole('region', { name: 'Task Voice Room' });
    await expect(room).toContainText('Bea Voice');
    release();
    await page.waitForLoadState('networkidle');
    await expect(room).toContainText('Bea Voice');
    await expect(room).toContainText('1/6');
  } finally { release(); await context.close(); }
});

for (const transport of ['udp', 'tcp'] as const) {
  test(`audio works through real TURN over ${transport.toUpperCase()} with direct ICE disabled`, async ({ page, browser }) => {
    test.skip(process.env.VOICE_TURN_E2E !== '1', 'Enable VOICE_TURN_E2E=1 for the real coturn fixture');
    test.setTimeout(60_000);
    await login(page.request);
    const project = await createProject(page.request);
    const task = await createTask(page.request, project, 'Relay-only voice');
    const context = await otherUser(browser, page.request);
    const bea = await context.newPage();
    try {
      if (transport === 'udp') await page.clock.install();
      await Promise.all([inspectMedia(page, transport), inspectMedia(bea, transport)]);
      await Promise.all([page.goto(`/t/${task.key}`), bea.goto(`/t/${task.key}`)]);
      await page.getByRole('button', { name: 'Join voice', exact: true }).click();
      await bea.getByRole('button', { name: 'Join voice', exact: true }).click();
      for (const participant of [page, bea]) {
        await expect(participant.getByRole('region', { name: 'Voice controls' }).getByText('connected', { exact: true })).toBeVisible({ timeout: 25_000 });
        await expect.poll(() => receivedAudio(participant), { timeout: 15_000 }).toBeGreaterThan(0);
        await expect.poll(() => participant.evaluate(async () => {
          const peers = (window as unknown as { voicePeers: RTCPeerConnection[] }).voicePeers;
          const stats = await peers.at(-1)!.getStats();
          const reports = new Map<string, { id: string; type: string; nominated?: boolean; state?: string; localCandidateId?: string; candidateType?: string; relayProtocol?: string; selectedCandidatePairId?: string }>();
          stats.forEach((report) => reports.set(report.id, report));
          const selected = [...reports.values()].find((report) => report.type === 'transport' && report.selectedCandidatePairId)?.selectedCandidatePairId;
          const pair = reports.get(selected ?? '');
          const candidate = reports.get(pair?.localCandidateId ?? '');
          return { type: candidate?.candidateType, transport: candidate?.relayProtocol };
        }), { timeout: 5000 }).toEqual({ type: 'relay', transport });
      }
      if (transport === 'udp') {
        const username = () => page.evaluate(() => (window as unknown as { voicePeers: RTCPeerConnection[] }).voicePeers.at(-1)?.getConfiguration().iceServers?.find((s) => s.username)?.username);
        const initial = await username();
        expect(initial).toBeTruthy();
        await page.clock.fastForward(151_000);
        await expect.poll(username).not.toBe(initial);
        await expect(page.getByRole('region', { name: 'Voice controls' }).getByText('connected', { exact: true })).toBeVisible({ timeout: 15_000 });
        await expect.poll(() => receivedAudio(page), { timeout: 15_000 }).toBeGreaterThan(0);
      }
      await page.getByRole('button', { name: 'Leave voice' }).click();
    } finally { await context.close(); }
  });
}
