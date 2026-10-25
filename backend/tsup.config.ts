import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/main.ts', 'src/cli.ts'],
  format: 'esm',
  platform: 'node',
  target: 'node22',
  // The shared package ships TypeScript sources, so bundle it in.
  noExternal: ['@claude-task/shared'],
  clean: true,
});
