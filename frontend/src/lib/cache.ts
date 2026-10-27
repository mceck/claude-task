// Applies real-time events to the TanStack Query caches.
import type { Agent, AgentBuild, Job, ProjectBundle, RealtimeEvent, Task, TaskCard, TimelineItem, TimelinePage, Topic } from '@claude-task/shared';
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

function isClosedStatus(qc: QueryClient, projectId: string, statusId: string): boolean {
  return findBundle(qc, projectId)?.statuses.find((s) => s.id === statusId)?.category === 'closed';
}

/** The newest version of the Task in any cached Board list or Task view, so older answers can't replace it. */
function cachedVersion(qc: QueryClient, card: TaskCard): number {
  const lists = qc.getQueriesData<TaskCard[]>({ queryKey: keys.tasks(card.projectId) }).flatMap(([, list]) => list ?? []);
  const views = qc.getQueriesData<Task>({ queryKey: ['task'] }).flatMap(([, t]) => (t ? [t] : []));
  return Math.max(-1, ...[...lists, ...views].filter((t) => t.id === card.id).map((t) => t.version));
}

/**
 * Puts the card in every cached Board list of its project (or takes it out of the ones hiding closed).
 * A card older than what's cached is ignored: HTTP answers can arrive after newer real-time events.
 */
export function upsertCard(qc: QueryClient, card: TaskCard): void {
  if (card.version < cachedVersion(qc, card)) return;
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

/** Replaces the cached Task unless the cache already has a newer version. */
export function setTask(qc: QueryClient, task: Task): void {
  qc.setQueriesData<Task>({ queryKey: ['task'] }, (t) => (t && t.id === task.id && t.version <= task.version ? task : t));
}

/** Whether `a` comes before `b` on the Timeline, newest first: the server's order (time, then kind and id). */
function newerThan(a: TimelineItem, b: TimelineItem): boolean {
  const at = Date.parse(a.createdAt);
  const bt = Date.parse(b.createdAt);
  if (at !== bt) return at > bt;
  return a.type !== b.type ? a.type > b.type : a.id > b.id;
}

/**
 * Replaces the item on the Timeline, or puts it in its place by time: events don't arrive in the order things
 * happened. An item older than everything loaded is left for "Load older activity" to bring.
 */
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
    const insert = (n: number, at: number) => ({
      ...data,
      pages: data.pages.map((p, i) => (i === n ? { ...p, items: [...p.items.slice(0, at), item, ...p.items.slice(at)] } : p)),
    });
    for (const [n, page] of data.pages.entries()) {
      const at = page.items.findIndex((i) => newerThan(item, i));
      if (at >= 0) return insert(n, at);
    }
    const last = data.pages.length - 1;
    if (last < 0 || data.pages[last]!.nextCursor) return data;
    return insert(last, data.pages[last]!.items.length);
  });
}

export function applyEvent(qc: QueryClient, event: RealtimeEvent): void {
  switch (event.type) {
    case 'wiki.changed':
      void qc.invalidateQueries({ queryKey: keys.wikis });
      void qc.invalidateQueries({ queryKey: keys.wiki(event.wikiId) });
      return;
    case 'timeline.reset':
      void qc.cancelQueries({ queryKey: keys.timeline(event.taskId) }, { revert: false });
      qc.setQueryData(keys.timeline(event.taskId), { pages: [{ items: [], nextCursor: null }], pageParams: [null] });
      void qc.invalidateQueries({ queryKey: keys.timeline(event.taskId) });
      void qc.invalidateQueries({ queryKey: keys.session(event.taskId) });
      return;
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
    case 'tags.changed':
      return updateBundles(qc, event.projectId, (b) => ({ ...b, tags: event.tags }));
    case 'project.updated':
      void qc.invalidateQueries({ queryKey: ['repository-settings', event.project.id] });
      updateBundles(qc, event.project.id, (b) => ({ ...b, project: event.project }));
      void qc.invalidateQueries({ queryKey: ['projects'] });
      return;
    case 'task.changed':
      setTask(qc, event.task);
      void qc.invalidateQueries({ queryKey: keys.session(event.task.id) });
      return;
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
    case 'session.changed':
      // An older HTTP snapshot must not overwrite this newer scheduling event.
      void qc.cancelQueries({ queryKey: keys.session(event.taskId), exact: true }, { revert: false });
      qc.setQueryData(keys.session(event.taskId), event.session);
      return;
    case 'agent_item.created':
    case 'agent_item.updated':
      return putTimelineItem(qc, event.item.taskId, { type: 'agent', id: event.item.id, createdAt: event.item.createdAt, item: event.item });
    case 'agent.updated':
      return upsertAgent(qc, event.agent);
    case 'agent.deleted':
      qc.setQueryData<Agent[]>(keys.agents, (list) => list?.filter((a) => a.id !== event.agentId));
      qc.removeQueries({ queryKey: keys.agent(event.agentId) });
      return;
    case 'queue.changed':
      qc.setQueryData(keys.queue(event.agentId), event.entries);
      return;
    case 'build.updated':
      qc.setQueryData<AgentBuild[]>(keys.builds(event.build.agentId), (list) => {
        if (!list) return list;
        const existing = list.find((b) => b.id === event.build.id);
        if (existing) return list.map((b) => (b.id === event.build.id ? { ...b, ...event.build } : b));
        return [{ ...event.build, log: '' }, ...list];
      });
      if (event.build.status !== 'building') void qc.invalidateQueries({ queryKey: keys.builds(event.build.agentId) });
      return;
    case 'build.log':
      qc.setQueryData<AgentBuild[]>(keys.builds(event.agentId), (list) =>
        list?.map((b) => (b.id === event.buildId ? { ...b, log: b.log + event.chunk } : b)),
      );
      return;
    case 'job.updated':
      qc.setQueryData<Job[]>(keys.jobs(event.job.agentId), (list) => {
        if (!list) return list;
        return list.some((j) => j.id === event.job.id) ? list.map((j) => (j.id === event.job.id ? event.job : j)) : [event.job, ...list];
      });
      void qc.invalidateQueries({ queryKey: keys.usage(event.job.agentId) });
      void qc.invalidateQueries({ queryKey: keys.job(event.job.id) });
      return;
  }
}

function upsertAgent(qc: QueryClient, agent: Agent): void {
  qc.setQueryData<Agent[]>(keys.agents, (list) => {
    if (!list) return list;
    const next = list.some((a) => a.id === agent.id) ? list.map((a) => (a.id === agent.id ? agent : a)) : [...list, agent];
    return next.sort((a, b) => a.name.localeCompare(b.name));
  });
  qc.setQueryData(keys.agent(agent.id), agent);
}


/** Refetches the queries a topic's events keep up to date. */
export function refreshTopic(qc: QueryClient, topic: Topic): void {
  const [kind, id] = topic.split(':') as ['project' | 'task' | 'agents' | 'agent', string];
  if (topic === 'wikis') {
    void qc.invalidateQueries({ queryKey: keys.wikis });
    void qc.invalidateQueries({ queryKey: ['wiki'] });
  } else if (kind === 'agents') {
    void qc.invalidateQueries({ queryKey: keys.agents });
  } else if (kind === 'agent') {
    for (const key of [keys.agent(id), keys.queue(id), keys.builds(id), keys.jobs(id), keys.usage(id)]) void qc.invalidateQueries({ queryKey: key });
  } else if (kind === 'project') {
    void qc.invalidateQueries({ queryKey: keys.tasks(id) });
    void qc.invalidateQueries({ queryKey: ['project'], predicate: (q) => (q.state.data as ProjectBundle | undefined)?.project.id === id });
  } else {
    void qc.invalidateQueries({ queryKey: ['task'], predicate: (q) => (q.state.data as Task | undefined)?.id === id });
    void qc.invalidateQueries({ queryKey: keys.timeline(id) });
    void qc.invalidateQueries({ queryKey: keys.session(id) });
  }
}
