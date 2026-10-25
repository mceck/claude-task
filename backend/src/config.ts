export interface Config {
  databaseUrl: string;
  host: string;
  port: number;
  dataDir: string;
  /** Built frontend to serve, if any (production). */
  staticDir: string | null;
  cookieSecure: boolean;
  trustProxy: boolean;
  logLevel: string;
  bootstrapAdmin: { email: string; password: string; displayName: string } | null;
  loginRateLimit: { max: number; windowMs: number };
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes'].includes(value.toLowerCase());
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  const adminEmail = env.ADMIN_EMAIL?.trim();
  const adminPassword = env.ADMIN_PASSWORD;
  return {
    databaseUrl,
    host: env.HOST ?? '0.0.0.0',
    port: Number(env.PORT ?? 3000),
    dataDir: env.DATA_DIR ?? './.data',
    staticDir: env.STATIC_DIR || null,
    cookieSecure: bool(env.COOKIE_SECURE, true),
    trustProxy: bool(env.TRUST_PROXY, false),
    logLevel: env.LOG_LEVEL ?? 'info',
    bootstrapAdmin:
      adminEmail && adminPassword
        ? { email: adminEmail, password: adminPassword, displayName: env.ADMIN_NAME?.trim() || 'Admin' }
        : null,
    loginRateLimit: { max: 10, windowMs: 15 * 60 * 1000 },
  };
}
