import { AGENT_ENV_MAX, ENV_VALUE_MAX, EFFORT_LEVELS, PERMISSION_MODES, RESERVED_ENV_NAME, parseDotenv, updateAgentBody } from '@claude-task/shared';
import type { Agent, CreateAgentBody, EffortLevel, PermissionMode, UpdateAgentBody } from '@claude-task/shared';
import { useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Link } from 'react-router';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useCredentials, useMcpServers, usePlugins } from '../api/queries';
import { AgentAvatar } from './agents';
import { Field } from './common';
import { AgentSkillSelector } from './AgentSkillSelector';
import { api, del, errorMessage } from '../api/client';
import { useAutosave } from '../lib/useAutosave';
import { AutosaveStatus } from './AutosaveStatus';

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

/** Quotes with exactly the escapes the shared dotenv parser understands. */
function quoteEnvValue(value: string): string {
  return `"${value
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('\n', '\\n')
    .replaceAll('\r', '\\r')
    .replaceAll('\t', '\\t')}"`;
}

/** Round-trips through the `.env` syntax without losing quotes, spaces or newlines. */
function envToText(env: Record<string, string>): string {
  return Object.entries(env)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => `${name}=${quoteEnvValue(value)}`)
    .join('\n');
}

function textToEnv(text: string): { env: Record<string, string>; errors: string[] } {
  if (!text.trim()) return { env: {}, errors: [] };
  const parsed = parseDotenv(text);
  if (!parsed.ok) return { env: {}, errors: parsed.errors };
  const errors: string[] = [];
  if (parsed.entries.length > AGENT_ENV_MAX) errors.push(`At most ${AGENT_ENV_MAX} variables.`);
  const env: Record<string, string> = {};
  for (const { name, value } of parsed.entries) {
    if (RESERVED_ENV_NAME.test(name)) errors.push(`${name} is set by the platform.`);
    else if (value.length > ENV_VALUE_MAX) errors.push(`${name} exceeds ${ENV_VALUE_MAX} characters.`);
    else env[name] = value;
  }
  return { env, errors };
}

export function AgentForm({ agent, onSave, onUpdate }: {
  agent?: Agent;
  onSave?: (body: CreateAgentBody, avatar: AvatarChange) => Promise<void>;
  onUpdate?: (body: UpdateAgentBody, avatar: AvatarChange) => Promise<void>;
}) {
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
  const [credentialId, setCredentialId] = useState(agent?.credentialId ?? '');
  const [envText, setEnvText] = useState(envToText(agent?.env ?? {}));
  const [env, setEnv] = useState<Record<string, string>>(agent?.env ?? {});
  const [envErrors, setEnvErrors] = useState<string[]>([]);
  const [model, setModel] = useState(agent?.model ?? '');
  const [effort, setEffort] = useState<EffortLevel | ''>(agent?.effort ?? '');
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(agent?.permissionMode ?? 'bypassPermissions');
  const [systemPrompt, setSystemPrompt] = useState(agent?.systemPrompt ?? '');
  const [enabled, setEnabled] = useState(agent?.enabled ?? true);
  const [avatar, setAvatar] = useState<AvatarChange>(null);
  const [avatarRevision, setAvatarRevision] = useState(0);
  const [preview, setPreview] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const changeEnv = (text: string) => {
    setEnvText(text);
    const parsed = textToEnv(text);
    setEnvErrors(parsed.errors);
    // Keep the last valid map while the text is incomplete; invalid text is never saved.
    if (!parsed.errors.length) setEnv(parsed.env);
  };
  const autosave = useAutosave({
    skillIds, mcpServerIds, pluginIds, name, avatarEmoji: emoji, avatarColor: color,
    description, env, credentialId, model: model.trim() || null, effort: effort || null,
    permissionMode, systemPrompt, enabled,
  }, async (changes) => {
    const checked = updateAgentBody.safeParse(changes);
    if (!checked.success) throw new Error(checked.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join(', '));
    await onUpdate!(checked.data, null);
  }, !!agent);
  const avatarAutosave = useAutosave({ revision: avatarRevision }, async () => {
    await onUpdate!({}, avatar);
  }, !!agent);
  const flush = () => {
    void autosave.flush();
    void avatarAutosave.flush();
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (agent) return;
    if (envErrors.length) return setError(envErrors.join(' '));
    setSaving(true);
    setError('');
    try {
      await onSave!({
        skillIds,
        mcpServerIds,
        pluginIds,
        name,
        avatarEmoji: emoji,
        avatarColor: color,
        description,
        env,
        credentialId,
        model: model.trim() || null,
        effort: effort || null,
        permissionMode,
        systemPrompt,
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
    setAvatarRevision((revision) => revision + 1);
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
    setAvatar(agent ? { remove: true } : null);
    setAvatarRevision((revision) => revision + 1);
  };
  const shownImage = avatar && 'remove' in avatar ? null : (preview ?? agent?.avatarImageUrl ?? null);
  const selectClass = 'h-9 w-full rounded-md border bg-background px-3 text-sm';
  return (
    <form onSubmit={submit} onBlur={agent ? flush : undefined} className="space-y-5">
      {agent && <AutosaveStatus {...autosave} label="Agent configuration save status" />}
      {agent && avatarRevision > 0 && <AutosaveStatus {...avatarAutosave} label="Agent image save status" />}
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
      <Field
        label="Environment variables"
        hint="One NAME=value per line, e.g. ANTHROPIC_BASE_URL, ANTHROPIC_MODEL or ENABLE_TOOL_SEARCH. They apply to every Job and win over the Project's. Values are stored in plain text: keep secrets in a Credential or a Project secret."
      >
        <Textarea
          aria-label="Environment variables"
          rows={5}
          className="font-mono text-xs"
          value={envText}
          onChange={(e) => changeEnv(e.target.value)}
          placeholder={'ANTHROPIC_BASE_URL="https://openrouter.ai/api"\nANTHROPIC_MODEL="openrouter/model"'}
        />
      </Field>
      {envErrors.length > 0 && (
        <p role="alert" className="text-sm text-destructive">
          {envErrors.join(' ')} Invalid variables are not saved.
        </p>
      )}
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
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Enabled
      </label>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {!agent && <Button type="submit" disabled={saving || !credentialId}>
        {saving ? 'Saving…' : 'Create agent'}
      </Button>}
    </form>
  );
}
