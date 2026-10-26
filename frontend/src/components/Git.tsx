import { pullRequestNoun, pullRequestRef } from '@claude-task/shared';
import type { GitProviderKind, PullRequest } from '@claude-task/shared';
import { GitBranch, GitMerge, GitPullRequest, GitPullRequestClosed } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

/** Revisions recorded before GitLab support carry no provider: they're GitHub's. */
export const withProvider = <T extends { number: number; provider?: GitProviderKind }>(pr: T) => ({ ...pr, provider: pr.provider ?? 'github' });
export const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

export function PullRequestBadge({ pr: raw }: { pr: PullRequest }) {
  const pr = withProvider(raw);
  const label = pr.state === 'open' && pr.draft ? 'draft' : pr.state;
  const Icon = pr.state === 'merged' ? GitMerge : pr.state === 'closed' ? GitPullRequestClosed : GitPullRequest;
  return (
    <a
      href={pr.url}
      target="_blank"
      rel="noreferrer"
      onClick={(e) => e.stopPropagation()}
      aria-label={`${capitalize(pullRequestNoun(pr.provider))} ${pullRequestRef(pr)}: ${label}`}
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
      <Icon className="size-3" /> {pullRequestRef(pr)} · {label}
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
export const providerName = (provider: GitProviderKind) => (provider === 'gitlab' ? 'GitLab' : 'GitHub');
export function ProviderBadge({ provider }: { provider: GitProviderKind }) {
  return (
    <Badge variant="outline" className={cn('font-mono', provider === 'gitlab' ? 'text-orange-400' : 'text-foreground')}>
      {providerName(provider)}
    </Badge>
  );
}
