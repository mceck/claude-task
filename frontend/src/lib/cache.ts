// Applies real-time events to the TanStack Query caches.
import type { ProjectBundle, RealtimeEvent, Task, TaskCard, TimelineItem, TimelinePage, Topic } from '@claude-task/shared';
import type { InfiniteData, QueryClient } from '@tanstack/react-query';
import { keys } from '../api/queries';

type BoardKey = ReturnType<typeof keys.board>;
type Timeline = InfiniteData<TimelinePage, string | null>;

export function compareCards(a: TaskCard, b: TaskCard): number {
  // Plain string comparison matches the server's C-collated fractional keys.
  if (a.position !== b.position) return a.position < b.position ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function toCard(task: Task): TaskCard {
  const { description: _d, createdBy: _c, ...card } = task;
  return card;
}

function findBundle(qc: QueryClient, projectId: string): ProjectBundle | undefined {
  return qc
    .getQueriesData<ProjectBundle>({ queryKey: ['project'] })
    .map(([, data]) => data)
    .find((d) => d?.project.id === projectId);
}

function updateBundles(qc: QueryClient, projectId: string, fn: (b: ProjectBundle) => ProjectBundle) {
  qc.setQueriesData<ProjectBundle>({ queryKey: ['project'] }, (b) => (b && b.project.id === projectId ? fn(b) : b));
}

export function isClosedStatus(qc: QueryClient, projectId: string, statusId: string): boolean {
  return findBundle(qc, projectId)?.statuses.find((s) => s.id === statusId)?.category === 'closed';
}

/** Puts the card in every cached Board list of its project (or takes it out of the ones hiding closed). */
export function upsertCard(qc: QueryClient, card: TaskCard): void {
  const closed = isClosedStatus(qc, card.projectId, card.statusId);
  for (const [key] of qc.getQueriesData<TaskCard[]>({ queryKey: keys.tasks(card.projectId) })) {
    const { includeClosed } = (key as BoardKey)[2];
    qc.setQueryData<TaskCard[]>(key, (list) => {
      if (!list) return list;
      const rest = list.filter((t) => t.id !== card.id);
      return closed && !includeClosed ? rest : [...rest, card];
    });
  }
  qc.setQueriesData<Task>({ queryKey: ['task'] }, (t) => (t && t.id === card.id ? { ...t, ...card } : t));
}

export function removeCard(qc: QueryClient, projectId: string, taskId: string): void {
  qc.setQueriesData<TaskCard[]>({ queryKey: keys.tasks(projectId) }, (list) => list?.filter((t) => t.id !== taskId));
}

export function setTask(qc: QueryClient, task: Task): void {
  qc.setQueriesData<Task>({ queryKey: ['task'] }, (t) => (t && t.id === task.id ? task : t));
}

/** Adds a new item at the newest end of the Timeline, or replaces it if present. */
export function putTimelineItem(qc: QueryClient, taskId: string, item: TimelineItem): void {
  qc.setQueryData<Timeline>(keys.timeline(taskId), (data) => {
    if (!data) return data;
    const exists = data.pages.some((p) => p.items.some((i) => i.id === item.id));
    if (exists) {
      return {
        ...data,
        pages: data.pages.map((p) => ({ ...p, items: p.items.map((i) => (i.id === item.id ? item : i)) })),
      };
    }
    const [first, ...rest] = data.pages;
    if (!first) return data;
    return { ...data, pages: [{ ...first, items: [item, ...first.items] }, ...rest] };
  });
}

export function applyEvent(qc: QueryClient, event: RealtimeEvent): void {
  switch (event.type) {
    case 'task.created':
    case 'task.updated':
    case 'task.moved':
      return upsertCard(qc, event.task);
    case 'task.deleted':
      return removeCard(qc, event.projectId, event.taskId);
    case 'statuses.changed':
      updateBundles(qc, event.projectId, (b) => ({ ...b, statuses: event.statuses }));
      // Category changes can move cards in or out of the closed-hiding lists.
      void qc.invalidateQueries({ queryKey: keys.tasks(event.projectId) });
      return;
    case 'labels.changed':
      return updateBundles(qc, event.projectId, (b) => ({ ...b, labels: event.labels }));
    case 'project.updated':
      updateBundles(qc, event.project.id, (b) => ({ ...b, project: event.project }));
      void qc.invalidateQueries({ queryKey: ['projects'] });
      return;
    case 'task.changed':
      return setTask(qc, event.task);
    case 'task.removed':
      void qc.invalidateQueries({ queryKey: ['task'] });
      return;
    case 'comment.created':
    case 'comment.updated':
    case 'comment.deleted':
      return putTimelineItem(qc, event.comment.taskId, {
        type: 'comment',
        id: event.comment.id,
        createdAt: event.comment.createdAt,
        comment: event.comment,
      });
    case 'revision.created':
      return putTimelineItem(qc, event.revision.taskId, {
        type: 'revision',
        id: event.revision.id,
        createdAt: event.revision.createdAt,
        revision: event.revision,
      });
  }
}


/** Refetches the queries a topic's events keep up to date. */
export function refreshTopic(qc: QueryClient, topic: Topic): void {
  const [kind, id] = topic.split(':') as ['project' | 'task', string];
  if (kind === 'project') {
    void qc.invalidateQueries({ queryKey: keys.tasks(id) });
    void qc.invalidateQueries({ queryKey: ['project'], predicate: (q) => (q.state.data as ProjectBundle | undefined)?.project.id === id });
  } else {
    void qc.invalidateQueries({ queryKey: ['task'], predicate: (q) => (q.state.data as Task | undefined)?.id === id });
    void qc.invalidateQueries({ queryKey: keys.timeline(id) });
  }
}
