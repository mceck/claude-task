// Task Tools: the MCP server (Streamable HTTP, stateless) an Agent's `claude` reaches with its
// Job token. Every mutation is a Revision attributed to the Agent. Each request builds the server
// for its Job, offering only the tools that can work there: the tool list is the contract, and
// a tool that always fails would only cost the model a call and some context.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context';
import { openPullRequest } from '../git/service';
import { registerAgentTools } from './agents';
import { registerConversationTools } from './conversation';
import { registerGlobalTools } from './global';
import { jobScope } from './scope';
import type { JobScope } from './scope';
import { registerTaskTools } from './tasks';
import { run } from './tool';

function buildServer(ctx: AppContext, scope: JobScope): McpServer {
  const server = new McpServer({ name: 'claude-task', version: '1.0.0' });
  // Wiki and Schedule Projects keep the tools of their own Task, whatever the switch says.
  const boardWrites = scope.boardWriteAccess && scope.projectKind === 'project';

  registerTaskTools(server, ctx, scope, { boardWrites });
  registerConversationTools(server, ctx, scope);
  if (boardWrites) registerAgentTools(server, ctx, scope);
  if (scope.schedule?.global) registerGlobalTools(server, ctx, scope);

  // A read-only Schedule has every push refused, so there is never a branch to open a pull request from.
  if (scope.hasRepository && !scope.schedule?.readOnly) {
    server.registerTool(
      'open_pull_request',
      {
        description:
          'Open the pull request (a merge request on GitLab) from your task branch to the base branch, or update it when it exists. Commit and push the branch first. Write the body for a reviewer: what changed, why, how you verified it, what is left. It never changes the task status.',
        inputSchema: {
          title: z.string().trim().min(1).max(500),
          body: z.string().max(100_000).describe('Markdown; a link to the task is appended'),
          draft: z.boolean().optional().describe('Open it as a draft (default false)'),
        },
      },
      (args) => run(ctx, () => openPullRequest(ctx, scope, args)),
    );
  }
  return server;
}

export function mcpRoutes(app: FastifyInstance, ctx: AppContext): void {
  const config = { auth: 'public' as const, csrf: false };

  app.post('/mcp', { config }, async (request, reply) => {
    const scope = await jobScope(ctx, request);
    const server = buildServer(ctx, scope);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    reply.raw.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    reply.hijack();
    await transport.handleRequest(request.raw, reply.raw, request.body);
  });

  // Stateless server: no server-initiated stream and no sessions to end.
  const notAllowed = async (_request: FastifyRequest, reply: FastifyReply) =>
    reply.status(405).header('allow', 'POST').send({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null });
  app.get('/mcp', { config }, notAllowed);
  app.delete('/mcp', { config }, notAllowed);
}
