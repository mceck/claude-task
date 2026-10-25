// Unpersisted output of running Turns (text and thinking deltas, retry status, setup output),
// kept outside the query cache because it changes many times a second.
import type { RealtimeEvent } from '@claude-task/shared';
import { useSyncExternalStore } from 'react';

export interface LiveTurn {
  text: string;
  thinking: string;
  retrying: { attempt: number; maxRetries: number; error: string | null } | null;
  setup: { jobId: string; output: string } | null;
}

const EMPTY: LiveTurn = { text: '', thinking: '', retrying: null, setup: null };
const SETUP_CAP = 64 * 1024;

const state = new Map<string, LiveTurn>();
const listeners = new Set<() => void>();

export function clearLiveTurns(): void {
  state.clear();
  for (const listener of listeners) listener();
}

function update(taskId: string, fn: (t: LiveTurn) => LiveTurn) {
  state.set(taskId, fn(state.get(taskId) ?? EMPTY));
  for (const l of listeners) l();
}

export function applyLiveEvent(event: RealtimeEvent): void {
  switch (event.type) {
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
      if (event.comment.kind === 'agent') update(event.comment.taskId, (t) => ({ ...t, text: '' }));
      return;
    case 'agent_item.created':
    case 'agent_item.updated':
      if (event.item.payload.kind === 'thinking') update(event.item.taskId, (t) => ({ ...t, thinking: '' }));
      if (event.item.payload.kind === 'turn_summary') update(event.item.taskId, () => EMPTY);
      if (event.item.payload.kind === 'activity') update(event.item.taskId, (t) => ({ ...t, text: '', setup: null }));
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
