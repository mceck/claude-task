import type { RepositorySettings as Settings } from '@claude-task/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { errorMessage, post, put } from '../api/client';
import { useRepositories, useRepositorySettings, keys } from '../api/queries';
import { Field } from './AgentForm';
import { ErrorText, Loading, Time } from './common';
import { ProtectionWarning } from './Git';

export function RepositorySettings({ projectId }: { projectId: string }) {
  const query = useRepositorySettings(projectId);
  const repos = useRepositories();
  if (query.isPending || repos.isPending) return <Loading />;
  if (query.error || repos.error) return <ErrorText>{errorMessage(query.error ?? repos.error)}</ErrorText>;
  if (!repos.data.configured)
    return (
      <p className="rounded-xl border bg-card p-5 text-sm text-muted-foreground">
        An admin must configure the GitHub App in GitHub settings before a repository can be linked.
      </p>
    );
  return <RepositoryForm key={projectId} projectId={projectId} settings={query.data} repositories={repos.data.repositories} />;
}
function RepositoryForm({
  projectId,
  settings,
  repositories,
}: {
  projectId: string;
  settings: Settings;
  repositories: import('@claude-task/shared').Repository[];
}) {
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState(settings.repository?.providerRepoId ?? '');
  const [base, setBase] = useState(settings.repository?.baseBranch ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const refresh = async (result: Settings) => {
    qc.setQueryData(['repository-settings', projectId], result);
    await qc.invalidateQueries({ queryKey: ['project'] });
    await qc.invalidateQueries({ queryKey: keys.tasks(projectId) });
  };
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const result = await put<Settings>(`/projects/${projectId}/repository`, {
        providerRepoId: selected,
        ...(base.trim() ? { baseBranch: base.trim() } : {}),
      });
      await refresh(result);
      toast.success('Repository saved');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const recheck = async () => {
    setBusy(true);
    setError('');
    try {
      await refresh(await post<Settings>(`/projects/${projectId}/repository/check-protection`));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const currentId = settings.repository?.providerRepoId;
  return (
    <div className="space-y-4">
      <section className="space-y-4 rounded-xl border bg-card p-5">
        <h2 className="font-medium">Repository</h2>
        <ProtectionWarning repository={settings.repository} />
        {settings.hasOpenSessions && (
          <p role="status" className="text-sm text-muted-foreground">
            This project has non-closed sessions, including paused sessions. Close their tasks before changing the repository. The base branch can still be
            changed.
          </p>
        )}
        <form onSubmit={save} className="space-y-4">
          <Field label="Search repositories">
            <Input aria-label="Search repositories" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Organization or repository name" />
          </Field>
          <Field label="GitHub repository">
            <select
              aria-label="GitHub repository"
              className="h-9 w-full rounded-md border bg-background px-3 text-sm"
              required
              disabled={busy || settings.hasOpenSessions}
              value={selected}
              onChange={(e) => {
                setSelected(e.target.value);
                setBase(repositories.find((r) => r.providerRepoId === e.target.value)?.defaultBranch ?? '');
              }}
            >
              <option value="">Choose a repository</option>
              {repositories
                .filter((r) => r.providerRepoId === selected || `${r.owner}/${r.name}`.toLowerCase().includes(search.toLowerCase()))
                .map((r) => (
                  <option key={r.providerRepoId} value={r.providerRepoId}>
                    {r.owner}/{r.name}
                    {r.private ? ' (private)' : ''}
                  </option>
                ))}
            </select>
          </Field>
          <Field label="Base branch" hint="Defaults to the repository’s default branch. The branch must exist on GitHub.">
            <Input aria-label="Base branch" value={base} onChange={(e) => setBase(e.target.value)} maxLength={250} />
          </Field>
          {settings.repository && (
            <a className="block text-sm underline" href={settings.repository.webUrl} target="_blank" rel="noreferrer">
              {settings.repository.owner}/{settings.repository.name}
            </a>
          )}
          <Button type="submit" disabled={busy || !selected || (settings.hasOpenSessions && selected !== currentId)}>
            Save repository
          </Button>
        </form>
        {error && <ErrorText>{error}</ErrorText>}
      </section>
      {settings.repository && (
        <section className="space-y-3 rounded-xl border bg-card p-5">
          <h2 className="font-medium">Base branch protection</h2>
          <p className="text-sm">
            {settings.repository.protection.protected === true ? 'Protected' : settings.repository.protection.protected === false ? 'Unprotected' : 'Unknown'} ·{' '}
            {settings.repository.baseBranch}
          </p>
          <p className="text-sm text-muted-foreground">{settings.repository.protection.details}</p>
          <p className="text-xs text-muted-foreground">
            Checked <Time iso={settings.repository.protection.checkedAt} />
          </p>
          <Button variant="outline" disabled={busy} onClick={recheck}>
            Re-check protection
          </Button>
        </section>
      )}
    </div>
  );
}
