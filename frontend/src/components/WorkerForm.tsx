import { AGENT_SERVICES, AGENT_SERVICE_INFO, DEFAULT_AGENT_SERVICES, WORKER_CAP_MAX, checkAgentDockerfile, updateWorkerBody } from '@claude-task/shared';
import type { AgentService, CreateWorkerBody, UpdateWorkerBody, Worker } from '@claude-task/shared';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { errorMessage } from '../api/client';
import { useAutosave } from '../lib/useAutosave';
import { AutosaveStatus } from './AutosaveStatus';
import { Field } from './common';

const DEFAULT_DOCKERFILE = 'FROM claude-task/agent-base\nUSER agent\n';

/** Highlight Dockerfile instructions and comments without changing the editable plain text. */
function DockerfileEditor({ value, onChange, disabled }: { value: string; onChange: (s: string) => void; disabled?: boolean }) {
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
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className={`${style} absolute inset-0 h-full resize-none bg-transparent text-transparent caret-foreground outline-none selection:bg-primary/30`}
      />
    </div>
  );
}

const issues = (error: { issues: { path: PropertyKey[]; message: string }[] }) =>
  error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join(', ');

/**
 * Creates a Worker (one submit) or edits one: name, description, minimum, cap and enabled save automatically;
 * Dockerfile, services and limits apply together with "Save Docker configuration".
 */
export function WorkerForm({
  worker,
  readOnly = false,
  onCreate,
  onUpdate,
}: {
  worker?: Worker;
  readOnly?: boolean;
  onCreate?: (body: CreateWorkerBody) => Promise<void>;
  onUpdate?: (body: UpdateWorkerBody) => Promise<void>;
}) {
  const [name, setName] = useState(worker?.name ?? '');
  const [description, setDescription] = useState(worker?.description ?? '');
  const [minimum, setMinimum] = useState(String(worker?.minimum ?? 0));
  const [cap, setCap] = useState(String(worker?.cap ?? 1));
  const [enabled, setEnabled] = useState(worker?.enabled ?? true);
  const [dockerfile, setDockerfile] = useState(worker?.dockerfile ?? DEFAULT_DOCKERFILE);
  const [services, setServices] = useState<AgentService[]>(worker?.services ?? DEFAULT_AGENT_SERVICES);
  const [cpu, setCpu] = useState(worker?.cpuLimit?.toString() ?? '');
  const [memory, setMemory] = useState(worker?.memoryMb?.toString() ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const editing = !!worker && !readOnly;
  const autosave = useAutosave(
    { name: name.trim(), description, minimum: Number(minimum), cap: Number(cap), enabled },
    async (changes) => {
      if (Number(minimum) > Number(cap)) throw new Error('The minimum cannot exceed the cap');
      const checked = updateWorkerBody.safeParse(changes);
      if (!checked.success) throw new Error(issues(checked.error));
      await onUpdate!(checked.data);
    },
    editing,
  );
  const docker = () => ({ dockerfile, services, cpuLimit: cpu ? Number(cpu) : null, memoryMb: memory ? Number(memory) : null });
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (worker) return;
    const check = checkAgentDockerfile(dockerfile);
    if (!check.ok) return setError(check.error);
    if (Number(minimum) > Number(cap)) return setError('The minimum cannot exceed the cap');
    setSaving(true);
    setError('');
    try {
      await onCreate!({ name, description, minimum: Number(minimum), cap: Number(cap), enabled, ...docker() });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };
  const saveDocker = async () => {
    const check = checkAgentDockerfile(dockerfile);
    if (!check.ok) return setError(check.error);
    const body = updateWorkerBody.safeParse(docker());
    if (!body.success) return setError(issues(body.error));
    setSaving(true);
    setError('');
    try {
      await onUpdate!(body.data);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };
  return (
    <form onSubmit={submit} onBlur={editing ? () => void autosave.flush() : undefined} className="space-y-5">
      {editing && <AutosaveStatus {...autosave} label="Worker configuration save status" />}
      <fieldset disabled={readOnly} className="space-y-5">
        <Field label="Name">
          <Input aria-label="Worker name" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} required />
        </Field>
        <Field label="Description">
          <Textarea aria-label="Worker description" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Minimum" hint="Worker Containers always running (0 starts them only when work arrives).">
            <Input aria-label="Minimum" type="number" min={0} max={WORKER_CAP_MAX} step={1} value={minimum} onChange={(e) => setMinimum(e.target.value)} required />
          </Field>
          <Field label="Cap" hint={`The most Worker Containers running at once, 1 to ${WORKER_CAP_MAX}: Tasks worked in parallel.`}>
            <Input aria-label="Cap" type="number" min={1} max={WORKER_CAP_MAX} step={1} value={cap} onChange={(e) => setCap(e.target.value)} required />
          </Field>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Enabled
        </label>
        <fieldset className="flex flex-col gap-4 rounded-lg border p-3" disabled={saving || readOnly}>
          <legend className="px-1 text-sm font-medium">Docker configuration</legend>
          <fieldset className="flex flex-col gap-2">
            <legend className="text-sm font-medium">Services</legend>
            <p className="text-xs text-muted-foreground">
              Installed and started inside each Worker Container, shared by the Tasks it runs. Each slot keeps its own data across rebuilds.
              Changes rebuild the image and apply to each container once it is free.
            </p>
            {AGENT_SERVICES.map((service) => (
              <label key={service} className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  aria-label={AGENT_SERVICE_INFO[service].name}
                  checked={services.includes(service)}
                  onChange={(e) => setServices(e.target.checked ? [...services, service] : services.filter((value) => value !== service))}
                />
                <span>
                  <b>{AGENT_SERVICE_INFO[service].name}</b>
                  <span className="block text-xs text-muted-foreground">{AGENT_SERVICE_INFO[service].description}</span>
                </span>
              </label>
            ))}
          </fieldset>
          <div className="space-y-1.5">
            <Label>Dockerfile</Label>
            <DockerfileEditor value={dockerfile} onChange={setDockerfile} disabled={readOnly} />
            <p className="text-xs text-muted-foreground">
              Start FROM claude-task/agent-base and finish as USER agent. Saving a new Dockerfile builds an image automatically.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="CPU limit" hint="Per Worker Container. Empty means no limit.">
              <Input aria-label="CPU limit" type="number" min="0.01" step="0.01" max="256" value={cpu} onChange={(e) => setCpu(e.target.value)} />
            </Field>
            <Field label="Memory (MB)" hint="Per Worker Container.">
              <Input aria-label="Memory (MB)" type="number" min="256" max="1048576" value={memory} onChange={(e) => setMemory(e.target.value)} />
            </Field>
          </div>
          {editing && (
            <Button type="button" className="self-start" disabled={saving} onClick={() => void saveDocker()}>
              {saving ? 'Saving…' : 'Save Docker configuration'}
            </Button>
          )}
        </fieldset>
      </fieldset>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {!worker && (
        <Button type="submit" disabled={saving || !name.trim()}>
          {saving ? 'Saving…' : 'Create worker'}
        </Button>
      )}
    </form>
  );
}
