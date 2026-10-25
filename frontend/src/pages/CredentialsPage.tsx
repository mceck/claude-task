import type { Credential, CredentialKind } from '@claude-task/shared';
import { useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { del, errorMessage, patch, post } from '../api/client';
import { keys, useCredentials, useMe } from '../api/queries';
import { Field } from '../components/AgentForm';
import { ErrorText, Loading, useConfirm } from '../components/common';
import { NotFoundPage } from './NotFoundPage';
import { PageHeader } from './ProjectsPage';

export function CredentialsPage() {
  const me = useMe();
  const credentials = useCredentials(me.data?.role === 'admin');
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [editing, setEditing] = useState<Credential | 'new' | null>(null);
  if (me.data?.role !== 'admin') return <NotFoundPage />;
  const refresh = () => qc.invalidateQueries({ queryKey: keys.credentials });
  const remove = async (credential: Credential) => {
    if (
      !(await confirm({
        title: `Delete ${credential.name}?`,
        description: 'This credential will no longer be available.',
        confirmLabel: 'Delete credential',
        destructive: true,
      }))
    )
      return;
    try {
      await del(`/credentials/${credential.id}`);
      await refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };
  return (
    <div className="mx-auto max-w-4xl px-8 py-8">
      <PageHeader title="Credentials" description="Secrets are write-only. Rotation applies to every linked agent on its next job.">
        <Button onClick={() => setEditing('new')}>
          <Plus /> New credential
        </Button>
      </PageHeader>
      {credentials.isPending ? (
        <Loading />
      ) : credentials.error ? (
        <ErrorText>{errorMessage(credentials.error)}</ErrorText>
      ) : (
        <div className="space-y-3">
          {!credentials.data.length && <p className="rounded-xl border border-dashed p-8 text-center text-muted-foreground">No credentials yet.</p>}
          {credentials.data.map((c) => (
            <section key={c.id} className="rounded-xl border bg-card p-5">
              <div className="flex items-center gap-3">
                <div className="flex-1">
                  <h2 className="font-medium">{c.name}</h2>
                  <p className="text-xs text-muted-foreground">
                    {c.kind === 'claude_oauth_token' ? 'Claude OAuth token' : 'Anthropic API key'} · <span className="font-mono">…{c.last4}</span>
                  </p>
                </div>
                <Button variant="outline" size="sm" onClick={() => setEditing(c)}>
                  Edit / rotate
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={c.usedBy.length > 0}
                  title={c.usedBy.length ? 'Used by agents; change their credential first.' : undefined}
                  onClick={() => remove(c)}
                >
                  Delete
                </Button>
              </div>
              <p className="mt-3 text-sm text-muted-foreground">
                Used by:{' '}
                {c.usedBy.length
                  ? c.usedBy.map((a, i) => (
                      <span key={a.id}>
                        {i > 0 && ', '}
                        <Link className="underline" to={`/agents/${a.id}`}>
                          {a.name}
                        </Link>
                      </span>
                    ))
                  : 'No agents'}
              </p>
              {c.rateLimit && <p className="mt-2 text-xs text-muted-foreground">Latest rate limit: {JSON.stringify(c.rateLimit.info)}</p>}
            </section>
          ))}
        </div>
      )}
      <Dialog open={!!editing} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing === 'new' ? 'New credential' : 'Edit credential'}</DialogTitle>
            <DialogDescription>The saved secret can’t be read back. Only its last four characters are shown.</DialogDescription>
          </DialogHeader>
          {editing && (
            <CredentialForm
              key={editing === 'new' ? 'new' : editing.id}
              credential={editing === 'new' ? undefined : editing}
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

function CredentialForm({ credential, onSaved }: { credential?: Credential; onSaved: () => Promise<void> }) {
  const [name, setName] = useState(credential?.name ?? '');
  const [kind, setKind] = useState<CredentialKind>(credential?.kind ?? 'claude_oauth_token');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (credential) await patch(`/credentials/${credential.id}`, { name, ...(secret ? { secret } : {}) });
      else await post('/credentials', { name, kind, secret });
      setSecret('');
      await onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="space-y-4">
      <Field label="Name">
        <Input aria-label="Credential name" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} required />
      </Field>
      <Field label="Kind">
        <select
          aria-label="Kind"
          className="h-9 w-full rounded-md border bg-background px-3 text-sm"
          value={kind}
          disabled={!!credential}
          onChange={(e) => setKind(e.target.value as CredentialKind)}
        >
          <option value="claude_oauth_token">Claude OAuth token (claude setup-token)</option>
          <option value="anthropic_api_key">Anthropic API key</option>
        </select>
      </Field>
      <Field label={credential ? 'New secret' : 'Secret'} hint={credential ? 'Leave empty to keep the current secret.' : undefined}>
        <Input
          aria-label={credential ? 'New secret' : 'Secret'}
          type="password"
          autoComplete="new-password"
          value={secret}
          minLength={8}
          maxLength={10000}
          onChange={(e) => setSecret(e.target.value)}
          required={!credential}
        />
      </Field>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <Button type="submit" disabled={busy}>
        {busy ? 'Saving…' : 'Save credential'}
      </Button>
    </form>
  );
}
