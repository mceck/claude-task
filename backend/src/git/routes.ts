import { githubAppBody, repositoryBody } from '@claude-task/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context';
import { parse } from '../errors';
import { githubSettings, saveGitHubSettings } from './configuration';
import { linkRepository, recheckProtection, repositorySettings } from './service';

const params = z.object({ id: z.string().min(1).max(64) });
export function gitRoutes(app: FastifyInstance, ctx: AppContext) {
  const admin = { config: { auth: 'admin' as const } };
  app.get('/git/github', admin, async () => ({ settings: await githubSettings(ctx.db, ctx.config) }));
  app.put('/git/github', admin, async (request) => {
    await saveGitHubSettings(ctx.db, ctx.config, parse(githubAppBody, request.body));
    return { settings: await githubSettings(ctx.db, ctx.config) };
  });
  app.get('/git/installations', admin, async () => ({ installations: await ctx.git.listInstallations() }));
  app.get('/git/repositories', async () => ({
    configured: await ctx.git.isConfigured(),
    repositories: (await ctx.git.isConfigured()) ? await ctx.git.listAccessibleRepositories() : [],
  }));
  app.get('/projects/:id/repository', async (request) => {
    const { id } = parse(params, request.params);
    return repositorySettings(ctx.db, id);
  });
  app.put('/projects/:id/repository', async (request) => {
    const { id } = parse(params, request.params);
    await linkRepository(ctx, id, parse(repositoryBody, request.body));
    return repositorySettings(ctx.db, id);
  });
  app.post('/projects/:id/repository/check-protection', async (request) => {
    const { id } = parse(params, request.params);
    await recheckProtection(ctx, id);
    return repositorySettings(ctx.db, id);
  });
}
