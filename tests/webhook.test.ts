import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import { POST as register } from '@/app/api/auth/register/route';
import { POST as checkout } from '@/app/api/billing/checkout/route';
import { POST as webhook } from '@/app/api/billing/webhook/route';
import { POST as legacyWebhook } from '@/app/api/payment/webhook/route';
import { GET as dashboard } from '@/app/api/dashboard/route';
import { GET as billingStatus } from '@/app/api/billing/status/route';
import { installFakeStripe, req, resetDb } from './helpers/app';
import { signedEvent, type FakeStripe } from './helpers/fake-stripe';

let stripe: FakeStripe;

beforeEach(async () => {
  await resetDb();
  stripe = installFakeStripe();
});

async function deliver(type: string, object: unknown, opts: { id?: string; created?: number; secret?: string; handler?: typeof webhook } = {}) {
  const { payload, header, event } = signedEvent(type, object, opts);
  const res = await (opts.handler ?? webhook)(req('POST', '/api/billing/webhook', { raw: payload, headers: { 'stripe-signature': header } }));
  return { res, event, body: await res.json() };
}

/** A registered, paid customer. */
async function paidCustomer(email = 'klant@synthetisch.test') {
  const reg = await (await register(req('POST', '/api/auth/register', { body: { email, name: 'Klant Test', password: 'password-123', companyName: `Org ${email}` } }))).json();
  const { sessionId } = await (await checkout(req('POST', '/api/billing/checkout', { token: reg.token }))).json();
  const { session, sub } = stripe.completeCheckout(sessionId);
  const done = await deliver('checkout.session.completed', session);
  expect(done.body.status).toBe('processed');
  return { token: reg.token as string, companyId: reg.user.companyId as string, sub, session };
}

async function access(token: string) {
  return (await dashboard(req('GET', '/api/dashboard', { token }))).status;
}

describe('webhook security', () => {
  it('rejects a payload with an invalid signature and changes nothing', async () => {
    const { payload } = signedEvent('checkout.session.completed', { id: 'cs_x' });
    const forged = signedEvent('checkout.session.completed', { id: 'cs_x' }, { secret: 'whsec_attacker' });
    const res = await webhook(req('POST', '/api/billing/webhook', { raw: payload, headers: { 'stripe-signature': forged.header } }));
    expect(res.status).toBe(400);
    expect(await prisma.stripeEvent.count()).toBe(0);
  });

  it('rejects a missing signature', async () => {
    const res = await webhook(req('POST', '/api/billing/webhook', { raw: '{}' }));
    expect(res.status).toBe(400);
  });

  it('answers 503 (Stripe retries) when the webhook secret is not configured', async () => {
    const saved = process.env.STRIPE_WEBHOOK_SECRET;
    delete process.env.STRIPE_WEBHOOK_SECRET;
    try {
      const res = await webhook(req('POST', '/api/billing/webhook', { raw: '{}', headers: { 'stripe-signature': 't=1,v1=x' } }));
      expect(res.status).toBe(503);
    } finally {
      process.env.STRIPE_WEBHOOK_SECRET = saved;
    }
  });

  it('keeps the legacy /api/payment/webhook path working with the same verification', async () => {
    const { token, sub } = await paidCustomer();
    stripe.setSubscription(sub.id, { status: 'canceled' });
    const { body } = await deliver('customer.subscription.deleted', { id: sub.id }, { handler: legacyWebhook });
    expect(body.status).toBe('processed');
    expect(await access(token)).toBe(402);
  });

  it('ignores a checkout that would attach a different Stripe customer to an organization', async () => {
    const { companyId } = await paidCustomer();
    const hijack = { id: 'cs_test_hijack', object: 'checkout.session', mode: 'subscription', client_reference_id: companyId, customer: 'cus_attacker', subscription: 'sub_attacker', metadata: {} };
    const { body } = await deliver('checkout.session.completed', hijack);
    expect(body).toMatchObject({ status: 'ignored', detail: 'customer does not match organization' });
  });

  it('ignores a checkout for an unknown organization without failing (no endless retries)', async () => {
    const { res, body } = await deliver('checkout.session.completed', { id: 'cs_test_unknown', mode: 'subscription', client_reference_id: 'no-such-org', customer: 'cus_x', subscription: 'sub_x', metadata: {} });
    expect(res.status).toBe(200);
    expect(body.status).toBe('ignored');
  });
});

describe('idempotency and ordering', () => {
  it('processes a duplicate delivery of the same event only once', async () => {
    const { session } = await paidCustomer();
    const first = signedEvent('checkout.session.completed', session, { id: 'evt_dup_1' });
    const r1 = await webhook(req('POST', '/api/billing/webhook', { raw: first.payload, headers: { 'stripe-signature': first.header } }));
    const r2 = await webhook(req('POST', '/api/billing/webhook', { raw: first.payload, headers: { 'stripe-signature': first.header } }));
    expect((await r1.json()).status).toBe('processed');
    expect((await r2.json()).status).toBe('duplicate');
    expect(await prisma.subscription.count()).toBe(1);
    expect(await prisma.stripeEvent.count({ where: { id: 'evt_dup_1' } })).toBe(1);
  });

  it('is not rolled back by an older event delivered after a cancellation', async () => {
    const { token, sub } = await paidCustomer();
    // Customer cancels; Stripe delivers the deletion first ...
    stripe.setSubscription(sub.id, { status: 'canceled' });
    await deliver('customer.subscription.deleted', { id: sub.id, status: 'canceled' }, { created: 2000 });
    expect(await access(token)).toBe(402);
    // ... and a stale "updated: active" event from earlier arrives late. The app re-reads Stripe.
    const late = await deliver('customer.subscription.updated', { id: sub.id, status: 'active' }, { created: 1000 });
    expect(late.res.status).toBe(200);
    expect(await access(token)).toBe(402);
    expect((await prisma.subscription.findFirst())?.status).toBe('CANCELED');
  });

  it('does not let a late event about an old subscription displace a re-purchased one', async () => {
    const { token, sub: oldSub } = await paidCustomer();
    stripe.setSubscription(oldSub.id, { status: 'canceled' });
    await deliver('customer.subscription.deleted', { id: oldSub.id });
    expect(await access(token)).toBe(402);

    // Re-purchase.
    const { sessionId } = await (await checkout(req('POST', '/api/billing/checkout', { token }))).json();
    const { session, sub: newSub } = stripe.completeCheckout(sessionId);
    await deliver('checkout.session.completed', session);
    expect(await access(token)).toBe(200);
    expect((await prisma.subscription.findFirst())?.stripeSubscriptionId).toBe(newSub.id);

    // A redelivered event about the old, canceled subscription arrives afterwards.
    const late = await deliver('customer.subscription.updated', { id: oldSub.id });
    expect(late.body.detail).toBe('stale');
    expect(await access(token)).toBe(200);
  });

  it('answers 500 so Stripe retries when Stripe cannot be reached, and succeeds on retry', async () => {
    const { token, sub } = await paidCustomer();
    stripe.setSubscription(sub.id, { status: 'canceled' });
    const gateway = stripe.gateway();
    const original = gateway.subscriptions.retrieve;
    let failures = 1;
    const { setStripeGatewayForTests } = await import('@/lib/billing/stripe');
    setStripeGatewayForTests({ ...gateway, subscriptions: { list: gateway.subscriptions.list, retrieve: (async (...args: Parameters<typeof original>) => {
      if (failures-- > 0) throw new Error('connection reset');
      return original(...args);
    }) as typeof original } });

    const event = signedEvent('customer.subscription.deleted', { id: sub.id }, { id: 'evt_retry_1' });
    const send = () => webhook(req('POST', '/api/billing/webhook', { raw: event.payload, headers: { 'stripe-signature': event.header } }));
    const first = await send();
    expect(first.status).toBe(500);
    expect(await prisma.stripeEvent.count({ where: { id: 'evt_retry_1' } })).toBe(0); // not marked done
    expect(await access(token)).toBe(200); // state unchanged by the failed attempt

    const retry = await send();
    expect(retry.status).toBe(200);
    expect(await access(token)).toBe(402);
  });
});

describe('failed payments, renewals and cancellation', () => {
  it('keeps access during the past-due grace period, then removes it', async () => {
    const { token, sub } = await paidCustomer();
    // Renewal fails; the paid period just ended. Stripe marks it past_due and retries the card.
    const justEnded = Math.floor(Date.now() / 1000) - 3600;
    stripe.setSubscription(sub.id, { status: 'past_due', periodEnd: justEnded });
    await deliver('invoice.payment_failed', stripe.invoice(sub.id, { id: 'in_1', status: 'open', amount_paid: 0, status_transitions: { finalized_at: justEnded, paid_at: null } }));
    const inGrace = await (await billingStatus(req('GET', '/api/billing/status', { token }))).json();
    expect(inGrace).toMatchObject({ entitled: true, reason: 'subscription_past_due_grace' });

    // Retries keep failing past the grace window (period ended 8 days ago).
    stripe.setSubscription(sub.id, { status: 'past_due', periodEnd: Math.floor(Date.now() / 1000) - 8 * 86400 });
    await deliver('invoice.payment_failed', stripe.invoice(sub.id, { id: 'in_1' }));
    expect(await access(token)).toBe(402);

    // The card is updated and the retry succeeds: access returns.
    stripe.setSubscription(sub.id, { status: 'active', periodEnd: Math.floor(Date.now() / 1000) + 365 * 86400 });
    await deliver('invoice.paid', stripe.invoice(sub.id, { id: 'in_1', status: 'paid', amount_paid: 60379, status_transitions: { finalized_at: justEnded, paid_at: Math.floor(Date.now() / 1000) } }));
    const paidInvoice = await prisma.invoice.findUniqueOrThrow({ where: { stripeInvoiceId: 'in_1' } });
    expect(paidInvoice).toMatchObject({ status: 'paid', amountPaid: 60379 });
    expect(await access(token)).toBe(200);
  });

  it('removes access when Stripe gives up (unpaid)', async () => {
    const { token, sub } = await paidCustomer();
    stripe.setSubscription(sub.id, { status: 'unpaid' });
    await deliver('customer.subscription.updated', { id: sub.id });
    const status = await (await billingStatus(req('GET', '/api/billing/status', { token }))).json();
    expect(status).toMatchObject({ entitled: false, reason: 'payment_failed' });
  });

  it('keeps access until period end when the customer cancels at period end', async () => {
    const { token, sub } = await paidCustomer();
    stripe.setSubscription(sub.id, { cancel_at_period_end: true });
    await deliver('customer.subscription.updated', { id: sub.id });
    const status = await (await billingStatus(req('GET', '/api/billing/status', { token }))).json();
    expect(status).toMatchObject({ entitled: true, subscription: { cancelAtPeriodEnd: true } });

    stripe.setSubscription(sub.id, { status: 'canceled' });
    await deliver('customer.subscription.deleted', { id: sub.id });
    expect(await access(token)).toBe(402);
  });

  it('does not grant access for an incomplete subscription (payment requires action)', async () => {
    const reg = await (await register(req('POST', '/api/auth/register', { body: { email: 'sca@test.example', name: 'SCA Test', password: 'password-123', companyName: 'SCA BV' } }))).json();
    const { sessionId } = await (await checkout(req('POST', '/api/billing/checkout', { token: reg.token }))).json();
    const { session } = stripe.completeCheckout(sessionId, 'incomplete');
    await deliver('checkout.session.completed', session);
    const status = await (await billingStatus(req('GET', '/api/billing/status', { token: reg.token }))).json();
    expect(status).toMatchObject({ entitled: false, reason: 'payment_pending' });
  });
});
