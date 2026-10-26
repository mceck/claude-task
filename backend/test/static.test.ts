// The built frontend as production serves it.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { useTestApp } from './helpers/app';

const staticDir = mkdtempSync(path.join(tmpdir(), 'ct-static-'));
writeFileSync(path.join(staticDir, 'index.html'), '<!doctype html><title>Claude Task</title>');
writeFileSync(path.join(staticDir, 'app.js'), 'console.log(1)');

describe('the web app', () => {
  const app = useTestApp({ config: { staticDir } });

  // Defense in depth against XSS (Agents write content users view) and clickjacking.
  it.each(['/', '/t/API-1', '/app.js'])('serves %s with a policy refusing inline scripts and framing', async (url) => {
    const res = await fetch(`${app.url}${url}`);
    expect(res.status).toBe(200);
    const csp = res.headers.get('content-security-policy')!;
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('same-origin');
  });
});
