// Container orchestration probes the backend through this endpoint.
import { describe, expect, it } from 'vitest';
import { useTestApp } from './helpers/app';

describe('health check', () => {
  const app = useTestApp();

  it('answers without a Login and outside the API prefix', async () => {
    const res = await fetch(`${app.url}/health`);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ status: 'ok' });
  });
});
