import type { RepositoryGroup, RepositorySettings as Settings } from '@claude-task/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { errorMessage, post, put } from '../api/client';
import { useRepositoryGroups, useRepositorySettings, keys } from '../api/queries';
import { Field } from './AgentForm';
import { ErrorText, Loading, Time } from './common';
import { ProviderBadge, providerName } from './Git';

/** Picker values identify a Repository across connections. */
const optionValue = (connectionId: string, providerRepoId: string) => `${connectionId}:${providerRepoId}`;

export function RepositorySettings({ projectId }: { projectId: string }) {
  const query = useRepositorySettings(projectId);
  const groups = useRepositoryGroups();
  if (query.isPending || groups.isPending) return <Loading />;
  if (query.error || groups.error) return <ErrorText>{errorMessage(query.error ?? groups.error)}</ErrorText>;
  if (!groups.data.length)
    return (
      <p className="rounded-xl border bg-card p-5 text-sm text-muted-foreground">
        An admin must add a Git Connection (GitHub App or GitLab) in Git settings before a repository can be linked.
      </p>
    );
  return <RepositoryForm key={projectId} projectId={projectId} settings={query.data} groups={groups.data} />;
}
function RepositoryForm({ projectId, settings, groups }: { projectId: string; settings: Settings; groups: RepositoryGroup[] }) {
  const qc = useQueryClient();
  const current = settings.repository;
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState(current ? optionValue(current.connectionId, current.providerRepoId) : '');
  const [base, setBase] = useState(current?.baseBranch ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const find = (value: string) => {
    for (const g of groups) for (const r of g.repositories) if (optionValue(g.connection.id, r.providerRepoId) === value) return { group: g, repository: r };
    return null;
  };
  const choice = find(selected);
  const refresh = async (result: Settings) => {
    qc.setQueryData(['repository-settings', projectId], result);
    await qc.invalidateQueries({ queryKey: ['project'] });
    await qc.invalidateQueries({ queryKey: keys.tasks(projectId) });
  };
  const save = async (e: FormEvent) => {
    e.preventDefault();
    const [connectionId, providerRepoId] = [selected.slice(0, selected.lastIndexOf(':')), selected.slice(selected.lastIndexOf(':') + 1)];
    setBusy(true);
    setError('');
    try {
      const result = await put<Settings>(`/projects/${projectId}/repository`, {
        connectionId,
        providerRepoId,
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
  const currentValue = current ? optionValue(current.connectionId, current.providerRepoId) : undefined;
  const term = search.toLowerCase();
  const failing = groups.filter((g) => g.error);
  return (
    <div className="space-y-4">
      <section className="space-y-4 rounded-xl border bg-card p-5">
        <h2 className="font-medium">Repository</h2>
        {settings.hasOpenSessions && (
          <p role="status" className="text-sm text-muted-foreground">
            This project has non-closed sessions, including paused sessions. Close their tasks before changing the repository. The base branch can still be
            changed.
          </p>
        )}
        <form onSubmit={save} className="space-y-4">
          <Field label="Search repositories">
            <Input aria-label="Search repositories" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Owner, group or repository name" />
          </Field>
          <Field label="Repository" hint="Repositories of every Git Connection, grouped by connection.">
            <select
              aria-label="Repository"
              className="h-9 w-full rounded-md border bg-background px-3 text-sm"
              required
              disabled={busy || settings.hasOpenSessions}
              value={selected}
              onChange={(e) => {
                setSelected(e.target.value);
                setBase(find(e.target.value)?.repository.defaultBranch ?? '');
              }}
            >
              <option value="">Choose a repository</option>
              {groups
                .filter((g) => g.repositories.length)
                .map((g) => (
                  <optgroup key={g.connection.id} label={`${providerName(g.connection.provider)} · ${g.connection.name} · ${g.connection.host}`}>
                    {g.repositories
                      .filter((r) => optionValue(g.connection.id, r.providerRepoId) === selected || `${r.owner}/${r.name}`.toLowerCase().includes(term))
                      .map((r) => (
                        <option key={r.providerRepoId} value={optionValue(g.connection.id, r.providerRepoId)}>
                          {r.owner}/{r.name}
                          {r.private ? ' (private)' : ''}
                        </option>
                      ))}
                  </optgroup>
                ))}
            </select>
          </Field>
          {failing.length > 0 && (
            <ul aria-label="Unavailable connections" className="space-y-1 text-sm text-amber-500">
              {failing.map((g) => (
                <li key={g.connection.id}>
                  {g.connection.name} ({g.connection.host}): {g.error}
                </li>
              ))}
            </ul>
          )}
          <Field
            label="Base branch"
            hint={`Defaults to the repository’s default branch. The branch must exist on ${choice ? providerName(choice.group.connection.provider) : 'the provider'}.`}
          >
            <Input aria-label="Base branch" value={base} onChange={(e) => setBase(e.target.value)} maxLength={250} />
          </Field>
          {current && (
            <a className="flex items-center gap-2 text-sm underline" href={current.webUrl} target="_blank" rel="noreferrer">
              <ProviderBadge provider={current.provider} />
              {current.owner}/{current.name}
            </a>
          )}
          <Button type="submit" disabled={busy || !selected || (settings.hasOpenSessions && selected !== currentValue)}>
            Save repository
          </Button>
        </form>
        {error && <ErrorText>{error}</ErrorText>}
      </section>
      {current && (
        <section className="space-y-3 rounded-xl border bg-card p-5">
          <h2 className="font-medium">Base branch protection</h2>
          <p className="text-sm text-muted-foreground">
            Pushes to the base branch are always blocked by claude-task. Provider protection is an optional second line of defense.
          </p>
          <p className="text-sm" role="status" aria-label="Provider protection">
            {current.protection.protected === true ? 'Protected' : current.protection.protected === false ? 'Not protected' : 'Unknown'} · {current.baseBranch}
          </p>
          <p className="text-sm text-muted-foreground">{current.protection.details}</p>
          <p className="text-xs text-muted-foreground">
            Checked <Time iso={current.protection.checkedAt} /> ·{' '}
            <a className="underline" href={current.protection.settingsUrl} target="_blank" rel="noreferrer">
              {providerName(current.provider)} branch settings
            </a>
          </p>
          <Button variant="outline" disabled={busy} onClick={recheck}>
            Re-check protection
          </Button>
        </section>
      )}
    </div>
  );
}
