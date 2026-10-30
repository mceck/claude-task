import type { Category, CategoryCounts } from '@claude-task/shared';

/** The color of a Status Category, on Board columns and Project progress. */
export const CATEGORY_COLOR: Record<Category, string> = {
  backlog: 'bg-slate-500',
  open: 'bg-slate-400',
  active: 'bg-blue-500',
  review: 'bg-violet-500',
  done: 'bg-emerald-500',
  closed: 'bg-zinc-600',
};

/**
 * Project progress shows only open, review and done; backlog and active count as open,
 * and closed Tasks are left out.
 */
export const PROGRESS_GROUPS: { key: string; categories: Category[]; color: string }[] = [
  { key: 'open', categories: ['backlog', 'open', 'active'], color: CATEGORY_COLOR.open },
  { key: 'review', categories: ['review'], color: CATEGORY_COLOR.review },
  { key: 'done', categories: ['done'], color: CATEGORY_COLOR.done },
];

/** The progress groups' Task counts and their total. */
export function progressCounts(taskCounts: CategoryCounts) {
  const counts = PROGRESS_GROUPS.map((group) => ({
    ...group,
    count: group.categories.reduce((n, category) => n + taskCounts[category], 0),
  }));
  const total = counts.reduce((n, group) => n + group.count, 0);
  return { counts, total };
}

/** "5 open · 2 review · 1 done", for tooltips and accessible labels. */
export function progressBreakdown(counts: { key: string; count: number }[]) {
  const parts = counts.filter((group) => group.count > 0).map((group) => `${group.count} ${group.key}`);
  return parts.length > 0 ? parts.join(' · ') : 'No tasks';
}
