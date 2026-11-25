import type { PrismaClient } from '@prisma/client';
import type { StripeGateway, BillingConfig } from './stripe';
import { applySubscription } from './sync';

// Checkout and post-checkout reconciliation for the signed-in customer's organization.

export class CheckoutError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

/** One Stripe Customer per organization, created once (Stripe idempotency key guards concurrent calls). */
export async function ensureStripeCustomer(
  prisma: PrismaClient,
  stripe: StripeGateway,
  company: { id: string; name: string; stripeCustomerId: string | null },
  email: string,
): Promise<string> {
  if (company.stripeCustomerId) return company.stripeCustomerId;
  const customer = await stripe.customers.create(
    { name: company.name, email, metadata: { companyId: company.id } },
    { idempotencyKey: `rie-customer-${company.id}` },
  );
  // Only the first writer wins; a concurrent request re-reads the stored id.
  await prisma.company.updateMany({ where: { id: company.id, stripeCustomerId: null }, data: { stripeCustomerId: customer.id } });
  const stored = await prisma.company.findUnique({ where: { id: company.id }, select: { stripeCustomerId: true } });
  return stored?.stripeCustomerId ?? customer.id;
}

export async function createCheckoutForCompany(
  prisma: PrismaClient,
  stripe: StripeGateway,
  config: BillingConfig,
  input: { companyId: string; userId: string; email: string; alreadyEntitled: boolean },
): Promise<{ url: string; sessionId: string }> {
  if (input.alreadyEntitled) throw new CheckoutError(409, 'already_subscribed', 'Deze organisatie heeft al een actief abonnement');
  // A payment Stripe already has (webhook lost, customer never returned) must not be bought twice.
  const recovered = await reconcileCustomer(prisma, stripe, input.companyId);
  if (recovered === 'applied') {
    const sub = await prisma.subscription.findUnique({ where: { companyId: input.companyId }, select: { status: true } });
    if (sub && ['ACTIVE', 'TRIALING', 'PAST_DUE'].includes(sub.status)) {
      throw new CheckoutError(409, 'already_subscribed', 'Deze organisatie heeft al een actief abonnement');
    }
  }
  const company = await prisma.company.findUnique({
    where: { id: input.companyId },
    select: { id: true, name: true, stripeCustomerId: true },
  });
  if (!company) throw new CheckoutError(403, 'no_organization', 'Organisatie niet gevonden');
  const customerId = await ensureStripeCustomer(prisma, stripe, company, input.email);

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    client_reference_id: company.id,
    line_items: [{ price: config.priceId, quantity: 1 }],
    metadata: { companyId: company.id, userId: input.userId },
    subscription_data: { metadata: { companyId: company.id } },
    allow_promotion_codes: true,
    billing_address_collection: 'required',
    tax_id_collection: { enabled: true },
    customer_update: { name: 'auto', address: 'auto' },
    locale: 'nl',
    success_url: `${config.appUrl}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${config.appUrl}/billing?canceled=1`,
  });
  if (!session.url) throw new CheckoutError(502, 'checkout_unavailable', 'Stripe gaf geen checkout-URL terug');
  return { url: session.url, sessionId: session.id };
}

/**
 * Recovery path when the webhook is late or lost: the returning customer's checkout session is read
 * from Stripe and applied. Only a session that belongs to the caller's own organization is accepted.
 */
export async function reconcileCheckoutSession(
  prisma: PrismaClient,
  stripe: StripeGateway,
  companyId: string,
  sessionId: string,
  now: () => number = () => Math.floor(Date.now() / 1000),
): Promise<'applied' | 'pending' | 'foreign' | 'stale'> {
  if (!/^cs_[A-Za-z0-9_]+$/.test(sessionId)) return 'foreign';
  const session = await stripe.checkout.sessions.retrieve(sessionId);
  const owner = session.client_reference_id || session.metadata?.companyId;
  if (owner !== companyId) return 'foreign';
  const subscriptionId = typeof session.subscription === 'string' ? session.subscription : session.subscription?.id;
  if (session.status !== 'complete' || !subscriptionId) return 'pending';
  const sub = await stripe.subscriptions.retrieve(subscriptionId);
  const outcome = await applySubscription(prisma, sub, now());
  return outcome === 'unmatched' ? 'pending' : outcome;
}

const PRIORITY: Record<string, number> = { active: 0, trialing: 1, past_due: 2, unpaid: 3, paused: 4, incomplete: 5, canceled: 6, incomplete_expired: 7 };

/**
 * Paid-but-no-access recovery. When the organization is not entitled but already has a Stripe customer,
 * ask Stripe for that customer's subscriptions and apply the most relevant one. Covers a lost or
 * delayed webhook when the customer never came back through the success page (closed tab, other
 * device), and prevents a second purchase in that state. Only the organization's own customer is read.
 */
export async function reconcileCustomer(
  prisma: PrismaClient,
  stripe: StripeGateway,
  companyId: string,
  now: () => number = () => Math.floor(Date.now() / 1000),
): Promise<'applied' | 'stale' | 'none'> {
  const company = await prisma.company.findUnique({ where: { id: companyId }, select: { stripeCustomerId: true } });
  if (!company?.stripeCustomerId) return 'none';
  const list = await stripe.subscriptions.list({ customer: company.stripeCustomerId, status: 'all', limit: 20 });
  const candidates = list.data
    .filter((s) => (s.metadata?.companyId ?? companyId) === companyId)
    .sort((a, b) => (PRIORITY[a.status] ?? 9) - (PRIORITY[b.status] ?? 9) || b.created - a.created);
  if (!candidates.length) return 'none';
  const outcome = await applySubscription(prisma, candidates[0], now());
  return outcome === 'unmatched' ? 'none' : outcome;
}
