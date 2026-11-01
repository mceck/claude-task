import { parseDotenv } from '@claude-task/shared';
import type { ProjectAgentSettings as Settings, ProjectEnvVar } from '@claude-task/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { del, errorMessage, patch, post, put } from '../api/client';
import { AgentStateDot } from './agents';
import { keys, useAgents, useAgentSettings, useMe } from '../api/queries';
import { Field, ErrorText, Loading, useConfirm } from './common';
import { useAutosave } from '../lib/useAutosave';
import { AutosaveStatus } from './AutosaveStatus';

export function ProjectAgentSettings({ projectId }: { projectId: string }) {
  const query = useAgentSettings(projectId);
  if (query.isPending) return <Loading />;
  if (query.error) return <ErrorText>{errorMessage(query.error)}</ErrorText>;
  return <SettingsForm key={projectId} projectId={projectId} settings={query.data} />;
}

function SettingsForm({ projectId, settings }: { projectId: string; settings: Settings }) {
  const agents = useAgents();
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
  const autosave = useAutosave({ setupScript, agentInstructions }, async (changes) => {
    await patch(`/projects/${projectId}/agent-settings`, changes);
    qc.setQueryData<Settings>(keys.agentSettings(projectId), (current) => current ? { ...current, ...changes } : current);
  });
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
      <section onBlur={() => void autosave.flush()} className="flex flex-col gap-4 rounded-xl border bg-card p-5">
        <h2 className="font-medium">Agent setup</h2>
        <Field label="Default agent" hint="Assigned to every new task. Tasks are created without an agent if it is disabled or removed.">
          <Select
            value={settings.defaultAgentId ?? 'none'}
            onValueChange={(id) =>
              void patch<{ settings: Settings }>(`/projects/${projectId}/agent-settings`, { defaultAgentId: id === 'none' ? null : id })
                .then((r) => qc.setQueryData(keys.agentSettings(projectId), r.settings))
                .catch((err) => toast.error(errorMessage(err)))
            }
          >
            <SelectTrigger aria-label="Default agent" className="w-fit min-w-48"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="none">No agent</SelectItem>
              {(agents.data ?? []).filter((a) => a.enabled || a.id === settings.defaultAgentId).map((a) => (
                <SelectItem key={a.id} value={a.id}>{a.name}{!a.enabled && ' (disabled)'} <AgentStateDot agent={a} /></SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <span id="auto-resume-label" className="text-sm font-medium">Automatic resume at limit</span>
            <p className="text-xs text-muted-foreground">New tasks resume by themselves after a usage limit resets.</p>
          </div>
          <Switch
            aria-labelledby="auto-resume-label"
            checked={settings.autoResume}
            onCheckedChange={(autoResume) =>
              void patch<{ settings: Settings }>(`/projects/${projectId}/agent-settings`, { autoResume })
                .then((r) => qc.setQueryData(keys.agentSettings(projectId), r.settings))
                .catch((err) => toast.error(errorMessage(err)))
            }
          />
        </div>
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <span id="board-write-access-label" className="text-sm font-medium">Agents may write to the board</span>
            <p className="text-xs text-muted-foreground">
              Agents can edit, move and comment on every task of this project, and start other agents. Closing tasks stays with people.
            </p>
          </div>
          <Switch
            aria-labelledby="board-write-access-label"
            checked={settings.boardWriteAccess}
            onCheckedChange={(boardWriteAccess) =>
              void patch<{ settings: Settings }>(`/projects/${projectId}/agent-settings`, { boardWriteAccess })
                .then((r) => qc.setQueryData(keys.agentSettings(projectId), r.settings))
                .catch((err) => toast.error(errorMessage(err)))
            }
          />
        </div>
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
        <AutosaveStatus {...autosave} label="Project agent settings save status" />
      </section>
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
        {admin && <EnvImport projectId={projectId} env={settings.env} busy={busy} run={run} />}
      </section>
    </div>
  );
}

const MAX_ENV_FILE = 500_000;

/** Paste or pick a `.env` file; its variables are merged into the Project's (same names overwritten). */
function EnvImport({
  projectId,
  env,
  busy,
  run,
}: {
  projectId: string;
  env: ProjectEnvVar[];
  busy: boolean;
  run: (fn: () => Promise<{ settings: Settings }>) => Promise<boolean>;
}) {
  const [content, setContent] = useState('');
  const [secret, setSecret] = useState(false);
  const parsed = useMemo(() => (content.trim() ? parseDotenv(content) : null), [content]);
  const existing = useMemo(() => new Map(env.map((e) => [e.name, e])), [env]);
  const pickFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > MAX_ENV_FILE) {
      toast.error('The .env file is too large');
      return;
    }
    setContent(await file.text());
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!parsed?.ok) return;
    if (await run(() => post(`/projects/${projectId}/env/import`, { content, secret }))) {
      toast.success(`Imported ${parsed.entries.length} ${parsed.entries.length === 1 ? 'variable' : 'variables'}`);
      setContent('');
      setSecret(false);
    }
  };
  return (
    <form onSubmit={submit} className="space-y-3 border-t pt-4">
      <h3 className="text-sm font-medium">Import .env</h3>
      <p className="text-sm text-muted-foreground">Variables are merged with the existing ones: same names are overwritten, others are kept. Existing secrets stay secret.</p>
      <Field label=".env content">
        <Textarea
          aria-label=".env content"
          rows={6}
          className="font-mono text-xs"
          placeholder={'API_URL=https://staging.example.com\nDB_PASSWORD="…"'}
          autoComplete="off"
          spellCheck={false}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          maxLength={MAX_ENV_FILE}
        />
      </Field>
      {parsed &&
        (parsed.ok ? (
          parsed.entries.length ? (
            <ul aria-label="Variables to import" className="flex flex-wrap gap-1.5 text-xs">
              {parsed.entries.map(({ name }) => (
                <li key={name} className="rounded-md border px-1.5 py-0.5 font-mono">
                  {name}
                  {existing.has(name) && <span className="ml-1 font-sans text-muted-foreground">{existing.get(name)!.secret ? '· overwrites secret' : '· overwrites'}</span>}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">No variables found.</p>
          )
        ) : (
          <ul className="space-y-0.5 text-sm text-destructive">
            {parsed.errors.map((err) => (
              <li key={err}>{err}</li>
            ))}
          </ul>
        ))}
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={secret} onChange={(e) => setSecret(e.target.checked)} /> Import as secrets
      </label>
      <div className="flex gap-2">
        <Button type="button" variant="outline" asChild>
          <label className="cursor-pointer">
            Choose file
            <input
              aria-label=".env file"
              type="file"
              className="sr-only"
              onChange={(e) => {
                void pickFile(e.target.files?.[0]);
                e.target.value = '';
              }}
            />
          </label>
        </Button>
        <Button type="submit" disabled={busy || !parsed?.ok || !parsed.entries.length}>
          {parsed?.ok && parsed.entries.length ? `Import ${parsed.entries.length} ${parsed.entries.length === 1 ? 'variable' : 'variables'}` : 'Import'}
        </Button>
      </div>
    </form>
  );
}
