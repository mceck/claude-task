import type { ProjectAgentSettings as Settings, ProjectEnvVar } from '@claude-task/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { del, errorMessage, patch, put } from '../api/client';
import { keys, useAgentSettings, useMe } from '../api/queries';
import { Field } from './AgentForm';
import { ErrorText, Loading, useConfirm } from './common';

export function ProjectAgentSettings({ projectId }: { projectId: string }) {
  const query = useAgentSettings(projectId);
  if (query.isPending) return <Loading />;
  if (query.error) return <ErrorText>{errorMessage(query.error)}</ErrorText>;
  return <SettingsForm key={projectId} projectId={projectId} settings={query.data} />;
}

function SettingsForm({ projectId, settings }: { projectId: string; settings: Settings }) {
  const admin = useMe().data?.role === 'admin';
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [setupScript, setSetupScript] = useState(settings.setupScript);
  const [agentInstructions, setInstructions] = useState(settings.agentInstructions);
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [secret, setSecret] = useState(false);
  const [editing, setEditing] = useState<ProjectEnvVar | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<{ settings: Settings }>): Promise<boolean> => {
    setBusy(true);
    try {
      const result = await fn();
      qc.setQueryData(keys.agentSettings(projectId), result.settings);
      return true;
    } catch (err) {
      toast.error(errorMessage(err));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (await run(() => patch(`/projects/${projectId}/agent-settings`, { setupScript, agentInstructions }))) toast.success('Agent settings saved');
  };
  const saveEnv = async (e: FormEvent) => {
    e.preventDefault();
    if (await run(() => put(`/projects/${projectId}/env/${encodeURIComponent(name)}`, { value, secret }))) {
      setName('');
      setValue('');
      setSecret(false);
      setEditing(null);
    }
  };
  const remove = async (env: ProjectEnvVar) => {
    if (
      await confirm({
        title: `Delete ${env.name}?`,
        description: 'The variable will be absent from the next job.',
        confirmLabel: 'Delete variable',
        destructive: true,
      })
    ) {
      await run(() => del<{ settings: Settings }>(`/projects/${projectId}/env/${encodeURIComponent(env.name)}`));
    }
  };
  return (
    <div className="space-y-4">
      <form onSubmit={save} className="space-y-4 rounded-xl border bg-card p-5">
        <h2 className="font-medium">Agent setup</h2>
        <Field label="Worktree setup script" hint="Runs once for each new worktree, before Claude starts.">
          <Textarea
            aria-label="Worktree setup script"
            rows={6}
            className="font-mono text-xs"
            value={setupScript}
            onChange={(e) => setSetupScript(e.target.value)}
            maxLength={100000}
          />
        </Field>
        <Field label="Agent instructions" hint="Applied to every agent working on this project, in addition to the repository’s CLAUDE.md.">
          <Textarea aria-label="Agent instructions" rows={6} value={agentInstructions} onChange={(e) => setInstructions(e.target.value)} maxLength={100000} />
        </Field>
        <Button type="submit" disabled={busy}>
          Save agent settings
        </Button>
      </form>
      <section className="space-y-4 rounded-xl border bg-card p-5">
        <h2 className="font-medium">Environment variables & secrets</h2>
        <p className="text-sm text-muted-foreground">Sent only to jobs for this project. Secrets are write-only. Admins manage variables and secrets.</p>
        {!settings.env.length ? (
          <p className="text-sm text-muted-foreground">No variables yet.</p>
        ) : (
          <ul className="divide-y rounded-lg border">
            {settings.env.map((env) => (
              <li key={env.id} className="flex items-center gap-3 p-3 text-sm">
                <span className="min-w-0 flex-1 truncate font-mono">{env.name}</span>
                <span className="max-w-64 truncate font-mono text-xs text-muted-foreground">{env.secret ? `Secret · …${env.last4}` : env.value}</span>
                {admin && (
                  <>
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => {
                        setEditing(env);
                        setName(env.name);
                        setSecret(env.secret);
                        setValue(env.value ?? '');
                      }}
                    >
                      Edit
                    </Button>
                    <Button size="xs" variant="ghost" disabled={busy} onClick={() => remove(env)}>
                      Delete
                    </Button>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
        {admin && (
          <form onSubmit={saveEnv} className="space-y-3 border-t pt-4">
            <h3 className="text-sm font-medium">{editing ? `Update ${editing.name}` : 'Add variable'}</h3>
            <Field label="Variable name">
              <Input
                aria-label="Variable name"
                className="font-mono"
                value={name}
                onChange={(e) => setName(e.target.value)}
                pattern="[A-Za-z_][A-Za-z0-9_]{0,127}"
                disabled={!!editing}
                required
              />
            </Field>
            <Field label={editing?.secret ? 'New value' : 'Value'}>
              <Input
                aria-label="Variable value"
                type={secret ? 'password' : 'text'}
                autoComplete="off"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                maxLength={100000}
                required={secret}
              />
            </Field>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={secret} onChange={(e) => setSecret(e.target.checked)} /> Secret
            </label>
            <div className="flex gap-2">
              <Button type="submit" disabled={busy}>
                {editing ? 'Update variable' : 'Add variable'}
              </Button>
              {editing && (
                <Button
                  variant="ghost"
                  onClick={() => {
                    setEditing(null);
                    setName('');
                    setValue('');
                    setSecret(false);
                  }}
                >
                  Cancel
                </Button>
              )}
            </div>
          </form>
        )}
      </section>
    </div>
  );
}
