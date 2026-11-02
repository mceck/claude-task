import { z } from 'zod';
import type { SessionState } from './agents';
import type { ProjectRepository } from './git';
import { repositoryBody } from './api';

export interface Wiki {
  id: string;
  name: string;
  description: string;
  repository: ProjectRepository;
  /** The default Agent of new Chats. */
  agentId: string | null;
  /** Where the Wiki's Jobs run. */
  workerId: string;
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
  /** The Chat's own Agent: the Wiki's default Agent when the Chat started, changeable at any time. */
  agentId: string | null;
  sessionState: SessionState | null;
  /** The Agent is working on this Chat right now. */
  running: boolean;
  unread: boolean;
  createdAt: string;
  lastActivityAt: string;
}

export const renameChatBody = z.strictObject({ title: z.string().trim().min(1).max(200) });
export const setChatAgentBody = z.strictObject({ agentId: z.uuid() });

export const createWikiBody = z.strictObject({
  name: z.string().trim().min(1).max(200),
  description: z.string().max(100_000).default(''),
  agentId: z.uuid(),
  workerId: z.uuid(),
  repository: repositoryBody,
});
export const updateWikiBody = z.strictObject({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(100_000).optional(),
  agentId: z.uuid().optional(),
  /** Refused with 409 while the Wiki has started Chats. */
  workerId: z.uuid().optional(),
});
export type CreateWikiBody = z.input<typeof createWikiBody>;
