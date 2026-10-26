import type { GitConnection, GitProviderKind } from '@claude-task/shared';
import { useQueryClient } from '@tanstack/react-query';
import { Plus, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { del, errorMessage, patch, post } from '../api/client';
import { useGitConnections, useMe } from '../api/queries';
import { Field, ErrorText, Loading, useConfirm } from '../components/common';
import { ProviderBadge, providerName } from '../components/Git';
import { NotFoundPage } from './NotFoundPage';
import { PageHeader } from './ProjectsPage';

const date = (iso: string) => new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

export function GitConnectionsPage() {
  const admin = useMe().data?.role === 'admin';
  const connections = useGitConnections(admin);
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [editing, setEditing] = useState<GitConnection | 'new' | null>(null);
  if (!admin) return <NotFoundPage />;
  const refresh = () => Promise.all(['git-connections', 'git-repositories'].map((k) => qc.invalidateQueries({ queryKey: [k] })));
  const remove = async (c: GitConnection) => {
    if (
      !(await confirm({
        title: `Delete ${c.name}?`,
        description: 'Its repositories can no longer be linked. Projects must link elsewhere first.',
        confirmLabel: 'Delete connection',
        destructive: true,
      }))
    )
      return;
    try {
      await del(`/git/connections/${c.id}`);
      await refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };
  return (
    <div className="mx-auto max-w-4xl px-8 py-8">
      <PageHeader
        title="Git connections"
        description="GitHub Apps and GitLab instances the platform reaches repositories through. Agents never get these credentials: their git traffic goes through the backend."
      >
        <Button onClick={() => setEditing('new')}>
          <Plus /> Add connection
        </Button>
      </PageHeader>
      {connections.isPending ? (
        <Loading />
      ) : connections.error ? (
        <ErrorText>{errorMessage(connections.error)}</ErrorText>
      ) : (
        <div className="space-y-3">
          {!connections.data.length && <p className="rounded-xl border border-dashed p-8 text-center text-muted-foreground">No Git connections yet.</p>}
          {connections.data.map((c) => (
            <ConnectionCard key={c.id} connection={c} onEdit={() => setEditing(c)} onDelete={() => remove(c)} />
          ))}
        </div>
      )}
      <Dialog open={!!editing} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing === 'new' ? 'Add connection' : 'Edit connection'}</DialogTitle>
            <DialogDescription>Secrets are encrypted at rest and can’t be read back.</DialogDescription>
          </DialogHeader>
          {editing && (
            <ConnectionForm
              key={editing === 'new' ? 'new' : editing.id}
              connection={editing === 'new' ? undefined : editing}
              onSaved={async () => {
                await refresh();
                setEditing(null);
              }}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ConnectionCard({ connection: c, onEdit, onDelete }: { connection: GitConnection; onEdit: () => void; onDelete: () => void }) {
  const env = c.source === 'environment';
  return (
    <section aria-label={c.name} className="space-y-3 rounded-xl border bg-card p-5">
      <div className="flex items-center gap-3">
        <ProviderBadge provider={c.provider} />
        <div className="min-w-0 flex-1">
          <h2 className="font-medium">{c.name}</h2>
          <p className="text-xs text-muted-foreground">
            {c.host}
            {c.appId && <> · App {c.appId}</>}
            {c.secretLast4 && (
              <>
                {' '}
                · token <span className="font-mono">…{c.secretLast4}</span>
              </>
            )}
            {c.expiresAt && <> · expires {date(c.expiresAt)}</>}
          </p>
        </div>
        {env ? (
          <Badge variant="outline" title="Managed through the backend environment">
            Environment · read-only
          </Badge>
        ) : (
          <>
            <Button variant="outline" size="sm" onClick={onEdit}>
              Edit / rotate
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={c.linkedProjects > 0}
              title={c.linkedProjects ? 'Projects link its repositories; link them elsewhere first.' : undefined}
              onClick={onDelete}
            >
              Delete
            </Button>
          </>
        )}
      </div>
      {c.health.state === 'error' && <ErrorText>{c.health.message}</ErrorText>}
      {c.health.state === 'expiring' && (
        <p role="alert" className="flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-500">
          <TriangleAlert className="size-4 shrink-0" /> {c.health.message} (expires {date(c.health.expiresAt)})
        </p>
      )}
      <p className="text-sm text-muted-foreground">
        {c.provider === 'github' ? 'Installations' : 'Works as'}:{' '}
        {c.access.length
          ? c.access.map((a, i) => (
              <span key={a.url}>
                {i > 0 && ', '}
                <a className="underline" href={a.url} target="_blank" rel="noreferrer">
                  {a.label}
                </a>
              </span>
            ))
          : 'none'}{' '}
        · {c.linkedProjects === 1 ? '1 linked project' : `${c.linkedProjects} linked projects`}
      </p>
    </section>
  );
}

function ConnectionForm({ connection, onSaved }: { connection?: GitConnection; onSaved: () => Promise<void> }) {
  const [provider, setProvider] = useState<GitProviderKind>(connection?.provider ?? 'github');
  const [name, setName] = useState(connection?.name ?? '');
  const [appId, setAppId] = useState(connection?.appId ?? '');
  const [baseUrl, setBaseUrl] = useState(connection?.baseUrl ?? 'https://gitlab.com');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (connection) {
        const credential = secret.trim() ? (provider === 'github' ? { privateKey: secret } : { token: secret.trim() }) : {};
        await patch(`/git/connections/${connection.id}`, { name, ...(provider === 'github' && appId !== connection.appId ? { appId } : {}), ...credential });
      } else
        await post(
          '/git/connections',
          provider === 'github' ? { provider, name, appId, privateKey: secret } : { provider, name, baseUrl: baseUrl.trim(), token: secret.trim() },
        );
      setSecret('');
      await onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const keep = connection ? 'Leave empty to keep the current one; it can’t be read back.' : 'Encrypted at rest; it can’t be read back.';
  return (
    <form onSubmit={submit} className="space-y-4">
      <Field label="Provider">
        <select
          aria-label="Provider"
          className="h-9 w-full rounded-md border bg-background px-3 text-sm"
          value={provider}
          disabled={!!connection}
          onChange={(e) => setProvider(e.target.value as GitProviderKind)}
        >
          <option value="github">GitHub App</option>
          <option value="gitlab">GitLab (gitlab.com or self-managed)</option>
        </select>
      </Field>
      <Field label="Name">
        <Input aria-label="Connection name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required placeholder={providerName(provider)} />
      </Field>
      {provider === 'github' ? (
        <>
          <p className="text-sm text-muted-foreground">
            Grant Contents: read/write, Pull requests: read/write and Metadata: read. Administration: read is optional (it shows provider branch protection).
          </p>
          <Field label="App ID">
            <Input aria-label="GitHub App ID" value={appId} onChange={(e) => setAppId(e.target.value)} pattern="[0-9]+" required />
          </Field>
          <Field label={connection ? 'New private key (PEM)' : 'Private key (PEM)'} hint={keep}>
            <Textarea
              aria-label="GitHub App private key"
              rows={7}
              className="font-mono text-xs"
              autoComplete="off"
              spellCheck={false}
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              required={!connection}
            />
          </Field>
        </>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            Use a token with the api and write_repository scopes, ideally a service account’s with Developer access to the projects to link. Tokens saved here
            are rotated automatically before they expire.
          </p>
          <Field label="GitLab URL" hint={connection ? 'Fixed once created: add a new connection to use another instance.' : undefined}>
            <Input aria-label="GitLab URL" type="url" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} required disabled={!!connection} />
          </Field>
          <Field label={connection ? 'New token' : 'Token'} hint={keep}>
            <Input
              aria-label="GitLab token"
              type="password"
              autoComplete="new-password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              maxLength={500}
              required={!connection}
            />
          </Field>
        </>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <Button type="submit" disabled={busy}>
        {busy ? 'Saving…' : 'Save connection'}
      </Button>
    </form>
  );
}
