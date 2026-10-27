import { z } from 'zod';
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
