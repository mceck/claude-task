import { loadConfig } from './config';
import { createServer } from './server';

const config = loadConfig();
const server = await createServer(config);
await server.app.listen({ host: config.host, port: config.port });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    server.app.log.info({ signal }, 'shutting down');
    server.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
}
