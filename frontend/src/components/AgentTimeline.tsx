// The Agent's work on the Timeline: Thinking, Activity groups, Turn Summaries, notices, and the
// live preview of the running Turn.
import type { ActivityEntry, AgentItem, TurnSummary } from '@claude-task/shared';
import {
  Brain,
  ChevronRight,
  CircleCheck,
  CircleSlash,
  CircleX,
  FilePen,
  FileText,
  Globe,
  KanbanSquare,
  ListTodo,
  Loader2,
  Plug,
  RefreshCw,
  Search,
  Shrink,
  Terminal,
  Users,
  Wrench,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useState } from 'react';
import { cn } from '@/lib/utils';
import { useTaskSession } from '../api/queries';
import { setLiveExpanded, useLiveTurn } from '../lib/live';
import { AgentAvatar, formatCost, formatDuration, formatTokens } from './agents';
import { Time } from './common';
import { Markdown } from './Markdown';
import { CollapsibleBody } from './Timeline';

function toolIcon(name: string): LucideIcon {
  if (name === 'Bash') return Terminal;
  if (['Edit', 'MultiEdit', 'Write', 'NotebookEdit'].includes(name)) return FilePen;
  if (name === 'Read') return FileText;
  if (name === 'Grep' || name === 'Glob') return Search;
  if (name === 'WebFetch' || name === 'WebSearch') return Globe;
  if (name === 'Task' || name === 'Agent') return Users;
  if (name === 'TodoWrite') return ListTodo;
  if (name.startsWith('mcp__claude-task__')) return KanbanSquare;
  if (name.startsWith('mcp__')) return Plug;
  return Wrench;
}

/** Inline code in summaries is written with backticks. */
function Summary({ text }: { text: string }) {
  const parts = text.split(/(`[^`]*`)/);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith('`') && p.endsWith('`') && p.length > 1 ? (
          <code key={i} className="rounded bg-muted px-1 py-px font-mono text-[11px] text-foreground/90">
            {p.slice(1, -1)}
          </code>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}

function Rail({ icon: Icon, className }: { icon: LucideIcon; className?: string }) {
  return (
    <span className={cn('z-10 flex size-5 shrink-0 items-center justify-center rounded-full border bg-background', className)}>
      <Icon className="size-3" />
    </span>
  );
}

export function AgentItemView({ item }: { item: AgentItem }) {
  const p = item.payload;
  if (p.kind === 'thinking') return <ThinkingView text={p.text} />;
  if (p.kind === 'activity') return <ActivityView entries={p.entries} />;
  if (p.kind === 'turn_summary') return <TurnSummaryView summary={p.summary} at={item.createdAt} />;
  return (
    <li className="relative flex items-center gap-3 pl-1.5 text-xs text-muted-foreground">
      <Rail icon={Shrink} />
      {p.text} · <Time iso={item.createdAt} />
    </li>
  );
}

function ThinkingView({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <li aria-label="Thinking" className="relative flex items-start gap-3 pl-1.5 text-xs">
      <Rail icon={Brain} className="text-violet-400" />
      <div className="min-w-0 flex-1">
        <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex items-center gap-1 pt-0.5 text-muted-foreground hover:text-foreground">
          <ChevronRight className={cn('size-3 transition-transform', open && 'rotate-90')} />
          Thinking
        </button>
        {open && (
          <div className="mt-1.5 rounded-lg border-l-2 border-violet-500/40 bg-muted/30 px-3 py-2 text-muted-foreground italic">
            <Markdown source={text} />
          </div>
        )}
      </div>
    </li>
  );
}

function countEntries(entries: ActivityEntry[]): { total: number; errors: number } {
  return entries.reduce(
    (acc, e) => {
      const nested = countEntries(e.children);
      return { total: acc.total + 1 + nested.total, errors: acc.errors + (e.status === 'error' ? 1 : 0) + nested.errors };
    },
    { total: 0, errors: 0 },
  );
}

function ActivityView({ entries }: { entries: ActivityEntry[] }) {
  const [open, setOpen] = useState(false);
  const { total, errors } = countEntries(entries);
  const running = entries.some((e) => e.status === 'pending');
  const icons = [...new Set(entries.map((e) => toolIcon(e.name)))].slice(0, 6);
  return (
    <li aria-label="Activity" className="relative flex items-start gap-3 pl-1.5 text-xs">
      <Rail icon={running ? Loader2 : Wrench} className={cn(running && '[&_svg]:animate-spin', errors > 0 && 'border-red-500/50 text-red-400')} />
      <div className="min-w-0 flex-1">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="flex max-w-full items-center gap-2 rounded-md pt-0.5 text-muted-foreground hover:text-foreground"
        >
          <ChevronRight className={cn('size-3 shrink-0 transition-transform', open && 'rotate-90')} />
          <span className="shrink-0 font-medium">
            {total} {total === 1 ? 'action' : 'actions'}
          </span>
          <span className="flex shrink-0 items-center gap-1 opacity-70">
            {icons.map((Icon, i) => (
              <Icon key={i} className="size-3" />
            ))}
          </span>
          {errors > 0 && (
            <span className="flex shrink-0 items-center gap-1 text-red-400">
              <CircleX className="size-3" /> {errors} failed
            </span>
          )}
          {!open && entries.length > 0 && <span className="min-w-0 truncate opacity-70"><Summary text={entries[entries.length - 1]!.summary} /></span>}
        </button>
        {open && (
          <ul className="mt-1.5 space-y-0.5 rounded-lg border bg-muted/20 p-1.5">
            {entries.map((e) => (
              <EntryView key={e.toolUseId} entry={e} />
            ))}
          </ul>
        )}
      </div>
    </li>
  );
}

function EntryView({ entry }: { entry: ActivityEntry }) {
  const [open, setOpen] = useState(false);
  const Icon = toolIcon(entry.name);
  return (
    <li>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-muted-foreground hover:bg-muted/60 hover:text-foreground"
      >
        <Icon className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate">
          <Summary text={entry.summary} />
        </span>
        {entry.outcome && <span className={cn('shrink-0 font-mono text-[10px]', entry.status === 'error' ? 'text-red-400' : 'opacity-70')}>{entry.outcome}</span>}
        {entry.status === 'pending' ? (
          <Loader2 className="size-3 shrink-0 animate-spin" />
        ) : entry.status === 'interrupted' ? (
          <CircleSlash aria-label="interrupted" className="size-3 shrink-0 opacity-70" />
        ) : entry.status === 'error' ? (
          <CircleX aria-label="failed" className="size-3 shrink-0 text-red-400" />
        ) : (
          <CircleCheck aria-label="succeeded" className="size-3 shrink-0 text-emerald-500/80" />
        )}
      </button>
      {open && (
        <div className="mt-1 mb-2 ml-6 space-y-2">
          <Block title="Input">{JSON.stringify(entry.input, null, 2)}</Block>
          {entry.output !== null && <Block title="Output">{entry.output || '(empty)'}</Block>}
        </div>
      )}
      {entry.children.length > 0 && (
        <ul aria-label="Subagent activity" className="ml-4 border-l pl-2">
          {entry.children.map((c) => (
            <EntryView key={c.toolUseId} entry={c} />
          ))}
        </ul>
      )}
    </li>
  );
}

function Block({ title, children }: { title: string; children: string }) {
  return (
    <div>
      <p className="mb-1 text-[10px] font-medium tracking-wider text-muted-foreground uppercase">{title}</p>
      <pre className="max-h-72 overflow-auto rounded-md border bg-background/60 p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-foreground/85">
        {children}
      </pre>
    </div>
  );
}

function TurnSummaryView({ summary, at }: { summary: TurnSummary; at: string }) {
  const tokens = summary.usage ? summary.usage.inputTokens + summary.usage.outputTokens + summary.usage.cacheReadTokens + summary.usage.cacheCreationTokens : null;
  return (
    <li aria-label="Turn summary" className="relative flex items-center gap-3 pl-1.5 text-xs text-muted-foreground">
      <Rail icon={summary.isError ? CircleX : CircleCheck} className={summary.isError ? 'text-red-400' : 'text-emerald-500'} />
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-medium text-foreground/80">{summary.isError ? `Turn ended (${summary.subtype.replace(/_/g, ' ')})` : 'Turn finished'}</span>
        <span>· {formatDuration(summary.durationMs)}</span>
        <span>
          · {summary.toolCalls} tool {summary.toolCalls === 1 ? 'call' : 'calls'}
        </span>
        {tokens !== null && <span>· {formatTokens(tokens)} tokens</span>}
        <span>· {formatCost(summary.costUsd)}</span>
        <span>
          · <Time iso={at} />
        </span>
      </span>
    </li>
  );
}

/** What the running Turn is writing right now (not stored yet), retries and setup output. */
export function LiveTurnView({ taskId }: { taskId: string }) {
  const live = useLiveTurn(taskId);
  const session = useTaskSession(taskId);
  const [showSetup, setShowSetup] = useState(false);
  return (
    <>
      {live.setup && (
        <li className="relative flex items-start gap-3 pl-1.5 text-xs">
          <Rail icon={Terminal} />
          <div className="min-w-0 flex-1">
            <button type="button" aria-expanded={showSetup} onClick={() => setShowSetup(!showSetup)} className="flex items-center gap-1 pt-0.5 text-muted-foreground hover:text-foreground">
              <ChevronRight className={cn('size-3 transition-transform', showSetup && 'rotate-90')} />
              Preparing the worktree
            </button>
            {showSetup && <pre className="mt-1.5 max-h-60 overflow-auto rounded-md border bg-background/60 p-2 font-mono text-[11px] whitespace-pre-wrap">{live.setup.output}</pre>}
          </div>
        </li>
      )}
      {live.retrying && (
        <li role="status" className="relative flex items-center gap-3 pl-1.5 text-xs text-amber-400">
          <Rail icon={RefreshCw} className="[&_svg]:animate-spin" />
          Retrying the Claude API (attempt {live.retrying.attempt}/{live.retrying.maxRetries}){live.retrying.error ? `: ${live.retrying.error}` : ''}
        </li>
      )}
      {live.thinking && !live.text && (
        <li className="relative flex items-center gap-3 pl-1.5 text-xs text-muted-foreground">
          <Rail icon={Brain} className="text-violet-400" />
          <span className="animate-pulse">Thinking…</span>
        </li>
      )}
      {live.text && (
        <li aria-label="Agent is writing" className="relative flex gap-3">
          <div className="z-10 shrink-0">
            {session.data?.agent ? (
              <AgentAvatar agent={session.data.agent} size="md" />
            ) : (
              <span className="flex size-8 items-center justify-center rounded-lg bg-violet-500/15 text-violet-400 ring-2 ring-background">
                <Loader2 className="size-4 animate-spin" />
              </span>
            )}
          </div>
          <div className="min-w-0 flex-1 rounded-xl border border-dashed border-violet-500/30 bg-violet-500/[0.04] px-4 py-3">
            <CollapsibleBody expand={live.expanded} onExpandedChange={(expanded) => setLiveExpanded(taskId, expanded)}>
              <Markdown source={live.text} />
              <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse rounded-sm bg-violet-400 align-middle" />
            </CollapsibleBody>
          </div>
        </li>
      )}
    </>
  );
}
