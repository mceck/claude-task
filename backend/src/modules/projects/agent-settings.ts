import { importEnvBody, parseDotenv, putEnvVarBody, updateAgentSettingsBody, ENV_VAR_NAME, ENV_VALUE_MAX, RESERVED_ENV_NAME } from '@claude-task/shared';
import type { ProjectAgentSettings, ProjectEnvVar } from '@claude-task/shared';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../context';
import type { Executor } from '../../db/client';
import { agents, projectEnvVars, projects } from '../../db/schema';
import { badRequest, notFound, parse } from '../../errors';
import { last4 } from '../../secrets';
import { getBoardProject } from './service';
import { idOrKey } from '../../ids';

const projectParams = z.object({ projectId: idOrKey });
const envParams = z.object({ projectId: idOrKey, name: z.string().regex(ENV_VAR_NAME) });

/** Names the platform sets itself; a Project can't override them. */
const RESERVED = RESERVED_ENV_NAME;
const MAX_IMPORT = 500;
const MAX_VALUE = ENV_VALUE_MAX;

function serializeEnvVar(r: typeof projectEnvVars.$inferSelect): ProjectEnvVar {
  return { id: r.id, name: r.name, secret: r.secret, value: r.secret ? null : r.value, last4: r.secret ? r.last4 : null };
}

async function loadSettings(db: Executor, projectId: string): Promise<ProjectAgentSettings> {
  const [p] = await db.select().from(projects).where(eq(projects.id, projectId));
  const env = await db.select().from(projectEnvVars).where(eq(projectEnvVars.projectId, projectId)).orderBy(asc(projectEnvVars.name));
  return { setupScript: p!.setupScript, agentInstructions: p!.agentInstructions, defaultAgentId: p!.defaultAgentId, autoResume: p!.autoResume, env: env.map(serializeEnvVar) };
}

/** The Project's "Agents" settings: Setup Script, Agent Instructions (members), env vars and secrets (admins). */
export function agentSettingsRoutes(app: FastifyInstance, ctx: AppContext): void {
  const admin = { config: { auth: 'admin' as const } };

  app.get('/projects/:projectId/agent-settings', async (request) => {
    const { projectId } = parse(projectParams, request.params);
    const project = await getBoardProject(ctx.db, projectId);
    return { settings: await loadSettings(ctx.db, project.id) };
  });

  app.patch('/projects/:projectId/agent-settings', async (request) => {
    const { projectId } = parse(projectParams, request.params);
    const body = parse(updateAgentSettingsBody, request.body);
    const project = await getBoardProject(ctx.db, projectId);
    if (body.defaultAgentId) {
      const [found] = await ctx.db.select({ id: agents.id }).from(agents).where(eq(agents.id, body.defaultAgentId));
      if (!found) throw badRequest('Unknown agent');
    }
    await ctx.db.update(projects).set({ ...body, updatedAt: new Date() }).where(eq(projects.id, project.id));
    return { settings: await loadSettings(ctx.db, project.id) };
  });

  const storedValue = (value: string, secret: boolean) =>
    secret
      ? { secret: true, value: null, valueCiphertext: ctx.config.secrets.encrypt(value), last4: last4(value) }
      : { secret: false, value, valueCiphertext: null, last4: null };

  app.put('/projects/:projectId/env/:name', admin, async (request) => {
    const { projectId, name } = parse(envParams, request.params);
    const body = parse(putEnvVarBody, { ...(request.body as object), name });
    if (RESERVED.test(body.name)) throw badRequest(`${body.name} is set by the platform`);
    const project = await getBoardProject(ctx.db, projectId);
    const values = storedValue(body.value, body.secret);
    await ctx.db
      .insert(projectEnvVars)
      .values({ projectId: project.id, name: body.name, ...values })
      .onConflictDoUpdate({ target: [projectEnvVars.projectId, projectEnvVars.name], set: { ...values, updatedAt: new Date() } });
    return { settings: await loadSettings(ctx.db, project.id) };
  });

  /** Merges a `.env` file into the Project's variables. A secret stays secret even when re-imported as plain. */
  app.post('/projects/:projectId/env/import', admin, async (request) => {
    const { projectId } = parse(projectParams, request.params);
    const body = parse(importEnvBody, request.body);
    const parsed = parseDotenv(body.content);
    if (!parsed.ok) throw badRequest(`Invalid .env file: ${parsed.errors.slice(0, 5).join('; ')}`, { errors: parsed.errors });
    const { entries } = parsed;
    if (entries.length === 0) throw badRequest('The .env file defines no variables');
    if (entries.length > MAX_IMPORT) throw badRequest(`A .env import can define at most ${MAX_IMPORT} variables`);
    const reserved = entries.filter((e) => RESERVED.test(e.name)).map((e) => e.name);
    if (reserved.length) throw badRequest(`Set by the platform: ${reserved.join(', ')}`);
    const tooLong = entries.filter((e) => e.value.length > MAX_VALUE).map((e) => e.name);
    if (tooLong.length) throw badRequest(`Values longer than ${MAX_VALUE} characters: ${tooLong.join(', ')}`);
    const project = await getBoardProject(ctx.db, projectId);
    await ctx.db.transaction(async (tx) => {
      const existing = await tx.select({ name: projectEnvVars.name, secret: projectEnvVars.secret }).from(projectEnvVars).where(eq(projectEnvVars.projectId, project.id));
      const secretNames = new Set(existing.filter((r) => r.secret).map((r) => r.name));
      const rows = entries.map((e) => ({ projectId: project.id, name: e.name, ...storedValue(e.value, body.secret || secretNames.has(e.name)) }));
      await tx
        .insert(projectEnvVars)
        .values(rows)
        .onConflictDoUpdate({
          target: [projectEnvVars.projectId, projectEnvVars.name],
          set: {
            secret: sql`excluded.secret`,
            value: sql`excluded.value`,
            valueCiphertext: sql`excluded.value_ciphertext`,
            last4: sql`excluded.last4`,
            updatedAt: new Date(),
          },
        });
    });
    return { settings: await loadSettings(ctx.db, project.id) };
  });

  app.delete('/projects/:projectId/env/:name', admin, async (request) => {
    const { projectId, name } = parse(envParams, request.params);
    const project = await getBoardProject(ctx.db, projectId);
    const removed = await ctx.db
      .delete(projectEnvVars)
      .where(and(eq(projectEnvVars.projectId, project.id), eq(projectEnvVars.name, name)))
      .returning();
    if (removed.length === 0) throw notFound('Variable');
    return { settings: await loadSettings(ctx.db, project.id) };
  });
}
