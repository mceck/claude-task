// The Board filter, shared so the server's list endpoint and the client's live
// cache updates agree on which cards match.
import type { Priority, TaskCard } from './domain';

export interface BoardFilter {
  /** User ids, or `none` for unassigned. Any of them matches. */
  assignees: string[];
  labels: string[];
  priorities: Priority[];
  text: string;
}

export const emptyBoardFilter: BoardFilter = { assignees: [], labels: [], priorities: [], text: '' };

export function isFilterActive(f: BoardFilter): boolean {
  return f.assignees.length > 0 || f.labels.length > 0 || f.priorities.length > 0 || f.text.trim() !== '';
}

/** Filter kinds combine with AND; values within one kind combine with OR. */
export function matchesBoardFilter(card: TaskCard, f: BoardFilter): boolean {
  if (f.assignees.length > 0) {
    const ok = f.assignees.some((a) =>
      a === 'none' ? card.assigneeIds.length === 0 : card.assigneeIds.includes(a),
    );
    if (!ok) return false;
  }
  if (f.labels.length > 0 && !f.labels.some((l) => card.labelIds.includes(l))) return false;
  if (f.priorities.length > 0 && !f.priorities.includes(card.priority)) return false;
  const text = f.text.trim().toLowerCase();
  if (text !== '' && !card.title.toLowerCase().includes(text) && !card.key.toLowerCase().includes(text)) {
    return false;
  }
  return true;
}
