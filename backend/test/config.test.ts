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

describe('storage configuration', () => {
  it('keeps blobs on the local filesystem when no storage setting is given', () => {
    expect(loadConfig(base).storage).toEqual({ type: 'disk' });
    expect(loadConfig({ ...base, STORAGE_TYPE: 'disk' }).storage).toEqual({ type: 'disk' });
  });

  it('builds an S3 store from the storage settings', () => {
    expect(
      loadConfig({
        ...base,
        STORAGE_TYPE: 's3',
        S3_BUCKET: 'claude-task-files',
        S3_REGION: 'eu-central-1',
        S3_ENDPOINT: 'http://127.0.0.1:9000',
        S3_ACCESS_KEY_ID: 'access',
        S3_SECRET_ACCESS_KEY: 'secret',
        S3_PREFIX: '/installation/',
      }).storage,
    ).toEqual({
      type: 's3',
      bucket: 'claude-task-files',
      region: 'eu-central-1',
      endpoint: 'http://127.0.0.1:9000',
      forcePathStyle: true,
      prefix: 'installation/',
      credentials: { accessKeyId: 'access', secretAccessKey: 'secret' },
    });
  });

  it('addresses AWS S3 by virtual host unless asked otherwise', () => {
    expect(loadConfig({ ...base, STORAGE_TYPE: 's3', S3_BUCKET: 'claude-task-files' }).storage).toMatchObject({
      type: 's3',
      region: 'us-east-1',
      endpoint: undefined,
      forcePathStyle: false,
      prefix: '',
      credentials: undefined,
    });
    expect(loadConfig({ ...base, STORAGE_TYPE: 's3', S3_BUCKET: 'claude-task-files', S3_FORCE_PATH_STYLE: 'true' }).storage).toMatchObject({ forcePathStyle: true });
    expect(loadConfig({ ...base, STORAGE_TYPE: 's3', S3_BUCKET: 'claude-task-files', S3_ENDPOINT: 'https://s3.example.test', S3_FORCE_PATH_STYLE: 'false' }).storage).toMatchObject({
      forcePathStyle: false,
    });
  });

  it.each([
    { what: 'an unknown storage type', env: { STORAGE_TYPE: 'ftp' }, message: /STORAGE_TYPE/ },
    { what: 'an S3 store without a bucket', env: { STORAGE_TYPE: 's3' }, message: /S3_BUCKET/ },
    { what: 'an S3 bucket name with a slash', env: { STORAGE_TYPE: 's3', S3_BUCKET: 'files/archive' }, message: /S3_BUCKET/ },
    { what: 'an S3 endpoint that is not a URL', env: { STORAGE_TYPE: 's3', S3_BUCKET: 'files', S3_ENDPOINT: '127.0.0.1:9000' }, message: /S3_ENDPOINT/ },
    { what: 'an S3 endpoint with a non-HTTP protocol', env: { STORAGE_TYPE: 's3', S3_BUCKET: 'files', S3_ENDPOINT: 's3://files' }, message: /S3_ENDPOINT/ },
    { what: 'half an S3 credential', env: { STORAGE_TYPE: 's3', S3_BUCKET: 'files', S3_ACCESS_KEY_ID: 'access' }, message: /S3_ACCESS_KEY_ID.*S3_SECRET_ACCESS_KEY/ },
    { what: 'an S3 prefix with unsupported characters', env: { STORAGE_TYPE: 's3', S3_BUCKET: 'files', S3_PREFIX: 'bad prefix' }, message: /S3_PREFIX/ },
  ])('rejects $what', ({ env, message }) => {
    expect(() => loadConfig({ ...base, ...env })).toThrow(message);
  });
});
