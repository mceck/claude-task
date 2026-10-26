import type { AgentRef, AgentState, Delivery, SessionState, TaskSession } from '@claude-task/shared';
import { CircleCheck, CircleDashed, CircleSlash, Clock } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

/** An Agent's uploaded image, or its emoji on its color. */
export function AgentAvatar({ agent, size = 'sm', state, className }: { agent: AgentRef; size?: 'xs' | 'sm' | 'md' | 'lg'; state?: SessionState | AgentState | null; className?: string }) {
  const box = { xs: 'size-5 text-[11px]', sm: 'size-6 text-xs', md: 'size-8 text-base', lg: 'size-11 text-xl' }[size];
  return (
    <span title={agent.name} className={cn('relative inline-flex shrink-0', className)}>
      <span
        className={cn('flex items-center justify-center overflow-hidden rounded-lg ring-2 ring-background', box)}
        style={agent.avatarImageUrl ? undefined : { background: `color-mix(in oklch, ${agent.avatarColor} 30%, transparent)`, boxShadow: `inset 0 0 0 1px color-mix(in oklch, ${agent.avatarColor} 55%, transparent)` }}
      >
        {agent.avatarImageUrl ? (
          <img src={agent.avatarImageUrl} alt="" className="size-full object-cover" />
        ) : (
          <span aria-hidden>{agent.avatarEmoji}</span>
        )}
      </span>
      {state && <StateDot state={state} className="absolute -right-0.5 -bottom-0.5" />}
    </span>
  );
}

const DOT: Record<string, string> = {
  running: 'bg-emerald-400',
  working: 'bg-emerald-400',
  pending: 'bg-sky-400',
  idle: 'bg-muted-foreground/70',
  paused: 'bg-amber-400',
  closed: 'bg-muted-foreground/40',
  offline: 'bg-muted-foreground/40',
  disabled: 'bg-muted-foreground/40',
  building: 'bg-sky-400',
  build_failed: 'bg-red-500',
};

function StateDot({ state, className }: { state: string; className?: string }) {
  const live = state === 'running' || state === 'working' || state === 'building';
  return (
    <span className={cn('relative flex size-2.5 rounded-full ring-2 ring-background', DOT[state] ?? 'bg-muted-foreground', className)}>
      {live && <span className={cn('absolute inset-0 animate-ping rounded-full opacity-70', DOT[state])} />}
    </span>
  );
}

const AGENT_STATE_LABEL: Record<AgentState, string> = {
  idle: 'Idle',
  working: 'Working',
  offline: 'Offline',
  disabled: 'Disabled',
  building: 'Building',
  build_failed: 'Build failed',
};

export function AgentStateBadge({ state, taskKey }: { state: AgentState; taskKey?: string | null }) {
  const tone =
    state === 'working'
      ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
      : state === 'build_failed'
        ? 'border-red-500/30 bg-red-500/10 text-red-400'
        : state === 'building'
          ? 'border-sky-500/30 bg-sky-500/10 text-sky-400'
          : 'border-border bg-muted/40 text-muted-foreground';
  return (
    <span className={cn('inline-flex h-6 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium', tone)}>
      <StateDot state={state} className="size-1.5 ring-0" />
      {AGENT_STATE_LABEL[state]}
      {state === 'working' && taskKey && <span className="font-mono opacity-80">{taskKey}</span>}
    </span>
  );
}

/** "queued #2", "running", "waiting for messages", "paused", "closed". */
function sessionLabel(session: Pick<TaskSession, 'state' | 'queuePosition' | 'held'>): string {
  if (session.held) return 'waiting for retry';
  if (session.queuePosition) return `queued #${session.queuePosition}`;
  return { pending: 'starting', idle: 'waiting for messages', running: 'running', paused: 'paused', closed: 'closed' }[session.state];
}

export function SessionChip({ session }: { session: TaskSession }) {
  const label = sessionLabel(session);
  const tone =
    session.state === 'running'
      ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
      : session.held
        ? 'border-red-500/30 bg-red-500/10 text-red-400'
        : session.queuePosition
          ? 'border-sky-500/30 bg-sky-500/10 text-sky-400'
          : session.state === 'paused'
            ? 'border-amber-500/30 bg-amber-500/10 text-amber-400'
            : 'border-border bg-muted/40 text-muted-foreground';
  return (
    <span aria-label={`Session: ${label}`} className={cn('inline-flex h-6 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium', tone)}>
      <StateDot state={session.state} className="size-1.5 ring-0" />
      {label}
    </span>
  );
}

/** Whether a User's Comment reached the Agent. */
export function DeliveryBadge({ delivery }: { delivery: Delivery }) {
  const { icon: Icon, label, className } = {
    queued: { icon: Clock, label: 'Queued', className: 'text-sky-400' },
    delivered: { icon: CircleCheck, label: 'Delivered', className: 'text-emerald-400' },
    not_delivered: { icon: CircleSlash, label: 'Not delivered', className: 'text-muted-foreground' },
  }[delivery.state] ?? { icon: CircleDashed, label: delivery.state, className: '' };
  const badge = (
    <span aria-label={`Delivery: ${label}`} className={cn('inline-flex items-center gap-1 text-[11px]', className)}>
      <Icon className="size-3" /> {label}
    </span>
  );
  if (!delivery.reason) return badge;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{badge}</TooltipTrigger>
      <TooltipContent>{delivery.reason}</TooltipContent>
    </Tooltip>
  );
}

export function formatCost(usd: number | null | undefined): string {
  if (usd === null || usd === undefined) return '—';
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function formatTokens(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}
