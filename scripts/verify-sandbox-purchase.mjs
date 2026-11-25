#!/usr/bin/env node
// Independently verifies a real Stripe test-mode purchase made through the dashboard.
//
//   DATABASE_URL=postgresql://... STRIPE_SECRET_KEY=sk_test_... \
//     node scripts/verify-sandbox-purchase.mjs customer@example.test
//
// Reads the organization from the database and cross-checks it against Stripe's own records:
// customer, subscription, price, status and invoices. Prints JSON evidence without secrets.
// Read-only on both sides. Refuses live keys.

import pg from 'pg';
import Stripe from 'stripe';

const email = process.argv[2]?.toLowerCase();
const key = process.env.STRIPE_SECRET_KEY ?? '';
if (!email) {
  console.error('usage: node scripts/verify-sandbox-purchase.mjs <customer email>');
  process.exit(2);
}
if (!/^(sk|rk)_test_/.test(key)) {
  console.error('STRIPE_SECRET_KEY must be a test-mode key (sk_test_/rk_test_).');
  process.exit(2);
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required (staging database).');
  process.exit(2);
}

const stripe = new Stripe(key);
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok: !!ok, ...(detail === undefined ? {} : { detail }) });

try {
  const user = (await db.query('select id, "companyId", role from users where lower(email) = $1', [email])).rows[0];
  check('user exists', user);
  if (!user) throw new Error('stop');
  const companies = (await db.query('select id, name, "stripeCustomerId" from companies where id = $1', [user.companyId])).rows;
  check('user belongs to exactly one organization', companies.length === 1, { role: user.role });
  const company = companies[0];
  check('organization linked to a Stripe customer', company?.stripeCustomerId?.startsWith('cus_'), company?.stripeCustomerId);

  const customer = await stripe.customers.retrieve(company.stripeCustomerId);
  check('Stripe customer exists in test mode', !customer.deleted && customer.livemode === false);
  check('Stripe customer metadata points back to the organization', customer.metadata?.companyId === company.id);

  const sub = (await db.query('select * from subscriptions where "companyId" = $1', [company.id])).rows[0];
  check('subscription recorded', sub, sub && { status: sub.status, stripeSubscriptionId: sub.stripeSubscriptionId });
  if (sub) {
    const remote = await stripe.subscriptions.retrieve(sub.stripeSubscriptionId);
    check('subscription belongs to the same Stripe customer', remote.customer === company.stripeCustomerId);
    check('stored status matches Stripe', remote.status.toUpperCase() === sub.status, { stripe: remote.status, stored: sub.status });
    check('price is STRIPE_PRICE_ID', !process.env.STRIPE_PRICE_ID || remote.items.data[0]?.price.id === process.env.STRIPE_PRICE_ID, remote.items.data[0]?.price.id);
    check('subscription metadata points back to the organization', remote.metadata?.companyId === company.id);
  }

  const remoteInvoices = await stripe.invoices.list({ customer: company.stripeCustomerId, limit: 20 });
  const stored = (await db.query('select "stripeInvoiceId", status, total, "amountPaid", currency from invoices where "companyId" = $1', [company.id])).rows;
  const finalized = remoteInvoices.data.filter((i) => i.status !== 'draft');
  check('at least one paid invoice in Stripe', finalized.some((i) => i.status === 'paid'));
  for (const inv of finalized) {
    const row = stored.find((r) => r.stripeInvoiceId === inv.id);
    check(`invoice ${inv.number} recorded with matching amounts`, row && row.total === inv.total && row.amountPaid === inv.amount_paid && row.status === inv.status,
      { stripe: { status: inv.status, total: inv.total, paid: inv.amount_paid }, stored: row ?? null });
  }

  const events = (await db.query('select type, outcome, count(*)::int as n from stripe_events group by type, outcome order by type')).rows;
  check('webhooks were received and processed', events.some((e) => e.outcome === 'processed'), events);
} catch (error) {
  if (error.message !== 'stop') check('verification ran without errors', false, error.message);
} finally {
  await db.end();
}

const ok = checks.every((c) => c.ok);
console.log(JSON.stringify({ email, ok, checks }, null, 2));
process.exit(ok ? 0 : 1);
