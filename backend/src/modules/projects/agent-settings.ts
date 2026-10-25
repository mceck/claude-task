import { putEnvVarBody, updateAgentSettingsBody, ENV_VAR_NAME } from '@claude-task/shared';
import type { ProjectAgentSettings, ProjectEnvVar } from '@claude-task/shared';
import { and, asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../context';
import type { Executor } from '../../db/client';
import { projectEnvVars, projects } from '../../db/schema';
import { badRequest, notFound, parse } from '../../errors';
import { last4 } from '../../secrets';
import { getProject } from './service';

const projectParams = z.object({ projectId: z.string().min(1).max(64) });
const envParams = z.object({ projectId: z.string().min(1).max(64), name: z.string().regex(ENV_VAR_NAME) });

/** Names the platform sets itself; a Project can't override them. */
const RESERVED = /^(CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY|CLAUDE_CODE_RESUME_INTERRUPTED_TURN|CLAUDE_TASK_.*|HOME|PATH|USER)$/;

function serializeEnvVar(r: typeof projectEnvVars.$inferSelect): ProjectEnvVar {
  return { id: r.id, name: r.name, secret: r.secret, value: r.secret ? null : r.value, last4: r.secret ? r.last4 : null };
}

async function loadSettings(db: Executor, projectId: string): Promise<ProjectAgentSettings> {
  const [p] = await db.select().from(projects).where(eq(projects.id, projectId));
  const env = await db.select().from(projectEnvVars).where(eq(projectEnvVars.projectId, projectId)).orderBy(asc(projectEnvVars.name));
  return { setupScript: p!.setupScript, agentInstructions: p!.agentInstructions, env: env.map(serializeEnvVar) };
}

/** The Project's "Agents" settings: Setup Script, Agent Instructions (members), env vars and secrets (admins). */
export function agentSettingsRoutes(app: FastifyInstance, ctx: AppContext): void {
  const admin = { config: { auth: 'admin' as const } };

  app.get('/projects/:projectId/agent-settings', async (request) => {
    const { projectId } = parse(projectParams, request.params);
    const project = await getProject(ctx.db, projectId);
    return { settings: await loadSettings(ctx.db, project.id) };
  });

  app.patch('/projects/:projectId/agent-settings', async (request) => {
    const { projectId } = parse(projectParams, request.params);
    const body = parse(updateAgentSettingsBody, request.body);
    const project = await getProject(ctx.db, projectId);
    await ctx.db.update(projects).set({ ...body, updatedAt: new Date() }).where(eq(projects.id, project.id));
    return { settings: await loadSettings(ctx.db, project.id) };
  });

  app.put('/projects/:projectId/env/:name', admin, async (request) => {
    const { projectId, name } = parse(envParams, request.params);
    const body = parse(putEnvVarBody, { ...(request.body as object), name });
    if (RESERVED.test(body.name)) throw badRequest(`${body.name} is set by the platform`);
    const project = await getProject(ctx.db, projectId);
    const values = body.secret
      ? { secret: true, value: null, valueCiphertext: ctx.config.secrets.encrypt(body.value), last4: last4(body.value) }
      : { secret: false, value: body.value, valueCiphertext: null, last4: null };
    await ctx.db
      .insert(projectEnvVars)
      .values({ projectId: project.id, name: body.name, ...values })
      .onConflictDoUpdate({ target: [projectEnvVars.projectId, projectEnvVars.name], set: { ...values, updatedAt: new Date() } });
    return { settings: await loadSettings(ctx.db, project.id) };
  });

  app.delete('/projects/:projectId/env/:name', admin, async (request) => {
    const { projectId, name } = parse(envParams, request.params);
    const project = await getProject(ctx.db, projectId);
    const removed = await ctx.db
      .delete(projectEnvVars)
      .where(and(eq(projectEnvVars.projectId, project.id), eq(projectEnvVars.name, name)))
      .returning();
    if (removed.length === 0) throw notFound('Variable');
    return { settings: await loadSettings(ctx.db, project.id) };
  });
}
