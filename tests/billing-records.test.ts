import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import { POST as register } from '@/app/api/auth/register/route';
import { POST as checkout } from '@/app/api/billing/checkout/route';
import { POST as webhook } from '@/app/api/billing/webhook/route';
import { GET as invoicesRoute } from '@/app/api/billing/invoices/route';
import { POST as portal } from '@/app/api/billing/portal/route';
import { GET as health } from '@/app/api/health/route';
import { installFakeStripe, req, resetDb } from './helpers/app';
import { signedEvent, type FakeStripe } from './helpers/fake-stripe';

let stripe: FakeStripe;

beforeEach(async () => {
  await resetDb();
  stripe = installFakeStripe();
});

function send(type: string, object: unknown, opts: { id?: string } = {}) {
  const { payload, header } = signedEvent(type, object, opts);
  return webhook(req('POST', '/api/billing/webhook', { raw: payload, headers: { 'stripe-signature': header } }));
}

async function signedUp(email: string) {
  const reg = await (await register(req('POST', '/api/auth/register', { body: { email, name: 'Test Klant', password: 'password-123', companyName: `Org ${email}` } }))).json();
  return { token: reg.token as string, companyId: reg.user.companyId as string };
}

async function paid(email: string) {
  const c = await signedUp(email);
  const { sessionId } = await (await checkout(req('POST', '/api/billing/checkout', { token: c.token }))).json();
  const { session, sub } = stripe.completeCheckout(sessionId);
  expect((await send('checkout.session.completed', session)).status).toBe(200);
  return { ...c, sub };
}

describe('invoice records', () => {
  it('records the paid invoice and shows it only to its own organization', async () => {
    const a = await paid('a@invoice.test');
    const b = await paid('b@invoice.test');
    const inv = stripe.invoice(a.sub.id);
    const res = await send('invoice.paid', inv);
    expect(res.status).toBe(200);

    const listA = (await (await invoicesRoute(req('GET', '/api/billing/invoices', { token: a.token }))).json()).invoices;
    expect(listA).toHaveLength(1);
    expect(listA[0]).toMatchObject({
      number: inv.number,
      status: 'paid',
      currency: 'eur',
      subtotal: 49900,
      tax: 10479,
      total: 60379,
      amountPaid: 60379,
      invoicePdf: inv.invoice_pdf,
    });
    const listB = (await (await invoicesRoute(req('GET', '/api/billing/invoices', { token: b.token }))).json()).invoices;
    expect(listB).toHaveLength(0);
    const stored = await prisma.invoice.findUniqueOrThrow({ where: { stripeInvoiceId: inv.id } });
    expect(stored.companyId).toBe(a.companyId);
  });

  it('ignores the payload and re-reads the invoice from Stripe (a forged amount is not stored)', async () => {
    const a = await paid('forge@invoice.test');
    const inv = stripe.invoice(a.sub.id);
    await send('invoice.paid', { ...inv, total: 1, amount_paid: 1 });
    expect((await prisma.invoice.findUniqueOrThrow({ where: { stripeInvoiceId: inv.id } })).total).toBe(60379);
  });

  it('skips drafts, which have no number yet', async () => {
    const a = await paid('draft@invoice.test');
    const inv = stripe.invoice(a.sub.id, { status: 'draft', number: null });
    await send('invoice.finalized', inv);
    expect(await prisma.invoice.count()).toBe(0);
  });

  it('keeps invoices visible to a lapsed customer', async () => {
    const a = await paid('lapsed@invoice.test');
    await send('invoice.paid', stripe.invoice(a.sub.id));
    stripe.setSubscription(a.sub.id, { status: 'canceled' });
    await send('customer.subscription.deleted', { id: a.sub.id });
    const res = await invoicesRoute(req('GET', '/api/billing/invoices', { token: a.token }));
    expect(res.status).toBe(200);
    expect((await res.json()).invoices).toHaveLength(1);
  });
});

describe('billing portal', () => {
  it('opens the Stripe portal for the organization\'s own customer', async () => {
    const a = await paid('portal@billing.test');
    const res = await portal(req('POST', '/api/billing/portal', { token: a.token }));
    expect(res.status).toBe(200);
    const customer = (await prisma.company.findUniqueOrThrow({ where: { id: a.companyId } })).stripeCustomerId;
    expect((await res.json()).url).toBe(`https://billing.stripe.test/p/session/${customer}`);
  });

  it('refuses when the organization never started a payment', async () => {
    const c = await signedUp('nopay@billing.test');
    const res = await portal(req('POST', '/api/billing/portal', { token: c.token }));
    expect(res.status).toBe(409);
  });
});

describe('concurrent webhook delivery', () => {
  it('handles the same event delivered 8 times at once: one subscription row, one ledger entry, no errors', async () => {
    const c = await signedUp('burst@concurrency.test');
    const { sessionId } = await (await checkout(req('POST', '/api/billing/checkout', { token: c.token }))).json();
    const { session } = stripe.completeCheckout(sessionId);
    const { payload, header } = signedEvent('checkout.session.completed', session, { id: 'evt_burst' });
    const results = await Promise.all(
      Array.from({ length: 8 }, () => webhook(req('POST', '/api/billing/webhook', { raw: payload, headers: { 'stripe-signature': header } }))),
    );
    expect(results.map((r) => r.status)).toEqual(Array(8).fill(200));
    const outcomes = await Promise.all(results.map((r) => r.json()));
    expect(outcomes.filter((o) => o.status === 'processed').length).toBeGreaterThanOrEqual(1);
    expect(await prisma.subscription.count({ where: { companyId: c.companyId } })).toBe(1);
    expect(await prisma.stripeEvent.count({ where: { id: 'evt_burst' } })).toBe(1);
    expect((await prisma.subscription.findFirstOrThrow()).status).toBe('ACTIVE');
  });

  it('handles different events for one subscription arriving simultaneously', async () => {
    const c = await signedUp('mix@concurrency.test');
    const { sessionId } = await (await checkout(req('POST', '/api/billing/checkout', { token: c.token }))).json();
    const { session, sub } = stripe.completeCheckout(sessionId);
    const inv = stripe.invoice(sub.id);
    const results = await Promise.all([
      send('customer.subscription.created', sub),
      send('checkout.session.completed', session),
      send('invoice.paid', inv),
      send('customer.subscription.updated', sub),
      send('invoice.finalized', inv),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    expect(await prisma.subscription.count()).toBe(1);
    expect(await prisma.invoice.count()).toBe(1);
    expect(await prisma.stripeEvent.count()).toBe(5);
  });
});

describe('health', () => {
  it('reports only up/down', async () => {
    const res = await health();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(['database', 'status', 'timestamp']);
    expect(body).toMatchObject({ status: 'ok', database: 'up' });
  });
});

describe('paid-but-no-access recovery', () => {
  it('grants access from /billing status when the webhook was lost and the customer never returned', async () => {
    const c = await signedUp('lost@recovery.test');
    const { sessionId } = await (await checkout(req('POST', '/api/billing/checkout', { token: c.token }))).json();
    stripe.completeCheckout(sessionId); // paid at Stripe; no webhook delivered, no return to the success page
    const { GET: status } = await import('@/app/api/billing/status/route');
    const body = await (await status(req('GET', '/api/billing/status', { token: c.token }))).json();
    expect(body).toMatchObject({ entitled: true, reconcile: 'customer:applied' });
    expect(stripe.calls).toContain('subscriptions.list');
  });

  it('refuses a second purchase when Stripe already has an active subscription for the organization', async () => {
    const c = await signedUp('twice@recovery.test');
    const first = await (await checkout(req('POST', '/api/billing/checkout', { token: c.token }))).json();
    stripe.completeCheckout(first.sessionId); // webhook lost
    const sessionsBefore = stripe.sessions.size;
    const again = await checkout(req('POST', '/api/billing/checkout', { token: c.token }));
    expect(again.status).toBe(409);
    expect((await again.json()).code).toBe('already_subscribed');
    expect(stripe.sessions.size).toBe(sessionsBefore); // no new checkout session created
    expect((await prisma.subscription.findFirstOrThrow({ where: { companyId: c.companyId } })).status).toBe('ACTIVE');
  });

  it('allows a new purchase after cancellation (re-purchase is not blocked by the old subscription)', async () => {
    const a = await paid('again@recovery.test');
    stripe.setSubscription(a.sub.id, { status: 'canceled' });
    await send('customer.subscription.deleted', { id: a.sub.id });
    const res = await checkout(req('POST', '/api/billing/checkout', { token: a.token }));
    expect(res.status).toBe(200);
  });

  it('does not reach other organizations: recovery only lists the caller\'s own Stripe customer', async () => {
    const a = await paid('owner@recovery.test');
    const b = await signedUp('other@recovery.test');
    stripe.calls.length = 0;
    const { GET: status } = await import('@/app/api/billing/status/route');
    const body = await (await status(req('GET', '/api/billing/status', { token: b.token }))).json();
    expect(body.entitled).toBe(false);
    // b has no Stripe customer yet, so nothing is listed at all.
    expect(stripe.calls).not.toContain('subscriptions.list');
    expect(await prisma.subscription.count({ where: { companyId: b.companyId } })).toBe(0);
    expect(await prisma.subscription.count({ where: { companyId: a.companyId } })).toBe(1);
  });
});
