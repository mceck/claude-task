// Unpersisted output of running Turns (text and thinking deltas, retry status, setup output),
// kept outside the query cache because it changes many times a second.
import type { RealtimeEvent } from '@claude-task/shared';
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
const listeners = new Set<() => void>();
/** Agent Comments that replaced an expanded live box. */
const expandedComments = new Set<string>();

export function clearLiveTurns(): void {
  state.clear();
  for (const listener of listeners) listener();
}

export function setLiveExpanded(taskId: string, expanded: boolean): void {
  update(taskId, (t) => ({ ...t, expanded }));
}

/** Whether this Agent Comment took over from a live box the reader had expanded. */
export function expandedFromLive(commentId: string): boolean {
  return expandedComments.has(commentId);
}

function update(taskId: string, fn: (t: LiveTurn) => LiveTurn) {
  state.set(taskId, fn(state.get(taskId) ?? EMPTY));
  for (const l of listeners) l();
}

export function applyLiveEvent(event: RealtimeEvent): void {
  switch (event.type) {
    case 'timeline.reset':
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
