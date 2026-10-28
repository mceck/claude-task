import { ProjectLogo } from '../components/ProjectLogo';
import { CATEGORIES, PROJECT_KEY_PATTERN } from '@claude-task/shared';
import type { Category, ProjectBundle, ProjectSummary } from '@claude-task/shared';
import { useQueryClient } from '@tanstack/react-query';
import { Archive, FolderKanban, Plus } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select';
import { errorMessage, post } from '../api/client';
import { keys, useAgents, useProjects, useRepositoryGroups } from '../api/queries';
import { ErrorText } from '../components/common';

export const CATEGORY_COLOR: Record<Category, string> = {
  open: 'bg-slate-400',
  active: 'bg-blue-500',
  review: 'bg-violet-500',
  done: 'bg-emerald-500',
  closed: 'bg-zinc-600',
};

export function PageHeader({ title, description, children }: { title: React.ReactNode; description?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end gap-3">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      </div>
      <div className="ml-auto flex items-center gap-3">{children}</div>
    </div>
  );
}

export function ProjectsPage() {
  const [archived, setArchived] = useState(false);
  const [creating, setCreating] = useState(false);
  const projects = useProjects(archived);

  return (
    <div className="mx-auto max-w-6xl px-8 py-8">
      <PageHeader title={archived ? 'Archived projects' : 'Projects'} description="Every project has its own board, statuses and tags.">
        <div className="flex items-center gap-2">
          <Switch id="show-archived" checked={archived} onCheckedChange={setArchived} />
          <Label htmlFor="show-archived" className="text-muted-foreground">
            Show archived
          </Label>
        </div>
        <Button onClick={() => setCreating(true)}>
          <Plus /> New project
        </Button>
      </PageHeader>
      {projects.isPending ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-36 rounded-xl" />
          ))}
        </div>
      ) : projects.data?.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed py-16 text-center">
          {archived ? <Archive className="size-8 text-muted-foreground" /> : <FolderKanban className="size-8 text-muted-foreground" />}
          <p className="text-sm text-muted-foreground">{archived ? 'No archived projects.' : 'No projects yet. Create one to get a board.'}</p>
          {!archived && (
            <Button variant="outline" onClick={() => setCreating(true)}>
              <Plus /> New project
            </Button>
          )}
        </div>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {projects.data?.map((p) => (
            <li key={p.id}>
              <ProjectCard project={p} />
            </li>
          ))}
        </ul>
      )}
      {creating && <CreateProjectDialog open={creating} onOpenChange={setCreating} />}
    </div>
  );
}

function ProjectCard({ project: p }: { project: ProjectSummary }) {
  const total = CATEGORIES.reduce((n, c) => n + p.taskCounts[c], 0);
  const finished = p.taskCounts.done + p.taskCounts.closed;
  return (
    <Link
      to={`/p/${p.key}`}
      className="group flex h-full flex-col rounded-xl border bg-card p-5 transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-lg hover:shadow-primary/5"
    >
      <div className="flex items-start gap-3">
        <ProjectLogo project={p} className="size-10" />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <p className="truncate font-medium group-hover:text-primary">{p.name}</p>
            {p.activity.runningAgents > 0 && (
              <span title="Agents running" aria-label="Agents running" data-testid="project-running" className="relative flex size-2 shrink-0">
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
              </span>
            )}
            {p.activity.unreadTasks > 0 && (
              <span
                title={`${p.activity.unreadTasks} unread ${p.activity.unreadTasks === 1 ? 'task' : 'tasks'}`}
                data-testid="project-unread"
                className="shrink-0 rounded-full bg-primary px-1.5 text-[10px] font-semibold leading-4 text-primary-foreground"
              >
                {p.activity.unreadTasks}
              </span>
            )}
          </div>
          <p className="line-clamp-2 text-sm text-muted-foreground">{p.description || 'No description'}</p>
        </div>
      </div>
      <div className="mt-auto pt-5">
        <div className="mb-2 flex justify-between text-xs text-muted-foreground">
          <span>{total} tasks</span>
          {total > 0 && <span>{Math.round((finished / total) * 100)}% done</span>}
        </div>
        <div className="flex h-1.5 overflow-hidden rounded-full bg-muted" aria-label="Task counts">
          {CATEGORIES.map((c) =>
            p.taskCounts[c] > 0 ? (
              <span key={c} title={`${p.taskCounts[c]} ${c}`} className={CATEGORY_COLOR[c]} style={{ width: `${(p.taskCounts[c] / total) * 100}%` }} />
            ) : null,
          )}
        </div>
        <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
          {CATEGORIES.map((c) => (
            <span key={c} className="flex items-center gap-1">
              <span className={`size-1.5 rounded-full ${CATEGORY_COLOR[c]}`} />
              {c} {p.taskCounts[c]}
            </span>
          ))}
        </div>
      </div>
    </Link>
  );
}

function CreateProjectDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [name, setName] = useState('');
  const [key, setKey] = useState('');
  const [keyTouched, setKeyTouched] = useState(false);
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [defaultAgentId, setDefaultAgentId] = useState('none');
  const [selected, setSelected] = useState('none');
  const [baseBranch, setBaseBranch] = useState('');
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const agents = useAgents();
  const groups = useRepositoryGroups();
  const repositories = (groups.data ?? []).flatMap((g) => g.repositories);
  const choice = repositories.find((r) => `${r.connectionId}:${r.providerRepoId}` === selected);
  const qc = useQueryClient();
  const navigate = useNavigate();

  const suggestedKey = name
    .toUpperCase()
    .replace(/[^A-Z ]/g, '')
    .split(/\s+/)
    .filter(Boolean)
    .map((w, _, all) => (all.length > 1 ? w[0] : w.slice(0, 4)))
    .join('')
    .slice(0, 6);
  const effectiveKey = keyTouched ? key : suggestedKey;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!PROJECT_KEY_PATTERN.test(effectiveKey)) return setError('The key must be 2–6 uppercase letters');
    if (selected !== 'none' && !choice) return setError('Choose an available repository');
    setBusy(true);
    setError(null);
    try {
      const bundle = await post<ProjectBundle>('/projects', {
        key: effectiveKey, name, description,
        defaultAgentId: defaultAgentId === 'none' ? null : defaultAgentId,
        ...(choice ? { repository: {
          connectionId: choice.connectionId,
          providerRepoId: choice.providerRepoId,
          ...(baseBranch.trim() ? { baseBranch: baseBranch.trim() } : {}),
        } } : {}),
      });
      qc.setQueryData(keys.project(bundle.project.key), bundle);
      void qc.invalidateQueries({ queryKey: ['projects'] });
      onOpenChange(false);
      navigate(`/p/${bundle.project.key}`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>New project</DialogTitle>
            <DialogDescription>It starts with a default set of statuses you can change later.</DialogDescription>
          </DialogHeader>
          <fieldset disabled={busy} className="min-w-0">
            <FieldGroup>
              <FieldGroup className="grid grid-cols-[1fr_8rem] gap-3">
                <Field>
                  <FieldLabel htmlFor="project-name">Name</FieldLabel>
                  <Input id="project-name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} autoFocus />
                </Field>
                <Field data-invalid={!!error && !PROJECT_KEY_PATTERN.test(effectiveKey)}>
                  <FieldLabel htmlFor="project-key">Key</FieldLabel>
                  <Input
                    id="project-key"
                    value={effectiveKey}
                    onChange={(e) => {
                      setKeyTouched(true);
                      setKey(e.target.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 6));
                    }}
                    className="font-mono"
                    aria-invalid={!!error && !PROJECT_KEY_PATTERN.test(effectiveKey)}
                    required
                  />
                </Field>
              </FieldGroup>
              <FieldDescription>
                Tasks will be numbered <span className="font-mono">{effectiveKey || 'KEY'}-1</span>, <span className="font-mono">{effectiveKey || 'KEY'}-2</span>… The key can’t be changed later.
              </FieldDescription>
              <Field>
                <FieldLabel htmlFor="project-description">Description</FieldLabel>
                <Textarea id="project-description" rows={3} maxLength={10000} value={description} onChange={(e) => setDescription(e.target.value)} />
              </Field>
              <Field>
                <FieldLabel htmlFor="project-default-agent">Default Agent</FieldLabel>
                <Select value={defaultAgentId} onValueChange={setDefaultAgentId} disabled={busy || agents.isPending}>
                  <SelectTrigger id="project-default-agent" className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="none">No Agent</SelectItem>
                      {(agents.data ?? []).filter((a) => a.enabled).map((a) => <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>)}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                <FieldDescription>Assigned to new Tasks. You can change this later.</FieldDescription>
                {agents.error && <><ErrorText>{errorMessage(agents.error)}</ErrorText><Button type="button" variant="outline" onClick={() => void agents.refetch()}>Retry agents</Button></>}
              </Field>
              <Field>
                <FieldLabel htmlFor="project-repository-search">Search repositories</FieldLabel>
                <Input id="project-repository-search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Owner, group or repository name" />
              </Field>
              <Field>
                <FieldLabel htmlFor="project-repository">Repository</FieldLabel>
                <Select value={selected} disabled={busy || groups.isPending} onValueChange={(value) => {
                  setSelected(value);
                  setBaseBranch(repositories.find((r) => `${r.connectionId}:${r.providerRepoId}` === value)?.defaultBranch ?? '');
                }}>
                  <SelectTrigger id="project-repository" className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectGroup><SelectItem value="none">No Repository</SelectItem></SelectGroup>
                    {(groups.data ?? []).map((g) => (
                      <SelectGroup key={g.connection.id}>
                        <SelectLabel>{g.connection.name} · {g.connection.host}</SelectLabel>
                        {g.repositories.filter((r) => `${r.connectionId}:${r.providerRepoId}` === selected || `${r.owner}/${r.name}`.toLowerCase().includes(search.toLowerCase())).map((r) => (
                          <SelectItem key={r.providerRepoId} value={`${r.connectionId}:${r.providerRepoId}`}>{r.owner}/{r.name}{r.private ? ' (private)' : ''}</SelectItem>
                        ))}
                      </SelectGroup>
                    ))}
                  </SelectContent>
                </Select>
                {groups.isPending && <FieldDescription>Loading repositories…</FieldDescription>}
                {groups.data?.length === 0 && <FieldDescription>An Admin can add a Git Connection in Git settings to link a Repository.</FieldDescription>}
                {groups.error && <><ErrorText>{errorMessage(groups.error)}</ErrorText><Button type="button" variant="outline" onClick={() => void groups.refetch()}>Retry repositories</Button></>}
                {(groups.data ?? []).filter((g) => g.error).map((g) => <ErrorText key={g.connection.id}>{g.connection.name}: {g.error}</ErrorText>)}
              </Field>
              {choice && <Field>
                <FieldLabel htmlFor="project-base-branch">Base branch</FieldLabel>
                <Input id="project-base-branch" value={baseBranch} onChange={(e) => setBaseBranch(e.target.value)} maxLength={250} />
                <FieldDescription>Defaults to the Repository’s default branch.</FieldDescription>
              </Field>}
            </FieldGroup>
          </fieldset>
          <ErrorText>{error}</ErrorText>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={busy}>{busy ? 'Creating…' : 'Create project'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
