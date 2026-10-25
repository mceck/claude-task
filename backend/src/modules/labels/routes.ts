import { createLabelBody, updateLabelBody } from '@claude-task/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { currentUser, userActor } from '../../auth/guard';
import { transact } from '../../context';
import type { AppContext } from '../../context';
import { labels } from '../../db/schema';
import { parse } from '../../errors';
import { getProject } from '../projects/service';
import { detachLabel } from '../tasks/service';
import { emitLabelsChanged, getLabel, listLabels, serializeLabel } from './service';

const projectParams = z.object({ projectId: z.string().min(1).max(64) });
const params = z.object({ id: z.uuid() });

export function labelRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/projects/:projectId/labels', async (request) => {
    const { projectId } = parse(projectParams, request.params);
    const project = await getProject(ctx.db, projectId);
    return { labels: await listLabels(ctx.db, project.id) };
  });

  app.post('/projects/:projectId/labels', async (request, reply) => {
    const { projectId } = parse(projectParams, request.params);
    const body = parse(createLabelBody, request.body);
    const label = await transact(ctx, async (tx, after) => {
      const project = await getProject(tx, projectId);
      const [label] = await tx
        .insert(labels)
        .values({ ...body, projectId: project.id })
        .returning();
      await emitLabelsChanged(tx, after, project.id);
      return label!;
    });
    return reply.status(201).send({ label: serializeLabel(label) });
  });

  app.patch('/labels/:id', async (request) => {
    const { id } = parse(params, request.params);
    const body = parse(updateLabelBody, request.body);
    return transact(ctx, async (tx, after) => {
      const existing = await getLabel(tx, id);
      const [label] = await tx.update(labels).set(body).where(eq(labels.id, id)).returning();
      await emitLabelsChanged(tx, after, existing.projectId);
      return { label: serializeLabel(label!) };
    });
  });

  app.delete('/labels/:id', async (request, reply) => {
    const { id } = parse(params, request.params);
    const actor = userActor(currentUser(request));
    await transact(ctx, async (tx, after) => {
      const existing = await getLabel(tx, id);
      await detachLabel(tx, after, existing, actor);
      await tx.delete(labels).where(eq(labels.id, id));
      await emitLabelsChanged(tx, after, existing.projectId);
    });
    return reply.status(204).send();
  });
}
