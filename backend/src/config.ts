import { SecretBox } from './secrets';
import { DEFAULT_VOICE_STUN_URLS } from '@claude-task/shared';

export interface Config {
  voiceStunUrls?: string[];
  voiceTurn?: { host: string; port: number; tlsPort: number | null; secret: string; ttlSeconds: number };
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
  webUrl?: string;
  push?: { serviceAccountFile: string };
  /** The `env-github` Git Connection. */
  github?: { appId: string; privateKey: string } | null;
  /** The `env-gitlab` Git Connection. */
  gitlab?: { baseUrl: string; token: string } | null;
  /** Accept `http://` GitLab URLs (tests, local development). */
  gitlabAllowHttp?: boolean;
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
  /** How often the backend pings each Runner; one missed round drops the connection (default 30s). */
  runnerPingIntervalMs?: number;
  /** How long a Task Tool waits for the Runner to upload the files an Agent posts (default 60s). */
  uploadTimeoutMs?: number;
  /** Stop this Installation's Agent Containers on graceful backend shutdown. */
  stopOnShutdown?: boolean;
  /** Stop an Agent's container while it has no work: no Job, empty Queue and no open Session. */
  stopWhenUnused: boolean;
  /** How long a Wiki's idle Session keeps its Agent's container running after its last Job. */
  wikiIdleStopMs: number;
}

/** The Claude Code version the Base Image installs, verified against the stream-json format in tests. */
export const DEFAULT_CLAUDE_CODE_VERSION = '2.1.310';

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes'].includes(value.toLowerCase());
}

function positiveInt(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const secrets = SecretBox.fromEnv(env.SECRETS_MASTER_KEY);
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  const adminEmail = env.ADMIN_EMAIL?.trim();
  const adminPassword = env.ADMIN_PASSWORD;
  const voiceStunUrls = env.VOICE_STUN_URLS === undefined ? DEFAULT_VOICE_STUN_URLS : env.VOICE_STUN_URLS.split(',').map((url) => url.trim()).filter(Boolean);
  if (voiceStunUrls.length > 8 || voiceStunUrls.some((url) => !/^stuns?:[^\s/?#@]+(?::[0-9]+)?$/.test(url))) throw new Error('VOICE_STUN_URLS accepts up to eight stun: or stuns: URLs');
  const turnHost = env.VOICE_TURN_HOST?.trim();
  const turnSecret = env.VOICE_TURN_SECRET;
  const turnEnabled = !!(turnHost || turnSecret || env.VOICE_TURN_TLS_PORT?.trim());
  const turnPort = env.VOICE_TURN_PORT || '3478';
  const turnTlsPort = env.VOICE_TURN_TLS_PORT?.trim();
  const turnTtl = env.VOICE_TURN_TTL_SECONDS || '86400';
  const validPort = (value: string) => /^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 65535;
  if (turnEnabled) {
    if (!turnHost || !/^(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(turnHost) || turnHost.includes('..')) throw new Error('VOICE_TURN_HOST is required when TURN is enabled; supply a hostname without protocol, port or path');
    if (!turnSecret || turnSecret.length < 32 || !/^[A-Za-z0-9_+/=-]+$/.test(turnSecret)) throw new Error('VOICE_TURN_SECRET must contain at least 32 base64 or hexadecimal characters');
    if (!validPort(turnPort) || (turnTlsPort && !validPort(turnTlsPort))) throw new Error('VOICE_TURN_PORT and VOICE_TURN_TLS_PORT must be valid ports (1-65535)');
    if (!/^\d+$/.test(turnTtl) || Number(turnTtl) < 300 || Number(turnTtl) > 86400) throw new Error('VOICE_TURN_TTL_SECONDS must be between 300 and 86400');
  }
  return {
    voiceStunUrls,
    voiceTurn: turnEnabled ? { host: turnHost!, port: Number(turnPort), tlsPort: turnTlsPort ? Number(turnTlsPort) : null, secret: turnSecret!, ttlSeconds: Number(turnTtl) } : undefined,
    databaseUrl,
    host: env.HOST ?? '0.0.0.0',
    port: Number(env.PORT ?? 3000),
    dataDir: env.DATA_DIR ?? './.data',
    staticDir: env.STATIC_DIR || null,
    cookieSecure: bool(env.COOKIE_SECURE, true),
    trustProxy: bool(env.TRUST_PROXY, false),
    logLevel: env.LOG_LEVEL ?? 'info',
    bootstrapAdmin: adminEmail && adminPassword ? { email: adminEmail, password: adminPassword, displayName: env.ADMIN_NAME?.trim() || 'Admin' } : null,
    loginRateLimit: { max: 10, windowMs: 15 * 60 * 1000 },
    secrets,
    push: env.FCM_SERVICE_ACCOUNT_FILE ? { serviceAccountFile: env.FCM_SERVICE_ACCOUNT_FILE } : undefined,
    webUrl: (env.APP_URL?.trim() || `http://localhost:${env.PORT ?? 3000}`).replace(/\/+$/, ''),
    github:
      env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY
        ? { appId: env.GITHUB_APP_ID.trim(), privateKey: env.GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, '\n') }
        : null,
    gitlab: env.GITLAB_TOKEN?.trim() ? { baseUrl: env.GITLAB_URL?.trim() || 'https://gitlab.com', token: env.GITLAB_TOKEN.trim() } : null,
    gitlabAllowHttp: bool(env.GITLAB_ALLOW_HTTP, false),
    agents: {
      runtime: env.AGENT_RUNTIME === 'fake' ? 'fake' : 'docker',
      dockerSocket: env.DOCKER_SOCKET ?? '/var/run/docker.sock',
      claudeCodeVersion: env.CLAUDE_CODE_VERSION?.trim() || DEFAULT_CLAUDE_CODE_VERSION,
      backendUrl: (env.AGENT_BACKEND_URL?.trim() || `http://host.docker.internal:${env.PORT ?? 3000}`).replace(/\/+$/, ''),
      network: env.AGENT_NETWORK?.trim() || null,
      commitEmailDomain: env.AGENT_COMMIT_EMAIL_DOMAIN?.trim() || 'agents.claude-task.local',
      reconcileIntervalMs: 30_000,
      runnerReconnectTimeoutMs: 5 * 60_000,
      stopOnShutdown: bool(env.AGENT_STOP_ON_SHUTDOWN, env.NODE_ENV !== 'production'),
      stopWhenUnused: bool(env.AGENT_STOP_WHEN_UNUSED, true),
      wikiIdleStopMs: positiveInt(env.AGENT_WIKI_IDLE_MINUTES, 30) * 60_000,
    },
  };
}
