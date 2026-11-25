import { defineConfig } from 'vitest/config';
import path from 'node:path';

// Tests run against a real SQLite database whose Prisma client is generated from the production
// schema (prisma/schema.postgres.prisma) by tests/global-setup.ts. `@prisma/client` is aliased to it.
export default defineConfig({
  resolve: {
    alias: {
      '@prisma/client': path.resolve(__dirname, 'node_modules/.prisma-test/client'),
      '@': path.resolve(__dirname, 'src'),
    },
  },
  test: {
    environment: 'node',
    globalSetup: ['tests/global-setup.ts'],
    setupFiles: ['tests/setup-env.ts'],
    include: ['tests/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 20000,
  },
});
