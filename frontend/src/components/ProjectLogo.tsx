import type { Project } from '@claude-task/shared';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { cn } from '@/lib/utils';

export function ProjectLogo({ project, className, compact = false }: { project: Pick<Project, 'key' | 'name' | 'logoUrl'>; className?: string; compact?: boolean }) {
  return (
    <Avatar className={cn('rounded-lg after:rounded-lg', className)}>
      <AvatarImage className="rounded-lg object-contain" src={project.logoUrl ?? undefined} alt={`${project.name} logo`} />
      <AvatarFallback className="rounded-lg font-mono text-[10px]">{compact ? project.key.slice(0, 2) : project.key}</AvatarFallback>
    </Avatar>
  );
}
