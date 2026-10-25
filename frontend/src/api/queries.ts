import type {
  Agent,
  AgentBuild,
  AgentUsage,
  Credential,
  Job,
  JobDetail,
  ProjectAgentSettings,
  QueueEntry,
  RateLimitObservation,
  TaskSession,
  MeResponse,
  ProjectBundle,
  ProjectSummary,
  Task,
  TaskCard,
  TimelinePage,
  User,
} from '@claude-task/shared';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { get } from './client';

export const keys = {
  me: ['me'] as const,
  users: ['users'] as const,
  projects: (archived: boolean) => ['projects', { archived }] as const,
  project: (idOrKey: string) => ['project', idOrKey.toUpperCase()] as const,
  /** All cached board lists of a project share this prefix. */
  tasks: (projectId: string) => ['tasks', projectId] as const,
  board: (projectId: string, includeClosed: boolean) => ['tasks', projectId, { includeClosed }] as const,
  task: (idOrKey: string) => ['task', idOrKey.toUpperCase()] as const,
  timeline: (taskId: string) => ['timeline', taskId] as const,
  session: (taskId: string) => ['session', taskId] as const,
  agents: ['agents'] as const,
  agent: (id: string) => ['agent', id] as const,
  builds: (agentId: string) => ['builds', agentId] as const,
  queue: (agentId: string) => ['queue', agentId] as const,
  jobs: (agentId: string) => ['jobs', agentId] as const,
  job: (id: string) => ['job', id] as const,
  usage: (agentId: string) => ['usage', agentId] as const,
  logs: (agentId: string) => ['logs', agentId] as const,
  credentials: ['credentials'] as const,
  agentSettings: (projectId: string) => ['agent-settings', projectId] as const,
};

export function useMe() {
  return useQuery({
    queryKey: keys.me,
    queryFn: () => get<MeResponse>('/auth/me').then((r) => r.user),
    retry: false,
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
    enabled: !!projectId,
  });
}

export function useTask(idOrKey: string | undefined) {
  return useQuery({
    queryKey: keys.task(idOrKey ?? ''),
    queryFn: () => get<{ task: Task }>(`/tasks/${encodeURIComponent(idOrKey!)}`).then((r) => r.task),
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

// Agents (Spec 02)

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
export function useRepositories() {
  return useQuery({ queryKey: ['git-repositories'], queryFn: () => get<{ configured: boolean; repositories: import('@claude-task/shared').Repository[] }>('/git/repositories') });
}
export function useRepositorySettings(projectId: string) {
  return useQuery({ queryKey: ['repository-settings', projectId], queryFn: () => get<import('@claude-task/shared').RepositorySettings>(`/projects/${projectId}/repository`) });
}
export function useGitHubSettings(enabled: boolean) {
  return useQuery({ queryKey: ['github-settings'], queryFn: () => get<{ settings: import('@claude-task/shared').GitHubAppSettings }>('/git/github').then((r) => r.settings), enabled });
}
export function useGitInstallations(enabled: boolean) {
  return useQuery({ queryKey: ['git-installations'], queryFn: () => get<{ installations: import('@claude-task/shared').GitInstallation[] }>('/git/installations').then((r) => r.installations), enabled });
}
