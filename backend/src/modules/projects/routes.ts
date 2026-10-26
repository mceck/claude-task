import { createProjectBody, listProjectsQuery, projectTopic, updateProjectBody } from '@claude-task/shared';
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { transact } from '../../context';
import type { AfterCommit, AppContext } from '../../context';
import type { Executor } from '../../db/client';
import { attachments, comments, projects, tasks } from '../../db/schema';
import { badRequest, parse } from '../../errors';
import { removeDeletedWorktrees } from '../../sessions/lifecycle';
import { listTags } from '../tags/service';
import { listStatuses } from '../statuses/service';
import { assertNoActiveJobs } from '../tasks/service';
import { createProject, getProject, listProjects, serializeProject } from './service';
import { idOrKey } from '../../ids';

const params = z.object({ id: idOrKey });

export function projectRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/projects', async (request) => {
    const query = parse(listProjectsQuery, request.query);
    return { projects: await listProjects(ctx.db, query.archived === 'true') };
  });

  app.post('/projects', async (request, reply) => {
    const body = parse(createProjectBody, request.body);
    const project = await ctx.db.transaction((tx) => createProject(tx, body));
    return reply.status(201).send(await bundle(ctx, project.id));
  });

  app.get('/projects/:id', async (request) => {
    const { id } = parse(params, request.params);
    const project = await getProject(ctx.db, id);
    return bundle(ctx, project.id);
  });

  app.patch('/projects/:id', async (request) => {
    const { id } = parse(params, request.params);
    const body = parse(updateProjectBody, request.body);
    return transact(ctx, async (tx, after) => {
      const existing = await getProject(tx, id, { lock: true });
      return updateProject(tx, after, existing.id, body);
    });
  });

  for (const action of ['archive', 'unarchive'] as const) {
    app.post(`/projects/:id/${action}`, async (request) => {
      const { id } = parse(params, request.params);
      return transact(ctx, async (tx, after) => {
        const existing = await getProject(tx, id, { lock: true });
        return updateProject(tx, after, existing.id, {
          archivedAt: action === 'archive' ? (existing.archivedAt ?? new Date()) : null,
        });
      });
    });
  }

  app.delete('/projects/:id', { config: { auth: 'admin' } }, async (request, reply) => {
    const { id } = parse(params, request.params);
    await transact(ctx, async (tx, after) => {
      const project = await getProject(tx, id, { lock: true });
      if (!project.archivedAt) throw badRequest('Archive the project before deleting it');
      const doomed = await tx.select({ id: tasks.id }).from(tasks).where(eq(tasks.projectId, project.id)).for('update');
      await assertNoActiveJobs(tx, eq(tasks.projectId, project.id));
      await removeDeletedWorktrees(tx, after, doomed.map((t) => t.id));
      const blobs = await tx
        .select({ blobId: attachments.blobId })
        .from(attachments)
        .leftJoin(comments, eq(comments.id, attachments.commentId))
        .innerJoin(tasks, eq(tasks.id, sql`coalesce(${attachments.taskId}, ${comments.taskId})`))
        .where(eq(tasks.projectId, project.id));
      // Tasks reference statuses without cascade, so remove them first.
      await tx.delete(tasks).where(eq(tasks.projectId, project.id));
      await tx.delete(projects).where(eq(projects.id, project.id));
      for (const b of blobs) after.run(() => ctx.blobs.delete(b.blobId));
    });
    return reply.status(204).send();
  });
}

async function updateProject(tx: Executor, after: AfterCommit, id: string, patch: Partial<typeof projects.$inferInsert>) {
  const [project] = await tx
    .update(projects)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(projects.id, id))
    .returning();
  after.emit(projectTopic(id), { type: 'project.updated', project: serializeProject(project!) });
  return { project: serializeProject(project!) };
}

async function bundle(ctx: AppContext, projectId: string) {
  const [project] = await ctx.db.select().from(projects).where(eq(projects.id, projectId));
  return {
    project: serializeProject(project!),
    statuses: await listStatuses(ctx.db, projectId),
    tags: await listTags(ctx.db, projectId),
  };
}

