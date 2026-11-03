// The ClickUp API v2 behind an interface, so tests can replace it (docs/specs/clickup.md).
import { Readable } from 'node:stream';
import type { ClickUpOption, ClickUpSourceType } from '@claude-task/shared';

export interface ClickUpStatus {
  id: string;
  name: string;
  color: string;
  /** `open`, `custom`, `done` or `closed`. */
  type: string;
  orderindex: number;
}

export interface ClickUpAttachment {
  id: string;
  title: string;
  url: string;
  size: number | null;
  contentType: string | null;
}

export interface ClickUpTask {
  id: string;
  name: string;
  /** Markdown. */
  description: string;
  status: ClickUpStatus;
  url: string;
  listId: string | null;
  attachments: ClickUpAttachment[];
}

export interface ClickUpSource {
  type: ClickUpSourceType;
  id: string;
  teamId: string;
  query: [string, string][];
}

export interface ClickUpClient {
  teams(): Promise<ClickUpOption[]>;
  spaces(teamId: string): Promise<ClickUpOption[]>;
  /** Every List of a Space, in folders or not, named "Folder / List" when in a folder. */
  lists(spaceId: string): Promise<ClickUpOption[]>;
  views(teamId: string): Promise<ClickUpOption[]>;
  listStatuses(listId: string): Promise<ClickUpStatus[]>;
  /** All pages of the source's tasks. */
  tasks(source: ClickUpSource): Promise<ClickUpTask[]>;
  setStatus(taskId: string, statusName: string): Promise<void>;
  download(attachment: ClickUpAttachment): Promise<{ stream: Readable; contentType: string | null }>;
}

export type ClickUpClientFactory = (token: string) => ClickUpClient;

export class ClickUpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const BASE = 'https://api.clickup.com/api/v2';
/** ClickUp allows 100 requests per minute and per token. */
const MIN_GAP_MS = 650;
const nextSlot = new Map<string, number>();

async function throttle(token: string): Promise<void> {
  const now = Date.now();
  const at = Math.max(now, nextSlot.get(token) ?? 0);
  nextSlot.set(token, at + MIN_GAP_MS);
  if (at > now) await new Promise((resolve) => setTimeout(resolve, at - now));
}

type Json = Record<string, any>;

export function httpClickUpClient(token: string): ClickUpClient {
  async function call(method: string, path: string, body?: unknown): Promise<Json> {
    await throttle(token);
    let res: Response;
    try {
      res = await fetch(`${BASE}${path}`, {
        method,
        headers: { authorization: token, ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      throw new ClickUpError(`ClickUp is unreachable: ${err instanceof Error ? err.message : 'network error'}`, 0);
    }
    if (!res.ok) {
      const detail = (await res.json().catch(() => null)) as Json | null;
      if (res.status === 429) throw new ClickUpError('ClickUp rate limit reached, the next pass will retry', 429);
      throw new ClickUpError(`ClickUp answered ${res.status}${detail?.err ? `: ${detail.err}` : ''}`, res.status);
    }
    return ((await res.json().catch(() => ({}))) ?? {}) as Json;
  }

  const options = (rows: Json[] | undefined): ClickUpOption[] => (rows ?? []).map((r) => ({ id: String(r.id), name: String(r.name) }));
  const mapStatus = (s: Json): ClickUpStatus => ({
    id: String(s.id ?? s.status),
    name: String(s.status),
    color: /^#[0-9a-fA-F]{6}$/.test(s.color ?? '') ? s.color : '#64748b',
    type: String(s.type ?? 'custom'),
    orderindex: Number(s.orderindex ?? 0),
  });

  return {
    async teams() {
      return options((await call('GET', '/team')).teams);
    },
    async spaces(teamId) {
      return options((await call('GET', `/team/${encodeURIComponent(teamId)}/space?archived=false`)).spaces);
    },
    async lists(spaceId) {
      const id = encodeURIComponent(spaceId);
      const folders = ((await call('GET', `/space/${id}/folder?archived=false`)).folders ?? []) as Json[];
      const loose = options((await call('GET', `/space/${id}/list?archived=false`)).lists);
      const inFolders = folders.flatMap((f) => options(f.lists).map((l) => ({ id: l.id, name: `${f.name} / ${l.name}` })));
      return [...loose, ...inFolders];
    },
    async views(teamId) {
      return options((await call('GET', `/team/${encodeURIComponent(teamId)}/view`)).views);
    },
    async listStatuses(listId) {
      return (((await call('GET', `/list/${encodeURIComponent(listId)}`)).statuses ?? []) as Json[]).map(mapStatus);
    },
    async tasks(source) {
      const out: ClickUpTask[] = [];
      for (let page = 0; page < 500; page++) {
        const params = new URLSearchParams();
        if (source.type === 'list') {
          params.append('list_ids[]', source.id);
          params.append('include_markdown_description', 'true');
          for (const [k, v] of source.query) params.append(k, v);
        }
        params.set('page', String(page));
        const path =
          source.type === 'list'
            ? `/team/${encodeURIComponent(source.teamId)}/task?${params}`
            : `/view/${encodeURIComponent(source.id)}/task?${params}`;
        const res = await call('GET', path);
        for (const t of (res.tasks ?? []) as Json[]) {
          out.push({
            id: String(t.id),
            name: String(t.name ?? ''),
            description: String(t.markdown_description ?? t.description ?? t.text_content ?? ''),
            status: mapStatus(t.status ?? {}),
            url: String(t.url ?? `https://app.clickup.com/t/${t.id}`),
            listId: t.list?.id ? String(t.list.id) : null,
            attachments: ((t.attachments ?? []) as Json[]).map((a) => ({
              id: String(a.id),
              title: String(a.title ?? a.id),
              url: String(a.url),
              size: typeof a.size === 'number' ? a.size : null,
              contentType: typeof a.mimetype === 'string' ? a.mimetype : null,
            })),
          });
        }
        if (res.last_page !== false) break;
      }
      return out;
    },
    async setStatus(taskId, statusName) {
      await call('PUT', `/task/${encodeURIComponent(taskId)}`, { status: statusName });
    },
    async download(attachment) {
      const res = await fetch(attachment.url, { signal: AbortSignal.timeout(120_000) });
      if (!res.ok || !res.body) throw new ClickUpError(`Could not download "${attachment.title}" (${res.status})`, res.status);
      return { stream: Readable.fromWeb(res.body as never), contentType: res.headers.get('content-type') };
    },
  };
}
