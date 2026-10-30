import pg from 'pg';
import type { FastifyBaseLogger } from 'fastify';
import type { RealtimeHub } from '../realtime/hub';
import { LOGIN_ENDED_CHANNEL } from './logins';

/** Receives Login revocations committed by other processes, including create-admin. */
export class LoginRevocations {
  ready = false;
  private client: pg.Client | null = null;
  private retry: NodeJS.Timeout | null = null;
  private stopping = false;

  constructor(private readonly databaseUrl: string, private readonly hub: RealtimeHub, private readonly log: FastifyBaseLogger) {}

  async start(): Promise<void> {
    const client = new pg.Client({ connectionString: this.databaseUrl, application_name: 'claude-task-login-revocations' });
    this.client = client;
    const disconnected = (err: Error) => {
      if (this.stopping || this.client !== client) return;
      this.ready = false;
      this.client = null;
      // A lost LISTEN connection can miss revocations. End existing sockets and admit
      // new ones only after listening again, when their Login is checked afresh.
      this.hub.closeAll();
      this.log.warn({ err }, 'Login revocation listener disconnected');
      void client.end().catch(() => {});
      this.retry = setTimeout(() => {
        this.retry = null;
        void this.start().catch(() => {});
      }, 1000);
    };
    client.on('error', disconnected);
    client.on('end', () => disconnected(new Error('Login revocation connection ended')));
    client.on('notification', (message) => {
      if (message.channel === LOGIN_ENDED_CHANNEL && message.payload) this.hub.disconnect({ loginIds: [message.payload] });
    });
    try {
      await client.connect();
      await client.query(`LISTEN ${LOGIN_ENDED_CHANNEL}`);
      if (!this.stopping && this.client === client) this.ready = true;
    } catch (err) {
      disconnected(err as Error);
      throw err;
    }
  }

  async close(): Promise<void> {
    this.stopping = true;
    this.ready = false;
    if (this.retry) clearTimeout(this.retry);
    await this.client?.end();
    this.client = null;
  }
}
