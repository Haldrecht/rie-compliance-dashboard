#!/usr/bin/env node
// Checks a staging configuration BEFORE a sandbox purchase. Prints only pass/fail and non-secret
// facts (key mode, host names), never values.
//
//   node --env-file=<staging env file outside the repo> scripts/staging-preflight.mjs [--probe]
//
// --probe also calls the deployed origin: health, signup flag, entry pages, and an unsigned webhook
// (must be rejected with 400 by the app, not 401/403 by deployment protection).

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FORBIDDEN_ON_STAGING = ['STRIPE_API_BASE', 'NEXT_PUBLIC_DEMO_MODE', 'STRIPE_ALLOW_LIVE'];

function hostOf(databaseUrl) {
  try {
    const u = new URL(databaseUrl);
    return `${u.hostname}${u.port ? `:${u.port}` : ''}/${u.pathname.replace(/^\//, '')}`;
  } catch {
    return null;
  }
}

/** Pure: returns [{name, ok, detail?}] for an environment object. */
export function checkStagingEnv(env) {
  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok: !!ok, ...(detail ? { detail } : {}) });

  const key = env.STRIPE_SECRET_KEY ?? '';
  check('STRIPE_SECRET_KEY is a test-mode key', /^(sk|rk)_test_/.test(key), key ? key.slice(0, key.indexOf('_', 3) + 1) + '…' : 'missing');
  check('STRIPE_WEBHOOK_SECRET is set (whsec_…)', /^whsec_.{16,}/.test(env.STRIPE_WEBHOOK_SECRET ?? ''));
  check('STRIPE_PRICE_ID is a Price id', /^price_[A-Za-z0-9]+$/.test(env.STRIPE_PRICE_ID ?? ''), env.STRIPE_PRICE_ID);
  check('STRIPE_PORTAL_CONFIGURATION_ID set (optional; else Stripe default portal)', true,
    /^bpc_/.test(env.STRIPE_PORTAL_CONFIGURATION_ID ?? '') ? env.STRIPE_PORTAL_CONFIGURATION_ID : 'not set: uses the account default portal');

  const dbHost = hostOf(env.DATABASE_URL ?? '');
  check('DATABASE_URL is a Postgres URL', dbHost && /^postgres(ql)?:/.test(env.DATABASE_URL), dbHost ?? 'missing/invalid');
  check('Database explicitly confirmed as staging (STAGING_DATABASE_CONFIRMED equals its host/db)',
    dbHost && env.STAGING_DATABASE_CONFIRMED === dbHost, `expected STAGING_DATABASE_CONFIRMED=${dbHost ?? '?'}`);
  if (env.PRODUCTION_DATABASE_HOST) {
    check('Database is not the production database', dbHost && !dbHost.startsWith(env.PRODUCTION_DATABASE_HOST));
  }

  let origin = null;
  try {
    const u = new URL(env.NEXT_PUBLIC_APP_URL ?? '');
    origin = u.protocol === 'https:' && u.pathname === '/' ? u.origin : null;
  } catch { /* invalid */ }
  check('NEXT_PUBLIC_APP_URL is a bare https origin', origin, env.NEXT_PUBLIC_APP_URL || 'missing');

  check('JWT_SECRET is set and at least 32 characters', (env.JWT_SECRET ?? '').length >= 32);
  check('PUBLIC_SIGNUP_ENABLED is "true"', env.PUBLIC_SIGNUP_ENABLED === 'true');
  for (const name of FORBIDDEN_ON_STAGING) check(`${name} is not set`, !env[name]);
  return { checks, origin };
}

export async function probeOrigin(origin, fetchImpl = fetch) {
  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok: !!ok, ...(detail ? { detail } : {}) });
  const get = async (p, init) => {
    try {
      return await fetchImpl(`${origin}${p}`, { redirect: 'manual', ...init });
    } catch (error) {
      return { status: 0, json: async () => ({}), error: String(error) };
    }
  };
  const health = await get('/api/health');
  const hb = await health.json().catch(() => ({}));
  check('GET /api/health → 200, database up', health.status === 200 && hb.database === 'up', `status ${health.status}`);
  const signup = await get('/api/auth/register');
  const sb = await signup.json().catch(() => ({}));
  check('GET /api/auth/register → {enabled: true}', signup.status === 200 && sb.enabled === true, `status ${signup.status}`);
  for (const p of ['/register', '/login', '/billing']) {
    const r = await get(p);
    check(`GET ${p} → 200`, r.status === 200, `status ${r.status}`);
  }
  const hook = await get('/api/billing/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=invalid' }, body: '{}' });
  check('Unsigned webhook rejected by the app (400), not blocked by deployment protection (401/403)', hook.status === 400, `status ${hook.status}`);
  return checks;
}

async function main() {
  const { checks, origin } = checkStagingEnv(process.env);
  if (process.argv.includes('--probe')) {
    if (origin) checks.push(...await probeOrigin(origin));
    else checks.push({ name: 'probe skipped: no valid origin', ok: false });
  }
  for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const ok = checks.every((c) => c.ok);
  console.log(ok ? '\nPreflight passed.' : '\nPreflight FAILED: fix the items above before any sandbox purchase.');
  process.exit(ok ? 0 : 1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
