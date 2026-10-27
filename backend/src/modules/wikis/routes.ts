import { randomUUID } from 'node:crypto';
import { createWikiBody, updateWikiBody } from '@claude-task/shared';
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { currentUser, userActor } from '../../auth/guard';
import { transact } from '../../context';
import type { AppContext } from '../../context';
import { projects, tasks } from '../../db/schema';
import { badRequest, parse } from '../../errors';
import { resolveRepository } from '../../git/service';
import { createProject } from '../projects/service';
import { createTask, deleteTask, getTaskRow, updateTask } from '../tasks/service';
import { getWiki, listWikis, resetWiki } from './service';

const params = z.object({ id: z.uuid() });
const WIKI_INSTRUCTIONS =
  'This repository is a shared Wiki made of Markdown files. Follow its CLAUDE.md, repository skills and conventions for reading and maintaining the Wiki. Treat the conversation as a shared discussion with multiple Users. Preserve existing documentation and skills.';

export function wikiRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/wikis', async () => ({ wikis: await listWikis(ctx.db) }));
  app.post('/wikis', async (request, reply) => {
    const body = parse(createWikiBody, request.body);
    const repository = await resolveRepository(ctx, body.repository);
    const actor = userActor(currentUser(request));
    const wiki = await transact(ctx, async (tx, after) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`git-connection:${repository.connectionId}`}))`);
      if (!(await ctx.git.find(repository.connectionId, tx))) throw badRequest('Choose an existing Git Connection');
      // Internal keys stay within the existing readable Task Key format.
      let key: string;
      do {
        key = 'W' + [...randomUUID().replaceAll('-', '').slice(0, 5)].map((c) => String.fromCharCode(65 + parseInt(c, 16))).join('');
      } while ((await tx.select({ id: projects.id }).from(projects).where(eq(projects.key, key))).length);
      const project = await createProject(tx, { key, name: body.name, description: body.description });
      await tx.update(projects).set({ kind: 'wiki', repository, agentInstructions: WIKI_INSTRUCTIONS }).where(eq(projects.id, project.id));
      const task = await createTask(
        tx,
        after,
        project.id,
        {
          title: body.name,
          description: body.description,
          priority: 'none',
          tagIds: [],
          assigneeIds: [],
        },
        actor,
      );
      await updateTask(tx, after, task.id, { version: task.version, agentId: body.agentId }, actor);
      after.emit('wikis', { type: 'wiki.changed', wikiId: project.id });
      return getWiki(tx, project.id);
    });
    return reply.status(201).send({ wiki });
  });
  app.get('/wikis/:id', async (request) => {
    const { id } = parse(params, request.params);
    return { wiki: await getWiki(ctx.db, id) };
  });
  app.patch('/wikis/:id', async (request) => {
    const { id } = parse(params, request.params);
    const body = parse(updateWikiBody, request.body);
    const actor = userActor(currentUser(request));
    return transact(ctx, async (tx, after) => {
      const wiki = await getWiki(tx, id, true);
      const task = await getTaskRow(tx, wiki.taskId);
      await updateTask(
        tx,
        after,
        task.id,
        {
          version: task.version,
          ...(body.name !== undefined ? { title: body.name } : {}),
          ...(body.description !== undefined ? { description: body.description } : {}),
          ...(body.agentId !== undefined ? { agentId: body.agentId } : {}),
        },
        actor,
      );
      await tx
        .update(projects)
        .set({
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.description !== undefined ? { description: body.description } : {}),
          updatedAt: new Date(),
        })
        .where(eq(projects.id, id));
      after.emit('wikis', { type: 'wiki.changed', wikiId: id });
      return { wiki: await getWiki(tx, id) };
    });
  });
  app.post('/wikis/:id/reset', async (request) => {
    const { id } = parse(params, request.params);
    return transact(ctx, async (tx, after) => {
      const wiki = await getWiki(tx, id, true);
      await resetWiki(tx, after, wiki);
      after.emit('wikis', { type: 'wiki.changed', wikiId: id });
      return { wiki: await getWiki(tx, id) };
    });
  });
  app.delete('/wikis/:id', async (request, reply) => {
    const { id } = parse(params, request.params);
    await transact(ctx, async (tx, after) => {
      const wiki = await getWiki(tx, id, true);
      const { blobIds } = await deleteTask(tx, after, wiki.taskId);
      await tx.delete(projects).where(eq(projects.id, id));
      after.emit('wikis', { type: 'wiki.changed', wikiId: id });
      for (const blob of blobIds) after.run(() => ctx.blobs.delete(blob));
    });
    return reply.status(204).send();
  });
}
