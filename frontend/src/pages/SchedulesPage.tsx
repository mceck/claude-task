import { AGENTS_TOPIC, describeCron, taskTopic } from '@claude-task/shared';
import type { Schedule, ScheduleRun } from '@claude-task/shared';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, CalendarClock, Pause, Pencil, Play, Plus, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { del, errorMessage, patch, post } from '../api/client';
import { keys, useAgents, useMe, useRepositoryGroups, useSchedule, useScheduleRuns, useSchedules, useTask, useTaskSession, useUsers } from '../api/queries';
import { Combobox } from '../components/Combobox';
import { ErrorText, Field, Loading, Time, useConfirm } from '../components/common';
import { TaskActivity } from '../components/TaskActivity';
import { SessionChip } from '../components/agents';
import { useTopic } from '../lib/realtime';

const STATE_LABEL: Record<ScheduleRun['state'], string> = { running: 'Running', succeeded: 'Succeeded', failed: 'Failed', skipped: 'Skipped' };
const STATE_VARIANT: Record<ScheduleRun['state'], 'default' | 'secondary' | 'destructive' | 'outline'> = {
  running: 'default',
  succeeded: 'secondary',
  failed: 'destructive',
  skipped: 'outline',
};

function RunState({ run }: { run: ScheduleRun }) {
  return <Badge variant={STATE_VARIANT[run.state]}>{STATE_LABEL[run.state]}</Badge>;
}

function duration(run: ScheduleRun): string {
  if (!run.finishedAt) return '';
  const seconds = Math.max(0, Math.round((new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()) / 1000));
  return seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.round(seconds / 60)} min` : `${(seconds / 3600).toFixed(1)} h`;
}

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' }) : '—');

function useIsAdmin(): boolean {
  return useMe().data?.role === 'admin';
}

export function SchedulesPage() {
  const query = useSchedules();
  const agents = useAgents();
  const admin = useIsAdmin();
  const [creating, setCreating] = useState(false);
  const [toggling, setToggling] = useState<string[]>([]);
  const qc = useQueryClient();
  useTopic('schedules');
  useTopic(AGENTS_TOPIC);
  const toggle = async (schedule: Schedule, enabled: boolean) => {
    setToggling((ids) => [...ids, schedule.id]);
    try {
      await patch(`/schedules/${schedule.id}`, { enabled });
      await qc.invalidateQueries({ queryKey: keys.schedules });
    } catch (err) {
      toast.error('Couldn’t update the schedule', { description: errorMessage(err) });
    } finally {
      setToggling((ids) => ids.filter((id) => id !== schedule.id));
    }
  };
  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Schedules</h1>
          <p className="mt-1 text-sm text-muted-foreground">Agents that work on their own, at a time you choose.</p>
        </div>
        {admin && (
          <Button onClick={() => setCreating(true)}>
            <Plus /> New schedule
          </Button>
        )}
      </header>
      {query.isPending ? (
        <Loading />
      ) : query.error ? (
        <ErrorText>{errorMessage(query.error)}</ErrorText>
      ) : query.data.length === 0 ? (
        <div className="rounded-xl border p-10 text-center text-muted-foreground">
          No schedules yet.{admin ? ' Create one to have an agent work on a timetable.' : ''}
        </div>
      ) : (
        <div className="rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Agent</TableHead>
                <TableHead>When</TableHead>
                <TableHead>Scope</TableHead>
                <TableHead>Next run</TableHead>
                <TableHead>Last run</TableHead>
                {admin && <TableHead>Enabled</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {query.data.map((s) => (
                <TableRow key={s.id}>
                  <TableCell className="max-w-[18rem] font-medium">
                    <Link to={`/schedules/${s.id}`} title={s.name} className="flex min-w-0 items-center gap-2 hover:underline">
                      <CalendarClock className="size-4 shrink-0" />
                      <span className="truncate">{s.name}</span>
                    </Link>
                  </TableCell>
                  <TableCell className="max-w-32 truncate" title={agents.data?.find((a) => a.id === s.agentId)?.name}>
                    {agents.data?.find((a) => a.id === s.agentId)?.name ?? '—'}
                  </TableCell>
                  <TableCell title={s.timeZone}>{describeCron(s.cron)}</TableCell>
                  <TableCell className="max-w-56 truncate" title={s.repository ? `${s.repository.owner}/${s.repository.name}` : 'Global'}>
                    {s.repository ? `${s.repository.owner}/${s.repository.name}` : 'Global'}
                    {s.readOnly && (
                      <Badge variant="outline" className="ml-2">
                        read-only
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>{s.enabled ? when(s.nextRunAt) : 'Paused'}</TableCell>
                  <TableCell>{s.lastRun ? <RunState run={s.lastRun} /> : '—'}</TableCell>
                  {admin && (
                    <TableCell>
                      <Switch
                        aria-label={`Enable ${s.name}`}
                        checked={s.enabled}
                        disabled={toggling.includes(s.id)}
                        onCheckedChange={(v) => void toggle(s, v)}
                      />
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>New schedule</DialogTitle>
          </DialogHeader>
          <ScheduleForm onSaved={() => setCreating(false)} />
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function SchedulePage() {
  const { scheduleId } = useParams();
  const query = useSchedule(scheduleId);
  const runs = useScheduleRuns(scheduleId);
  const agents = useAgents();
  const admin = useIsAdmin();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const acting = useRef(false);
  useTopic('schedules');
  if (query.isPending) return <Loading />;
  if (query.error) return <ErrorText>{errorMessage(query.error)}</ErrorText>;
  const schedule = query.data;
  const act = async (fn: () => Promise<unknown>) => {
    // A double click must not start two runs or flip the pause state twice.
    if (acting.current) return;
    acting.current = true;
    setBusy(true);
    setError('');
    try {
      await fn();
      await qc.invalidateQueries({ queryKey: keys.schedules });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      acting.current = false;
      setBusy(false);
    }
  };
  const remove = async () => {
    if (
      !(await confirm({
        title: 'Delete schedule?',
        description: 'Delete this schedule with all its runs and their conversations.',
        confirmLabel: 'Delete schedule',
        destructive: true,
      }))
    )
      return;
    setError('');
    try {
      await del(`/schedules/${schedule.id}`);
      await qc.invalidateQueries({ queryKey: keys.schedules });
      navigate('/schedules');
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  return (
    <div className="mx-auto max-w-6xl space-y-6 p-8">
      <header className="flex flex-wrap items-center gap-3">
        <Button variant="ghost" size="icon-sm" asChild>
          <Link to="/schedules" aria-label="Back to schedules">
            <ArrowLeft />
          </Link>
        </Button>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-2xl font-semibold">{schedule.name}</h1>
          <p className="text-sm text-muted-foreground">
            {describeCron(schedule.cron)} ({schedule.timeZone}) · {agents.data?.find((a) => a.id === schedule.agentId)?.name ?? 'No agent'} ·{' '}
            {schedule.repository ? `${schedule.repository.owner}/${schedule.repository.name}` : 'Global'}
            {schedule.readOnly ? ' · read-only' : ''}
          </p>
        </div>
        {admin && (
          <>
            <Button disabled={busy} onClick={() => void act(() => post(`/schedules/${schedule.id}/run`))}>
              <Play /> Run now
            </Button>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => void act(() => patch(`/schedules/${schedule.id}`, { enabled: !schedule.enabled }))}
            >
              {schedule.enabled ? <Pause /> : <Play />} {schedule.enabled ? 'Pause' : 'Resume'}
            </Button>
            <Button variant="ghost" size="icon-sm" aria-label="Edit schedule" onClick={() => setEditing(true)}>
              <Pencil />
            </Button>
            <Button variant="ghost" size="icon-sm" aria-label="Delete schedule" onClick={remove}>
              <Trash2 />
            </Button>
          </>
        )}
      </header>
      {error && <ErrorText>{error}</ErrorText>}
      <section className="space-y-2 rounded-xl border p-4">
        <p className="text-sm text-muted-foreground">
          Next run: {schedule.enabled ? when(schedule.nextRunAt) : 'paused'}
          {schedule.consecutiveSkips > 0 && ` · skipped ${schedule.consecutiveSkips} time${schedule.consecutiveSkips > 1 ? 's' : ''} in a row`}
          {schedule.createdBy && ` · created by ${schedule.createdBy.displayName}`}
        </p>
        <p className="text-sm font-medium">Prompt</p>
        <p className="whitespace-pre-wrap text-sm">{schedule.prompt}</p>
      </section>
      <section className="space-y-2">
        <h2 className="text-lg font-medium">Runs</h2>
        {runs.isPending ? (
          <Loading />
        ) : runs.error ? (
          <ErrorText>{errorMessage(runs.error)}</ErrorText>
        ) : runs.data.length === 0 ? (
          <div className="rounded-xl border p-8 text-center text-muted-foreground">No runs yet.</div>
        ) : (
          <div className="rounded-xl border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Started</TableHead>
                  <TableHead>Duration</TableHead>
                  <TableHead>Outcome</TableHead>
                  <TableHead>Run</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {runs.data.map((run) => (
                  <TableRow key={run.id}>
                    <TableCell>
                      <Time iso={run.startedAt} />
                      {run.manual && <span className="ml-2 text-xs text-muted-foreground">manual</span>}
                    </TableCell>
                    <TableCell>{duration(run)}</TableCell>
                    <TableCell>
                      <RunState run={run} />
                      {run.skipReason && <span className="ml-2 text-sm text-muted-foreground">{run.skipReason}</span>}
                    </TableCell>
                    <TableCell>
                      {run.taskKey && (
                        <Link to={`/schedules/${schedule.id}/runs/${run.taskKey}`} className="underline">
                          {run.taskKey}
                        </Link>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>
      <Dialog open={editing} onOpenChange={setEditing}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit schedule</DialogTitle>
          </DialogHeader>
          <ScheduleForm schedule={schedule} onSaved={() => setEditing(false)} />
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** A run's Task: the conversation of the Scheduled Run, with the Timeline of what the Agent did. */
export function ScheduleRunPage() {
  const { scheduleId, taskKey } = useParams();
  const schedule = useSchedule(scheduleId);
  const task = useTask(taskKey);
  const session = useTaskSession(task.data?.id);
  const users = useUsers();
  useTopic(task.data ? taskTopic(task.data.id) : null);
  useTopic(AGENTS_TOPIC);
  // The Task must be one of this Schedule's runs, not any Task whose key happens to be in the URL.
  if (schedule.data && task.data && task.data.projectId !== schedule.data.projectId) return <ErrorText>Run not found.</ErrorText>;
  // Closing the run ends its conversation: it stays readable but takes no more Comments.
  const closed = session.data?.state === 'closed';
  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-center gap-3 border-b p-4">
        <Button variant="ghost" size="icon-sm" asChild>
          <Link to={`/schedules/${scheduleId}`} aria-label="Back to the schedule">
            <ArrowLeft />
          </Link>
        </Button>
        <div className="min-w-0 flex-1">
          <h1 className="truncate font-semibold">{task.data?.title ?? taskKey}</h1>
          <p className="text-xs text-muted-foreground">{schedule.data?.name}</p>
        </div>
        {session.data && <SessionChip session={session.data} />}
      </header>
      {task.isPending ? (
        <Loading />
      ) : task.error ? (
        <ErrorText>{errorMessage(task.error)}</ErrorText>
      ) : (
        <TaskActivity
          key={task.data.id}
          task={task.data}
          statuses={[]}
          tags={[]}
          users={users.data ?? []}
          session={session.data}
          hideChanges
          reserveDockSpace
          readOnly={closed ? 'This run is closed: its conversation is read-only.' : undefined}
        />
      )}
    </div>
  );
}

function ScheduleForm({ schedule, onSaved }: { schedule?: Schedule; onSaved: () => void }) {
  const agents = useAgents();
  const groups = useRepositoryGroups();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState(schedule?.name ?? '');
  const [agentId, setAgentId] = useState(schedule?.agentId ?? '');
  const [cron, setCron] = useState(schedule?.cron ?? '0 9 * * 1-5');
  const [timeZone, setTimeZone] = useState(schedule?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC');
  const [prompt, setPrompt] = useState(schedule?.prompt ?? '');
  const [selected, setSelected] = useState(schedule?.repository ? `${schedule.repository.connectionId}:${schedule.repository.providerRepoId}` : '');
  const [baseBranch, setBaseBranch] = useState(schedule?.repository?.baseBranch ?? '');
  const [readOnly, setReadOnly] = useState(schedule?.readOnly ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const repositories = (groups.data ?? []).flatMap((g) => g.repositories);
  const zones = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const choice = repositories.find((r) => `${r.connectionId}:${r.providerRepoId}` === selected);
      const unchanged =
        !!schedule?.repository && `${schedule.repository.connectionId}:${schedule.repository.providerRepoId}` === selected && schedule.repository.baseBranch === baseBranch.trim();
      // The picker may not list the Repository yet (loading, or its Connection failed): keep the stored one.
      const chosen = choice
        ? { connectionId: choice.connectionId, providerRepoId: choice.providerRepoId }
        : schedule?.repository && `${schedule.repository.connectionId}:${schedule.repository.providerRepoId}` === selected
          ? { connectionId: schedule.repository.connectionId, providerRepoId: schedule.repository.providerRepoId }
          : null;
      const repository = selected && chosen ? { ...chosen, ...(baseBranch.trim() ? { baseBranch: baseBranch.trim() } : {}) } : null;
      // A disabled Agent stays valid while it is not being changed: unrelated edits must still save.
      const agentChanged = !schedule || schedule.agentId !== agentId;
      const body = {
        name,
        cron,
        timeZone,
        prompt,
        readOnly,
        ...(agentChanged ? { agentId } : {}),
        ...(schedule && unchanged ? {} : { repository }),
      };
      const result = schedule
        ? await patch<{ schedule: Schedule }>(`/schedules/${schedule.id}`, body)
        : await post<{ schedule: Schedule }>('/schedules', body);
      await qc.invalidateQueries({ queryKey: keys.schedules });
      onSaved();
      if (!schedule) navigate(`/schedules/${result.schedule.id}`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={save} className="min-w-0 space-y-4">
      <Field label="Name">
        <Input aria-label="Schedule name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} />
      </Field>
      <Field label="Agent">
        <select aria-label="Agent" className="h-9 w-full rounded-md border bg-background px-3 text-sm" required value={agentId} onChange={(e) => setAgentId(e.target.value)}>
          <option value="">Choose an agent</option>
          {agents.data
            ?.filter((a) => a.enabled || a.id === agentId)
            .map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
                {a.enabled ? '' : ' (disabled)'}{a.enabled && a.state === 'idle' ? ' ○' : a.enabled && a.state === 'working' ? ' ●' : ''}
              </option>
            ))}
        </select>
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Cron expression" hint={describeCron(cron)}>
          <Input aria-label="Cron expression" value={cron} onChange={(e) => setCron(e.target.value)} required className="font-mono" />
        </Field>
        <Field label="Time zone">
          <Input aria-label="Time zone" list="schedule-time-zones" value={timeZone} onChange={(e) => setTimeZone(e.target.value)} required />
          <datalist id="schedule-time-zones">
            {zones.map((z) => (
              <option key={z} value={z} />
            ))}
          </datalist>
        </Field>
      </div>
      <Field label="Prompt" hint="Posted as the first message of every run.">
        <Textarea aria-label="Prompt" value={prompt} onChange={(e) => setPrompt(e.target.value)} required rows={5} />
      </Field>
      <Field label="Repository" hint="Leave empty for a global schedule: its agent works on the boards.">
        <Combobox
          aria-label="Repository"
          placeholder="No repository (global)"
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
      {selected && (
        <>
          <Field label="Base branch">
            <Input aria-label="Base branch" value={baseBranch} onChange={(e) => setBaseBranch(e.target.value)} />
          </Field>
          <Button type="button" variant="ghost" size="sm" onClick={() => setSelected('')}>
            Remove repository
          </Button>
        </>
      )}
      <label className="flex items-center gap-3 text-sm">
        <Switch aria-label="Read-only" checked={readOnly} onCheckedChange={setReadOnly} />
        <span>
          Read-only
          <span className="block text-xs text-muted-foreground">The agent can fetch the repository but every push is refused.</span>
        </span>
      </label>
      {(error || agents.error) && <ErrorText>{error || errorMessage(agents.error)}</ErrorText>}
      <Button type="submit" disabled={busy || !name.trim() || !agentId || !cron.trim() || !prompt.trim()}>
        {busy ? 'Saving…' : schedule ? 'Save schedule' : 'Create schedule'}
      </Button>
    </form>
  );
}
