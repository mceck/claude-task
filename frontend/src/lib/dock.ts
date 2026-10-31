// The Chat Dock: conversations minimized to the bottom of the screen, kept per browser like the Task layout.
// A conversation is either in the Dock or on a page, never both: opening one from the Dock removes it.
import { useSyncExternalStore } from 'react';

export interface DockEntry {
  /** The conversation's Task: a Task's own id, or the Task behind a Wiki Chat. */
  taskId: string;
  /** Set for a Wiki Chat, so it can be opened at its Wiki's address. */
  wikiId?: string;
  /** A Wiki Chat's conversation generation when it was minimized: a Delete Chat bumps it, and the panel goes. */
  generation?: number;
}

interface DockState {
  /** Oldest first: the newest sits nearest the screen corner. */
  entries: DockEntry[];
  /** The entries reduced to their title bar. */
  collapsed: string[];
}

/** The most conversations the Dock keeps, however wide the screen. */
export const MAX_DOCK_ENTRIES = 6;
/** The most panels shown open at once; older ones stay as title bars. */
export const MAX_OPEN_ENTRIES = 3;

const STORAGE_KEY = 'claude-task-chat-dock';

function parse(raw: string | null): DockState {
  if (!raw) return { entries: [], collapsed: [] };
  try {
    const value = JSON.parse(raw) as { entries?: unknown; collapsed?: unknown };
    const valid = (Array.isArray(value.entries) ? value.entries : []).filter(
      (entry): entry is DockEntry =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as DockEntry).taskId === 'string' &&
        (entry as DockEntry).taskId.length > 0 &&
        ((entry as DockEntry).wikiId === undefined || typeof (entry as DockEntry).wikiId === 'string') &&
        ((entry as DockEntry).generation === undefined || typeof (entry as DockEntry).generation === 'number'),
    );
    // One panel per conversation, the newest occurrence winning.
    const entries = [...new Map(valid.map((entry) => [entry.taskId, entry])).values()];
    const ids = new Set(entries.map((entry) => entry.taskId));
    const collapsed = (Array.isArray(value.collapsed) ? value.collapsed : []).filter(
      (id): id is string => typeof id === 'string' && ids.has(id),
    );
    return { entries: entries.slice(-MAX_DOCK_ENTRIES), collapsed };
  } catch {
    return { entries: [], collapsed: [] };
  }
}

function load(): DockState {
  try {
    return parse(localStorage.getItem(STORAGE_KEY));
  } catch {
    // Storage can be unavailable (private windows, a blocked origin): the Dock then lasts for the page.
    return { entries: [], collapsed: [] };
  }
}

let state: DockState = load();
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function commit(next: DockState, keepOpen?: string): void {
  const ids = new Set(next.entries.map((entry) => entry.taskId));
  const collapsed = next.collapsed.filter((id) => ids.has(id));
  // Keep the most recent open: a fourth panel collapses the oldest open one, but never the one just opened.
  const open = next.entries.map((entry) => entry.taskId).filter((id) => !collapsed.includes(id));
  let excess = Math.max(0, open.length - MAX_OPEN_ENTRIES);
  for (const id of open) {
    if (excess <= 0) break;
    if (id === keepOpen) continue;
    collapsed.push(id);
    excess--;
  }
  state = { entries: next.entries, collapsed };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Only a per-browser convenience: the default (nothing minimized) is fine without it.
  }
  for (const listener of listeners) listener();
}

/** The conversation's entries and which of them are collapsed. */
export function useDock(): DockState {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => state,
  );
}

/** Puts a conversation in the Dock, open, as the newest; drops the oldest beyond the Dock's capacity. */
export function minimizeInDock(entry: DockEntry): void {
  const entries = [...state.entries.filter((other) => other.taskId !== entry.taskId), entry];
  commit({
    entries: entries.slice(-MAX_DOCK_ENTRIES),
    collapsed: state.collapsed.filter((id) => id !== entry.taskId),
  });
}

/** Takes a conversation out of the Dock, e.g. because it is about to be shown on a page. */
export function removeFromDock(taskId: string): void {
  if (!state.entries.some((entry) => entry.taskId === taskId)) return;
  commit({ entries: state.entries.filter((entry) => entry.taskId !== taskId), collapsed: state.collapsed });
}

/** Shows or hides a Dock panel's conversation. */
export function toggleInDock(taskId: string): void {
  if (!state.entries.some((entry) => entry.taskId === taskId)) return;
  const opening = state.collapsed.includes(taskId);
  const collapsed = opening ? state.collapsed.filter((id) => id !== taskId) : [...state.collapsed, taskId];
  // The panel the user just opened stays open: the oldest other one makes room.
  commit({ entries: state.entries, collapsed }, opening ? taskId : undefined);
}

/** Another User may log in next in this browser. */
export function clearDock(): void {
  if (state.entries.length === 0) return;
  commit({ entries: [], collapsed: [] });
}

const DOCK_MEDIA = '(min-width: 768px)';

/** Whether the screen is wide enough for the Dock; below it, minimizing is not offered. */
export function useDockAvailable(): boolean {
  return useSyncExternalStore(
    (listener) => {
      const media = matchMedia(DOCK_MEDIA);
      media.addEventListener('change', listener);
      return () => media.removeEventListener('change', listener);
    },
    () => matchMedia(DOCK_MEDIA).matches,
    () => false,
  );
}
