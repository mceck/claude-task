import { SCHEDULED_MESSAGE_MAX_DAYS } from '@claude-task/shared';
import type { Comment, ScheduledMessage } from '@claude-task/shared';
import { useQueryClient } from '@tanstack/react-query';
import { CalendarClock, CheckCircle2, ChevronRight, Clock, FileText, Lock, RotateCcw, X } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { ApiError, del, errorMessage, patch, post } from '../api/client';
import { keys, useScheduledMessages } from '../api/queries';
import { putScheduledMessage, putTimelineItem } from '../lib/cache';
import { ErrorText } from './common';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

const pad = (n: number) => String(n).padStart(2, '0');

/** The value of a `datetime-local` input for this moment, in the browser's time zone. */
export function toLocalInput(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Why the chosen time cannot be scheduled, or null. `value` is a `datetime-local` value, read in the browser's time zone. */
export function dueError(value: string): string | null {
  const at = new Date(value).getTime();
  if (Number.isNaN(at)) return 'Pick a date and a time';
  const ahead = at - Date.now();
  if (ahead < MINUTE) return 'The time must be at least a minute from now';
  if (ahead > SCHEDULED_MESSAGE_MAX_DAYS * DAY) return `The time must be within ${SCHEDULED_MESSAGE_MAX_DAYS} days`;
  return null;
}

/** The instant a `datetime-local` value stands for, as the API expects it. */
export const toInstant = (value: string): string => new Date(value).toISOString();

const dueFormat = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const formatDue = (iso: string | Date) => dueFormat.format(new Date(iso));

/** The composer's schedule button: a date and time in the browser's time zone, shown on the button once chosen. */
export function SchedulePicker({ value, onChange, disabled }: { value: string; onChange: (value: string) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const error = value ? dueError(value) : null;
  const inHours = (hours: number) => toLocalInput(new Date(Date.now() + hours * 60 * MINUTE));
  const tomorrow = () => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(9, 0, 0, 0);
    return toLocalInput(d);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled}
          aria-label={value ? `Scheduled for ${formatDue(value)}` : 'Schedule'}
          className={cn('text-muted-foreground', value && 'text-primary hover:text-primary')}
        >
          <Clock /> {value ? formatDue(value) : <span className="hidden @sm:inline">Schedule</span>}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 space-y-3">
        <p className="text-sm font-medium">Send later</p>
        <Input
          type="datetime-local"
          aria-label="Send at"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          min={toLocalInput(new Date())}
        />
        <div className="flex flex-wrap gap-1.5">
          <Button size="xs" variant="outline" onClick={() => onChange(inHours(1))}>
            In 1 hour
          </Button>
          <Button size="xs" variant="outline" onClick={() => onChange(tomorrow())}>
            Tomorrow 09:00
          </Button>
        </div>
        <ErrorText>{error}</ErrorText>
        <div className="flex justify-between">
          <Button
            size="sm"
            variant="ghost"
            disabled={!value}
            onClick={() => {
              onChange('');
              setOpen(false);
            }}
          >
            <X /> Clear
          </Button>
          <Button size="sm" disabled={!value || !!error} onClick={() => setOpen(false)}>
            Done
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** What a finished message came to. */
function outcome(message: ScheduledMessage): string {
  if (message.state === 'sent') return 'Sent';
  return message.cancelReason ? `Cancelled: ${message.cancelReason}` : 'Cancelled';
}

function Excerpt({ message }: { message: ScheduledMessage }) {
  return (
    <>
      {message.body && <p className="line-clamp-2 text-sm break-words whitespace-pre-line">{message.body}</p>}
      {message.attachments.length > 0 && (
        <ul aria-label="Files" className="flex flex-wrap gap-1.5">
          {message.attachments.map((f) => (
            <li key={f.id} className="flex items-center gap-1 rounded-md border bg-muted/50 px-1.5 py-0.5 text-xs">
              <FileText className="size-3 text-muted-foreground" />
              {f.filename}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function Badges({ message }: { message: ScheduledMessage }) {
  return (
    <>
      {message.kind === 'limit_resume' && (
        <Badge variant="secondary" className="h-4 gap-1 px-1.5 text-[10px]">
          <RotateCcw /> Resume after usage limit
        </Badge>
      )}
      {message.internal && (
        <Badge variant="outline" className="h-4 gap-1 border-dashed border-slate-400/50 px-1.5 text-[10px] text-slate-400">
          <Lock /> Internal chat
        </Badge>
      )}
    </>
  );
}

function PendingRow({ message }: { message: ScheduledMessage }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(message.body);
  const [due, setDue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A message that is no longer pending (somebody else's change, or it was published) is shown as it is now.
  const failed = (err: unknown, what: string) => {
    if (err instanceof ApiError && err.status === 409) void qc.invalidateQueries({ queryKey: keys.scheduled(message.taskId) });
    toast.error(`Couldn’t ${what}`, { description: errorMessage(err) });
  };
  const act = async (what: string, run: () => Promise<{ message: ScheduledMessage }>) => {
    setBusy(true);
    try {
      putScheduledMessage(qc, (await run()).message);
      return true;
    } catch (err) {
      failed(err, what);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const startEdit = () => {
    setBody(message.body);
    setDue(toLocalInput(new Date(message.dueAt)));
    setError(null);
    setEditing(true);
  };
  const save = async () => {
    const problem = dueError(due);
    if (problem) return setError(problem);
    const changes: { body?: string; dueAt?: string } = {};
    if (message.kind === 'user' && body !== message.body) changes.body = body;
    if (toInstant(due) !== new Date(message.dueAt).toISOString()) changes.dueAt = toInstant(due);
    if (Object.keys(changes).length === 0) return setEditing(false);
    if (await act('save the change', () => patch(`/scheduled-messages/${message.id}`, changes))) setEditing(false);
  };

  return (
    <li className="space-y-1.5 rounded-lg border bg-background/60 px-3 py-2">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <CalendarClock className="size-3.5" />
        <time dateTime={message.dueAt} className="font-medium text-foreground">
          {formatDue(message.dueAt)}
        </time>
        <span>{message.author.displayName}</span>
        <Badges message={message} />
        {!editing && (
          <span className="ml-auto flex gap-1">
            <Button size="xs" variant="ghost" disabled={busy} onClick={startEdit}>
              Edit
            </Button>
            <Button size="xs" variant="ghost" disabled={busy} onClick={() => void act('cancel the message', () => del(`/scheduled-messages/${message.id}`))}>
              Cancel
            </Button>
            <Button size="xs" variant="ghost" disabled={busy} onClick={() => void act('send the message', () => post(`/scheduled-messages/${message.id}/send`))}>
              Send now
            </Button>
          </span>
        )}
      </div>
      {editing ? (
        <div className="space-y-2">
          {message.kind === 'user' && <Textarea aria-label="Scheduled message text" rows={3} value={body} onChange={(e) => setBody(e.target.value)} />}
          <Input type="datetime-local" aria-label="Send at" value={due} onChange={(e) => setDue(e.target.value)} />
          <ErrorText>{error}</ErrorText>
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Discard
            </Button>
            <Button size="sm" disabled={busy || (message.kind === 'user' && !body.trim() && message.attachments.length === 0)} onClick={() => void save()}>
              Save
            </Button>
          </div>
        </div>
      ) : (
        <Excerpt message={message} />
      )}
    </li>
  );
}

/** The Task's pending Scheduled Messages, with the latest finished ones behind a toggle. Hidden when there are none. */
export function ScheduledStrip({ taskId }: { taskId: string }) {
  const messages = useScheduledMessages(taskId).data ?? [];
  const [showHistory, setShowHistory] = useState(false);
  const pending = messages.filter((m) => m.state === 'pending');
  const finished = messages.filter((m) => m.state !== 'pending');
  if (messages.length === 0) return null;
  return (
    <section aria-label="Scheduled" className="space-y-2">
      {pending.length > 0 && (
        <>
          <h3 className="text-xs font-medium text-muted-foreground">Scheduled</h3>
          <ul className="space-y-2">
            {pending.map((m) => (
              <PendingRow key={m.id} message={m} />
            ))}
          </ul>
        </>
      )}
      {finished.length > 0 && (
        <div>
          <button
            type="button"
            aria-expanded={showHistory}
            onClick={() => setShowHistory(!showHistory)}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <ChevronRight className={cn('size-3 transition-transform', showHistory && 'rotate-90')} /> History ({finished.length})
          </button>
          {showHistory && (
            <ul aria-label="Scheduled history" className="mt-2 space-y-1.5">
              {finished.map((m) => (
                <li key={m.id} className="space-y-1 rounded-lg border border-dashed px-3 py-1.5 text-muted-foreground">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span>{outcome(m)}</span>
                    <span>· due {formatDue(m.dueAt)}</span>
                    <span>· {m.author.displayName}</span>
                    <Badges message={m} />
                  </div>
                  <Excerpt message={m} />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

/** The offer on the System Comment of a usage limit: the first answer decides for everybody. */
export function LimitResumeCard({ comment }: { comment: Comment }) {
  const offer = comment.limitResume!;
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);

  const answer = async (schedule: boolean) => {
    setBusy(true);
    try {
      const res = await post<{ comment: Comment }>(`/comments/${comment.id}/limit-resume`, { schedule });
      putTimelineItem(qc, comment.taskId, { type: 'comment', id: res.comment.id, createdAt: res.comment.createdAt, comment: res.comment });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        // Somebody answered first, or the offer lapsed: show how it stands now.
        void qc.invalidateQueries({ queryKey: keys.timeline(comment.taskId) });
        void qc.invalidateQueries({ queryKey: keys.scheduled(comment.taskId) });
        toast.error('This offer was already settled', { description: errorMessage(err) });
      } else toast.error('Couldn’t send your answer', { description: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  const by = offer.decidedBy?.displayName;
  return (
    <section aria-label="Resume after usage limit" className="mt-3 space-y-2 rounded-lg border bg-background/60 p-3">
      {offer.state === 'open' ? (
        <>
          <p className="flex items-center gap-1.5 text-sm">
            <CalendarClock className="size-3.5 text-muted-foreground" /> The usage limit resets {formatDue(offer.resetsAt)}. Resume the agent then?
          </p>
          <div className="flex gap-2">
            <Button size="sm" disabled={busy} onClick={() => void answer(true)}>
              Schedule resume
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void answer(false)}>
              No
            </Button>
          </div>
        </>
      ) : (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {offer.state === 'scheduled' && (
            <>
              <CheckCircle2 className="size-3.5 text-emerald-500" /> Resume scheduled {by ? `by ${by}` : 'automatically'} after the reset ({formatDue(offer.resetsAt)})
            </>
          )}
          {offer.state === 'declined' && <>No resume: declined{by ? ` by ${by}` : ''}</>}
          {offer.state === 'unneeded' && <>The resume offer is no longer needed</>}
        </p>
      )}
    </section>
  );
}
