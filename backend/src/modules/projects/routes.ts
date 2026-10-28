import { createProjectBody, listProjectsQuery, PROJECT_LOGO_MAX_BYTES, PROJECT_LOGO_TYPES, projectTopic, updateProjectBody } from '@claude-task/shared';
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { transact } from '../../context';
import type { AfterCommit, AppContext } from '../../context';
import type { Executor } from '../../db/client';
import { agents, attachments, comments, projects, tasks } from '../../db/schema';
import { badRequest, HttpError, notFound, parse } from '../../errors';
import { removeDeletedWorktrees } from '../../sessions/lifecycle';
import { listTags } from '../tags/service';
import { listStatuses } from '../statuses/service';
import { assertNoActiveJobs } from '../tasks/service';
import { createProject, getBoardProject, listProjects, serializeProject } from './service';
import { currentUser } from '../../auth/guard';
import { idOrKey } from '../../ids';
import { resolveRepository } from '../../git/service';

const params = z.object({ id: idOrKey });

export function projectRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/projects', async (request) => {
    const query = parse(listProjectsQuery, request.query);
    return { projects: await listProjects(ctx.db, currentUser(request).id, query.archived === 'true') };
  });

  app.post('/projects', async (request, reply) => {
    const body = parse(createProjectBody, request.body);
    const repository = body.repository ? await resolveRepository(ctx, body.repository) : null;
    const project = await ctx.db.transaction(async (tx) => {
      if (repository) {
        // Serialize the initial link against deletion of its Git Connection.
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`git-connection:${repository.connectionId}`}))`);
        if (!(await ctx.git.find(repository.connectionId, tx))) throw badRequest('Choose a repository of an existing Git Connection');
      }
      if (body.defaultAgentId) {
        const [agent] = await tx.select({ id: agents.id }).from(agents).where(eq(agents.id, body.defaultAgentId)).for('key share');
        if (!agent) throw badRequest('Unknown agent');
      }
      return createProject(tx, { ...body, repository });
    });
    return reply.status(201).send(await bundle(ctx, project.id));
  });

  app.get('/projects/:id', async (request) => {
    const { id } = parse(params, request.params);
    const project = await getBoardProject(ctx.db, id);
    return bundle(ctx, project.id);
  });

  app.patch('/projects/:id', async (request) => {
    const { id } = parse(params, request.params);
    const body = parse(updateProjectBody, request.body);
    return transact(ctx, async (tx, after) => {
      const existing = await getBoardProject(tx, id, { lock: true });
      return updateProject(tx, after, existing.id, body);
    });
  });

  app.get('/projects/:id/logo', async (request, reply) => {
    const { id } = parse(params, request.params);
    const project = await getBoardProject(ctx.db, id);
    const blob = project.logoBlobId ? await ctx.blobs.get(project.logoBlobId) : null;
    if (!blob) throw notFound('Logo');
    return reply
      .header('content-type', blob.metadata.contentType)
      .header('content-length', String(blob.metadata.size))
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'; sandbox")
      .header('cache-control', 'private, max-age=0, must-revalidate')
      .send(blob.stream);
  });

  app.put('/projects/:id/logo', async (request) => {
    const { id } = parse(params, request.params);
    await getBoardProject(ctx.db, id);
    const blobId = await receiveLogo(ctx, request);
    return transact(ctx, async (tx, after) => {
      const previous = await getBoardProject(tx, id, { lock: true });
      const result = await updateProject(tx, after, previous.id, { logoBlobId: blobId });
      if (previous.logoBlobId) after.run(() => ctx.blobs.delete(previous.logoBlobId!));
      return result;
    }).catch(async (err) => {
      await ctx.blobs.delete(blobId);
      throw err;
    });
  });

  app.delete('/projects/:id/logo', async (request) => {
    const { id } = parse(params, request.params);
    return transact(ctx, async (tx, after) => {
      const previous = await getBoardProject(tx, id, { lock: true });
      const result = await updateProject(tx, after, previous.id, { logoBlobId: null });
      if (previous.logoBlobId) after.run(() => ctx.blobs.delete(previous.logoBlobId!));
      return result;
    });
  });

  for (const action of ['archive', 'unarchive'] as const) {
    app.post(`/projects/:id/${action}`, async (request) => {
      const { id } = parse(params, request.params);
      return transact(ctx, async (tx, after) => {
        const existing = await getBoardProject(tx, id, { lock: true });
        return updateProject(tx, after, existing.id, {
          archivedAt: action === 'archive' ? (existing.archivedAt ?? new Date()) : null,
        });
      });
    });
  }

  app.delete('/projects/:id', { config: { auth: 'admin' } }, async (request, reply) => {
    const { id } = parse(params, request.params);
    await transact(ctx, async (tx, after) => {
      const project = await getBoardProject(tx, id, { lock: true });
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
      if (project.logoBlobId) after.run(() => ctx.blobs.delete(project.logoBlobId!));
      for (const b of blobs) after.run(() => ctx.blobs.delete(b.blobId));
    });
    return reply.status(204).send();
  });
}

async function receiveLogo(ctx: AppContext, request: FastifyRequest): Promise<string> {
  if (!request.isMultipart()) throw badRequest('Send the image as multipart/form-data');
  const tooLarge = () => new HttpError(413, 'file_too_large', 'The logo must be at most 2 MB');
  let blobId: string | null = null;
  try {
    for await (const part of request.parts({ limits: { fileSize: PROJECT_LOGO_MAX_BYTES, files: 1 } })) {
      if (part.type !== 'file') continue;
      if (!(PROJECT_LOGO_TYPES as readonly string[]).includes(part.mimetype)) {
        part.file.resume();
        throw badRequest('The logo must be a PNG, JPEG, GIF or WebP image');
      }
      const stored = await ctx.blobs.put(part.file, { filename: 'logo', contentType: part.mimetype });
      blobId = stored.id;
      if (part.file.truncated) throw tooLarge();
      if (stored.size === 0) throw badRequest('The image file is empty');
    }
    if (!blobId) throw badRequest('Missing image file');
    return blobId;
  } catch (err) {
    if (blobId) await ctx.blobs.delete(blobId);
    if ((err as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') throw tooLarge();
    throw err;
  }
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

