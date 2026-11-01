import type { AgentRef, AgentState, ContextUsage, Delivery, SessionState, TaskSession } from '@claude-task/shared';
import { Check, CheckCheck, Clock, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

/** An Agent's uploaded image, or its emoji on its color. */
export function AgentAvatar({ agent, size = 'sm', state, className }: { agent: AgentRef; size?: 'xs' | 'sm' | 'md' | 'lg'; state?: SessionState | AgentState | null; className?: string }) {
  const box = { xs: 'size-5 text-[11px]', sm: 'size-6 text-xs', md: 'size-8 text-base', lg: 'size-11 text-xl' }[size];
  // A deleted or failed image falls back to the emoji, like the User and Project avatars do.
  const [imageFailed, setImageFailed] = useState(false);
  const image = agent.avatarImageUrl && !imageFailed ? agent.avatarImageUrl : null;
  return (
    <span title={agent.name} className={cn('relative inline-flex shrink-0', className)}>
      <span
        className={cn('flex items-center justify-center overflow-hidden rounded-lg ring-2 ring-background', box)}
        style={image ? undefined : { background: `color-mix(in oklch, ${agent.avatarColor} 30%, transparent)`, boxShadow: `inset 0 0 0 1px color-mix(in oklch, ${agent.avatarColor} 55%, transparent)` }}
      >
        {image ? (
          <img src={image} alt="" className="size-full object-cover" onError={() => setImageFailed(true)} />
        ) : (
          <span aria-hidden>{agent.avatarEmoji}</span>
        )}
      </span>
      {state && <StateDot state={state} className="absolute -right-0.5 -bottom-0.5" />}
    </span>
  );
}

// Hollow marks the waiting and inactive states (idle, offline, closed, disabled); every other state is filled.
const DOT: Record<string, string> = {
  running: 'bg-emerald-400',
  working: 'bg-emerald-400',
  pending: 'bg-sky-400',
  idle: 'border-[1.5px] border-emerald-400',
  paused: 'bg-amber-400',
  closed: 'border-[1.5px] border-muted-foreground/60',
  offline: 'border-[1.5px] border-muted-foreground/60',
  disabled: 'border-[1.5px] border-red-400',
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

/** Next to an Agent in a select: its state with the same dot as everywhere else (hollow green when free, pulsing green when busy, pulsing blue while building, red when failed or disabled, grey when offline). */
export function AgentStateDot({ agent }: { agent: { state: AgentState } }) {
  return <StateDot state={agent.state} className="shrink-0 ring-0" />;
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

/** Compact token counts: `120.2K`, `1.2M`, `940`. */
export function formatContextTokens(n: number): string {
  const one = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1));
  if (n >= 1_000_000) return `${one(n / 1_000_000)}M`;
  // Just below a million would read "1000K".
  if (n >= 999_950) return '1M';
  return n >= 1000 ? `${one(n / 1000)}K` : String(Math.round(n));
}

/** How full the conversation's context is, beside the Session chip: `120.2K (53%)`. */
export function ContextBadge({ context }: { context: ContextUsage }) {
  const pct = context.window ? Math.min(100, Math.round((context.tokens / context.window) * 100)) : null;
  const title = pct === null
    ? `Context: ${formatContextTokens(context.tokens)} tokens`
    : `Context: ${formatContextTokens(context.tokens)} of ${formatContextTokens(context.window!)} tokens (${pct}%)`;
  // Neutral until it fills up, then the usual warning and error tones.
  const tone =
    pct === null || pct < 70
      ? 'border-border bg-muted/40 text-muted-foreground'
      : pct < 90
        ? 'border-amber-500/30 bg-amber-500/10 text-amber-400'
        : 'border-red-500/30 bg-red-500/10 text-red-400';
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span aria-label={title} className={cn('inline-flex h-6 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium', tone)}>
          <span
            aria-hidden
            className="size-3 shrink-0 rounded-full"
            style={
              pct === null
                ? { background: 'color-mix(in oklch, currentColor 25%, transparent)' }
                : {
                    background: `conic-gradient(currentColor ${pct}%, color-mix(in oklch, currentColor 20%, transparent) 0)`,
                    maskImage: 'radial-gradient(circle, transparent 38%, black 40%)',
                    WebkitMaskImage: 'radial-gradient(circle, transparent 38%, black 40%)',
                  }
            }
          />
          {formatContextTokens(context.tokens)}
          {pct !== null && ` (${pct}%)`}
        </span>
      </TooltipTrigger>
      <TooltipContent>{title}</TooltipContent>
    </Tooltip>
  );
}

const clock = (iso: string | null) =>
  iso ? ` · ${new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : '';

/** The text behind a Delivery's ticks: its state, the Agent and when it changed. */
export function deliveryLabel(delivery: Delivery, agentName: string | null): string {
  const agent = agentName ?? 'the agent';
  switch (delivery.state) {
    case 'queued':
      return `Queued${clock(delivery.at)}`;
    case 'delivered':
      return `Delivered to ${agent}${clock(delivery.at)}`;
    case 'handled':
      return `Handled by ${agent}${clock(delivery.at)}`;
    case 'not_delivered':
      return `Not delivered${delivery.reason ? `: ${delivery.reason}` : ''}`;
  }
}

/** Whether a User's Comment reached the Agent, as chat-style ticks. */
export function DeliveryTicks({ delivery, agentName }: { delivery: Delivery; agentName: string | null }) {
  const { icon: Icon, className } = {
    queued: { icon: Clock, className: 'text-muted-foreground' },
    delivered: { icon: Check, className: 'text-muted-foreground' },
    handled: { icon: CheckCheck, className: 'text-primary' },
    not_delivered: { icon: TriangleAlert, className: 'text-amber-500' },
  }[delivery.state];
  const label = deliveryLabel(delivery, agentName);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span role="img" aria-label={`Delivery: ${label}`} data-delivery={delivery.state} className={cn('inline-flex items-center', className)}>
          <Icon className="size-3.5" />
        </span>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
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
