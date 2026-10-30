import type { ProjectSummary } from '@claude-task/shared';
import { MessageSquare } from 'lucide-react';
import { NavLink } from 'react-router';
import { progressBreakdown, progressCounts } from '@/lib/progress';
import { cn } from '@/lib/utils';
import { ProjectLogo } from './ProjectLogo';

export const navItem = ({ isActive }: { isActive: boolean }) =>
  cn(
    'flex h-8 items-center gap-2.5 rounded-md px-2.5 text-sm transition-colors',
    isActive
      ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground'
      : 'text-sidebar-foreground/70 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground',
  );

/**
 * A Project in the sidebar's Boards list: logo and name, a thin stacked bar of its
 * Task counts and, on the right, an Agent running dot and the unread Task count.
 */
export function ProjectNavItem({ project }: { project: ProjectSummary }) {
  const { counts, total } = progressCounts(project.taskCounts);
  const open = counts[0]!.count;
  const breakdown = progressBreakdown(counts);
  const { runningAgents, unreadTasks } = project.activity;
  return (
    <NavLink
      to={`/p/${project.key}`}
      className={({ isActive }) =>
        cn(
          'flex min-h-8 flex-col justify-center gap-1 rounded-md px-2.5 py-1 text-sm transition-colors',
          isActive
            ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground'
            : 'text-sidebar-foreground/70 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground',
        )
      }
    >
      <span className="flex w-full items-center gap-2.5">
        <ProjectLogo project={project} className="size-5" compact />
        <span className="truncate">{project.name}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {runningAgents > 0 && (
            <span
              title={runningAgents === 1 ? 'An Agent is running' : `${runningAgents} Agents are running`}
              aria-label={runningAgents === 1 ? 'An Agent is running' : `${runningAgents} Agents are running`}
              data-testid="sidebar-project-running"
              className="size-1.5 rounded-full bg-emerald-500 shadow-[0_0_4px_var(--color-emerald-500)]"
            />
          )}
          {unreadTasks > 0 && (
            <span
              title={`${unreadTasks} unread ${unreadTasks === 1 ? 'task' : 'tasks'}`}
              aria-label={`${unreadTasks} unread ${unreadTasks === 1 ? 'task' : 'tasks'}`}
              data-testid="sidebar-project-unread"
              className="flex items-center gap-1 text-[10px] font-semibold text-amber-500"
            >
              <MessageSquare aria-hidden className="size-3.5" strokeWidth={2.25} />
              {unreadTasks}
            </span>
          )}
        </span>
      </span>
      {total > 0 && (
        <span className="flex w-full items-center gap-2 pl-[30px]">
          <span
            className="flex h-[3px] flex-1 overflow-hidden rounded-full bg-sidebar-foreground/15"
            title={`Task counts: ${breakdown}`}
            aria-label={`Task counts: ${breakdown}`}
          >
            {counts.map((group) =>
              group.count > 0 ? (
                <span key={group.key} title={`${group.count} ${group.key}`} className={group.color} style={{ width: `${(group.count / total) * 100}%` }} />
              ) : null,
            )}
          </span>
          <span
            className="text-[10px] leading-none tabular-nums text-muted-foreground"
            title={`${open} open of ${total} ${total === 1 ? 'task' : 'tasks'} · ${breakdown}`}
            aria-label={`${open} open of ${total} ${total === 1 ? 'task' : 'tasks'}`}
          >
            {open}/{total}
          </span>
        </span>
      )}
    </NavLink>
  );
}
