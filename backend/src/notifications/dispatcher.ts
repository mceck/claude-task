import type { NotificationKind, PushAlert } from '@claude-task/shared';
import { sql } from 'drizzle-orm';
import type { AppContext } from '../context';
import { buildAlert } from './alerts';
import { PushTransportError } from './transport';

type Delivery = {
  event_id: string; user_id: string; device_id: string; attempts: number; task_id: string | null;
  kind: NotificationKind; token_ciphertext: string; token_hash: string; valid: boolean;
};
const SEND_TIMEOUT_MS = 15_000;
const SEND_CONCURRENCY = 10;
/** A timeout is an unknown outcome: it is not retryable, so it never replays an alert. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([p, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Push send timed out')), ms); })])
    .finally(() => clearTimeout(timer));
}
/** Durable outbox with committed claims. Ambiguous transport outcomes are never alerted again. */
export class PushDispatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> | null = null;
  constructor(private readonly ctx: AppContext) {}
  start(): void {
    this.timer = setInterval(() => { void this.dispatch().catch(() => this.ctx.log.warn('Push dispatch failed')); }, 2000);
    this.timer.unref();
    void this.dispatch().catch(() => this.ctx.log.warn('Push dispatch failed'));
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }
  async settle(): Promise<void> { await this.running; }
  dispatch(): Promise<void> {
    if (!this.ctx.push.configured) return Promise.resolve();
    this.running ??= this.batch().finally(() => { this.running = null; });
    return this.running;
  }
  private async send(d: Delivery, alert: PushAlert): Promise<void> {
    try {
      const outcome = await withTimeout(this.ctx.push.send({ token: this.ctx.config.secrets.decrypt(d.token_ciphertext),
        eventId: d.event_id, taskId: d.task_id, kind: d.kind, alert }), SEND_TIMEOUT_MS);
      if (outcome === 'invalid') await this.ctx.db.execute(sql`delete from push_devices where id = ${d.device_id}::uuid and token_hash = ${d.token_hash}`);
    } catch (err) {
      const attempts = d.attempts + 1;
      const retryable = err instanceof PushTransportError && err.retryable && attempts < 6;
      // Errors are logged by kind only: provider messages can embed a device token.
      this.ctx.log.warn({ eventId: d.event_id, retryable, transport: err instanceof PushTransportError }, 'Push delivery failed');
      if (!retryable) return;
      try {
        await this.ctx.db.execute(sql`update push_deliveries set finished_at = null,
          next_attempt_at = now() + ${Math.min(3600, 2 ** attempts * 10)} * interval '1 second' where ${this.key(d)}`);
      } catch {
        this.ctx.log.warn({ eventId: d.event_id }, 'Push retry could not be rescheduled');
      }
    }
  }
  private key(d: Delivery) {
    return sql`event_id = ${d.event_id} and user_id = ${d.user_id}::uuid and device_id = ${d.device_id}::uuid`;
  }
  private async batch(): Promise<void> {
    for (let round = 0; round < 5; round++) {
      const claimed: Delivery[] = [];
      let taken = 0;
      for (let i = 0; i < SEND_CONCURRENCY; i++) {
        const d = await this.ctx.db.transaction(async (tx) => {
          const rows = await tx.execute<Delivery>(sql`select d.event_id, d.user_id, d.device_id, d.attempts, d.token_hash, e.task_id, e.kind, v.token_ciphertext,
            ((case when e.kind like 'schedule.%' then true
                when e.kind = 'comment.mentioned' then not coalesce(p.muted, false)
                else coalesce(p.following, false) and not coalesce(p.muted, false) end) and u.active and not u.must_change_password
              and (e.kind <> 'comment.mentioned' or exists (select 1 from comments c
                where c.id::text = substring(e.id from 9) and c.deleted_at is null))
              and (e.kind like 'schedule.%' or st.category <> 'closed')
              and l.expires_at > now() and v.user_id = d.user_id and v.token_hash = d.token_hash
              and e.created_at > now() - interval '24 hours') as valid
            from push_deliveries d join notification_events e on e.id = d.event_id
            left join tasks t on t.id = e.task_id left join statuses st on st.id = t.status_id
            join push_devices v on v.id = d.device_id join users u on u.id = d.user_id
            join logins l on l.id = v.login_id
            left join task_preferences p on p.task_id = e.task_id and p.user_id = d.user_id
            where d.finished_at is null and d.next_attempt_at <= now()
            order by d.next_attempt_at limit 1 for update of d skip locked`);
          const delivery = rows.rows[0];
          if (!delivery) return null;
          // Reserve permanently BEFORE sending. A crash after provider acceptance must not replay an alert.
          // Only a definite rejection may reopen the claim. Unread remains authoritative if an alert is lost.
          await tx.execute(sql`update push_deliveries set finished_at = now(), attempts = attempts + 1 where ${this.key(delivery)}`);
          return delivery;
        });
        if (!d) break;
        taken++;
        if (d.valid) claimed.push(d);
      }
      // Built when sent, so the Alert shows the Task and Comment as they are now.
      const alerts = new Map<string, Promise<PushAlert | null>>();
      for (const d of claimed) if (!alerts.has(d.event_id)) alerts.set(d.event_id, buildAlert(this.ctx.db, d.event_id));
      await Promise.all(claimed.map(async (d) => {
        const alert = await alerts.get(d.event_id)!.catch(() => null);
        if (alert) await this.send(d, alert);
        else this.ctx.log.warn({ eventId: d.event_id }, 'Push alert could not be built');
      }));
      if (taken < SEND_CONCURRENCY) return;
    }
  }
}
