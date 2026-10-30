// The Task's Runs: what the bar lists and the live transcript of each (docs/specs/clients.md#runs).
// Kept outside the query cache because messages arrive one by one, and per page session because the
// backend keeps transcripts in memory only.
import type { RealtimeEvent, RunInfo, RunMessage, RunSummary, RunTranscript } from '@claude-task/shared';
import { useSyncExternalStore } from 'react';

interface TaskRuns {
  runs: RunSummary[];
  /** Failures the reader closed in this page session. */
  dismissed: string[];
  transcripts: Record<string, RunTranscript>;
  /** Messages that arrived while a transcript was being fetched. */
  buffered: Record<string, RunMessage[]>;
  /** Runs whose transcript the reader can open. */
  wanted: string[];
  /** The Run whose dialog is open, from the bar or from its Timeline row. */
  open: string | null;
}

const EMPTY: TaskRuns = { runs: [], dismissed: [], transcripts: {}, buffered: {}, wanted: [], open: null };

const state = new Map<string, TaskRuns>();
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

function update(taskId: string, fn: (r: TaskRuns) => TaskRuns): void {
  state.set(taskId, fn(state.get(taskId) ?? EMPTY));
  notify();
}

/** Drops every Task's Runs, as on a lost connection: what the next snapshot brings is the truth. */
export function clearRuns(): void {
  if (state.size === 0) return;
  state.clear();
  notify();
}

/** Whether a Run still belongs in the bar: what runs now, and what failed until the reader closes it. */
export function inBar(r: RunSummary, dismissed: string[]): boolean {
  return r.status === 'running' || (r.status === 'error' && !dismissed.includes(r.id));
}

export function applyRunEvent(event: RealtimeEvent): void {
  switch (event.type) {
    case 'run.updated':
      return update(event.taskId, (r) => ({ ...r, runs: upsert(r.runs, event.run) }));
    case 'run.message':
      return update(event.taskId, (r) => {
        const transcript = r.transcripts[event.runId];
        if (transcript) return { ...r, transcripts: { ...r.transcripts, [event.runId]: merge(transcript, event.message) } };
        if (!r.wanted.includes(event.runId)) return r;
        // The snapshot isn't here yet: hold the message so it isn't lost when it lands.
        const held = [...(r.buffered[event.runId] ?? []), event.message].slice(-2_000);
        return { ...r, buffered: { ...r.buffered, [event.runId]: held } };
      });
    case 'timeline.reset':
      // The transcript still lives in the backend until the Job ends; only the bar starts over.
      return update(event.taskId, (r) => ({ ...r, runs: [] }));
    case 'task.removed':
      state.delete(event.taskId);
      return notify();
  }
}

/** Seeds the store with the Task's active Runs, when the page opens or the connection comes back. */
export function setActiveRuns(taskId: string, runs: RunSummary[]): void {
  update(taskId, (r) => {
    const listed = new Set(runs.map((run) => run.id));
    const merged = runs.reduce<RunSummary[]>((list, run) => upsert(list, run), r.runs);
    // Runs the endpoint no longer lists are gone from the backend; the finished ones the reader saw
    // in this page session stay, so their Timeline row still opens the dialog.
    return { ...r, runs: merged.filter((run) => listed.has(run.id) || run.status !== 'running') };
  });
}

export function dismissRun(taskId: string, runId: string): void {
  update(taskId, (r) => (r.dismissed.includes(runId) ? r : { ...r, dismissed: [...r.dismissed, runId] }));
}

/**
 * Opens a Run's dialog. The Timeline row passes its own Run, which seeds the store when the page
 * reloaded and the Run is no longer among the active ones.
 */
export function openRun(taskId: string, runId: string, trace?: RunInfo): void {
  update(taskId, (r) => ({
    ...r,
    runs: trace ? upsert(r.runs, { ...trace, id: runId }) : r.runs,
    open: runId,
    wanted: r.wanted.includes(runId) ? r.wanted : [...r.wanted, runId],
  }));
}

export function closeRun(taskId: string): void {
  update(taskId, (r) => ({ ...r, open: null }));
}

export function setTranscript(taskId: string, transcript: RunTranscript): void {
  update(taskId, (r) => {
    let merged = transcript;
    for (const message of r.buffered[transcript.id] ?? []) merged = merge(merged, message);
    const { [transcript.id]: _dropped, ...buffered } = r.buffered;
    return {
      ...r,
      runs: upsert(r.runs, { ...transcript.run, id: transcript.id }),
      transcripts: { ...r.transcripts, [transcript.id]: merged },
      buffered,
    };
  });
}

/** Numbers make merging exact: a tool result replaces its message, a new one appends. */
function merge(transcript: RunTranscript, message: RunMessage): RunTranscript {
  if (message.n < transcript.messages.length) {
    return { ...transcript, messages: transcript.messages.map((m) => (m.n === message.n ? message : m)) };
  }
  if (message.n > transcript.messages.length) return transcript;
  return { ...transcript, messages: [...transcript.messages, message], nextIndex: transcript.messages.length + 1 };
}

function upsert(runs: RunSummary[], run: RunSummary): RunSummary[] {
  return runs.some((r) => r.id === run.id) ? runs.map((r) => (r.id === run.id ? run : r)) : [...runs, run];
}

function useTaskRuns(taskId: string): TaskRuns {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state.get(taskId) ?? EMPTY,
  );
}

/** What the bar lists, in the backend's order: running first, then failures waiting to be read. */
export function useRunBar(taskId: string): RunSummary[] {
  const { runs, dismissed } = useTaskRuns(taskId);
  return runs.filter((r) => inBar(r, dismissed));
}

export function useRun(taskId: string, runId: string | null): RunSummary | null {
  const runs = useTaskRuns(taskId).runs;
  return runId === null ? null : (runs.find((r) => r.id === runId) ?? null);
}

export function useOpenRun(taskId: string): string | null {
  return useTaskRuns(taskId).open;
}

export function useRunTranscript(taskId: string, runId: string | null): RunTranscript | null {
  const transcripts = useTaskRuns(taskId).transcripts;
  return runId === null ? null : (transcripts[runId] ?? null);
}
