import { AGENTS_TOPIC, taskTopic } from '@claude-task/shared';
import type { Wiki } from '@claude-task/shared';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, BookOpen, Plus, RotateCcw, Settings, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { del, errorMessage, patch, post } from '../api/client';
import { Combobox } from '../components/Combobox';
import { keys, useAgents, useRepositoryGroups, useTask, useTaskSession, useUsers, useWiki, useWikis } from '../api/queries';
import { ErrorText, Field, Loading, useConfirm } from '../components/common';
import { BranchLink, PullRequestBadge } from '../components/Git';
import { TaskActivity } from '../components/TaskActivity';
import { SessionChip } from '../components/agents';
import { useTopic } from '../lib/realtime';
import { applyEvent } from '../lib/cache';
import { applyLiveEvent } from '../lib/live';

export function WikisPage() {
  const query = useWikis();
  const [creating, setCreating] = useState(false);
  useTopic('wikis');
  return (
    <div className="mx-auto max-w-5xl space-y-6 p-8">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Wiki</h1>
          <p className="mt-1 text-sm text-muted-foreground">LLM wiki with a shared conversation and an assigned agent.</p>
        </div>
        <Button onClick={() => setCreating(true)}>
          <Plus /> New wiki
        </Button>
      </header>
      {query.isPending ? (
        <Loading />
      ) : query.error ? (
        <ErrorText>{errorMessage(query.error)}</ErrorText>
      ) : query.data.length === 0 ? (
        <div className="rounded-xl border p-10 text-center text-muted-foreground">
          Create a wiki to work together on your documentation.
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {query.data.map((wiki) => (
            <Link
              key={wiki.id}
              to={`/wikis/${wiki.id}`}
              className="space-y-2 rounded-xl border bg-card p-5 transition-colors hover:bg-muted/40"
            >
              <div className="flex items-center gap-2 font-medium">
                <BookOpen className="size-4" />
                {wiki.name}
              </div>
              <p className="line-clamp-2 text-sm text-muted-foreground">
                {wiki.description || `${wiki.repository.owner}/${wiki.repository.name}`}
              </p>
              <p className="text-xs text-muted-foreground">
                {wiki.repository.owner}/{wiki.repository.name}
              </p>
            </Link>
          ))}
        </div>
      )}
      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New wiki</DialogTitle>
          </DialogHeader>
          <WikiForm onSaved={() => setCreating(false)} />
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function WikiPage() {
  const { wikiId } = useParams();
  const query = useWiki(wikiId!);
  useTopic('wikis');
  if (query.isPending) return <Loading />;
  if (query.error) return <ErrorText>{errorMessage(query.error)}</ErrorText>;
  return <WikiConversation key={query.data.id} wiki={query.data} />;
}

function WikiConversation({ wiki }: { wiki: Wiki }) {
  const task = useTask(wiki.taskId);
  const session = useTaskSession(wiki.taskId);
  const users = useUsers();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useTopic(taskTopic(wiki.taskId));
  useTopic(AGENTS_TOPIC);
  const reset = async () => {
    if (
      !(await confirm({
        title: 'Reset chat?',
        description: 'Delete all messages for everyone and start a fresh agent session. Wiki files are kept.',
        confirmLabel: 'Reset chat',
        destructive: true,
      }))
    )
      return;
    setBusy(true);
    setError('');
    try {
      await post(`/wikis/${wiki.id}/reset`);
      const event = { type: 'timeline.reset', taskId: wiki.taskId } as const;
      applyEvent(qc, event);
      applyLiveEvent(event);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (
      !(await confirm({
        title: 'Delete wiki?',
        description: 'Delete this wiki and its chat from the app. The remote repository is kept.',
        confirmLabel: 'Delete wiki',
        destructive: true,
      }))
    )
      return;
    setBusy(true);
    setError('');
    try {
      await del(`/wikis/${wiki.id}`);
      await qc.invalidateQueries({ queryKey: keys.wikis });
      navigate('/wikis');
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };
  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-center gap-3 border-b p-4">
        <Button variant="ghost" size="icon-sm" asChild>
          <Link to="/wikis" aria-label="Back to wikis">
            <ArrowLeft />
          </Link>
        </Button>
        <div className="min-w-0 flex-1">
          <h1 className="truncate font-semibold">{task.data?.title ?? wiki.name}</h1>
          <a href={wiki.repository.webUrl} target="_blank" rel="noreferrer" className="text-xs text-muted-foreground underline">
            {wiki.repository.owner}/{wiki.repository.name}
          </a>
        </div>
        {session.data && <SessionChip session={session.data} />}
        {session.data?.state === 'running' && (
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => {
              void post(`/tasks/${wiki.taskId}/session/stop`).catch((e) => setError(errorMessage(e)));
            }}
          >
            Stop
          </Button>
        )}
        {session.data?.held && (
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => {
              void post(`/tasks/${wiki.taskId}/session/retry`).catch((e) => setError(errorMessage(e)));
            }}
          >
            Retry
          </Button>
        )}
        <Button variant="outline" disabled={busy} onClick={reset}>
          <RotateCcw /> Reset chat
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label="Wiki settings" onClick={() => setEditing(true)}>
          <Settings />
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label="Delete wiki" disabled={busy} onClick={remove}>
          <Trash2 />
        </Button>
      </header>
      {task.data?.branchName && task.data.branchUrl && (
        <div className="flex items-center gap-3 border-b px-4 py-2">
          <BranchLink name={task.data.branchName} url={task.data.branchUrl} />
          {task.data.pullRequest && <PullRequestBadge pr={task.data.pullRequest} />}
        </div>
      )}
      {error && (
        <div className="p-4">
          <ErrorText>{error}</ErrorText>
        </div>
      )}
      {task.isPending ? (
        <Loading />
      ) : task.error ? (
        <ErrorText>{errorMessage(task.error)}</ErrorText>
      ) : (
        <TaskActivity task={task.data} statuses={[]} tags={[]} users={users.data ?? []} session={session.data} hideChanges />
      )}
      <Dialog open={editing} onOpenChange={setEditing}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Wiki settings</DialogTitle>
          </DialogHeader>
          <WikiForm wiki={wiki} onSaved={() => setEditing(false)} />
        </DialogContent>
      </Dialog>
    </div>
  );
}

function WikiForm({ wiki, onSaved }: { wiki?: Wiki; onSaved: () => void }) {
  const agents = useAgents();
  const groups = useRepositoryGroups();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState(wiki?.name ?? '');
  const [description, setDescription] = useState(wiki?.description ?? '');
  const [agentId, setAgentId] = useState(wiki?.agentId ?? '');
  const [selected, setSelected] = useState('');
  const [baseBranch, setBaseBranch] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const repositories = (groups.data ?? []).flatMap((g) =>
    g.repositories.map((r) => ({ ...r, label: `${g.connection.name} · ${r.owner}/${r.name}` })),
  );
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const choice = repositories.find((r) => `${r.connectionId}:${r.providerRepoId}` === selected);
      const body = { name, description, agentId };
      const result = wiki
        ? await patch<{ wiki: Wiki }>(`/wikis/${wiki.id}`, body)
        : await post<{ wiki: Wiki }>('/wikis', {
            ...body,
            repository: {
              connectionId: choice!.connectionId,
              providerRepoId: choice!.providerRepoId,
              ...(baseBranch.trim() ? { baseBranch: baseBranch.trim() } : {}),
            },
          });
      qc.setQueryData(keys.wiki(result.wiki.id), result.wiki);
      await qc.invalidateQueries({ queryKey: keys.wikis });
      await qc.invalidateQueries({ queryKey: keys.task(result.wiki.taskId) });
      onSaved();
      if (!wiki) navigate(`/wikis/${result.wiki.id}`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={save} className="min-w-0 space-y-4">
      <Field label="Name">
        <Input aria-label="Wiki name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} />
      </Field>
      <Field label="Description">
        <Textarea aria-label="Wiki description" value={description} onChange={(e) => setDescription(e.target.value)} />
      </Field>
      <Field label="Agent">
        <select
          aria-label="Agent"
          className="h-9 w-full rounded-md border bg-background px-3 text-sm"
          required
          value={agentId}
          onChange={(e) => setAgentId(e.target.value)}
        >
          <option value="">Choose an agent</option>
          {agents.data
            ?.filter((a) => a.enabled || a.id === agentId)
            .map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
        </select>
      </Field>
      {!wiki && (
        <>
          <Field label="Repository" hint="The repository already contains Markdown files and the skills to maintain them.">
            <Combobox
              aria-label="Repository"
              placeholder="Choose a repository"
              searchPlaceholder="Search by owner, group or name"
              value={selected}
              onValueChange={(value) => {
                setSelected(value);
                setBaseBranch(repositories.find((r) => `${r.connectionId}:${r.providerRepoId}` === value)?.defaultBranch ?? '');
              }}
              groups={(groups.data ?? [])
                .filter((g) => g.repositories.length)
                .map((g) => ({
                  label: `${g.connection.name} · ${g.connection.host}`,
                  options: g.repositories.map((r) => ({ value: `${r.connectionId}:${r.providerRepoId}`, label: `${r.owner}/${r.name}`, hint: r.private ? 'private' : undefined })),
                }))}
            />
          </Field>
          <Field label="Base branch">
            <Input aria-label="Base branch" value={baseBranch} onChange={(e) => setBaseBranch(e.target.value)} />
          </Field>
          {groups.data
            ?.filter((g) => g.error)
            .map((g) => (
              <ErrorText key={g.connection.id}>
                {g.connection.name}: {g.error}
              </ErrorText>
            ))}
          {!groups.isPending && repositories.length === 0 && (
            <p className="text-sm text-muted-foreground">Add a Git Connection in Git settings to select a repository.</p>
          )}
        </>
      )}
      {(error || agents.error || (!wiki && groups.error)) && <ErrorText>{error || errorMessage(agents.error ?? groups.error)}</ErrorText>}
      <Button type="submit" disabled={busy || !name.trim() || !agentId || (!wiki && !selected)}>
        {busy ? 'Saving…' : wiki ? 'Save wiki' : 'Create wiki'}
      </Button>
    </form>
  );
}
