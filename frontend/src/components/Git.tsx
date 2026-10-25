import type { ProjectRepository, PullRequest } from '@claude-task/shared';
import { GitBranch, GitMerge, GitPullRequest, GitPullRequestClosed, TriangleAlert } from 'lucide-react';
import { cn } from '@/lib/utils';

export function PullRequestBadge({ pr }: { pr: PullRequest }) {
  const label = pr.state === 'open' && pr.draft ? 'draft' : pr.state;
  const Icon = pr.state === 'merged' ? GitMerge : pr.state === 'closed' ? GitPullRequestClosed : GitPullRequest;
  return (
    <a
      href={pr.url}
      target="_blank"
      rel="noreferrer"
      onClick={(e) => e.stopPropagation()}
      aria-label={`Pull request #${pr.number}: ${label}`}
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]',
        pr.state === 'merged'
          ? 'border-violet-500/30 text-violet-400'
          : pr.state === 'closed'
            ? 'border-red-500/30 text-red-400'
            : pr.draft
              ? 'text-muted-foreground'
              : 'border-emerald-500/30 text-emerald-400',
      )}
    >
      <Icon className="size-3" /> #{pr.number} · {label}
    </a>
  );
}
export function BranchLink({ name, url }: { name: string; url: string }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="inline-flex max-w-full items-center gap-1.5 truncate font-mono text-xs text-muted-foreground hover:text-foreground"
    >
      <GitBranch className="size-3.5 shrink-0" /> {name}
    </a>
  );
}
export function ProtectionWarning({ repository, compact = false }: { repository: ProjectRepository | null; compact?: boolean }) {
  if (!repository || repository.protection.protected === true) return null;
  const text = `Agents run without guardrails. Require pull requests on ${repository.baseBranch} and do not grant the App direct-push bypass.`;
  return (
    <a
      href={repository.protection.settingsUrl}
      target="_blank"
      rel="noreferrer"
      aria-label="Base branch protection warning"
      title={text}
      className={cn('flex items-center gap-2 text-amber-500', !compact && 'rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm')}
    >
      <TriangleAlert className="size-4 shrink-0" />
      {!compact && (
        <span>
          {repository.protection.protected === null ? 'Protection is unknown. ' : 'Base branch is unprotected. '}
          {text}
        </span>
      )}
    </a>
  );
}
