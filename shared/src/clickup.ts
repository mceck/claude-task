// ClickUp sync (docs/specs/clickup.md).
import { z } from 'zod';
import type { Category } from './domain';

export const CLICKUP_SOURCE_TYPES = ['list', 'view'] as const;
export type ClickUpSourceType = (typeof CLICKUP_SOURCE_TYPES)[number];

/** ClickUp filter parameters a link's query string may carry (brackets optional). */
export const CLICKUP_QUERY_PARAMS = [
  'statuses',
  'assignees',
  'tags',
  'due_date_gt',
  'due_date_lt',
  'date_created_gt',
  'date_created_lt',
  'date_updated_gt',
  'date_updated_lt',
  'include_closed',
  'subtasks',
  'custom_fields',
  'order_by',
  'reverse',
] as const;

/** Parses a query string of ClickUp filters into ordered pairs; the error names the first refused parameter. */
export function parseClickUpQuery(query: string): { ok: true; params: [string, string][] } | { ok: false; error: string } {
  const text = query.trim().replace(/^\?/, '');
  const params: [string, string][] = [];
  if (text === '') return { ok: true, params };
  for (const pair of text.split('&')) {
    if (pair === '') continue;
    const eq = pair.indexOf('=');
    let rawName: string;
    let value: string;
    try {
      rawName = decodeURIComponent((eq < 0 ? pair : pair.slice(0, eq)).replace(/\+/g, ' '));
      value = eq < 0 ? '' : decodeURIComponent(pair.slice(eq + 1).replace(/\+/g, ' '));
    } catch {
      return { ok: false, error: 'The query string is not valid' };
    }
    const base = rawName.replace(/\[\]$/, '');
    if (!(CLICKUP_QUERY_PARAMS as readonly string[]).includes(base)) {
      return { ok: false, error: `Unsupported ClickUp filter "${rawName}"` };
    }
    // ClickUp wants arrays as `name[]`.
    const array = ['statuses', 'assignees', 'tags'].includes(base);
    params.push([array ? `${base}[]` : base, value]);
  }
  return { ok: true, params };
}

/** The Category a new Mirrored Status gets, from the ClickUp status type and name. */
export function deduceCategory(type: string, name: string): Category {
  if (type === 'closed') return 'closed';
  const n = name.toLowerCase();
  if (n.includes('review')) return 'review';
  if (/\b(done|complete|completed)\b/.test(n)) return 'done';
  return 'open';
}

export const clickUpLinkBody = z.strictObject({
  credentialId: z.uuid(),
  teamId: z.string().trim().min(1).max(50),
  sourceType: z.enum(CLICKUP_SOURCE_TYPES),
  sourceId: z.string().trim().min(1).max(100),
  query: z
    .string()
    .max(2000)
    .default('')
    .refine((q) => parseClickUpQuery(q).ok, 'Unsupported ClickUp filter'),
});
export type ClickUpLinkBody = z.input<typeof clickUpLinkBody>;

export const updateClickUpLinkBody = clickUpLinkBody.partial();
export type UpdateClickUpLinkBody = z.input<typeof updateClickUpLinkBody>;

/** A Project's ClickUp Link. */
export interface ProjectClickUp {
  credentialId: string;
  teamId: string;
  sourceType: ClickUpSourceType;
  sourceId: string;
  query: string;
  lastSyncedAt: string | null;
  lastError: string | null;
}

/** A Task's ClickUp state; null on Tasks that never came from ClickUp. */
export interface TaskClickUp {
  url: string | null;
  /** False once the ClickUp task left the source: the Task is local until it returns. */
  linked: boolean;
  /** The description was edited here; syncs leave it alone until it is restored. */
  descriptionDetached: boolean;
  pushPending: boolean;
  error: string | null;
}

export interface ClickUpOption {
  id: string;
  name: string;
}
