import { createProjectBody, listProjectsQuery, projectTopic, updateProjectBody } from '@claude-task/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { transact } from '../../context';
import type { AppContext } from '../../context';
import { attachments, comments, projects, tasks } from '../../db/schema';
import { badRequest, parse } from '../../errors';
import { listLabels } from '../labels/service';
import { listStatuses } from '../statuses/service';
import { createProject, getProject, listProjects, serializeProject } from './service';

const params = z.object({ id: z.string().min(1).max(64) });

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
      const [project] = await tx
        .update(projects)
        .set({ ...body, updatedAt: new Date() })
        .where(eq(projects.id, existing.id))
        .returning();
      after.emit(projectTopic(existing.id), { type: 'project.updated', project: serializeProject(project!) });
      return { project: serializeProject(project!) };
    });
  });

  for (const action of ['archive', 'unarchive'] as const) {
    app.post(`/projects/:id/${action}`, async (request) => {
      const { id } = parse(params, request.params);
      return transact(ctx, async (tx, after) => {
        const existing = await getProject(tx, id, { lock: true });
        const [project] = await tx
          .update(projects)
          .set({ archivedAt: action === 'archive' ? (existing.archivedAt ?? new Date()) : null, updatedAt: new Date() })
          .where(eq(projects.id, existing.id))
          .returning();
        after.emit(projectTopic(existing.id), { type: 'project.updated', project: serializeProject(project!) });
        return { project: serializeProject(project!) };
      });
    });
  }

  app.delete('/projects/:id', { config: { auth: 'admin' } }, async (request, reply) => {
    const { id } = parse(params, request.params);
    await transact(ctx, async (tx, after) => {
      const project = await getProject(tx, id, { lock: true });
      if (!project.archivedAt) throw badRequest('Archive the project before deleting it');
      const blobs = await tx
        .select({ blobId: attachments.blobId })
        .from(attachments)
        .innerJoin(comments, eq(comments.id, attachments.commentId))
        .innerJoin(tasks, eq(tasks.id, comments.taskId))
        .where(eq(tasks.projectId, project.id));
      // Tasks reference statuses without cascade, so remove them first.
      await tx.delete(tasks).where(eq(tasks.projectId, project.id));
      await tx.delete(projects).where(eq(projects.id, project.id));
      for (const b of blobs) after.run(() => ctx.blobs.delete(b.blobId));
    });
    return reply.status(204).send();
  });
}

async function bundle(ctx: AppContext, projectId: string) {
  const [project] = await ctx.db.select().from(projects).where(eq(projects.id, projectId));
  return {
    project: serializeProject(project!),
    statuses: await listStatuses(ctx.db, projectId),
    labels: await listLabels(ctx.db, projectId),
  };
}

