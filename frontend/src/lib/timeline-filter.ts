/** How much of the Timeline a reader wants to see. One button cycles through the three levels. */
export type TimelineFilter = 'changes' | 'activity' | 'all';

export interface TimelineFilterOption {
  value: TimelineFilter;
  /** What is hidden, as the button reads it. */
  label: string;
  /** The accessible name, spelling the level out in full. */
  name: string;
  /** What the next click does. */
  hint: string;
}

export const TIMELINE_FILTERS: readonly TimelineFilterOption[] = [
  {
    value: 'changes',
    label: 'Changes',
    name: 'Timeline filter: changes hidden',
    hint: 'Task changes are hidden. Click to hide agent activity and tool calls too.',
  },
  {
    value: 'activity',
    label: 'Changes + Activity',
    name: 'Timeline filter: changes and agent activity hidden',
    hint: 'Task changes, agent activity and tool calls are hidden. Click to show everything.',
  },
  {
    value: 'all',
    label: 'Everything',
    name: 'Timeline filter: everything shown',
    hint: 'Everything is shown. Click to hide task changes again.',
  },
];

export function timelineFilterOption(filter: TimelineFilter): TimelineFilterOption {
  return TIMELINE_FILTERS[TIMELINE_FILTERS.findIndex((f) => f.value === filter)] ?? TIMELINE_FILTERS[0]!;
}

/** The next level: changes hidden → also activity hidden → everything shown → changes hidden. */
export function nextTimelineFilter(filter: TimelineFilter): TimelineFilter {
  const i = TIMELINE_FILTERS.findIndex((f) => f.value === filter);
  return TIMELINE_FILTERS[(i + 1) % TIMELINE_FILTERS.length]!.value;
}
