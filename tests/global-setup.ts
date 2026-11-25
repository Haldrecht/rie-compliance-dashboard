import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
export const TEST_DIR = path.join(root, 'node_modules', '.prisma-test');

// Derive a SQLite schema from the production Postgres schema so tests exercise the real models.
export default function setup() {
  mkdirSync(TEST_DIR, { recursive: true });
  const source = readFileSync(path.join(root, 'prisma', 'schema.postgres.prisma'), 'utf8');
  // TEST_DATABASE_URL=postgresql://... runs the suite on Postgres (CI and concurrency evidence);
  // otherwise a throwaway SQLite file is used. Either way the models come from the production schema.
  const postgresUrl = process.env.TEST_DATABASE_URL;
  const schema = source
    .replace(/generator client \{[\s\S]*?\}/, `generator client {\n  provider = "prisma-client-js"\n  output   = "${path.join(TEST_DIR, 'client')}"\n}`)
    .replace(/datasource db \{[\s\S]*?\}/, `datasource db {\n  provider = "${postgresUrl ? 'postgresql' : 'sqlite'}"\n  url      = env("DATABASE_URL")\n}`);
  const schemaPath = path.join(TEST_DIR, 'schema.prisma');
  writeFileSync(schemaPath, schema);
  const dbPath = path.join(TEST_DIR, 'test.db');
  rmSync(dbPath, { force: true });
  const env = { ...process.env, DATABASE_URL: postgresUrl || `file:${dbPath}`, PRISMA_HIDE_UPDATE_MESSAGE: '1' };
  const prisma = path.join(root, 'node_modules', '.bin', 'prisma');
  execFileSync(prisma, ['generate', '--schema', schemaPath], { env, stdio: 'pipe' });
  execFileSync(prisma, ['db', 'push', '--schema', schemaPath, '--skip-generate'], { env, stdio: 'pipe' });
}
