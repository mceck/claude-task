// The Run Registry: live transcripts of Subagent Runs and Background Commands (docs/specs/agent-sessions.md#runs).
// Memory only, bounded per Job, dropped when the Job ends.
import type { RunInfo, RunMessage, RunMessageDraft, RunSummary, RunTranscript, Usage } from '@claude-task/shared';

export const RUN_MESSAGE_LIMIT = 500;
export const RUN_BYTES_LIMIT = 2 * 1024 * 1024;
export const RUNS_PER_JOB = 30;
/** A text block, a tool input or a tool output kept for display. */
export const RUN_CONTENT_LIMIT = 20 * 1024;

export function cut(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

interface RunRecord {
  id: string;
  jobId: string;
  taskId: string;
  run: RunInfo;
  prompt: string | null;
  usage: Usage | null;
  messages: RunMessage[];
  bytes: number;
  truncated: boolean;
}

const size = (message: RunMessage): number => JSON.stringify(message).length;

/** Keeps the Run transcripts of every running Job, keyed by Run id (the Agent Item id). */
export class RunRegistry {
  private readonly runs = new Map<string, RunRecord>();

  create(jobId: string, taskId: string, id: string, run: RunInfo, prompt: string | null): RunSummary {
    this.makeRoom(jobId);
    this.runs.set(id, {
      id,
      jobId,
      taskId,
      run,
      prompt: prompt === null ? null : cut(prompt, RUN_CONTENT_LIMIT),
      usage: null,
      messages: [],
      bytes: 0,
      truncated: false,
    });
    return { ...run, id };
  }

  /** Numbers and appends a message; null once the Run is full or unknown. */
  message(runId: string, draft: RunMessageDraft): RunMessage | null {
    const record = this.runs.get(runId);
    if (!record) return null;
    return this.append(record, draft);
  }

  /** Settles a transcript tool call with its result. */
  toolResult(
    runId: string,
    toolUseId: string,
    status: 'pending' | 'ok' | 'error' | 'interrupted',
    outcome: string | null,
    output: string | null,
  ): RunMessage | null {
    const record = this.runs.get(runId);
    if (!record) return null;
    const message = record.messages.find((m) => m.type === 'tool' && m.toolUseId === toolUseId);
    if (!message || message.type !== 'tool') return null;
    const previous = size(message);
    const settled = {
      ...message,
      status,
      outcome,
      output: output === null ? null : cut(output, RUN_CONTENT_LIMIT),
    };
    // An output can be much larger than the call that opened it: it must respect the same 2 MB bound.
    const fits = record.bytes - previous + size(settled) <= RUN_BYTES_LIMIT;
    if (!fits) record.truncated = true;
    Object.assign(message, fits ? settled : { ...settled, output: null });
    record.bytes += size(message) - previous;
    return message;
  }

  /** The Run as the bar keeps it, with the tool calls counted so far. */
  summary(runId: string): RunSummary | null {
    const record = this.runs.get(runId);
    return record ? { ...record.run, id: record.id } : null;
  }

  /** Marks the Run finished; returns it as the clients keep it. */
  end(runId: string, run: RunInfo, usage: Usage | null): RunSummary | null {
    const record = this.runs.get(runId);
    if (!record) return null;
    record.run = run;
    if (usage) record.usage = usage;
    return { ...run, id: runId };
  }

  /** What the bar shows: what runs now and what failed; successes and interruptions leave it. */
  active(jobId: string): RunSummary[] {
    const runs: RunSummary[] = [];
    for (const record of this.runs.values()) {
      if (record.jobId !== jobId) continue;
      if (record.run.status !== 'running' && record.run.status !== 'error') continue;
      runs.push({ ...record.run, id: record.id });
    }
    return runs.sort((a, b) => {
      const rank = (r: RunSummary): number => (r.status === 'running' ? 0 : 1);
      return rank(a) - rank(b) || a.startedAt.localeCompare(b.startedAt);
    });
  }

  transcript(runId: string): RunTranscript | null {
    const record = this.runs.get(runId);
    if (!record) return null;
    return {
      id: record.id,
      run: record.run,
      prompt: record.prompt,
      usage: record.usage,
      messages: record.messages.map((m) => ({ ...m })),
      nextIndex: record.messages.length,
      truncated: record.truncated,
    };
  }

  /** The Task a Run belongs to, for permission checks; null when unknown. */
  taskOf(runId: string): string | null {
    return this.runs.get(runId)?.taskId ?? null;
  }

  endJob(jobId: string): void {
    for (const [id, record] of this.runs) if (record.jobId === jobId) this.runs.delete(id);
  }

  get size(): number {
    return this.runs.size;
  }

  private append(record: RunRecord, draft: RunMessageDraft): RunMessage | null {
    if (record.truncated) return null;
    const n = record.messages.length;
    const message: RunMessage =
      draft.type === 'text'
        ? { type: 'text', n, text: cut(draft.text, RUN_CONTENT_LIMIT) }
        : {
            type: 'tool',
            n,
            toolUseId: draft.toolUseId,
            name: draft.name,
            summary: draft.summary,
            status: draft.status,
            outcome: draft.outcome,
            input: draft.input,
            output: draft.output === null ? null : cut(draft.output, RUN_CONTENT_LIMIT),
            childRunId: draft.childRunId,
          };
    const bytes = size(message);
    if (record.messages.length >= RUN_MESSAGE_LIMIT || record.bytes + bytes > RUN_BYTES_LIMIT) {
      record.truncated = true;
      return null;
    }
    record.messages.push(message);
    record.bytes += bytes;
    // The bar shows how much a Run is doing while it works: the projector's own count only
    // arrives with `run.end`.
    if (message.type === 'tool') record.run.toolCalls++;
    return message;
  }

  private makeRoom(jobId: string): void {
    const ofJob = [...this.runs.values()].filter((r) => r.jobId === jobId);
    if (ofJob.length < RUNS_PER_JOB) return;
    const finished = ofJob.filter((r) => r.run.status !== 'running');
    const victim = (finished.length > 0 ? finished : ofJob).sort((a, b) => a.run.startedAt.localeCompare(b.run.startedAt))[0]!;
    this.runs.delete(victim.id);
  }
}
