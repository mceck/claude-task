import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';

const base = {
  DATABASE_URL: 'postgres://localhost:5432/postgres',
  SECRETS_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
  ADMIN_EMAIL: 'admin@example.com',
  ADMIN_PASSWORD: 'admin-password',
};

describe('configuration', () => {
  it('accepts a bootstrapped Admin that can log in', () => {
    expect(loadConfig(base).bootstrapAdmin).toMatchObject({ email: 'admin@example.com', password: 'admin-password' });
  });

  it.each([
    { what: 'an invalid email', env: { ADMIN_EMAIL: 'not-an-email' }, message: /ADMIN_EMAIL/ },
    { what: 'an email over the login limit', env: { ADMIN_EMAIL: `${'a'.repeat(310)}@example.com` }, message: /ADMIN_EMAIL/ },
    { what: 'a password that is too short', env: { ADMIN_PASSWORD: 'short' }, message: /ADMIN_PASSWORD/ },
    { what: 'a password over the login limit', env: { ADMIN_PASSWORD: 'x'.repeat(201) }, message: /ADMIN_PASSWORD/ },
  ])('rejects $what instead of creating an Admin who cannot log in', ({ env, message }) => {
    expect(() => loadConfig({ ...base, ...env })).toThrow(message);
  });
});
