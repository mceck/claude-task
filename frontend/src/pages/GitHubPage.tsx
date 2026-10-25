import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { errorMessage, put } from '../api/client';
import { useGitHubSettings, useGitInstallations, useMe, useRepositories } from '../api/queries';
import { Field } from '../components/AgentForm';
import { ErrorText, Loading } from '../components/common';
import { NotFoundPage } from './NotFoundPage';
import { PageHeader } from './ProjectsPage';

export function GitHubPage() {
  const admin = useMe().data?.role === 'admin';
  const settings = useGitHubSettings(admin);
  if (!admin) return <NotFoundPage />;
  if (settings.isPending) return <Loading />;
  if (settings.error) return <ErrorText>{errorMessage(settings.error)}</ErrorText>;
  return (
    <div className="mx-auto max-w-4xl space-y-6 px-8 py-8">
      <PageHeader
        title="GitHub App"
        description="Connect an App installed on your organization. Agent tokens are temporary and restricted to a single repository."
      />
      <GitHubForm key={`${settings.data.appId}:${settings.data.source}`} settings={settings.data} />
      {settings.data.configured && <AccessibleRepositories />}
    </div>
  );
}
function GitHubForm({ settings }: { settings: import('@claude-task/shared').GitHubAppSettings }) {
  const qc = useQueryClient();
  const [appId, setAppId] = useState(settings.appId ?? '');
  const [privateKey, setPrivateKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const env = settings.source === 'environment';
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await put('/git/github', { appId, ...(privateKey.trim() ? { privateKey } : {}) });
      setPrivateKey('');
      await Promise.all(['github-settings', 'git-installations', 'git-repositories'].map((k) => qc.invalidateQueries({ queryKey: [k] })));
      toast.success('GitHub App saved');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={save} className="space-y-4 rounded-xl border bg-card p-5">
      <h2 className="font-medium">App configuration</h2>
      <p className="text-sm text-muted-foreground">
        Grant Contents: read/write, Pull requests: read/write, Metadata: read and Administration: read. Do not grant the App a bypass for base branch
        protection.
      </p>
      {env && <p className="text-sm text-muted-foreground">Managed through GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY in the backend environment.</p>}
      <Field label="App ID">
        <Input aria-label="GitHub App ID" value={appId} onChange={(e) => setAppId(e.target.value)} pattern="[0-9]+" required disabled={env} />
      </Field>
      <Field
        label="Private key (PEM)"
        hint={
          settings.privateKeyConfigured
            ? 'A key is saved. Leave empty to keep it; it cannot be read back.'
            : 'Encrypted at rest. The saved key cannot be read back.'
        }
      >
        <Textarea
          aria-label="GitHub App private key"
          rows={7}
          className="font-mono text-xs"
          autoComplete="off"
          spellCheck={false}
          value={privateKey}
          onChange={(e) => setPrivateKey(e.target.value)}
          required={!settings.privateKeyConfigured}
          disabled={env}
        />
      </Field>
      {error && <ErrorText>{error}</ErrorText>}
      {!env && (
        <Button type="submit" disabled={busy}>
          Save GitHub App
        </Button>
      )}
    </form>
  );
}
function AccessibleRepositories() {
  const installations = useGitInstallations(true);
  const repos = useRepositories();
  const qc = useQueryClient();
  return (
    <section className="space-y-4 rounded-xl border bg-card p-5">
      <div className="flex items-center justify-between">
        <h2 className="font-medium">Installations & accessible repositories</h2>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            void qc.invalidateQueries({ queryKey: ['git-installations'] });
            void qc.invalidateQueries({ queryKey: ['git-repositories'] });
          }}
        >
          Refresh repositories
        </Button>
      </div>
      {installations.isPending || repos.isPending ? (
        <Loading />
      ) : installations.error || repos.error ? (
        <ErrorText>{errorMessage(installations.error ?? repos.error)}</ErrorText>
      ) : (
        <>
          <ul className="flex flex-wrap gap-3 text-sm">
            {installations.data.map((i) => (
              <li key={i.id}>
                <a className="underline" href={i.url} target="_blank" rel="noreferrer">
                  {i.account}
                </a>
              </li>
            ))}
          </ul>
          <ul className="divide-y rounded-lg border">
            {repos.data.repositories.map((r) => (
              <li key={r.providerRepoId} className="p-3 text-sm">
                <a href={r.webUrl} className="underline" target="_blank" rel="noreferrer">
                  {r.owner}/{r.name}
                </a>
                <span className="ml-2 text-xs text-muted-foreground">
                  {r.private ? 'private' : 'public'} · {r.defaultBranch}
                </span>
              </li>
            ))}
          </ul>
          {repos.data.repositories.length === 0 && (
            <p className="text-sm text-muted-foreground">No accessible repositories. Install the App and grant it access to your repositories.</p>
          )}
        </>
      )}
    </section>
  );
}
