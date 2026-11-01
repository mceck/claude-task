import { loadConfig } from './config';
import { backfillTurnContexts } from './projection/backfill';
import { createServer } from './server';

const config = loadConfig();
const server = await createServer(config);
await server.app.listen({ host: config.host, port: config.port });

// Conversations from before Context Usage existed get their chip without waiting for a new Turn.
// It runs after the port opens, so a long history never delays the backend becoming ready.
void backfillTurnContexts(server.ctx.db, server.app.log).catch((err) => server.app.log.warn({ err }, 'Context Usage backfill failed'));

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    server.app.log.info({ signal }, 'shutting down');
    server.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
}
