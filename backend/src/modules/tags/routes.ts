import { createTagBody, updateTagBody } from '@claude-task/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { currentUser, userActor } from '../../auth/guard';
import { transact } from '../../context';
import type { AppContext } from '../../context';
import { tags } from '../../db/schema';
import { notFound, parse } from '../../errors';
import { getBoardProject } from '../projects/service';
import { detachTag } from '../tasks/service';
import { emitTagsChanged, getTag, listTags, serializeTag } from './service';
import { idOrKey } from '../../ids';

const projectParams = z.object({ projectId: idOrKey });
const params = z.object({ id: z.uuid() });

export function tagRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/projects/:projectId/tags', async (request) => {
    const { projectId } = parse(projectParams, request.params);
    const project = await getBoardProject(ctx.db, projectId);
    return { tags: await listTags(ctx.db, project.id) };
  });

  app.post('/projects/:projectId/tags', async (request, reply) => {
    const { projectId } = parse(projectParams, request.params);
    const body = parse(createTagBody, request.body);
    const tag = await transact(ctx, async (tx, after) => {
      const project = await getBoardProject(tx, projectId);
      const [tag] = await tx
        .insert(tags)
        .values({ ...body, projectId: project.id })
        .returning();
      await emitTagsChanged(tx, after, project.id);
      return tag!;
    });
    return reply.status(201).send({ tag: serializeTag(tag) });
  });

  app.patch('/tags/:id', async (request) => {
    const { id } = parse(params, request.params);
    const body = parse(updateTagBody, request.body);
    return transact(ctx, async (tx, after) => {
      const existing = await getTag(tx, id);
      await getBoardProject(tx, existing.projectId);
      // An empty edit changes nothing; returning it avoids Drizzle's "No values to set" error.
      if (Object.keys(body).length === 0) return { tag: serializeTag(existing) };
      const [tag] = await tx.update(tags).set(body).where(eq(tags.id, id)).returning();
      if (!tag) throw notFound('Tag');
      await emitTagsChanged(tx, after, existing.projectId);
      return { tag: serializeTag(tag) };
    });
  });

  app.delete('/tags/:id', async (request, reply) => {
    const { id } = parse(params, request.params);
    const actor = userActor(currentUser(request));
    await transact(ctx, async (tx, after) => {
      const peek = await getTag(tx, id);
      // Task writes take a shared lock on the Project; deleting a Tag takes it exclusively
      // so the Tag can't be added to another Task between the scan and the delete.
      await getBoardProject(tx, peek.projectId, { lock: true });
      const existing = await getTag(tx, id);
      await detachTag(tx, after, existing, actor);
      await tx.delete(tags).where(eq(tags.id, id));
      await emitTagsChanged(tx, after, existing.projectId);
    });
    return reply.status(204).send();
  });
}
