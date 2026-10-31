import { AGENTS_TOPIC, taskTopic } from '@claude-task/shared';
import type { Wiki, WikiChat } from '@claude-task/shared';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, BookOpen, Loader2, MoreHorizontal, PanelBottomClose, Pencil, Plus, Settings, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { del, errorMessage, patch, post } from '../api/client';
import { Combobox } from '../components/Combobox';
import { keys, useAgents, useRepositoryGroups, useTask, useTaskSession, useUsers, useWiki, useWikiChats, useWikis } from '../api/queries';
import { ErrorText, Field, Loading, Time, useConfirm } from '../components/common';
import { BranchLink, PullRequestBadge } from '../components/Git';
import { TaskActivity } from '../components/TaskActivity';
import { SessionChip } from '../components/agents';
import { useTopic } from '../lib/realtime';
import { applyEvent } from '../lib/cache';
import { minimizeInDock, removeFromDock, useDockAvailable } from '../lib/dock';
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
  const { chatId } = useParams();
  const chats = useWikiChats(wiki.id);
  const agents = useAgents();
  const wikiTask = useTask(wiki.taskId);
  const qc = useQueryClient();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const [renaming, setRenaming] = useState<WikiChat | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // The empty Chat reserved by New chat: it is listed only once it has a Comment.
  const [reserved, setReserved] = useState<WikiChat | null>(null);
  const reserving = useRef(false);
  const dockable = useDockAvailable();
  const list = chats.data;
  const urlTask = useTask(chatId);
  const listed = chatId ? (list?.find((c) => c.id === chatId) ?? (reserved?.id === chatId ? reserved : undefined)) : undefined;
  // An empty Chat is not listed until its first Comment: accept its Task when the URL names it.
  const unlisted: WikiChat | undefined =
    chatId && !listed && urlTask.data?.projectId === wiki.id
      ? {
          id: urlTask.data.id,
          wikiId: wiki.id,
          title: 'Chat',
          agentId: urlTask.data.agentId,
          sessionState: urlTask.data.session?.state ?? null,
          running: urlTask.data.session?.state === 'running',
          unread: false,
          createdAt: urlTask.data.createdAt,
          lastActivityAt: urlTask.data.updatedAt,
        }
      : undefined;
  // A Chat id in the address is never replaced by another Chat: only the Wiki root picks the latest.
  const chat = chatId ? (listed ?? unlisted) : (list?.[0] ?? reserved ?? undefined);
  const task = useTask(chat?.id);
  const session = useTaskSession(chat?.id);
  const users = useUsers();
  useTopic(chat ? taskTopic(chat.id) : null);
  // The branch and pull request live on the backing Task, even when another Chat created them.
  useTopic(wikiTask.data ? taskTopic(wikiTask.data.id) : null);
  useTopic(AGENTS_TOPIC);
  // The open Chat is not also in the Dock: opening it from there (or from anywhere) moves it back to the page.
  useEffect(() => {
    if (chat) removeFromDock(chat.id);
  }, [chat?.id]);
  // A Wiki without Chats opens an empty composer, which needs a Task to post to.
  useEffect(() => {
    if (!list || chat || reserving.current) return;
    reserving.current = true;
    post<{ chat: WikiChat }>(`/wikis/${wiki.id}/chats`)
      .then((r) => setReserved(r.chat))
      .catch((err) => setError(errorMessage(err)))
      .finally(() => {
        reserving.current = false;
      });
  }, [list, chat, wiki.id]);
  const openChat = (id: string) => navigate(`/wikis/${wiki.id}/chats/${id}`);
  const newChat = async () => {
    setBusy(true);
    setError('');
    try {
      const r = await post<{ chat: WikiChat }>(`/wikis/${wiki.id}/chats`);
      setReserved(r.chat);
      openChat(r.chat.id);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const deleteChat = async (target: WikiChat) => {
    if (
      !(await confirm({
        title: 'Delete chat?',
        description: 'Delete this chat and everything in it for everyone. Wiki files are kept.',
        confirmLabel: 'Delete chat',
        destructive: true,
      }))
    )
      return;
    setError('');
    try {
      await del(`/wikis/${wiki.id}/chats/${target.id}`);
      const remaining = (qc.getQueryData<WikiChat[]>(keys.wikiChats(wiki.id)) ?? []).filter((c) => c.id !== target.id);
      qc.setQueryData(keys.wikiChats(wiki.id), remaining);
      const event = { type: 'timeline.reset', taskId: target.id } as const;
      applyEvent(qc, event);
      applyLiveEvent(event);
      if (reserved?.id === target.id) setReserved(null);
      if (chat?.id === target.id) {
        if (remaining[0]) openChat(remaining[0].id);
        else navigate(`/wikis/${wiki.id}`);
      }
      void qc.invalidateQueries({ queryKey: keys.wikiChats(wiki.id) });
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  const remove = async () => {
    if (
      !(await confirm({
        title: 'Delete wiki?',
        description: 'Delete this wiki and its chats from the app. The remote repository is kept.',
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
  const owner = chat?.agentId && chat.agentId !== wiki.agentId ? agents.data?.find((a) => a.id === chat.agentId) : undefined;
  const readOnly =
    chat?.agentId && chat.agentId !== wiki.agentId
      ? `This chat is run by ${owner?.name ?? 'another agent'}: assign the wiki back to that agent to continue it.`
      : undefined;
  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-center gap-3 border-b p-4">
        <Button variant="ghost" size="icon-sm" asChild>
          <Link to="/wikis" aria-label="Back to wikis">
            <ArrowLeft />
          </Link>
        </Button>
        <div className="min-w-0 flex-1">
          <h1 className="truncate font-semibold">{wiki.name}</h1>
          <a href={wiki.repository.webUrl} target="_blank" rel="noreferrer" className="text-xs text-muted-foreground underline">
            {wiki.repository.owner}/{wiki.repository.name}
          </a>
        </div>
        <Button variant="ghost" size="icon-sm" aria-label="Wiki settings" onClick={() => setEditing(true)}>
          <Settings />
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label="Delete wiki" disabled={busy} onClick={remove}>
          <Trash2 />
        </Button>
      </header>
      {wikiTask.data?.branchName && wikiTask.data.branchUrl && (
        <div className="flex items-center gap-3 border-b px-4 py-2">
          <BranchLink name={wikiTask.data.branchName} url={wikiTask.data.branchUrl} />
          {wikiTask.data.pullRequest && <PullRequestBadge pr={wikiTask.data.pullRequest} />}
        </div>
      )}
      {error && (
        <div className="p-4">
          <ErrorText>{error}</ErrorText>
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <nav aria-label="Chats" className="flex w-56 shrink-0 flex-col border-r md:w-72">
          <div className="p-3">
            <Button variant="outline" className="w-full" disabled={busy} onClick={newChat}>
              <Plus /> New chat
            </Button>
          </div>
          <ul className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-2">
            {chats.isPending && <Loading />}
            {chats.error && <ErrorText>{errorMessage(chats.error)}</ErrorText>}
            {list?.map((c) => (
              <ChatRow
                key={c.id}
                chat={c}
                active={c.id === chat?.id}
                onOpen={() => openChat(c.id)}
                onRename={() => setRenaming(c)}
                onDelete={() => void deleteChat(c)}
              />
            ))}
          </ul>
        </nav>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {chat && (
            <div className="flex flex-wrap items-center gap-3 border-b px-4 py-2">
              <h2 className="min-w-0 flex-1 truncate text-sm font-medium">{list?.find((c) => c.id === chat.id)?.title ?? 'New chat'}</h2>
              {session.data && <SessionChip session={session.data} />}
              {session.data?.state === 'running' && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    void post(`/tasks/${chat.id}/session/stop`).catch((e) => setError(errorMessage(e)));
                  }}
                >
                  Stop
                </Button>
              )}
              {session.data?.held && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    void post(`/tasks/${chat.id}/session/retry`).catch((e) => setError(errorMessage(e)));
                  }}
                >
                  Retry
                </Button>
              )}
              {dockable && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Minimize chat"
                      disabled={!task.data}
                      onClick={() => {
                        // The Dock keeps the conversation generation, so a later Delete Chat closes its panel.
                        minimizeInDock({
                          taskId: chat.id,
                          wikiId: wiki.id,
                          generation: task.data?.chatGeneration ?? 0,
                        });
                        navigate('/wikis');
                      }}
                    >
                      <PanelBottomClose />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Minimize chat</TooltipContent>
                </Tooltip>
              )}
            </div>
          )}
          {!chat || task.isPending ? (
            <Loading />
          ) : task.error ? (
            <ErrorText>{errorMessage(task.error)}</ErrorText>
          ) : (
            <TaskActivity
              key={chat.id}
              task={task.data}
              statuses={[]}
              tags={[]}
              users={users.data ?? []}
              session={session.data}
              hideChanges
              readOnly={readOnly}
              reserveDockSpace
            />
          )}
        </div>
      </div>
      <Dialog open={editing} onOpenChange={setEditing}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Wiki settings</DialogTitle>
          </DialogHeader>
          <WikiForm wiki={wiki} onSaved={() => setEditing(false)} />
        </DialogContent>
      </Dialog>
      <Dialog open={!!renaming} onOpenChange={(open) => !open && setRenaming(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename chat</DialogTitle>
          </DialogHeader>
          {renaming && <RenameChatForm key={renaming.id} wikiId={wiki.id} chat={renaming} onDone={() => setRenaming(null)} />}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ChatRow({
  chat,
  active,
  onOpen,
  onRename,
  onDelete,
}: {
  chat: WikiChat;
  active: boolean;
  onOpen: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  return (
    <li className={`group flex items-center gap-1 rounded-md pr-1 ${active ? 'bg-muted' : 'hover:bg-muted/50'}`}>
      <button type="button" aria-current={active ? 'true' : undefined} className="min-w-0 flex-1 p-2 text-left" onClick={onOpen}>
        <span className="flex items-center gap-1.5">
          <span className="truncate text-sm">{chat.title}</span>
          {chat.unread && !active && <span role="img" aria-label="Unread" className="size-2 shrink-0 rounded-full bg-primary" />}
          {chat.running && <Loader2 role="img" aria-label="Working" className="size-3 shrink-0 animate-spin text-muted-foreground" />}
        </span>
        <Time iso={chat.lastActivityAt} className="text-xs text-muted-foreground" />
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label={`Chat actions: ${chat.title}`}>
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={onRename}>
            <Pencil /> Rename
          </DropdownMenuItem>
          <DropdownMenuItem variant="destructive" onSelect={onDelete}>
            <Trash2 /> Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}

function RenameChatForm({ wikiId, chat, onDone }: { wikiId: string; chat: WikiChat; onDone: () => void }) {
  const qc = useQueryClient();
  const [title, setTitle] = useState(chat.title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await patch<{ chat: WikiChat }>(`/wikis/${wikiId}/chats/${chat.id}`, { title });
      qc.setQueryData<WikiChat[]>(keys.wikiChats(wikiId), (list) => list?.map((c) => (c.id === r.chat.id ? r.chat : c)));
      onDone();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };
  return (
    <form onSubmit={save} className="min-w-0 space-y-4">
      <Input aria-label="Chat title" value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} />
      {error && <ErrorText>{error}</ErrorText>}
      <Button type="submit" disabled={busy || !title.trim()}>
        {busy ? 'Saving…' : 'Rename chat'}
      </Button>
    </form>
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
