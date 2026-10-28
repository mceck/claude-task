import { z } from 'zod';
import type { SessionState } from './agents';
import type { ProjectRepository } from './git';
import { repositoryBody } from './api';

export interface Wiki {
  id: string;
  name: string;
  description: string;
  repository: ProjectRepository;
  agentId: string | null;
  /** Shared conversation, using the same Comments and Session APIs as Tasks. */
  taskId: string;
  createdAt: string;
  updatedAt: string;
}

/** One of a Wiki's conversations. Its id is the id of the Task that holds it: Comments, Session and Timeline use the Task APIs. */
export interface WikiChat {
  id: string;
  wikiId: string;
  title: string;
  /** The Agent that runs the Chat: the Wiki's Agent when the Chat was created. */
  agentId: string | null;
  sessionState: SessionState | null;
  /** The Agent is working on this Chat right now. */
  running: boolean;
  unread: boolean;
  createdAt: string;
  lastActivityAt: string;
}

export const renameChatBody = z.strictObject({ title: z.string().trim().min(1).max(200) });

export const createWikiBody = z.strictObject({
  name: z.string().trim().min(1).max(200),
  description: z.string().max(100_000).default(''),
  agentId: z.uuid(),
  repository: repositoryBody,
});
export const updateWikiBody = z.strictObject({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(100_000).optional(),
  agentId: z.uuid().optional(),
});
export type CreateWikiBody = z.input<typeof createWikiBody>;
