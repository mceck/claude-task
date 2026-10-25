import { SecretBox } from './secrets';

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
  /** Encrypts Credentials and secret env values (`SECRETS_MASTER_KEY`). */
  secrets: SecretBox;
  agents: AgentsConfig;
}

export interface AgentsConfig {
  /** `docker` talks to the host's Docker socket; `fake` simulates containers (e2e tests, demos). */
  runtime: 'docker' | 'fake';
  dockerSocket: string;
  /** The pinned Claude Code CLI version baked into the Base Image. */
  claudeCodeVersion: string;
  /** How Agent Containers reach this backend (HTTP base URL; the Runner derives the WebSocket URL). */
  backendUrl: string;
  /** Docker network Agent Containers join (e.g. the compose network with the backend); null = default bridge. */
  network: string | null;
  commitEmailDomain: string;
  reconcileIntervalMs: number;
  /** A Job whose Runner stays away this long is treated as interrupted. */
  runnerReconnectTimeoutMs: number;
}

/** The Claude Code version the Base Image installs, verified against the stream-json format in tests. */
export const DEFAULT_CLAUDE_CODE_VERSION = '2.1.310';

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes'].includes(value.toLowerCase());
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const secrets = SecretBox.fromEnv(env.SECRETS_MASTER_KEY);
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
    secrets,
    agents: {
      runtime: env.AGENT_RUNTIME === 'fake' ? 'fake' : 'docker',
      dockerSocket: env.DOCKER_SOCKET ?? '/var/run/docker.sock',
      claudeCodeVersion: env.CLAUDE_CODE_VERSION?.trim() || DEFAULT_CLAUDE_CODE_VERSION,
      backendUrl: (env.AGENT_BACKEND_URL?.trim() || `http://host.docker.internal:${env.PORT ?? 3000}`).replace(/\/+$/, ''),
      network: env.AGENT_NETWORK?.trim() || null,
      commitEmailDomain: env.AGENT_COMMIT_EMAIL_DOMAIN?.trim() || 'agents.claude-task.local',
      reconcileIntervalMs: 30_000,
      runnerReconnectTimeoutMs: 5 * 60_000,
    },
  };
}
