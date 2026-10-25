import { checkAgentDockerfile, EFFORT_LEVELS, PERMISSION_MODES } from '@claude-task/shared';
import type { Agent, CreateAgentBody, EffortLevel, PermissionMode } from '@claude-task/shared';
import { useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Link } from 'react-router';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useCredentials } from '../api/queries';
import { errorMessage } from '../api/client';

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-sm font-medium">{label}</span>
      {children}
      {hint && <span className="block text-xs text-muted-foreground">{hint}</span>}
    </label>
  );
}

export function LogView({ children, label = 'Log' }: { children: string; label?: string }) {
  return (
    <pre
      aria-label={label}
      className="max-h-96 overflow-auto rounded-lg border bg-muted/30 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words"
    >
      {children || 'No output yet.'}
    </pre>
  );
}

/** Highlight Dockerfile instructions and comments without changing the editable plain text. */
function DockerfileEditor({ value, onChange }: { value: string; onChange: (s: string) => void }) {
  const lines = value.split('\n');
  const style = 'm-0 w-full border-0 p-3 font-mono text-xs leading-6 whitespace-pre-wrap break-words';
  return (
    <div className="relative rounded-lg border bg-muted/30 focus-within:ring-2 focus-within:ring-ring">
      <pre aria-hidden className={`${style} pointer-events-none min-h-48`}>
        {lines.map((line, i) => {
          const match = /^(\s*)(#.*|[A-Za-z]+)(.*)$/.exec(line);
          return (
            <span key={i}>
              {match ? (
                <>
                  {match[1]}
                  <span className={match[2]!.startsWith('#') ? 'text-muted-foreground' : 'text-violet-400'}>{match[2]}</span>
                  {match[3]}
                </>
              ) : (
                line
              )}
              {i < lines.length - 1 ? '\n' : ''}
            </span>
          );
        })}
        {'\n'}
      </pre>
      <textarea
        aria-label="Dockerfile"
        spellCheck={false}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`${style} absolute inset-0 h-full resize-none bg-transparent text-transparent caret-foreground outline-none selection:bg-primary/30`}
      />
    </div>
  );
}

export function AgentForm({ agent, onSave }: { agent?: Agent; onSave: (body: CreateAgentBody) => Promise<void> }) {
  const credentials = useCredentials();
  const [name, setName] = useState(agent?.name ?? '');
  const [emoji, setEmoji] = useState(agent?.avatarEmoji ?? '🤖');
  const [color, setColor] = useState(agent?.avatarColor ?? '#6366f1');
  const [description, setDescription] = useState(agent?.description ?? '');
  const [dockerfile, setDockerfile] = useState(agent?.dockerfile ?? 'FROM claude-task/agent-base\nUSER agent\n');
  const [credentialId, setCredentialId] = useState(agent?.credentialId ?? '');
  const [model, setModel] = useState(agent?.model ?? '');
  const [effort, setEffort] = useState<EffortLevel | ''>(agent?.effort ?? '');
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(agent?.permissionMode ?? 'bypassPermissions');
  const [systemPrompt, setSystemPrompt] = useState(agent?.systemPrompt ?? '');
  const [cpu, setCpu] = useState(agent?.cpuLimit?.toString() ?? '');
  const [memory, setMemory] = useState(agent?.memoryMb?.toString() ?? '');
  const [enabled, setEnabled] = useState(agent?.enabled ?? true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const check = checkAgentDockerfile(dockerfile);
    if (!check.ok) return setError(check.error);
    setSaving(true);
    setError('');
    try {
      await onSave({
        name,
        avatarEmoji: emoji,
        avatarColor: color,
        description,
        dockerfile,
        credentialId,
        model: model.trim() || null,
        effort: effort || null,
        permissionMode,
        systemPrompt,
        cpuLimit: cpu ? Number(cpu) : null,
        memoryMb: memory ? Number(memory) : null,
        enabled,
      });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };
  const selectClass = 'h-9 w-full rounded-md border bg-background px-3 text-sm';
  return (
    <form onSubmit={submit} className="space-y-5">
      <div className="grid grid-cols-[1fr_5rem_4rem] gap-3">
        <Field label="Name">
          <Input aria-label="Agent name" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} required />
        </Field>
        <Field label="Emoji">
          <Input aria-label="Emoji" value={emoji} onChange={(e) => setEmoji(e.target.value)} maxLength={16} required />
        </Field>
        <Field label="Color">
          <Input aria-label="Color" type="color" value={color} onChange={(e) => setColor(e.target.value)} />
        </Field>
      </div>
      <Field label="Description">
        <Textarea aria-label="Agent description" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} />
      </Field>
      <Field label="Credential">
        <select aria-label="Credential" className={selectClass} required value={credentialId} onChange={(e) => setCredentialId(e.target.value)}>
          <option value="">Choose a credential</option>
          {credentials.data?.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} · …{c.last4}
            </option>
          ))}
        </select>
      </Field>
      {credentials.error && (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(credentials.error)}
        </p>
      )}
      {credentials.data?.length === 0 && (
        <p className="text-sm text-muted-foreground">
          <Link className="underline" to="/admin/credentials">
            Create a credential
          </Link>{' '}
          before saving an agent.
        </p>
      )}
      <div className="grid grid-cols-2 gap-3">
        <Field label="Model" hint="Leave empty to use Claude’s default.">
          <Input aria-label="Model" value={model} onChange={(e) => setModel(e.target.value)} maxLength={100} />
        </Field>
        <Field label="Effort">
          <select aria-label="Effort" className={selectClass} value={effort} onChange={(e) => setEffort(e.target.value as EffortLevel | '')}>
            <option value="">Default</option>
            {EFFORT_LEVELS.map((v) => (
              <option key={v}>{v}</option>
            ))}
          </select>
        </Field>
      </div>
      <Field label="Permission mode">
        <select
          aria-label="Permission mode"
          className={selectClass}
          value={permissionMode}
          onChange={(e) => setPermissionMode(e.target.value as PermissionMode)}
        >
          {PERMISSION_MODES.map((v) => (
            <option key={v}>{v}</option>
          ))}
        </select>
      </Field>
      <Field label="System prompt">
        <Textarea aria-label="System prompt" rows={5} value={systemPrompt} onChange={(e) => setSystemPrompt(e.target.value)} maxLength={50000} />
      </Field>
      <div className="space-y-1.5">
        <Label>Dockerfile</Label>
        <DockerfileEditor value={dockerfile} onChange={setDockerfile} />
        <p className="text-xs text-muted-foreground">
          Start FROM claude-task/agent-base and finish as USER agent. Saving a new Dockerfile builds an image automatically.
        </p>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="CPU limit" hint="Empty means no limit.">
          <Input aria-label="CPU limit" type="number" min="0.01" step="0.01" max="256" value={cpu} onChange={(e) => setCpu(e.target.value)} />
        </Field>
        <Field label="Memory (MB)">
          <Input aria-label="Memory (MB)" type="number" min="256" max="1048576" value={memory} onChange={(e) => setMemory(e.target.value)} />
        </Field>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Enabled
      </label>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <Button type="submit" disabled={saving || !credentialId}>
        {saving ? 'Saving…' : agent ? 'Save agent' : 'Create agent'}
      </Button>
    </form>
  );
}
