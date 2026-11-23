import type Stripe from 'stripe';
import type { PrismaClient } from '@prisma/client';
import { fromStripeStatus } from './entitlement';

// Applies a Stripe Subscription object to the organization's stored entitlement.
//
// Idempotent and order-safe: it is keyed by company, and a snapshot whose version is older than
// the stored one is ignored, so duplicate or out-of-order webhook deliveries cannot roll state back.
// Callers pass the freshest object they can (webhooks re-fetch it from Stripe before applying).

export type SyncOutcome = 'applied' | 'stale' | 'unmatched';

function idOf(value: string | { id: string } | null | undefined): string | null {
  if (!value) return null;
  return typeof value === 'string' ? value : value.id;
}

/** Period end lives on the subscription (API <= 2025-02) or on its items (2025-03 "basil" and later). */
export function periodEndOf(sub: Stripe.Subscription): Date | null {
  const top = (sub as unknown as { current_period_end?: number }).current_period_end;
  const fromItems = sub.items?.data?.map((i) => (i as unknown as { current_period_end?: number }).current_period_end)
    .filter((v): v is number => typeof v === 'number');
  const seconds = typeof top === 'number' ? top : fromItems?.length ? Math.max(...fromItems) : null;
  return seconds === null ? null : new Date(seconds * 1000);
}

/** Find the organization a subscription belongs to: metadata first, then the stored Stripe customer. */
export async function companyForSubscription(prisma: PrismaClient, sub: Stripe.Subscription): Promise<string | null> {
  const fromMeta = sub.metadata?.companyId;
  if (fromMeta) {
    const company = await prisma.company.findUnique({ where: { id: fromMeta }, select: { id: true } });
    if (company) return company.id;
  }
  const customerId = idOf(sub.customer);
  if (customerId) {
    const company = await prisma.company.findUnique({ where: { stripeCustomerId: customerId }, select: { id: true } });
    if (company) return company.id;
  }
  const existing = await prisma.subscription.findUnique({ where: { stripeSubscriptionId: sub.id }, select: { companyId: true } });
  return existing?.companyId ?? null;
}

export async function applySubscription(
  prisma: PrismaClient,
  sub: Stripe.Subscription,
  version: number,
): Promise<SyncOutcome> {
  const companyId = await companyForSubscription(prisma, sub);
  if (!companyId) return 'unmatched';
  const customerId = idOf(sub.customer) ?? '';
  const data = {
    stripeSubscriptionId: sub.id,
    stripeCustomerId: customerId,
    stripePriceId: sub.items?.data?.[0]?.price?.id ?? null,
    status: fromStripeStatus(sub.status),
    currentPeriodEnd: periodEndOf(sub),
    cancelAtPeriodEnd: !!sub.cancel_at_period_end,
    syncedAt: version,
  };

  // Lock-free and safe under concurrent delivery: every write is a single conditional statement,
  // so there is no read-then-write window.
  //  - not older than what is stored (out-of-order snapshots are dropped);
  //  - an ended subscription never displaces a different, live one (late events after a re-purchase).
  const terminal = ['CANCELED', 'INCOMPLETE_EXPIRED', 'INCOMPLETE'].includes(data.status);
  const guard = {
    companyId,
    syncedAt: { lte: version },
    ...(terminal ? { OR: [{ stripeSubscriptionId: sub.id }, { status: { notIn: ['ACTIVE', 'TRIALING', 'PAST_DUE'] as const } }] } : {}),
  };

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const updated = await prisma.subscription.updateMany({ where: guard as never, data });
    if (updated.count === 1) return linkCustomer(prisma, companyId, customerId);
    const exists = await prisma.subscription.count({ where: { companyId } });
    if (exists) return 'stale';
    try {
      await prisma.subscription.create({ data: { companyId, ...data } });
      return linkCustomer(prisma, companyId, customerId);
    } catch (error) {
      // Unique violation: another delivery created the row (or this subscription id is held by a row
      // being replaced) between our statements. Re-evaluate against the row that won.
      if ((error as { code?: string }).code !== 'P2002') throw error;
    }
  }
  throw new Error(`Could not apply subscription ${sub.id} after concurrent updates`);
}

async function linkCustomer(prisma: PrismaClient, companyId: string, customerId: string): Promise<SyncOutcome> {
  if (customerId) {
    await prisma.company.updateMany({ where: { id: companyId, stripeCustomerId: null }, data: { stripeCustomerId: customerId } });
  }
  return 'applied';
}
