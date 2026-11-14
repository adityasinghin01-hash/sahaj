import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(root, 'apps/api/src'),
      '@sahaj/gate': path.resolve(root, 'packages/gate/src/index.ts'),
      '@sahaj/atlas/postgres': path.resolve(root, 'packages/atlas/src/postgres.ts'),
      '@sahaj/atlas': path.resolve(root, 'packages/atlas/src/index.ts'),
      '@sahaj/adapters': path.resolve(root, 'packages/adapters/src/index.ts'),
    },
  },
  test: {
    include: ['tests/acceptance/phase5/*.test.ts'],
    environment: 'node',
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
