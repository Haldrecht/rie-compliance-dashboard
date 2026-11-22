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
  return prisma.$transaction(async (tx) => {
    const current = await tx.subscription.findUnique({ where: { companyId } });
    if (current && current.syncedAt > version) return 'stale' as const;
    // A late event about an old, ended subscription must not displace the organization's live one.
    const liveStatuses = ['ACTIVE', 'TRIALING', 'PAST_DUE'];
    const terminal = ['CANCELED', 'INCOMPLETE_EXPIRED', 'INCOMPLETE'].includes(data.status);
    if (current && current.stripeSubscriptionId !== sub.id && liveStatuses.includes(current.status) && terminal) {
      return 'stale' as const;
    }
    // Otherwise a newer subscription replacing a canceled one (re-purchase) takes over the organization's row.
    if (current) {
      await tx.subscription.update({ where: { companyId }, data });
    } else {
      await tx.subscription.create({ data: { companyId, ...data } });
    }
    if (customerId) {
      await tx.company.updateMany({ where: { id: companyId, stripeCustomerId: null }, data: { stripeCustomerId: customerId } });
    }
    return 'applied' as const;
  });
}
