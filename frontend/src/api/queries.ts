import type {
  Schedule,
  ScheduleRun,
  Wiki,
  WikiChat,
  Agent,
  AgentBuild,
  AgentUsage,
  Credential,
  GitConnection,
  Job,
  JobDetail,
  ProjectAgentSettings,
  QueueEntry,
  RepositoryGroup,
  RepositorySettings,
  RateLimitObservation,
  TaskSession,
  McpServer,
  MeResponse,
  Plugin,
  ProjectBundle,
  ProjectSummary,
  Skill,
  Task,
  TaskAttachment,
  TaskCard,
  TaskPreference,
  TimelinePage,
  User,
} from '@claude-task/shared';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { get } from './client';

export const keys = {
  schedules: ['schedules'] as const,
  schedule: (id: string) => ['schedules', id] as const,
  scheduleRuns: (id: string) => ['schedules', id, 'runs'] as const,
  wikis: ['wikis'] as const,
  wiki: (id: string) => ['wiki', id] as const,
  /** Under the wiki key, so a wiki change refetches it too. */
  wikiChats: (id: string) => ['wiki', id, 'chats'] as const,
  me: ['me'] as const,
  users: ['users'] as const,
  projects: (archived: boolean) => ['projects', { archived }] as const,
  project: (idOrKey: string) => ['project', idOrKey.toUpperCase()] as const,
  /** All cached board lists of a project share this prefix. */
  tasks: (projectId: string) => ['tasks', projectId] as const,
  board: (projectId: string, includeClosed: boolean) => ['tasks', projectId, { includeClosed }] as const,
  task: (idOrKey: string) => ['task', idOrKey.toUpperCase()] as const,
  /** The asking User's private state for every Task of a Project. */
  taskPreferences: (projectId: string) => ['task-preferences', projectId] as const,
  timeline: (taskId: string) => ['timeline', taskId] as const,
  /** Every file of a Task: its description's and its Comments'. */
  attachments: (taskId: string) => ['task-attachments', taskId] as const,
  session: (taskId: string) => ['session', taskId] as const,
  /** The Task's active Runs; the transcripts live in the backend's memory only. */
  runs: (taskId: string) => ['runs', taskId] as const,
  run: (taskId: string, runId: string) => ['runs', taskId, runId] as const,
  agents: ['agents'] as const,
  agent: (id: string) => ['agent', id] as const,
  builds: (agentId: string) => ['builds', agentId] as const,
  queue: (agentId: string) => ['queue', agentId] as const,
  jobs: (agentId: string) => ['jobs', agentId] as const,
  job: (id: string) => ['job', id] as const,
  usage: (agentId: string) => ['usage', agentId] as const,
  logs: (agentId: string) => ['logs', agentId] as const,
  credentials: ['credentials'] as const,
  skills: ['skills'] as const,
  mcpServers: ['mcp-servers'] as const,
  plugins: ['plugins'] as const,
  agentSettings: (projectId: string) => ['agent-settings', projectId] as const,
};

export function useMe() {
  return useQuery({
    queryKey: keys.me,
    queryFn: () => get<MeResponse>('/auth/me').then((r) => r.user),
    // The shared retry rule already stops on 401/403 while retrying transient failures.
    staleTime: 60_000,
  });
}

export function useUsers() {
  return useQuery({
    queryKey: keys.users,
    queryFn: () => get<{ users: User[] }>('/users').then((r) => r.users),
    staleTime: 60_000,
  });
}

export function useProjects(archived: boolean) {
  return useQuery({
    queryKey: keys.projects(archived),
    queryFn: () => get<{ projects: ProjectSummary[] }>(`/projects?archived=${archived}`).then((r) => r.projects),
    // The list is not on a live topic: keep the activity badges fresh while it is open.
    refetchInterval: 15_000,
  });
}

export function useProject(idOrKey: string | undefined) {
  return useQuery({
    queryKey: keys.project(idOrKey ?? ''),
    queryFn: () => get<ProjectBundle>(`/projects/${encodeURIComponent(idOrKey!)}`),
    enabled: !!idOrKey,
  });
}

export function useBoardTasks(projectId: string | undefined, includeClosed: boolean) {
  return useQuery({
    queryKey: keys.board(projectId ?? '', includeClosed),
    queryFn: () =>
      get<{ tasks: TaskCard[] }>(`/projects/${projectId}/tasks?includeClosed=${includeClosed}`).then((r) => r.tasks),
    // A snapshot started before a real-time update cannot replace the newer card.
    structuralSharing: (old, next) => {
      if (!old) return next as TaskCard[];
      const previous = new Map((old as TaskCard[]).map((card) => [card.id, card]));
      return (next as TaskCard[]).map((card) => {
        const cached = previous.get(card.id);
        return cached && cached.version > card.version ? cached : card;
      });
    },
    enabled: !!projectId,
  });
}

export function useTaskPreferences(projectId: string | undefined) {
  return useQuery({
    queryKey: keys.taskPreferences(projectId ?? ''),
    queryFn: () =>
      get<{ preferences: TaskPreference[] }>(`/projects/${projectId}/task-preferences`).then((r) => r.preferences),
    enabled: !!projectId,
  });
}

export function useTask(idOrKey: string | undefined) {
  return useQuery({
    queryKey: keys.task(idOrKey ?? ''),
    queryFn: () => get<{ task: Task }>(`/tasks/${encodeURIComponent(idOrKey!)}`).then((r) => r.task),
    // A refetch started before a WebSocket update can land after it: never go back to an older version.
    structuralSharing: (old, next) => ((old as Task | undefined)?.version ?? -1) > (next as Task).version ? (old as Task) : (next as Task),
    enabled: !!idOrKey,
    retry: (count, err) => (err as { status?: number }).status !== 404 && count < 2,
  });
}

export function useTimeline(taskId: string | undefined) {
  return useInfiniteQuery({
    queryKey: keys.timeline(taskId ?? ''),
    queryFn: ({ pageParam }) =>
      get<TimelinePage>(`/tasks/${taskId}/timeline?limit=50${pageParam ? `&before=${pageParam}` : ''}`),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled: !!taskId,
  });
}

export function useTaskAttachments(taskId: string | undefined) {
  return useQuery({
    queryKey: keys.attachments(taskId ?? ''),
    queryFn: () =>
      get<{ attachments: TaskAttachment[] }>(`/tasks/${taskId}/attachments`).then((r) => r.attachments),
    enabled: !!taskId,
  });
}

// Agents (docs/specs/agents.md)

export function useAgents() {
  return useQuery({ queryKey: keys.agents, queryFn: () => get<{ agents: Agent[] }>('/agents').then((r) => r.agents), staleTime: 30_000 });
}

export function useAgent(id: string | undefined) {
  return useQuery({
    queryKey: keys.agent(id ?? ''),
    queryFn: () => get<{ agent: Agent }>(`/agents/${id}`).then((r) => r.agent),
    enabled: !!id,
  });
}

export function useBuilds(agentId: string) {
  return useQuery({ queryKey: keys.builds(agentId), queryFn: () => get<{ builds: AgentBuild[] }>(`/agents/${agentId}/builds`).then((r) => r.builds) });
}

export function useQueue(agentId: string) {
  return useQuery({ queryKey: keys.queue(agentId), queryFn: () => get<{ entries: QueueEntry[] }>(`/agents/${agentId}/queue`).then((r) => r.entries) });
}

export function useJobs(agentId: string) {
  return useQuery({ queryKey: keys.jobs(agentId), queryFn: () => get<{ jobs: Job[] }>(`/agents/${agentId}/jobs`).then((r) => r.jobs) });
}

export function useJob(id: string | null) {
  return useQuery({ queryKey: keys.job(id ?? ''), queryFn: () => get<{ job: JobDetail }>(`/jobs/${id}`).then((r) => r.job), enabled: !!id });
}

export function useUsage(agentId: string) {
  return useQuery({
    queryKey: keys.usage(agentId),
    queryFn: () => get<AgentUsage & { rateLimit: RateLimitObservation | null }>(`/agents/${agentId}/usage`),
  });
}

/** Container logs, polled while shown. */
export function useContainerLogs(agentId: string, enabled: boolean) {
  return useQuery({
    queryKey: keys.logs(agentId),
    queryFn: () => get<{ logs: string }>(`/agents/${agentId}/logs?tail=500`).then((r) => r.logs),
    enabled,
    refetchInterval: enabled ? 3000 : false,
  });
}

export function useCredentials(enabled = true) {
  return useQuery({ queryKey: keys.credentials, queryFn: () => get<{ credentials: Credential[] }>('/credentials').then((r) => r.credentials), enabled });
}

export function useSkills() {
  return useQuery({ queryKey: keys.skills, queryFn: () => get<{ skills: Skill[] }>('/skills').then((r) => r.skills) });
}
export function usePlugins() {
  return useQuery({ queryKey: keys.plugins, queryFn: () => get<{ plugins: Plugin[] }>('/plugins').then((r) => r.plugins) });
}
export function useMcpServers() {
  return useQuery({ queryKey: keys.mcpServers, queryFn: () => get<{ mcpServers: McpServer[] }>('/mcp-servers').then((r) => r.mcpServers) });
}

export function useTaskSession(taskId: string | undefined) {
  return useQuery({
    queryKey: keys.session(taskId ?? ''),
    queryFn: () => get<{ session: TaskSession | null }>(`/tasks/${taskId}/session`).then((r) => r.session),
    enabled: !!taskId,
  });
}

export function useAgentSettings(projectId: string) {
  return useQuery({
    queryKey: keys.agentSettings(projectId),
    queryFn: () => get<{ settings: ProjectAgentSettings }>(`/projects/${projectId}/agent-settings`).then((r) => r.settings),
  });
}

// Git Integration
export function useRepositoryGroups() {
  return useQuery({ queryKey: ['git-repositories'], queryFn: () => get<{ groups: RepositoryGroup[] }>('/git/repositories').then((r) => r.groups) });
}
export function useRepositorySettings(projectId: string) {
  return useQuery({ queryKey: ['repository-settings', projectId], queryFn: () => get<RepositorySettings>(`/projects/${projectId}/repository`) });
}
export function useGitConnections(enabled: boolean) {
  return useQuery({ queryKey: ['git-connections'], queryFn: () => get<{ connections: GitConnection[] }>('/git/connections').then((r) => r.connections), enabled });
}

export function useSchedules() {
  return useQuery({ queryKey: keys.schedules, queryFn: () => get<{ schedules: Schedule[] }>('/schedules').then((r) => r.schedules) });
}
export function useSchedule(id: string | undefined) {
  return useQuery({
    queryKey: keys.schedule(id ?? ''),
    queryFn: () => get<{ schedule: Schedule }>(`/schedules/${id}`).then((r) => r.schedule),
    enabled: !!id,
  });
}
export function useScheduleRuns(id: string | undefined) {
  return useQuery({
    queryKey: keys.scheduleRuns(id ?? ''),
    queryFn: () => get<{ runs: ScheduleRun[] }>(`/schedules/${id}/runs`).then((r) => r.runs),
    enabled: !!id,
  });
}

export function useWikis() {
  return useQuery({ queryKey: keys.wikis, queryFn: () => get<{ wikis: Wiki[] }>('/wikis').then((r) => r.wikis) });
}
export function useWiki(id: string | undefined) {
  return useQuery({
    queryKey: keys.wiki(id ?? ''),
    queryFn: () => get<{ wiki: Wiki }>(`/wikis/${id}`).then((r) => r.wiki),
    enabled: !!id,
  });
}
export function useWikiChats(id: string | undefined) {
  return useQuery({
    queryKey: keys.wikiChats(id ?? ''),
    queryFn: () => get<{ chats: WikiChat[] }>(`/wikis/${id}/chats`).then((r) => r.chats),
    enabled: !!id,
  });
}
