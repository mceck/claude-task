import { AGENT_SERVICES, AGENT_SERVICE_INFO, DEFAULT_AGENT_SERVICES, checkAgentDockerfile, EFFORT_LEVELS, PERMISSION_MODES } from '@claude-task/shared';
import type { Agent, AgentService, CreateAgentBody, EffortLevel, PermissionMode } from '@claude-task/shared';
import { useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Link } from 'react-router';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useCredentials, useMcpServers, usePlugins } from '../api/queries';
import { AgentAvatar } from './agents';
import { Field } from './common';
import { AgentSkillSelector } from './AgentSkillSelector';
import { api, del, errorMessage } from '../api/client';

/** What the form wants done with the Agent's image once the Agent is saved. */
type AvatarChange = { file: File } | { remove: true } | null;

/** Uploads or removes the image; call after the Agent exists. */
export async function applyAvatarChange(agentId: string, change: AvatarChange): Promise<void> {
  if (!change) return;
  if ('file' in change) {
    const form = new FormData();
    form.set('file', change.file);
    await api('PUT', `/agents/${agentId}/avatar`, form);
  } else {
    await del(`/agents/${agentId}/avatar`);
  }
}

const AVATAR_ACCEPT = 'image/png,image/jpeg,image/gif,image/webp';
const AVATAR_MAX_BYTES = 2 * 1024 * 1024;

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

export function AgentForm({ agent, onSave }: { agent?: Agent; onSave: (body: CreateAgentBody, avatar: AvatarChange) => Promise<void> }) {
  const credentials = useCredentials();
  const mcpServers = useMcpServers();
  const plugins = usePlugins();
  const [skillIds, setSkillIds] = useState(agent?.skillIds ?? []);
  const [mcpServerIds, setMcpServerIds] = useState(agent?.mcpServerIds ?? []);
  const [pluginIds, setPluginIds] = useState(agent?.pluginIds ?? []);
  const [name, setName] = useState(agent?.name ?? '');
  const [emoji, setEmoji] = useState(agent?.avatarEmoji ?? '🤖');
  const [color, setColor] = useState(agent?.avatarColor ?? '#6366f1');
  const [description, setDescription] = useState(agent?.description ?? '');
  const [dockerfile, setDockerfile] = useState(agent?.dockerfile ?? 'FROM claude-task/agent-base\nUSER agent\n');
  const [services, setServices] = useState<AgentService[]>(agent?.services ?? DEFAULT_AGENT_SERVICES);
  const [credentialId, setCredentialId] = useState(agent?.credentialId ?? '');
  const [model, setModel] = useState(agent?.model ?? '');
  const [effort, setEffort] = useState<EffortLevel | ''>(agent?.effort ?? '');
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(agent?.permissionMode ?? 'bypassPermissions');
  const [systemPrompt, setSystemPrompt] = useState(agent?.systemPrompt ?? '');
  const [cpu, setCpu] = useState(agent?.cpuLimit?.toString() ?? '');
  const [memory, setMemory] = useState(agent?.memoryMb?.toString() ?? '');
  const [enabled, setEnabled] = useState(agent?.enabled ?? true);
  const [avatar, setAvatar] = useState<AvatarChange>(null);
  const [preview, setPreview] = useState<string | null>(null);
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
        skillIds,
        mcpServerIds,
        pluginIds,
        name,
        avatarEmoji: emoji,
        avatarColor: color,
        description,
        dockerfile,
        services,
        credentialId,
        model: model.trim() || null,
        effort: effort || null,
        permissionMode,
        systemPrompt,
        cpuLimit: cpu ? Number(cpu) : null,
        memoryMb: memory ? Number(memory) : null,
        enabled,
      }, avatar);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };
  const pickImage = (file: File | undefined) => {
    if (!file) return;
    if (!AVATAR_ACCEPT.split(',').includes(file.type)) return setError('The image must be a PNG, JPEG, GIF or WebP');
    if (file.size > AVATAR_MAX_BYTES) return setError('The image must be at most 2 MB');
    setError('');
    setAvatar({ file });
    setPreview((old) => {
      if (old) URL.revokeObjectURL(old);
      return URL.createObjectURL(file);
    });
  };
  const clearImage = () => {
    setPreview((old) => {
      if (old) URL.revokeObjectURL(old);
      return null;
    });
    setAvatar(agent?.avatarImageUrl ? { remove: true } : null);
  };
  const shownImage = avatar && 'remove' in avatar ? null : (preview ?? agent?.avatarImageUrl ?? null);
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
      <div className="flex items-center gap-3">
        <AgentAvatar agent={{ id: agent?.id ?? '', name, avatarEmoji: emoji, avatarColor: color, avatarImageUrl: shownImage }} size="lg" />
        <div className="space-y-1">
          <div className="flex gap-2">
            <Button type="button" variant="outline" size="sm" asChild>
              <label className="cursor-pointer">
                {shownImage ? 'Replace image' : 'Upload image'}
                <input
                  aria-label="Avatar image"
                  type="file"
                  accept={AVATAR_ACCEPT}
                  className="sr-only"
                  onChange={(e) => {
                    pickImage(e.target.files?.[0]);
                    e.target.value = '';
                  }}
                />
              </label>
            </Button>
            {shownImage && (
              <Button type="button" variant="ghost" size="sm" onClick={clearImage}>
                Remove image
              </Button>
            )}
          </div>
          <span className="block text-xs text-muted-foreground">An image replaces the emoji and color. PNG, JPEG, GIF or WebP, up to 2 MB.</span>
        </div>
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
      <AgentSkillSelector selectedIds={skillIds} onChange={setSkillIds} />
      <fieldset className="space-y-2 rounded-lg border p-3">
        <legend className="px-1 text-sm font-medium">MCP servers</legend>
        {mcpServers.isPending && <p className="text-xs text-muted-foreground">Loading…</p>}
        {mcpServers.error && <p role="alert" className="text-sm text-destructive">{errorMessage(mcpServers.error)}</p>}
        {mcpServers.data?.map((item) => (
          <label key={item.id} className="flex items-start gap-2 text-sm">
            <input type="checkbox" checked={mcpServerIds.includes(item.id)} onChange={(e) => setMcpServerIds(e.target.checked ? [...mcpServerIds, item.id] : mcpServerIds.filter((id) => id !== item.id))} />
            <span><b>{item.name}</b><span className="block text-xs text-muted-foreground">{item.description}</span></span>
          </label>
        ))}
        <Link to="/admin/extensions" className="text-xs underline">Manage shared skills and MCP servers</Link>
      </fieldset>
      <fieldset className="space-y-2 rounded-lg border p-3">
        <legend className="px-1 text-sm font-medium">Plugins</legend>
        {plugins.isPending && <p className="text-xs text-muted-foreground">Loading…</p>}
        {plugins.error && <p role="alert" className="text-sm text-destructive">{errorMessage(plugins.error)}</p>}
        {plugins.data?.map((item) => (
          <label key={item.id} className="flex items-start gap-2 text-sm">
            <input type="checkbox" checked={pluginIds.includes(item.id)} onChange={(e) => setPluginIds(e.target.checked ? [...pluginIds, item.id] : pluginIds.filter((id) => id !== item.id))} />
            <span><b>{item.name}</b><span className="block text-xs text-muted-foreground">{item.description || item.source}</span></span>
          </label>
        ))}
        <Link to="/admin/extensions" className="text-xs underline">Manage shared plugins</Link>
      </fieldset>
      <fieldset className="space-y-2 rounded-lg border p-3">
        <legend className="px-1 text-sm font-medium">Services</legend>
        <p className="text-xs text-muted-foreground">
          Installed and started inside this agent’s container. Data persists across rebuilds.
          Changes rebuild the image and apply when the agent is idle.
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
