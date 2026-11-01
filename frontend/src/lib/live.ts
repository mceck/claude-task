// Unpersisted output of running Turns (text and thinking deltas, retry status, setup output),
// kept outside the query cache because it changes many times a second.
import type { ContextUsage, RealtimeEvent } from '@claude-task/shared';
import { useSyncExternalStore } from 'react';

interface LiveTurn {
  text: string;
  /** The reader expanded the text's box; the Comment that replaces it opens expanded too. */
  expanded: boolean;
  thinking: string;
  retrying: { attempt: number; maxRetries: number; error: string | null } | null;
  setup: { jobId: string; output: string } | null;
}

const EMPTY: LiveTurn = { text: '', expanded: false, thinking: '', retrying: null, setup: null };
const SETUP_CAP = 64 * 1024;

const state = new Map<string, LiveTurn>();
/**
 * The context size after the latest model call of a running Turn. Kept apart from `state` because
 * the Turn's end must not reset it, and applied over the stored Session context, which only moves
 * when a Turn ends.
 */
const contexts = new Map<string, ContextUsage>();
const listeners = new Set<() => void>();
/** Agent Comments that replaced an expanded live box. */
const expandedComments = new Set<string>();

export function clearLiveTurns(): void {
  state.clear();
  contexts.clear();
  for (const listener of listeners) listener();
}

export function setLiveExpanded(taskId: string, expanded: boolean): void {
  update(taskId, (t) => ({ ...t, expanded }));
}

/** Whether this Agent Comment took over from a live box the reader had expanded. */
export function expandedFromLive(commentId: string): boolean {
  return expandedComments.has(commentId);
}

/** The Session's stored context, replaced by the running Turn's latest measurement (keeping the stored window). */
export function useLiveContext(taskId: string, stored: ContextUsage | null | undefined, running = true): ContextUsage | null {
  const live = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => contexts.get(taskId),
  );
  // A Board card is not told when its Session stops, so it only trusts the live figure while the card says running.
  if (!live || !running) return stored ?? null;
  return { tokens: live.tokens, window: live.window ?? stored?.window ?? null };
}

function setContext(taskId: string, context: ContextUsage | null) {
  if (context) contexts.set(taskId, context);
  else if (!contexts.delete(taskId)) return;
  for (const l of listeners) l();
}

function update(taskId: string, fn: (t: LiveTurn) => LiveTurn) {
  state.set(taskId, fn(state.get(taskId) ?? EMPTY));
  for (const l of listeners) l();
}

export function applyLiveEvent(event: RealtimeEvent): void {
  switch (event.type) {
    case 'live.context':
      return setContext(event.taskId, event.context);
    case 'timeline.reset':
      setContext(event.taskId, null);
      return update(event.taskId, () => EMPTY);
    case 'live.delta':
      return update(event.taskId, (t) =>
        event.delta.kind === 'text' ? { ...t, text: t.text + event.delta.text } : { ...t, thinking: t.thinking + event.delta.text },
      );
    case 'live.status':
      return update(event.taskId, (t) => ({ ...t, retrying: event.status }));
    case 'job.setup_output':
      return update(event.taskId, (t) => ({
        ...t,
        setup: { jobId: event.jobId, output: ((t.setup?.jobId === event.jobId ? t.setup.output : '') + event.chunk).slice(-SETUP_CAP) },
      }));
    // The persisted version arrived: the live preview has done its job.
    case 'comment.created':
    case 'comment.updated':
      if (event.comment.kind !== 'agent') return;
      if (state.get(event.comment.taskId)?.expanded) expandedComments.add(event.comment.id);
      update(event.comment.taskId, (t) => ({ ...t, text: '', expanded: false }));
      return;
    case 'agent_item.created':
    case 'agent_item.updated':
      if (event.item.payload.kind === 'thinking') update(event.item.taskId, (t) => ({ ...t, thinking: '' }));
      if (event.item.payload.kind === 'turn_summary') update(event.item.taskId, () => EMPTY);
      if (event.item.payload.kind === 'activity') update(event.item.taskId, (t) => ({ ...t, text: '', expanded: false, setup: null }));
      return;
    case 'session.changed':
      // The stored context is current once the Session stops running.
      if (event.session?.state !== 'running') setContext(event.taskId, null);
      if (event.session?.state !== 'running') update(event.taskId, (t) => ({ ...EMPTY, setup: t.setup }));
      return;
  }
}

export function useLiveTurn(taskId: string): LiveTurn {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state.get(taskId) ?? EMPTY,
  );
}
