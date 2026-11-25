#!/usr/bin/env node
// Reproducible Stripe TEST-MODE setup for the RI&E staging deployment. Idempotent: re-running reuses
// what exists. Refuses live keys. Never prints secrets.
//
//   STRIPE_SECRET_KEY=sk_test_... node scripts/stripe-sandbox-setup.mjs \
//     --origin https://<staging-host> --amount 49900 --secret-file ~/.config/haldrecht/staging-whsec
//
// Creates or reuses:
//   - Product "RI&E Compliance Dashboard" and a yearly EUR Price (lookup key rie_dashboard_yearly_eur)
//   - A Customer Portal configuration (card update, invoice history, cancel at period end)
//   - A webhook endpoint <origin>/api/billing/webhook with the events the app handles
// Prints the ids to put in the staging environment. A newly created webhook signing secret is written
// to --secret-file (mode 0600, must be outside the repository); it is shown by Stripe only once.

import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const LOOKUP_KEY = 'rie_dashboard_yearly_eur';
export const APP_TAG = 'rie-dashboard';
export const WEBHOOK_EVENTS = [
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'customer.subscription.paused',
  'customer.subscription.resumed',
  'invoice.finalized',
  'invoice.paid',
  'invoice.payment_failed',
  'invoice.payment_action_required',
  'invoice.voided',
  'invoice.marked_uncollectible',
];

export function assertTestKey(key) {
  if (!/^(sk|rk)_test_/.test(key ?? '')) throw new Error('STRIPE_SECRET_KEY must be a test-mode key (sk_test_/rk_test_). Live keys are refused.');
}

export function assertOrigin(origin) {
  const url = new URL(origin);
  if (url.protocol !== 'https:') throw new Error('--origin must be https (Stripe delivers webhooks to public https endpoints)');
  if (url.pathname !== '/' || url.search || url.hash) throw new Error('--origin must be a bare origin, e.g. https://staging.example');
  return url.origin;
}

/** Pure orchestration over an injected Stripe client, so it can be tested without network access. */
export async function setupSandbox(stripe, { origin, amount, currency = 'eur' }) {
  const result = { created: [], reused: [] };
  const note = (kind, what) => result[kind].push(what);

  // Product + Price (lookup key makes this idempotent).
  const prices = await stripe.prices.list({ lookup_keys: [LOOKUP_KEY], active: true, limit: 1 });
  let price = prices.data[0];
  if (price) {
    if (price.unit_amount !== amount || price.currency !== currency || price.recurring?.interval !== 'year') {
      throw new Error(`Existing price ${price.id} (${LOOKUP_KEY}) differs from the requested amount/currency/interval; archive it in Stripe or pass the existing amount.`);
    }
    note('reused', `price ${price.id}`);
  } else {
    const product = await stripe.products.create({
      name: 'RI&E Compliance Dashboard',
      description: 'Jaarabonnement per organisatie',
      metadata: { app: APP_TAG },
    });
    note('created', `product ${product.id}`);
    price = await stripe.prices.create({
      product: product.id,
      currency,
      unit_amount: amount,
      recurring: { interval: 'year' },
      lookup_key: LOOKUP_KEY,
      metadata: { app: APP_TAG },
    });
    note('created', `price ${price.id}`);
  }

  // Customer Portal configuration tagged for this app.
  const configs = await stripe.billingPortal.configurations.list({ active: true, limit: 100 });
  let portal = configs.data.find((c) => c.metadata?.app === APP_TAG);
  if (portal) {
    note('reused', `portal configuration ${portal.id}`);
  } else {
    portal = await stripe.billingPortal.configurations.create({
      business_profile: { headline: 'HALDRECHT RI&E Dashboard — abonnement beheren' },
      default_return_url: `${origin}/billing`,
      features: {
        invoice_history: { enabled: true },
        payment_method_update: { enabled: true },
        customer_update: { enabled: true, allowed_updates: ['email', 'address', 'tax_id', 'name'] },
        subscription_cancel: { enabled: true, mode: 'at_period_end' },
      },
      metadata: { app: APP_TAG },
    });
    note('created', `portal configuration ${portal.id}`);
  }

  // Webhook endpoint.
  const url = `${origin}/api/billing/webhook`;
  const endpoints = await stripe.webhookEndpoints.list({ limit: 100 });
  let endpoint = endpoints.data.find((e) => e.url === url);
  let newSecret = null;
  if (endpoint) {
    const missing = WEBHOOK_EVENTS.filter((e) => !endpoint.enabled_events.includes(e) && !endpoint.enabled_events.includes('*'));
    if (missing.length || endpoint.status !== 'enabled') {
      endpoint = await stripe.webhookEndpoints.update(endpoint.id, { enabled_events: WEBHOOK_EVENTS, disabled: false });
      note('reused', `webhook endpoint ${endpoint.id} (events updated)`);
    } else {
      note('reused', `webhook endpoint ${endpoint.id}`);
    }
  } else {
    endpoint = await stripe.webhookEndpoints.create({ url, enabled_events: WEBHOOK_EVENTS, description: 'RI&E staging', metadata: { app: APP_TAG } });
    newSecret = endpoint.secret ?? null;
    note('created', `webhook endpoint ${endpoint.id}`);
  }

  return {
    ...result,
    env: {
      STRIPE_PRICE_ID: price.id,
      STRIPE_PORTAL_CONFIGURATION_ID: portal.id,
      NEXT_PUBLIC_APP_URL: origin,
    },
    webhookEndpointId: endpoint.id,
    newWebhookSecret: newSecret,
  };
}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const key = process.env.STRIPE_SECRET_KEY;
  assertTestKey(key);
  const origin = assertOrigin(arg('origin') ?? '');
  const amount = Number(arg('amount'));
  if (!Number.isInteger(amount) || amount <= 0) throw new Error('--amount must be the yearly price in cents, e.g. 49900');
  const secretFile = arg('secret-file');
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  if (secretFile && path.resolve(secretFile).startsWith(repoRoot + path.sep)) throw new Error('--secret-file must be outside the repository');

  const { default: Stripe } = await import('stripe');
  const out = await setupSandbox(new Stripe(key), { origin, amount });

  if (out.newWebhookSecret) {
    if (!secretFile) {
      console.error('A new webhook endpoint was created but no --secret-file was given. Reveal its signing secret in the Stripe Dashboard (Developers → Webhooks) instead.');
    } else {
      if (existsSync(secretFile)) throw new Error(`${secretFile} exists; refusing to overwrite`);
      writeFileSync(secretFile, `${out.newWebhookSecret}\n`, { mode: 0o600 });
    }
  }
  const { newWebhookSecret, ...printable } = out;
  console.log(JSON.stringify({
    ...printable,
    webhookSecret: newWebhookSecret ? (secretFile ? `written to ${secretFile} (set it as STRIPE_WEBHOOK_SECRET)` : 'see Stripe Dashboard') : 'unchanged (existing endpoint keeps its secret)',
  }, null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
