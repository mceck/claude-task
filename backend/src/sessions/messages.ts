// What an Agent receives: the Message content blocks (Comments, Task snapshots, notices)
// and the system prompt its Session runs with.
import { RUNNER_ATTACHMENTS_PATH } from '@claude-task/shared';
import type { AttachmentToFetch, InputBlock } from '@claude-task/shared';
import { asc, eq, inArray } from 'drizzle-orm';
import type { AppContext } from '../context';
import type { Executor } from '../db/client';
import { attachments, comments, labels, projects, statuses, taskLabels, tasks } from '../db/schema';
import { actorResolver } from '../modules/actors';

export type CommentRow = typeof comments.$inferSelect;

/** Images up to this size travel as image blocks; anything else is fetched into the Worktree. */
export const IMAGE_BLOCK_MAX_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
export const AGENT_HOME = '/home/agent';

export interface MessageParts {
  blocks: InputBlock[];
  fetch: AttachmentToFetch[];
}

export function attachmentPath(commentId: string, filename: string): string {
  return `.claude-task/attachments/${commentId}/${filename.replace(/[/\\]/g, '_') || 'file'}`;
}

/** `[Comment by <name> — <ISO time>]` and the body; attachments as images or fetched files. */
export async function renderComments(ctx: AppContext, db: Executor, rows: CommentRow[]): Promise<MessageParts> {
  const parts: MessageParts = { blocks: [], fetch: [] };
  if (rows.length === 0) return parts;
  const resolve = await actorResolver(db, rows.map((r) => ({ type: r.authorType, id: r.authorId })));
  const files = await db
    .select()
    .from(attachments)
    .where(inArray(attachments.commentId, rows.map((r) => r.id)))
    .orderBy(asc(attachments.position));

  for (const c of rows) {
    if (c.noticeMessage) {
      parts.blocks.push({ type: 'text', text: c.noticeMessage });
      continue;
    }
    const author = resolve({ type: c.authorType, id: c.authorId });
    const who = c.kind === 'agent' ? `${author.displayName} (agent)` : author.displayName;
    let text = `[Comment by ${who} — ${c.createdAt.toISOString()}]\n${c.body}`;
    const images: InputBlock[] = [];
    for (const f of files.filter((x) => x.commentId === c.id)) {
      if (IMAGE_TYPES.has(f.contentType) && f.size <= IMAGE_BLOCK_MAX_BYTES) {
        const data = await readBlob(ctx, f.blobId);
        if (data) {
          images.push({ type: 'image', source: { type: 'base64', media_type: f.contentType, data: data.toString('base64') } });
          text += `\n(Attached image: ${f.filename})`;
          continue;
        }
      }
      const path = attachmentPath(c.id, f.filename);
      parts.fetch.push({ url: `${ctx.config.agents.backendUrl}${RUNNER_ATTACHMENTS_PATH}/${f.id}`, path });
      text += `\n(Attached file: \`${path}\`)`;
    }
    parts.blocks.push({ type: 'text', text }, ...images);
  }
  return parts;
}

async function readBlob(ctx: AppContext, blobId: string): Promise<Buffer | null> {
  const blob = await ctx.blobs.get(blobId);
  if (!blob) return null;
  const chunks: Buffer[] = [];
  for await (const chunk of blob.stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks);
}

export interface TaskSnapshot {
  key: string;
  title: string;
  description: string;
  priority: string;
  status: string;
  category: string;
  labels: string[];
  projectName: string;
  version: number;
}

export async function taskSnapshot(db: Executor, taskId: string): Promise<TaskSnapshot> {
  const [row] = await db
    .select({ task: tasks, projectKey: projects.key, projectName: projects.name, status: statuses.name, category: statuses.category })
    .from(tasks)
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .innerJoin(statuses, eq(statuses.id, tasks.statusId))
    .where(eq(tasks.id, taskId));
  const t = row!.task;
  const labelRows = await db
    .select({ name: labels.name })
    .from(labels)
    .innerJoin(taskLabels, eq(taskLabels.labelId, labels.id))
    .where(eq(taskLabels.taskId, taskId))
    .orderBy(asc(labels.name));
  return {
    key: `${row!.projectKey}-${t.number}`,
    title: t.title,
    description: t.description,
    priority: t.priority,
    status: row!.status,
    category: row!.category,
    labels: labelRows.map((l) => l.name),
    projectName: row!.projectName,
    version: t.version,
  };
}

export function describeTask(t: TaskSnapshot): string {
  return [
    `Task ${t.key}: ${t.title}`,
    `Status: ${t.status} (${t.category}) · Priority: ${t.priority} · Labels: ${t.labels.length ? t.labels.join(', ') : 'none'}`,
    '',
    'Description:',
    t.description.trim() || '(no description)',
  ].join('\n');
}

/** The first Message of a new Session: the Task, its conversation so far, and the branch. */
export function startMessage(
  t: TaskSnapshot,
  conversation: MessageParts,
  opts: { branch: string | null; previousAgent: boolean },
): MessageParts {
  const intro = [
    `You have been assigned task ${t.key} in project "${t.projectName}".`,
    '',
    describeTask(t),
  ];
  if (opts.branch) intro.push('', `Task branch: ${opts.branch}`);
  if (opts.previousAgent) {
    intro.push(
      '',
      'Another agent worked on this task before you' + (opts.branch ? ' on the same branch' : '') + '. Its messages are in the conversation below.',
    );
  }
  intro.push('', conversation.blocks.length ? 'Conversation so far (oldest first):' : 'There are no comments yet.');
  return { blocks: [{ type: 'text', text: intro.join('\n') }, ...conversation.blocks], fetch: conversation.fetch };
}

export const RESUME_MESSAGE = 'The previous run was interrupted by a restart; continue where you left off.';
export const REASSIGNED_MESSAGE = 'You have been assigned to this task again. Read it with get_task to catch up on any changes.';

export interface PromptInput {
  agentName: string;
  taskKey: string;
  projectName: string;
  worktreePath: string;
  branch: string | null;
  projectInstructions: string;
  agentPrompt: string;
}

/** `--append-system-prompt`: the platform section, then Project and Agent instructions. */
export function systemPrompt(p: PromptInput): string {
  const platform = [
    `You are ${p.agentName}, an AI agent on the team's task board, working on task ${p.taskKey} in project "${p.projectName}".`,
    `Your working directory is ${AGENT_HOME}/${p.worktreePath}${p.branch ? `, a git worktree on the task branch \`${p.branch}\`` : ''}.`,
    '',
    'How this works:',
    '- Everything you write as text is posted as a comment on the task, for humans: write clearly and use markdown.',
    '- New messages from humans can arrive while you work. Take them into account as soon as you see them.',
    '- If you need clarification, ask in text and end your turn. The answer will arrive as a new message.',
    '- Files attached to comments are saved under `.claude-task/attachments/` in your working directory.',
    '',
    'Task tools (MCP server `claude-task`):',
    '- `get_task`: read your task (or another task of the project by key): fields, statuses, labels and comments.',
    '- `update_task`: change your task\'s title, description, priority or labels (e.g. tick checklist items).',
    '- `set_status`: move your task to another status to signal progress. Closed statuses are for humans.',
    '- `list_tasks`: list the project\'s tasks.',
    '- `create_task`: report an out-of-scope issue as a new, unassigned task.',
  ];
  if (p.branch) {
    platform.push(
      '',
      'Git:',
      '- `open_pull_request`: open or update a pull request from your task branch after committing and pushing it.',
      `- Never push to branches other than \`${p.branch}\`.`,
      '- Before moving the task to a review status, commit, push the task branch and open or update the pull request with `open_pull_request`.',
    );
  }
  return [platform.join('\n'), p.projectInstructions.trim() && `Project instructions:\n${p.projectInstructions.trim()}`, p.agentPrompt.trim()]
    .filter(Boolean)
    .join('\n\n');
}
