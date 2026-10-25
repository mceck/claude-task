import { CATEGORIES, projectTopic } from '@claude-task/shared';
import type { Category, Label as LabelT, Project, ProjectBundle, Status } from '@claude-task/shared';
import { useQueryClient } from '@tanstack/react-query';
import { Archive, ArchiveRestore, ArrowDown, ArrowLeft, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { del, errorMessage, patch, post, put } from '../api/client';
import { keys, useMe, useProject } from '../api/queries';
import { LabelChip, Loading, StatusDot, useConfirm } from '../components/common';
import { useTopic } from '../lib/realtime';
import { NotFoundPage } from './NotFoundPage';
import { CATEGORY_COLOR, PageHeader } from './ProjectsPage';
import { ProjectAgentSettings } from '../components/ProjectAgentSettings';

export function ProjectSettingsPage() {
  const { projectKey } = useParams();
  const bundle = useProject(projectKey);
  useTopic(bundle.data ? projectTopic(bundle.data.project.id) : null);

  if (bundle.isPending) return <Loading className="h-full" />;
  if (!bundle.data) return <NotFoundPage what="Project" />;
  const { project } = bundle.data;

  return (
    <div className="mx-auto max-w-3xl px-8 py-8">
      <Button asChild variant="ghost" size="sm" className="mb-3 -ml-2 text-muted-foreground">
        <Link to={`/p/${project.key}`}>
          <ArrowLeft /> {project.key} board
        </Link>
      </Button>
      <PageHeader title={`${project.name} settings`} />
      <Tabs defaultValue="general">
        <TabsList className="mb-4">
          <TabsTrigger value="general">General</TabsTrigger>
          <TabsTrigger value="statuses">Statuses</TabsTrigger>
          <TabsTrigger value="labels">Labels</TabsTrigger>
          <TabsTrigger value="agents">Agents</TabsTrigger>
        </TabsList>
        <TabsContent value="general">
          <General project={project} />
        </TabsContent>
        <TabsContent value="statuses">
          <Statuses bundle={bundle.data} />
        </TabsContent>
        <TabsContent value="labels">
          <Labels bundle={bundle.data} />
        </TabsContent>
        <TabsContent value="agents"><ProjectAgentSettings projectId={project.id} /></TabsContent>
      </Tabs>
    </div>
  );
}

function Section({ title, description, children, danger }: { title: string; description?: ReactNode; children: ReactNode; danger?: boolean }) {
  return (
    <section className={`rounded-xl border bg-card p-5 ${danger ? 'border-destructive/30' : ''}`}>
      <h2 className="font-medium">{title}</h2>
      {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

/** Runs a mutation, refreshes the project and reports errors as toasts. */
function useRun(project: Project) {
  const qc = useQueryClient();
  return async (fn: () => Promise<unknown>, success?: string): Promise<boolean> => {
    try {
      await fn();
      if (success) toast.success(success);
      return true;
    } catch (err) {
      toast.error(errorMessage(err));
      return false;
    } finally {
      await Promise.all([qc.invalidateQueries({ queryKey: keys.project(project.key) }), qc.invalidateQueries({ queryKey: ['projects'] })]);
    }
  };
}

function General({ project }: { project: Project }) {
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description);
  const me = useMe();
  const run = useRun(project);
  const confirm = useConfirm();
  const navigate = useNavigate();

  const save = (e: FormEvent) => {
    e.preventDefault();
    void run(() => patch(`/projects/${project.id}`, { name, description }), 'Project saved');
  };

  const remove = async () => {
    const ok = await confirm({
      title: `Delete ${project.key} permanently?`,
      description: 'All its tasks, comments and attachments are deleted. This can’t be undone.',
      confirmLabel: 'Delete project',
      destructive: true,
    });
    if (ok && (await run(() => del(`/projects/${project.id}`), `${project.key} deleted`))) navigate('/');
  };

  return (
    <div className="space-y-4">
      <Section title="Details">
        <form onSubmit={save} className="space-y-4">
          <div className="grid grid-cols-[8rem_1fr] gap-3">
            <div className="space-y-2">
              <Label htmlFor="key">Key</Label>
              <Input id="key" value={project.key} disabled className="font-mono" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="name">Name</Label>
              <Input id="name" value={name} onChange={(e) => setName(e.target.value)} required />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="description">Description</Label>
            <Textarea id="description" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <div className="flex justify-end">
            <Button type="submit">Save changes</Button>
          </div>
        </form>
      </Section>
      <Section
        title={project.archivedAt ? 'This project is archived' : 'Archive project'}
        description={
          project.archivedAt
            ? 'It’s hidden from the projects list. Its board and history are still here.'
            : 'Hide the project from the list without losing anything. You can unarchive it at any time.'
        }
        danger={!!project.archivedAt}
      >
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={() =>
              run(() => post(`/projects/${project.id}/${project.archivedAt ? 'unarchive' : 'archive'}`), project.archivedAt ? 'Project unarchived' : 'Project archived')
            }
          >
            {project.archivedAt ? <ArchiveRestore /> : <Archive />}
            {project.archivedAt ? 'Unarchive' : 'Archive'}
          </Button>
          {project.archivedAt && me.data?.role === 'admin' && (
            <Button variant="destructive" onClick={remove}>
              <Trash2 /> Delete permanently
            </Button>
          )}
        </div>
      </Section>
    </div>
  );
}

function CategoryPicker({ value, onChange, label }: { value: Category; onChange: (c: Category) => void; label: string }) {
  return (
    <Select value={value} onValueChange={(c) => onChange(c as Category)}>
      <SelectTrigger size="sm" className="w-28" aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {CATEGORIES.map((c) => (
          <SelectItem key={c} value={c}>
            <span className={`size-2 rounded-full ${CATEGORY_COLOR[c]}`} /> {c}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function ColorInput({ value, onCommit, label }: { value: string; onCommit: (color: string) => void; label: string }) {
  return (
    <label className="relative flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md border hover:border-foreground/30">
      <StatusDot color={value} className="size-3" />
      <input
        type="color"
        aria-label={label}
        defaultValue={value}
        onBlur={(e) => e.target.value !== value && onCommit(e.target.value)}
        className="absolute inset-0 cursor-pointer opacity-0"
      />
    </label>
  );
}

function Statuses({ bundle }: { bundle: ProjectBundle }) {
  const { project } = bundle;
  const statuses = [...bundle.statuses].sort((a, b) => a.position - b.position);
  const [deleting, setDeleting] = useState<Status | null>(null);
  const [name, setName] = useState('');
  const [color, setColor] = useState('#64748b');
  const [category, setCategory] = useState<Category>('active');
  const run = useRun(project);

  const swap = (i: number, j: number) => {
    const ids = statuses.map((s) => s.id);
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    void run(() => put(`/projects/${project.id}/statuses/order`, { statusIds: ids }));
  };

  const add = (e: FormEvent) => {
    e.preventDefault();
    void run(() => post(`/projects/${project.id}/statuses`, { name, color, category })).then((ok) => ok && setName(''));
  };

  return (
    <div className="space-y-4">
      <Section
        title="Workflow"
        description={
          <>
            The category tells the system what a status means. A project always keeps at least one <b>open</b> and one <b>closed</b> status.
            Closed statuses are hidden on the board unless “Show closed” is on.
          </>
        }
      >
        <ul className="divide-y rounded-lg border">
          {statuses.map((s, i) => (
            <li key={`${s.id}:${s.name}:${s.color}:${s.category}`} className="flex items-center gap-2 px-3 py-2">
              <ColorInput label={`Color of ${s.name}`} value={s.color} onCommit={(c) => run(() => patch(`/statuses/${s.id}`, { color: c }))} />
              <Input
                aria-label={`Name of ${s.name}`}
                defaultValue={s.name}
                onBlur={(e) => e.target.value.trim() && e.target.value !== s.name && run(() => patch(`/statuses/${s.id}`, { name: e.target.value }))}
                className="h-7 flex-1 border-transparent bg-transparent shadow-none hover:border-input dark:bg-transparent"
              />
              <CategoryPicker label={`Category of ${s.name}`} value={s.category} onChange={(c) => run(() => patch(`/statuses/${s.id}`, { category: c }))} />
              <Button variant="ghost" size="icon-sm" aria-label={`Move ${s.name} up`} disabled={i === 0} onClick={() => swap(i, i - 1)}>
                <ArrowUp />
              </Button>
              <Button variant="ghost" size="icon-sm" aria-label={`Move ${s.name} down`} disabled={i === statuses.length - 1} onClick={() => swap(i, i + 1)}>
                <ArrowDown />
              </Button>
              <Button variant="ghost" size="icon-sm" aria-label={`Delete ${s.name}`} className="text-muted-foreground hover:text-destructive" onClick={() => setDeleting(s)}>
                <Trash2 />
              </Button>
            </li>
          ))}
        </ul>
        <form onSubmit={add} className="mt-3 flex items-center gap-2">
          <label className="relative flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-md border">
            <StatusDot color={color} className="size-3" />
            <input type="color" aria-label="New status color" value={color} onChange={(e) => setColor(e.target.value)} className="absolute inset-0 opacity-0" />
          </label>
          <Input aria-label="New status name" placeholder="New status name" value={name} onChange={(e) => setName(e.target.value)} required />
          <CategoryPicker label="New status category" value={category} onChange={setCategory} />
          <Button type="submit" variant="outline">
            <Plus /> Add
          </Button>
        </form>
      </Section>
      <DeleteStatusDialog
        status={deleting}
        others={statuses.filter((s) => s.id !== deleting?.id)}
        onClose={() => setDeleting(null)}
        onConfirm={(targetStatusId) =>
          run(() => del(`/statuses/${deleting!.id}?targetStatusId=${targetStatusId}`), 'Status deleted').then((ok) => ok && setDeleting(null))
        }
      />
    </div>
  );
}

function DeleteStatusDialog({
  status,
  others,
  onClose,
  onConfirm,
}: {
  status: Status | null;
  others: Status[];
  onClose: () => void;
  onConfirm: (targetStatusId: string) => void;
}) {
  const [target, setTarget] = useState('');
  const selected = others.some((s) => s.id === target) ? target : (others[0]?.id ?? '');
  return (
    <Dialog open={!!status} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete “{status?.name}”</DialogTitle>
          <DialogDescription>Its tasks move to the end of the status you pick, and each move is recorded on the task.</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label>Move its tasks to</Label>
          <Select value={selected} onValueChange={setTarget}>
            <SelectTrigger className="w-full" aria-label="Move its tasks to">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {others.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  <StatusDot color={s.color} className="size-2" /> {s.name}
                  <span className="text-muted-foreground">· {s.category}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="destructive" disabled={!selected} onClick={() => onConfirm(selected)}>
            Delete status
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Labels({ bundle }: { bundle: ProjectBundle }) {
  const { project, labels } = bundle;
  const [name, setName] = useState('');
  const [color, setColor] = useState('#6366f1');
  const run = useRun(project);
  const confirm = useConfirm();

  const add = (e: FormEvent) => {
    e.preventDefault();
    void run(() => post(`/projects/${project.id}/labels`, { name, color })).then((ok) => ok && setName(''));
  };

  const remove = async (l: LabelT) => {
    const ok = await confirm({ title: `Delete label “${l.name}”?`, description: 'It’s removed from every task.', confirmLabel: 'Delete label', destructive: true });
    if (ok) void run(() => del(`/labels/${l.id}`));
  };

  return (
    <Section title="Labels" description="Project-scoped tags to categorize tasks. A task can have several.">
      {labels.length === 0 ? (
        <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">No labels yet.</p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {labels.map((l) => (
            <li key={`${l.id}:${l.name}:${l.color}`} className="flex items-center gap-2 px-3 py-2">
              <ColorInput label={`Color of ${l.name}`} value={l.color} onCommit={(c) => run(() => patch(`/labels/${l.id}`, { color: c }))} />
              <Input
                aria-label={`Name of ${l.name}`}
                defaultValue={l.name}
                onBlur={(e) => e.target.value.trim() && e.target.value !== l.name && run(() => patch(`/labels/${l.id}`, { name: e.target.value }))}
                className="h-7 flex-1 border-transparent bg-transparent shadow-none hover:border-input dark:bg-transparent"
              />
              <LabelChip name={l.name} color={l.color} />
              <Button variant="ghost" size="icon-sm" aria-label={`Delete ${l.name}`} className="text-muted-foreground hover:text-destructive" onClick={() => remove(l)}>
                <Trash2 />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={add} className="mt-3 flex items-center gap-2">
        <label className="relative flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-md border">
          <StatusDot color={color} className="size-3" />
          <input type="color" aria-label="New label color" value={color} onChange={(e) => setColor(e.target.value)} className="absolute inset-0 opacity-0" />
        </label>
        <Input aria-label="New label name" placeholder="New label name" value={name} onChange={(e) => setName(e.target.value)} required />
        <Button type="submit" variant="outline">
          <Plus /> Add
        </Button>
      </form>
    </Section>
  );
}
