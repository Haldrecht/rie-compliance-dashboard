/* eslint-disable @typescript-eslint/no-explicit-any -- in-memory Stripe double for script tests */
import { describe, expect, it } from 'vitest';
import { setupSandbox, assertTestKey, assertOrigin, LOOKUP_KEY, WEBHOOK_EVENTS } from '../scripts/stripe-sandbox-setup.mjs';
import { checkStagingEnv, probeOrigin } from '../scripts/staging-preflight.mjs';

// The sandbox scripts are exercised against an in-memory Stripe double; they have NOT been run
// against real Stripe (no test key available).

function fakeStripe() {
  const state = { products: [] as any[], prices: [] as any[], configs: [] as any[], endpoints: [] as any[], n: 0 };
  const id = (p: string) => `${p}_${++state.n}`;
  return {
    state,
    prices: {
      list: async ({ lookup_keys }: any) => ({ data: state.prices.filter((p) => lookup_keys.includes(p.lookup_key) && p.active) }),
      create: async (p: any) => { const price = { id: id('price'), active: true, ...p }; state.prices.push(price); return price; },
    },
    products: { create: async (p: any) => { const prod = { id: id('prod'), ...p }; state.products.push(prod); return prod; } },
    billingPortal: {
      configurations: {
        list: async () => ({ data: state.configs }),
        create: async (c: any) => { const cfg = { id: id('bpc'), active: true, ...c }; state.configs.push(cfg); return cfg; },
      },
    },
    webhookEndpoints: {
      list: async () => ({ data: state.endpoints }),
      create: async (e: any) => { const ep = { id: id('we'), status: 'enabled', secret: 'whsec_created_once', ...e }; state.endpoints.push(ep); return ep; },
      update: async (eid: string, patch: any) => { const ep = state.endpoints.find((e) => e.id === eid); Object.assign(ep, patch, { status: 'enabled' }); return ep; },
    },
  };
}

describe('stripe-sandbox-setup', () => {
  it('creates product, yearly EUR price, portal configuration and webhook endpoint', async () => {
    const stripe = fakeStripe();
    const out = await setupSandbox(stripe, { origin: 'https://staging.example', amount: 49900 });
    expect(stripe.state.prices[0]).toMatchObject({ currency: 'eur', unit_amount: 49900, recurring: { interval: 'year' }, lookup_key: LOOKUP_KEY });
    expect(stripe.state.configs[0].features.subscription_cancel).toEqual({ enabled: true, mode: 'at_period_end' });
    expect(stripe.state.endpoints[0]).toMatchObject({ url: 'https://staging.example/api/billing/webhook', enabled_events: WEBHOOK_EVENTS });
    expect(out.env).toEqual({ STRIPE_PRICE_ID: 'price_2', STRIPE_PORTAL_CONFIGURATION_ID: 'bpc_3', NEXT_PUBLIC_APP_URL: 'https://staging.example' });
    expect(out.newWebhookSecret).toBe('whsec_created_once');
  });

  it('is idempotent: a second run reuses everything and exposes no secret', async () => {
    const stripe = fakeStripe();
    await setupSandbox(stripe, { origin: 'https://staging.example', amount: 49900 });
    const again = await setupSandbox(stripe, { origin: 'https://staging.example', amount: 49900 });
    expect(again.created).toEqual([]);
    expect(stripe.state.prices).toHaveLength(1);
    expect(stripe.state.endpoints).toHaveLength(1);
    expect(again.newWebhookSecret).toBeNull();
  });

  it('refuses to silently change an existing price', async () => {
    const stripe = fakeStripe();
    await setupSandbox(stripe, { origin: 'https://staging.example', amount: 49900 });
    await expect(setupSandbox(stripe, { origin: 'https://staging.example', amount: 59900 })).rejects.toThrow(/differs/);
  });

  it('refuses live keys and non-https origins', () => {
    expect(() => assertTestKey('sk_live_x')).toThrow(/Live keys are refused/);
    expect(() => assertTestKey('sk_test_x')).not.toThrow();
    expect(() => assertOrigin('http://staging.example')).toThrow(/https/);
    expect(() => assertOrigin('https://staging.example/app')).toThrow(/bare origin/);
  });
});

describe('staging-preflight', () => {
  const good = {
    STRIPE_SECRET_KEY: 'sk_test_' + 'x'.repeat(24),
    STRIPE_WEBHOOK_SECRET: 'whsec_' + 'y'.repeat(32),
    STRIPE_PRICE_ID: 'price_ABC',
    DATABASE_URL: 'postgresql://u:p@staging-db.example:5432/rie_staging',
    STAGING_DATABASE_CONFIRMED: 'staging-db.example:5432/rie_staging',
    NEXT_PUBLIC_APP_URL: 'https://staging.example',
    JWT_SECRET: 'z'.repeat(40),
    PUBLIC_SIGNUP_ENABLED: 'true',
  };

  it('passes a correct staging configuration and never echoes secret values', () => {
    const { checks } = checkStagingEnv(good);
    expect(checks.filter((c: any) => !c.ok)).toEqual([]);
    const text = JSON.stringify(checks);
    expect(text).not.toContain('x'.repeat(24));
    expect(text).not.toContain('y'.repeat(32));
    expect(text).not.toContain('z'.repeat(40));
    expect(text).not.toContain(':p@');
  });

  it.each([
    ['live key', { STRIPE_SECRET_KEY: 'sk_live_abc' }],
    ['unconfirmed database', { STAGING_DATABASE_CONFIRMED: 'prod-db.example:5432/rie' }],
    ['http origin', { NEXT_PUBLIC_APP_URL: 'http://staging.example' }],
    ['short JWT secret', { JWT_SECRET: 'short' }],
    ['stand-in API base left on', { STRIPE_API_BASE: 'http://127.0.0.1:12211' }],
    ['demo mode', { NEXT_PUBLIC_DEMO_MODE: 'true' }],
    ['production database', { PRODUCTION_DATABASE_HOST: 'staging-db.example' }],
  ])('fails on %s', (_name, patch) => {
    const { checks } = checkStagingEnv({ ...good, ...patch });
    expect(checks.some((c: any) => !c.ok)).toBe(true);
  });

  it('probe flags deployment protection blocking the webhook', async () => {
    const responses: Record<string, { status: number; body?: unknown }> = {
      '/api/health': { status: 200, body: { database: 'up' } },
      '/api/auth/register': { status: 200, body: { enabled: true } },
      '/register': { status: 200 }, '/login': { status: 200 }, '/billing': { status: 200 },
      '/api/billing/webhook': { status: 401 },
    };
    const fetchImpl = (async (url: string) => {
      const r = responses[new URL(url).pathname];
      return { status: r.status, json: async () => r.body ?? {} };
    }) as unknown as typeof fetch;
    const checks = await probeOrigin('https://staging.example', fetchImpl);
    expect(checks.filter((c: any) => !c.ok).map((c: any) => c.name)).toEqual([
      'Unsigned webhook rejected by the app (400), not blocked by deployment protection (401/403)',
    ]);
  });
});
