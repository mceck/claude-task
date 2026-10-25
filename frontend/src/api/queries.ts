import type {
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
