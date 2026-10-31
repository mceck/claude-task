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
  /** Furthest from the corner first: new entries arrive nearest it, and the User drags them into their own order. */
  entries: DockEntry[];
  /** The entries reduced to their title bar. */
  collapsed: string[];
}

/** The most conversations the Dock keeps, however wide the screen. */
export const MAX_DOCK_ENTRIES = 6;
/** The most panels shown open at once; the ones furthest from the corner stay as title bars. */
export const MAX_OPEN_ENTRIES = 3;

const STORAGE_KEY = 'claude-task-chat-dock';

function parse(raw: string | null): DockState {
  if (!raw) return { entries: [], collapsed: [] };
  try {
    const value = JSON.parse(raw) as { entries?: unknown; collapsed?: unknown };
    const entries = (Array.isArray(value.entries) ? value.entries : []).filter(
      (entry): entry is DockEntry =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as DockEntry).taskId === 'string' &&
        ((entry as DockEntry).wikiId === undefined || typeof (entry as DockEntry).wikiId === 'string') &&
        ((entry as DockEntry).generation === undefined || typeof (entry as DockEntry).generation === 'number'),
    );
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

function commit(next: DockState): void {
  const ids = new Set(next.entries.map((entry) => entry.taskId));
  const collapsed = next.collapsed.filter((id) => ids.has(id));
  // Keep three open: a fourth panel collapses the open one furthest from the corner.
  const open = next.entries.map((entry) => entry.taskId).filter((id) => !collapsed.includes(id));
  for (const id of open.slice(0, Math.max(0, open.length - MAX_OPEN_ENTRIES))) collapsed.push(id);
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

/** Puts a conversation in the Dock, open, nearest the corner; drops the one furthest from it beyond the Dock's capacity. */
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

/** Gives a conversation another conversation's place in the row, e.g. when the User drags it there. */
export function moveInDock(activeId: string, overId: string): void {
  const from = state.entries.findIndex((entry) => entry.taskId === activeId);
  const to = state.entries.findIndex((entry) => entry.taskId === overId);
  if (from < 0 || to < 0 || from === to) return;
  const entries = [...state.entries];
  const [moved] = entries.splice(from, 1);
  entries.splice(to, 0, moved!);
  // Only the position changes: a dragged panel stays as open or as collapsed as it was.
  commit({ entries, collapsed: state.collapsed });
}

/** Shows or hides a Dock panel's conversation. */
export function toggleInDock(taskId: string): void {
  if (!state.entries.some((entry) => entry.taskId === taskId)) return;
  const collapsed = state.collapsed.includes(taskId)
    ? state.collapsed.filter((id) => id !== taskId)
    : [...state.collapsed, taskId];
  commit({ entries: state.entries, collapsed });
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
