import { saveMcpServerBody, savePluginBody } from '@claude-task/shared';
import type { McpServer, SaveMcpServerBody } from '@claude-task/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { api, del, errorMessage, post } from '../api/client';
import { keys, useMe, useMcpServers, usePlugins, useSkills } from '../api/queries';
import { Field } from '../components/AgentForm';
import { ErrorText, Loading } from '../components/common';

export function ExtensionsPage() {
  const me = useMe();
  return me.isPending ? <Loading /> : me.data?.role === 'admin' ? <ExtensionCatalog /> : <p className="p-8">Admin access required.</p>;
}
function ExtensionCatalog() {
  const skills = useSkills(),
    mcp = useMcpServers(),
    plugins = usePlugins(),
    qc = useQueryClient();
  const [source, setSource] = useState('');
  const [names, setNames] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<McpServer | null | undefined>(undefined);
  const [plugin, setPlugin] = useState({ name: '', source: '', description: '' });
  const refresh = () => Promise.all([keys.skills, keys.mcpServers, keys.plugins, keys.agents].map((queryKey) => qc.invalidateQueries({ queryKey })));
  const act = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await work();
      await refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mx-auto max-w-4xl space-y-8 px-8 py-8">
      <header>
        <h1 className="text-2xl font-semibold">Extensions</h1>
        <p className="text-sm text-muted-foreground">Shared catalog. Assign entries in each agent’s configuration.</p>
      </header>
      <ErrorText>
        {error || (skills.error && errorMessage(skills.error)) || (mcp.error && errorMessage(mcp.error)) || (plugins.error && errorMessage(plugins.error))}
      </ErrorText>
      <Tabs defaultValue="skills">
        <TabsList className="mb-4" aria-label="Extension categories">
          <TabsTrigger value="skills">Skills</TabsTrigger>
          <TabsTrigger value="plugins">Plugins</TabsTrigger>
          <TabsTrigger value="mcp">MCP</TabsTrigger>
        </TabsList>
        <TabsContent value="skills" className="space-y-4">
          <h2 className="text-lg font-medium">Skills</h2>
          <form
            className="space-y-3 rounded-xl border p-4"
            onSubmit={(e) => {
              e.preventDefault();
              void act(() => post('/skills/import', { source, skills: names.trim() ? names.split(/[,\s]+/).filter(Boolean) : ['*'] }));
            }}
          >
            <Field label="Skill source" hint="Same source formats as skills add: owner/repo, repository URL or a link to a skill directory.">
              <Input
                aria-label="Skill source"
                value={source}
                onChange={(e) => setSource(e.target.value)}
                placeholder="vercel-labs/agent-skills"
                required
              />
            </Field>
            <Field label="Skill names" hint="Comma-separated names; leave empty to import all skills from the source.">
              <Input aria-label="Skill names" value={names} onChange={(e) => setNames(e.target.value)} placeholder="web-design-guidelines" />
            </Field>
            <p className="text-xs text-muted-foreground">
              Imports include scripts and supporting files. Reimporting updates assigned agents before their next job.
            </p>
            <Button disabled={busy}>{busy ? 'Working…' : 'Import skills'}</Button>
          </form>
          {skills.data?.map((skill) => (
            <article key={skill.id} className="flex items-start gap-3 rounded-lg border p-4">
              <div className="min-w-0 flex-1">
                <h3 className="font-medium">/{skill.name}</h3>
                <p className="text-sm text-muted-foreground">{skill.description}</p>
                <p className="mt-1 break-all text-xs text-muted-foreground">
                  {skill.source} · {skill.fileCount} files{!skill.userInvocable && ' · Hidden from slash commands'}
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => void act(() => post('/skills/import', { source: skill.source, skills: [skill.name] }))}
              >
                Reimport
              </Button>
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => void act(() => del(`/skills/${skill.id}`))}>
                Delete
              </Button>
            </article>
          ))}
        </TabsContent>
        <TabsContent value="plugins" className="space-y-4">
          <h2 className="text-lg font-medium">Plugins</h2>
          <form
            className="space-y-3 rounded-xl border p-4"
            onSubmit={(e) => {
              e.preventDefault();
              const result = savePluginBody.safeParse(plugin);
              if (!result.success) return setError(result.error.issues.map((i) => i.message).join('; '));
              void act(async () => {
                await post('/plugins', result.data);
                setPlugin({ name: '', source: '', description: '' });
              });
            }}
          >
            <div className="grid grid-cols-2 gap-3">
              <Field label="Plugin" hint="The plugin's name, or plugin@marketplace for a marketplace Claude Code already knows.">
                <Input
                  aria-label="Plugin name"
                  value={plugin.name}
                  onChange={(e) => setPlugin({ ...plugin, name: e.target.value })}
                  placeholder="superpowers@anthropic-plugin-directory"
                  required
                />
              </Field>
              <Field label="Marketplace source" hint="owner/repo, HTTPS or Git SSH URL. Leave empty with plugin@marketplace.">
                <Input
                  aria-label="Marketplace source"
                  value={plugin.source}
                  onChange={(e) => setPlugin({ ...plugin, source: e.target.value })}
                  placeholder="anthropics/claude-plugins-official"
                />
              </Field>
            </div>
            <Field label="Description">
              <Input aria-label="Plugin description" value={plugin.description} onChange={(e) => setPlugin({ ...plugin, description: e.target.value })} />
            </Field>
            <p className="text-xs text-muted-foreground">
              Agents install plugins with claude plugin install, from public marketplaces, before their next job. Update installs the marketplace’s
              latest version on every assigned agent.
            </p>
            <Button disabled={busy}>{busy ? 'Working…' : 'Add plugin'}</Button>
          </form>
          {plugins.data?.map((item) => (
            <article key={item.id} className="flex items-start gap-3 rounded-lg border p-4">
              <div className="min-w-0 flex-1">
                <h3 className="font-medium">{item.name}</h3>
                {item.description && <p className="text-sm text-muted-foreground">{item.description}</p>}
                {item.source && <p className="mt-1 break-all text-xs text-muted-foreground">{item.source}</p>}
              </div>
              <Button variant="outline" size="sm" disabled={busy} onClick={() => void act(() => post(`/plugins/${item.id}/update`, {}))}>
                Update
              </Button>
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => void act(() => del(`/plugins/${item.id}`))}>
                Delete
              </Button>
            </article>
          ))}
        </TabsContent>
        <TabsContent value="mcp" className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-medium">MCP servers</h2>
            <Button variant="outline" onClick={() => setEditing(null)}>
              Add MCP server
            </Button>
          </div>
          {editing !== undefined && (
            <McpEditor
              key={editing?.id ?? 'new'}
              server={editing}
              onCancel={() => setEditing(undefined)}
              onSave={async (body) => {
                const result = saveMcpServerBody.safeParse(body);
                if (!result.success) throw new Error(result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
                await api(editing ? 'PUT' : 'POST', editing ? `/mcp-servers/${editing.id}` : '/mcp-servers', result.data);
                await refresh();
                setEditing(undefined);
              }}
            />
          )}
          {mcp.data?.map((server) => (
            <article key={server.id} className="flex items-center gap-3 rounded-lg border p-4">
              <div className="flex-1">
                <h3 className="font-medium">
                  {server.name} <span className="text-xs text-muted-foreground">{server.type}</span>
                </h3>
                <p className="text-sm text-muted-foreground">{server.description}</p>
                <p className="break-all text-xs text-muted-foreground">
                  {server.type === 'stdio' ? [server.command, ...server.args].join(' ') : server.url}
                </p>
              </div>
              <Button size="sm" variant="outline" onClick={() => setEditing(server)}>
                Edit
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act(() => del(`/mcp-servers/${server.id}`))}>
                Delete
              </Button>
            </article>
          ))}
        </TabsContent>
      </Tabs>
    </div>
  );
}

type ValueRow = { key: string; value: string | null; secret: boolean };
function McpEditor({
  server,
  onSave,
  onCancel,
}: {
  server: McpServer | null;
  onSave: (body: SaveMcpServerBody) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(server?.name ?? '');
  const [description, setDescription] = useState(server?.description ?? '');
  const [type, setType] = useState<McpServer['type']>(server?.type ?? 'http');
  const [url, setUrl] = useState(server?.url ?? '');
  const [command, setCommand] = useState(server?.command ?? '');
  const [args, setArgs] = useState(server?.args.join('\n') ?? '');
  const toRows = (values: McpServer['env'] | undefined): ValueRow[] =>
    Object.entries(values ?? {}).map(([key, v]) => ({ key, value: v.value, secret: v.secret }));
  const [headers, setHeaders] = useState(toRows(server?.headers));
  const [env, setEnv] = useState(toRows(server?.env));
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  return (
    <form
      className="space-y-3 rounded-xl border p-4"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError('');
        try {
          const rows = type === 'stdio' ? env : headers;
          if (new Set(rows.map((r) => r.key)).size !== rows.length) throw new Error('Duplicate variable or header name');
          const values = Object.fromEntries(rows.map(({ key, value, secret }) => [key, { value, secret }]));
          await onSave({
            name,
            description,
            type,
            url: type === 'stdio' ? '' : url,
            command: type === 'stdio' ? command : '',
            args: type === 'stdio' ? args.split('\n').filter(Boolean) : [],
            headers: type === 'stdio' ? {} : values,
            env: type === 'stdio' ? values : {},
          });
        } catch (e) {
          setError(errorMessage(e));
        } finally {
          setBusy(false);
        }
      }}
    >
      <Field label="Server name">
        <Input aria-label="MCP server name" value={name} onChange={(e) => setName(e.target.value)} required />
      </Field>
      <Field label="Description">
        <Input aria-label="MCP description" value={description} onChange={(e) => setDescription(e.target.value)} />
      </Field>
      <Field label="Transport">
        <select
          aria-label="MCP transport"
          value={type}
          onChange={(e) => setType(e.target.value as McpServer['type'])}
          className="h-9 rounded border bg-background px-3 text-sm"
        >
          <option value="http">HTTP</option>
          <option value="sse">SSE</option>
          <option value="stdio">stdio</option>
        </select>
      </Field>
      {type === 'stdio' ? (
        <>
          <Field label="Command" hint="Runs inside the agent container. Install the server and its runtime in the agent’s Dockerfile.">
            <Input aria-label="MCP command" value={command} onChange={(e) => setCommand(e.target.value)} required />
          </Field>
          <Field label="Arguments" hint="One argument per line, without shell quoting.">
            <Textarea aria-label="MCP arguments" value={args} onChange={(e) => setArgs(e.target.value)} />
          </Field>
          <ValueEditor label="Environment variables" rows={env} onChange={setEnv} />
        </>
      ) : (
        <>
          <Field label="URL">
            <Input aria-label="MCP URL" value={url} onChange={(e) => setUrl(e.target.value)} required />
          </Field>
          <ValueEditor label="Headers" rows={headers} onChange={setHeaders} />
        </>
      )}
      <ErrorText>{error}</ErrorText>
      <div className="flex gap-2">
        <Button disabled={busy}>{busy ? 'Saving…' : 'Save MCP server'}</Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
function ValueEditor({ label, rows, onChange }: { label: string; rows: ValueRow[]; onChange: (rows: ValueRow[]) => void }) {
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">{label}</legend>
      {rows.map((row, i) => (
        <div key={i} className="flex items-center gap-2">
          <Input
            aria-label={`${label} name ${i + 1}`}
            value={row.key}
            onChange={(e) => onChange(rows.map((r, j) => (j === i ? { ...r, key: e.target.value } : r)))}
            placeholder="Name"
            required
          />
          <Input
            aria-label={`${label} value ${i + 1}`}
            type={row.secret ? 'password' : 'text'}
            autoComplete="off"
            value={row.value ?? ''}
            placeholder={row.value === null ? 'Saved secret (unchanged)' : 'Value'}
            onChange={(e) => onChange(rows.map((r, j) => (j === i ? { ...r, value: e.target.value } : r)))}
          />
          <label className="flex items-center gap-1 text-xs">
            <input
              type="checkbox"
              checked={row.secret}
              onChange={(e) => onChange(rows.map((r, j) => (j === i ? { ...r, secret: e.target.checked, value: r.value ?? '' } : r)))}
            />
            Secret
          </label>
          <Button type="button" variant="ghost" size="sm" onClick={() => onChange(rows.filter((_, j) => j !== i))}>
            Remove
          </Button>
        </div>
      ))}
      <Button type="button" variant="outline" size="sm" onClick={() => onChange([...rows, { key: '', value: '', secret: false }])}>
        Add {label.toLowerCase()}
      </Button>
    </fieldset>
  );
}
