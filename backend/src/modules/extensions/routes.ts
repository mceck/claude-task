import { importSkillsBody, saveMcpServerBody } from '@claude-task/shared';
import { asc, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../context';
import { agentMcpServers, agentSkills, mcpServers, skills } from '../../db/schema';
import { badRequest, conflict, notFound, parse } from '../../errors';
import { importSkills } from './import-skills';
import { invalidateExtensions, serializeMcp, serializeSkill, storeMcpValues } from './service';

const params = z.object({ id: z.uuid() });
export function extensionRoutes(app: FastifyInstance, ctx: AppContext): void {
  const admin = { config: { auth: 'admin' as const } };
  const sync = (ids: string[]) => {
    for (const id of new Set(ids))
      void ctx.scheduler.reconcile(id).then(
        () => ctx.scheduler.kick(id),
        () => {},
      );
  };
  app.get('/skills', async () => ({ skills: (await ctx.db.select().from(skills).orderBy(asc(skills.name))).map(serializeSkill) }));
  app.post('/skills/import', { ...admin, bodyLimit: 16_000 }, async (request, reply) => {
    const body = parse(importSkillsBody, request.body);
    // Sources are remote. Local paths would expose files on the backend host.
    if (!/^(?:https:\/\/[^\s]+|git@[A-Za-z0-9.-]+:[^\s]+|[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.@/-]*)$/.test(body.source))
      throw badRequest('Use owner/repo, an HTTPS URL or a Git SSH URL');
    if (body.source.startsWith('https://')) {
      const url = new URL(body.source);
      if (url.username || url.password) throw badRequest('Do not include credentials in the skill source');
    }
    const imported = await importSkills(body.source, body.skills);
    const result = await ctx.db.transaction(async (tx) => {
      const updated = [];
      for (const skill of imported) {
        const [existing] = await tx.select().from(skills).where(eq(skills.name, skill.name)).for('update');
        if (existing && existing.source !== body.source) throw conflict(`Skill ${skill.name} already exists from another source`);
        const [row] = existing
          ? await tx
              .update(skills)
              .set({ ...skill, updatedAt: new Date() })
              .where(eq(skills.id, existing.id))
              .returning()
          : await tx
              .insert(skills)
              .values({ ...skill, source: body.source })
              .returning();
        updated.push(row!);
      }
      const assigned = await tx
        .select({ id: agentSkills.agentId })
        .from(agentSkills)
        .where(
          inArray(
            agentSkills.skillId,
            updated.map((s) => s.id),
          ),
        );
      const ids = assigned.map((r) => r.id);
      await invalidateExtensions(tx, ids);
      return { skills: updated.map(serializeSkill), ids };
    });
    sync(result.ids);
    return reply.status(201).send({ skills: result.skills });
  });
  app.delete('/skills/:id', admin, async (request, reply) => {
    const { id } = parse(params, request.params);
    await ctx.db.transaction(async (tx) => {
      const [assigned] = await tx.select().from(agentSkills).where(eq(agentSkills.skillId, id));
      if (assigned) throw conflict('Unassign this skill from all agents before deleting it');
      if (!(await tx.delete(skills).where(eq(skills.id, id)).returning()).length) throw notFound('Skill');
    });
    return reply.status(204).send();
  });

  app.get('/mcp-servers', admin, async () => ({
    mcpServers: (await ctx.db.select().from(mcpServers).orderBy(asc(mcpServers.name))).map(serializeMcp),
  }));
  app.post('/mcp-servers', admin, async (request, reply) => {
    const body = parse(saveMcpServerBody, request.body);
    const [row] = await ctx.db
      .insert(mcpServers)
      .values({ ...body, headers: storeMcpValues(ctx, body.headers), env: storeMcpValues(ctx, body.env) })
      .returning();
    return reply.status(201).send({ mcpServer: serializeMcp(row!) });
  });
  app.put('/mcp-servers/:id', admin, async (request) => {
    const { id } = parse(params, request.params);
    const body = parse(saveMcpServerBody, request.body);
    const result = await ctx.db.transaction(async (tx) => {
      const [before] = await tx.select().from(mcpServers).where(eq(mcpServers.id, id)).for('update');
      if (!before) throw notFound('MCP server');
      const [row] = await tx
        .update(mcpServers)
        .set({
          ...body,
          headers: storeMcpValues(ctx, body.headers, before.headers),
          env: storeMcpValues(ctx, body.env, before.env),
          updatedAt: new Date(),
        })
        .where(eq(mcpServers.id, id))
        .returning();
      const assigned = await tx.select({ id: agentMcpServers.agentId }).from(agentMcpServers).where(eq(agentMcpServers.mcpServerId, id));
      const ids = assigned.map((r) => r.id);
      await invalidateExtensions(tx, ids);
      return { row: row!, ids };
    });
    sync(result.ids);
    return { mcpServer: serializeMcp(result.row) };
  });
  app.delete('/mcp-servers/:id', admin, async (request, reply) => {
    const { id } = parse(params, request.params);
    await ctx.db.transaction(async (tx) => {
      const [assigned] = await tx.select().from(agentMcpServers).where(eq(agentMcpServers.mcpServerId, id));
      if (assigned) throw conflict('Unassign this MCP server from all agents before deleting it');
      if (!(await tx.delete(mcpServers).where(eq(mcpServers.id, id)).returning()).length) throw notFound('MCP server');
    });
    return reply.status(204).send();
  });
}
