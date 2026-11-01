// Task Tools around Conversations: posting files, Questions and Surveys to the Agent's own Task,
// and searching and reading what was said across the Project.
import type { Category, QuestionItem, QuestionKind } from '@claude-task/shared';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { discardBlobs } from '../blobstore';
import { transact } from '../context';
import type { AppContext } from '../context';
import { badRequest } from '../errors';
import { createAgentComment } from '../modules/comments/service';
import type { NewAttachment, NewQuestion } from '../modules/comments/service';
import { expectedRespondents, questionBody, validateItems } from '../modules/questions/service';
import { readComments, searchComments } from '../modules/search/comments';
import { assertJobActive } from './scope';
import type { JobScope } from './scope';
import { assertOrdinaryProject, targetProject } from './tasks';
import { categoryInput, filePaths, projectKeyInput, questionItems, run } from './tool';

export function registerConversationTools(server: McpServer, ctx: AppContext, scope: JobScope): void {
  const global = !!scope.schedule?.global;

  server.registerTool(
    'search_comments',
    {
      description:
        `Search what was said in the conversations of ${global ? 'a' : 'your'} project's tasks, other and past tasks included: decisions, discussions, earlier fixes. Every word of \`query\` must appear in the same comment, as a case-insensitive substring with accents as typed. Answers the newest hits, each with its task, comment id, author, time and a snippet of about 250 characters; \`truncated\` means there are more, so add a word or a filter. Read around a hit with \`read_comments\`. Comments of closed tasks are left out unless \`status_category\` is \`closed\`; internal notes never appear.`,
      inputSchema: {
        ...(global ? { project: projectKeyInput.optional() } : {}),
        query: z.string().trim().min(2).max(200).describe('Distinctive words, not a sentence'),
        status_category: categoryInput.optional().describe('Only comments on tasks in this category; `closed` searches only closed tasks'),
        limit: z.number().int().min(1).max(50).optional().describe('Maximum hits (default 20)'),
      },
    },
    (args) => run(ctx, () => searchProjectComments(ctx, scope, args)),
  );

  server.registerTool(
    'read_comments',
    {
      description:
        'Read the conversation around one comment, e.g. a `search_comments` hit: up to `before` comments before it and `after` after it, oldest first, with full bodies and attachment names, plus `hasMoreBefore` and `hasMoreAfter`. To read further, call it again from the first or the last id you got. Use `get_task` for the task itself.',
      inputSchema: {
        comment_id: z.string().min(1).describe('A comment id from `search_comments` or a previous `read_comments`'),
        before: z.number().int().min(0).max(25).optional().describe('Comments before it (default 10)'),
        after: z.number().int().min(0).max(25).optional().describe('Comments after it (default 10)'),
      },
    },
    (args) => run(ctx, () => readTaskComments(ctx, scope, args)),
  );

  server.registerTool(
    'send_files',
    {
      description:
        'Post files from your container to your task\'s conversation as one comment, so humans can see them: screenshots, charts, logs, reports. Images are shown inline. Up to 10 files of up to 25 MB each; nothing is posted if any of them cannot be read. Attach long output instead of pasting it into your text.',
      inputSchema: {
        paths: filePaths.min(1),
        caption: z.string().max(100_000).optional().describe('Markdown shown with the files'),
      },
    },
    ({ paths, caption }) => run(ctx, () => sendFiles(ctx, scope, paths, caption ?? '')),
  );

  // Nobody answers during a Scheduled Run.
  if (scope.schedule) return;
  server.registerTool(
    'ask_question',
    {
      description:
        'Ask the humans on your task a multiple-choice question when you need a decision with clear options: 1 to 4 items answered together. The first person who answers decides. Then end your turn: the answer arrives as a new message. Ask open-ended questions in plain text instead.',
      inputSchema: { questions: questionItems, paths: filePaths.optional().describe('Files to show with the question, e.g. mockups to choose from') },
    },
    ({ questions, paths }) => run(ctx, () => postQuestion(ctx, scope, 'question', questions, paths ?? [])),
  );
  server.registerTool(
    'create_survey',
    {
      description:
        "Collect answers from every user assigned to your task; anyone may answer. Use it ONLY when a human explicitly asked for a survey or for several people's opinions; otherwise use `ask_question`. The results arrive in one message once every assignee answered or someone sends them early.",
      inputSchema: { questions: questionItems, paths: filePaths.optional().describe('Files to show with the survey') },
    },
    ({ questions, paths }) => run(ctx, () => postQuestion(ctx, scope, 'survey', questions, paths ?? [])),
  );
}

async function searchProjectComments(ctx: AppContext, scope: JobScope, args: { project?: string; query: string; status_category?: Category; limit?: number }) {
  const { id: projectId } = await targetProject(ctx.db, scope, args.project);
  const limit = args.limit ?? 20;
  const hits = await searchComments(ctx.db, { projectId, query: args.query, statusCategory: args.status_category, limit });
  return { hits, truncated: hits.length >= limit };
}

async function readTaskComments(ctx: AppContext, scope: JobScope, args: { comment_id: string; before?: number; after?: number }) {
  const window = await readComments(ctx.db, { commentId: args.comment_id, before: args.before ?? 10, after: args.after ?? 10 });
  if (!window) throw badRequest('No such comment, or it is internal or deleted.');
  if (scope.schedule?.global) await assertOrdinaryProject(ctx.db, window.projectId, args.comment_id);
  else if (window.projectId !== scope.projectId) throw badRequest('That comment is not in your project.');
  return { task: window.task, comments: window.comments, hasMoreBefore: window.hasMoreBefore, hasMoreAfter: window.hasMoreAfter };
}

/** Asks the Runner for the files; any unreadable file posts nothing. */
async function collectFiles(ctx: AppContext, scope: JobScope, paths: string[]): Promise<NewAttachment[]> {
  if (paths.length === 0) return [];
  const { manifest, files } = await ctx.uploads.request(scope.agentId, scope.jobId, paths);
  const failed = manifest.filter((e) => e.error);
  if (failed.length > 0) {
    await discardBlobs(ctx.blobs, files.map((f) => f.blobId));
    throw badRequest(`Nothing was posted. These files could not be read:\n${failed.map((e) => `- ${e.path}: ${e.error}`).join('\n')}`);
  }
  return files;
}

async function postAgentComment(ctx: AppContext, scope: JobScope, body: string, files: NewAttachment[], question?: NewQuestion): Promise<string> {
  try {
    return await transact(ctx, async (tx, after) => {
      // Collecting files takes a while: the Job may have ended, or the Task closed, meanwhile.
      await assertJobActive(tx, scope, 'the comment could be posted');
      return createAgentComment(tx, after, { taskId: scope.taskId, agentId: scope.agentId, jobId: scope.jobId, body, attachments: files, question });
    });
  } catch (err) {
    await discardBlobs(ctx.blobs, files.map((f) => f.blobId));
    throw err;
  }
}

async function sendFiles(ctx: AppContext, scope: JobScope, paths: string[], caption: string) {
  const files = await collectFiles(ctx, scope, paths);
  const id = await postAgentComment(ctx, scope, caption, files);
  return { posted: id, files: files.map((f) => f.filename) };
}

async function postQuestion(ctx: AppContext, scope: JobScope, kind: QuestionKind, items: QuestionItem[], paths: string[]) {
  validateItems(items);
  const expected = kind === 'survey' ? await expectedRespondents(ctx.db, scope.taskId) : [];
  if (kind === 'survey' && expected.length === 0) {
    throw badRequest('This task has no assignees to answer a survey: ask people to assign themselves to the task, or use ask_question.');
  }
  const files = await collectFiles(ctx, scope, paths);
  const names = expected.map((e) => e.name);
  const id = await postAgentComment(ctx, scope, questionBody(kind, items, names), files, { kind, items, expectedRespondentIds: expected.map((e) => e.id) });
  if (kind === 'question') return { posted: id, next: 'Question posted. End your turn now; the answer will arrive as a new message.' };
  return {
    posted: id,
    expectedRespondents: names,
    next: `Survey posted. The results arrive in one message once ${names.join(', ')} have answered, or when someone sends it early. End your turn unless you have other work to do meanwhile.`,
  };
}
