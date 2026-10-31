import { useSyncExternalStore } from 'react';

/** The kinds of Timeline entry a reader can hide. One viewer preference, shared by every Task of every Project. */
export interface HiddenTimelineItems {
  /** Revisions: the recorded field changes of the Task. */
  changes: boolean;
  /** The Agent's items: Thinking, Activity and tool calls, Runs, Turn Summaries and notices. */
  activity: boolean;
}

export const DEFAULT_HIDDEN_TIMELINE_ITEMS: HiddenTimelineItems = { changes: true, activity: false };

const STORAGE_KEY = 'timeline-hidden';

function readStored(): HiddenTimelineItems {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Partial<Record<keyof HiddenTimelineItems, unknown>> | null;
    return {
      changes: typeof parsed?.changes === 'boolean' ? parsed.changes : DEFAULT_HIDDEN_TIMELINE_ITEMS.changes,
      activity: typeof parsed?.activity === 'boolean' ? parsed.activity : DEFAULT_HIDDEN_TIMELINE_ITEMS.activity,
    };
  } catch {
    return DEFAULT_HIDDEN_TIMELINE_ITEMS;
  }
}

let current = readStored();
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function onStorage(event: StorageEvent) {
  if (event.key !== STORAGE_KEY) return;
  current = readStored();
  emit();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  // Another tab changed the preference: every open conversation follows it.
  if (listeners.size === 1) window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.removeEventListener('storage', onStorage);
  };
}

/** What the reader currently hides; changing it updates every Timeline on the page and in other tabs. */
export function useHiddenTimelineItems(): HiddenTimelineItems {
  return useSyncExternalStore(subscribe, () => current);
}

function store(next: HiddenTimelineItems) {
  current = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Private mode: the choice lasts for this page only.
  }
  emit();
}

export function setTimelineHidden(key: keyof HiddenTimelineItems, hidden: boolean) {
  if (current[key] !== hidden) store({ ...current, [key]: hidden });
}

export function showEverythingInTimeline() {
  store({ changes: false, activity: false });
}

/** The reader's choice in words, for the menu trigger: "Changes hidden", "Everything shown". */
export function hiddenTimelineLabel(hidden: HiddenTimelineItems): string {
  const hiddenKinds = [hidden.changes && 'Changes', hidden.activity && 'Activity'].filter(Boolean) as string[];
  return hiddenKinds.length ? `${hiddenKinds.join(' + ')} hidden` : 'Everything shown';
}
