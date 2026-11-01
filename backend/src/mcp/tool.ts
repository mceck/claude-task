// What every Task Tool shares: how results and errors reach the model, and the common inputs.
import { ATTACHMENT_MAX_FILES, CATEGORIES, PRIORITIES, QUESTION_LIMITS } from '@claude-task/shared';
import { z } from 'zod';
import type { AppContext } from '../context';
import { fromDatabaseError, HttpError } from '../errors';
import { GitProviderError } from '../git/provider';

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

/** Compact JSON: every answer goes through the model's context. */
const ok = (value: unknown): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });

/** Tool errors go back to the model as text it can act on; unexpected ones are logged, not shown. */
export async function run(ctx: AppContext, fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return ok(await fn());
  } catch (err) {
    const known = err instanceof HttpError || err instanceof GitProviderError ? err : fromDatabaseError(err);
    if (!known) ctx.log.error({ err }, 'task tool failed');
    return { content: [{ type: 'text', text: known ? known.message : 'Internal error' }], isError: true };
  }
}

export const taskKeyInput = z.string().trim().min(1).max(40).describe('Task key, e.g. API-42');
export const projectKeyInput = z.string().trim().min(1).max(10).describe("Project key, e.g. API; defaults to your task's project");
export const statusNameInput = z.string().trim().min(1).max(100).describe('Status name, case-insensitive (get_task lists them)');
export const categoryInput = z.enum(CATEGORIES);

/** The editable fields of a Task, shared by the tools that create and edit one. */
export const taskFields = {
  title: z.string().trim().min(1).max(500),
  description: z.string().max(100_000).describe('Markdown'),
  priority: z.enum(PRIORITIES),
  tags: z.array(z.string()).max(50).describe("Tag names that exist in the task's project; the list replaces the current tags"),
};

export const filePaths = z
  .array(z.string().min(1).max(4096))
  .max(ATTACHMENT_MAX_FILES)
  .describe('Files in your container: relative to your working directory, or absolute');

const questionItem = z.object({
  header: z.string().trim().min(1).max(QUESTION_LIMITS.header).describe('Very short label shown as a chip, e.g. "Database"'),
  question: z.string().trim().min(1).max(QUESTION_LIMITS.question).describe('The full question, in markdown'),
  options: z
    .array(
      z.object({
        label: z.string().trim().min(1).max(QUESTION_LIMITS.label).describe('What people pick (1 to 5 words)'),
        description: z.string().trim().max(QUESTION_LIMITS.description).default('').describe('What choosing it means, its trade-offs'),
      }),
    )
    .min(QUESTION_LIMITS.options.min)
    .max(QUESTION_LIMITS.options.max)
    .describe('2 to 4 options; an "Other" free-text answer is always added for you'),
  multiSelect: z.boolean().default(false).describe('Allow choosing several options'),
});
export const questionItems = z.array(questionItem).min(QUESTION_LIMITS.items.min).max(QUESTION_LIMITS.items.max);
