// The Active Runs bar and the Run dialog: the Agent's live Subagent Runs and Background Commands
// (docs/specs/clients.md#runs). The transcripts are transient, so the store holds them, not the cache.
import type { RunSummary, RunToolMessage, RunTranscript, Usage } from '@claude-task/shared';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight, Terminal, Users, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { get } from '../api/client';
import { keys } from '../api/queries';
import {
  closeRun,
  dismissRun,
  openRun,
  setActiveRuns,
  setTranscript,
  useOpenRun,
  useRun,
  useRunBar,
  useRunTranscript,
} from '../lib/runs';
import { cn } from '../lib/utils';
import { Block, Summary, elapsed, statusLabel, StatusIcon, toolIcon } from './AgentTimeline';
import { formatCost, formatDuration, formatTokens } from './agents';
import { Markdown } from './Markdown';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from './ui/dialog';

/** The Runs bar above the composer, with the dialog of the Run the reader opened. */
export function ActiveRuns({ taskId }: { taskId: string }) {
  const query = useQuery({
    queryKey: keys.runs(taskId),
    queryFn: () => get<{ runs: RunSummary[] }>(`/tasks/${taskId}/runs`),
  });
  useEffect(() => {
    if (query.data) setActiveRuns(taskId, query.data.runs);
  }, [taskId, query.data]);
  const runs = useRunBar(taskId);
  const open = useOpenRun(taskId);
  const now = useNow(runs.some((run) => run.status === 'running'));
  if (runs.length === 0 && open === null) return null;
  return (
    <>
      {runs.length > 0 && (
        <div aria-label="Active runs" className="flex flex-wrap items-center gap-1.5">
          {runs.map((run) => (
            <RunChip key={run.id} taskId={taskId} run={run} now={now} />
          ))}
        </div>
      )}
      {open !== null && <RunDialog taskId={taskId} runId={open} />}
    </>
  );
}

function RunChip({ taskId, run, now }: { taskId: string; run: RunSummary; now: number }) {
  const Icon = run.runType === 'command' ? Terminal : Users;
  const calls = run.toolCalls === 1 ? '1 call' : `${run.toolCalls} calls`;
  return (
    <div
      className={cn(
        'flex items-center gap-1 rounded-full border bg-muted/40 py-0.5 pr-1 pl-1.5 text-xs',
        run.status === 'error' && 'border-red-500/40',
      )}
    >
      <button
        type="button"
        onClick={() => openRun(taskId, run.id)}
        className="flex min-w-0 items-center gap-1.5 rounded-full px-1 py-0.5 text-muted-foreground hover:text-foreground"
      >
        <Icon className="size-3 shrink-0" />
        <span className="max-w-56 truncate text-foreground/90">{run.description}</span>
        <StatusIcon status={run.status} className="size-3 shrink-0" />
        <span className="shrink-0 tabular-nums">{formatDuration(elapsed(run, now))}</span>
        {run.toolCalls > 0 && <span className="shrink-0 opacity-70">{calls}</span>}
      </button>
      {run.status === 'error' && (
        <button
          type="button"
          aria-label={`Dismiss ${run.description}`}
          title="Dismiss"
          onClick={() => dismissRun(taskId, run.id)}
          className="rounded-full p-0.5 text-muted-foreground hover:text-foreground"
        >
          <X className="size-3" />
        </button>
      )}
    </div>
  );
}

function RunDialog({ taskId, runId }: { taskId: string; runId: string }) {
  const stored = useRun(taskId, runId);
  const transcript = useRunTranscript(taskId, runId);
  const query = useQuery({
    queryKey: keys.run(taskId, runId),
    queryFn: () => get<RunTranscript>(`/tasks/${taskId}/runs/${runId}`),
    retry: false,
  });
  useEffect(() => {
    if (query.data) setTranscript(taskId, query.data);
  }, [taskId, query.data]);
  const run = stored ?? (transcript ? { ...transcript.run, id: transcript.id } : null);
  const now = useNow(run?.status === 'running');
  // The last messages can land after the Run's final status: the transcript is fetched once more.
  const refreshed = useRef<string | null>(null);
  const { refetch, isSuccess } = query;
  const finished = run !== null && run.status !== 'running';
  useEffect(() => {
    if (!finished || !isSuccess || refreshed.current === runId) return;
    refreshed.current = runId;
    void refetch();
  }, [finished, isSuccess, runId, refetch]);

  // Follows the newest message while the reader stays at the bottom.
  const viewport = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const messages = transcript?.messages.length ?? 0;
  useEffect(() => {
    const el = viewport.current;
    if (el && following.current) el.scrollTop = el.scrollHeight;
  }, [messages, runId]);

  const Icon = run?.runType === 'command' ? Terminal : Users;
  const calls = run?.toolCalls === 1 ? '1 tool call' : `${run?.toolCalls ?? 0} tool calls`;
  const momentary = run?.runType === 'command' ? 'Background command' : (run?.subagentType ?? 'Subagent');
  return (
    <Dialog open onOpenChange={(open) => !open && closeRun(taskId)}>
      <DialogContent className="flex max-h-[85dvh] flex-col gap-3 sm:max-w-3xl">
        <DialogHeader className="shrink-0 pr-8">
          <DialogTitle className="flex items-center gap-2 text-sm">
            <Icon className="size-4 shrink-0" />
            <span className="min-w-0 truncate">{run?.description ?? 'Run'}</span>
          </DialogTitle>
          {run && (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
              <span>{momentary}</span>
              <span>· {statusLabel(run.status)}</span>
              <span>· {formatDuration(elapsed(run, now))}</span>
              <span>· {calls}</span>
              {transcript?.usage && (
                <span>
                  · {formatTokens(tokens(transcript.usage))} tokens · {formatCost(transcript.usage.costUsd)}
                </span>
              )}
            </div>
          )}
          {run?.error && (
            <p className="max-h-32 overflow-y-auto rounded-md border border-red-500/30 bg-red-500/5 px-2 py-1.5 text-xs whitespace-pre-wrap text-red-400">
              {run.error}
            </p>
          )}
          {!run?.error && run?.outcome && (
            // A Background Command reports how it ended: its outcome is the only trace of it.
            <p aria-label="Outcome" className="text-xs text-muted-foreground">
              {run.outcome}
            </p>
          )}
          {transcript?.prompt && (
            <PromptSection prompt={transcript.prompt} />
          )}
        </DialogHeader>
        <div
          ref={viewport}
          aria-label="Run transcript"
          onScroll={(event) => {
            const el = event.currentTarget;
            following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
          }}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain rounded-lg border bg-muted/20 p-3"
        >
          {transcript === null ? (
            <p className="text-xs text-muted-foreground">
              {(query.error as { status?: number } | null)?.status === 404
                ? 'This Run’s transcript is no longer in memory.'
                : query.isError
                  ? 'The transcript could not be loaded.'
                  : 'Loading…'}
            </p>
          ) : (
            <div className="space-y-2">
              {transcript.messages.map((message) =>
                message.type === 'text' ? (
                  <div key={message.n} className="text-sm">
                    <Markdown source={message.text} />
                  </div>
                ) : (
                  <RunToolRow key={message.n} taskId={taskId} message={message} />
                ),
              )}
              {transcript.messages.length === 0 && <p className="text-xs text-muted-foreground">Nothing yet.</p>}
            </div>
          )}
          {transcript?.truncated && (
            <p className="mt-2 text-[11px] text-muted-foreground italic">
              The transcript reached its size limit, so older messages were dropped.
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function PromptSection({ prompt }: { prompt: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="text-xs">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 py-0.5 text-muted-foreground hover:text-foreground"
      >
        <ChevronRight className={cn('size-3 transition-transform', open && 'rotate-90')} />
        Prompt
      </button>
      {open && (
        <div className="mt-1">
          <Block title="Prompt">{prompt}</Block>
        </div>
      )}
    </div>
  );
}

function RunToolRow({ taskId, message }: { taskId: string; message: RunToolMessage }) {
  const [open, setOpen] = useState(false);
  const Icon = toolIcon(message.name);
  const childRunId = message.childRunId;
  return (
    <div className="text-xs">
      <div className="flex items-center gap-2 rounded-md px-1.5 py-1 text-muted-foreground hover:bg-muted/60">
        <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
          <Icon className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">
            <Summary text={message.summary} />
          </span>
          {message.outcome && (
            <span className={cn('shrink-0 font-mono text-[10px]', message.status === 'error' ? 'text-red-400' : 'opacity-70')}>{message.outcome}</span>
          )}
          <StatusIcon status={message.status} className="size-3 shrink-0" />
        </button>
        {childRunId && (
          <button
            type="button"
            onClick={() => openRun(taskId, childRunId)}
            className="flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] hover:text-foreground"
          >
            <Users className="size-2.5" /> Open
          </button>
        )}
      </div>
      {open && (
        <div className="mt-1 mb-2 ml-6 space-y-2">
          <Block title="Input">{JSON.stringify(message.input, null, 2)}</Block>
          {message.output !== null && <Block title="Output">{message.output || '(empty)'}</Block>}
        </div>
      )}
    </div>
  );
}

function tokens(usage: Usage): number {
  return usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheCreationTokens;
}

/** A 1 s clock while something runs, so elapsed times grow without a re-render per event. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}
