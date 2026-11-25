// Access rules for the paid product. Pure functions: no I/O, so they are unit-tested directly.
//
// An organization is entitled when its Stripe subscription grants access. A user is entitled when they
// are a platform ADMIN, hold an active admin-provisioned License (the pre-existing manual channel), or
// belong to an entitled organization.

export type SubscriptionStatus =
  | 'INCOMPLETE'
  | 'INCOMPLETE_EXPIRED'
  | 'TRIALING'
  | 'ACTIVE'
  | 'PAST_DUE'
  | 'CANCELED'
  | 'UNPAID'
  | 'PAUSED';

export interface SubscriptionSnapshot {
  status: SubscriptionStatus;
  currentPeriodEnd: Date | null;
}

export interface LicenseSnapshot {
  status: string;
  expiresAt: Date | null;
}

export type EntitlementReason =
  | 'platform_admin'
  | 'license'
  | 'subscription_active'
  | 'subscription_past_due_grace'
  | 'no_subscription'
  | 'payment_pending'
  | 'payment_failed'
  | 'canceled'
  | 'paused';

export interface Entitlement {
  entitled: boolean;
  reason: EntitlementReason;
}

/**
 * Failed renewal policy: Stripe retries the card (Smart Retries) and keeps the subscription PAST_DUE.
 * Access continues until the paid period ends plus this grace; after that, or once Stripe gives up
 * (UNPAID / CANCELED), access stops. A successful retry returns the subscription to ACTIVE.
 */
export const PAST_DUE_GRACE_DAYS = 7;

export function subscriptionEntitlement(sub: SubscriptionSnapshot | null, now: Date = new Date()): Entitlement {
  if (!sub) return { entitled: false, reason: 'no_subscription' };
  switch (sub.status) {
    case 'ACTIVE':
    case 'TRIALING':
      return { entitled: true, reason: 'subscription_active' };
    case 'PAST_DUE': {
      if (!sub.currentPeriodEnd) return { entitled: false, reason: 'payment_failed' };
      const graceEnd = sub.currentPeriodEnd.getTime() + PAST_DUE_GRACE_DAYS * 86_400_000;
      return now.getTime() <= graceEnd
        ? { entitled: true, reason: 'subscription_past_due_grace' }
        : { entitled: false, reason: 'payment_failed' };
    }
    case 'INCOMPLETE':
      return { entitled: false, reason: 'payment_pending' };
    case 'UNPAID':
    case 'INCOMPLETE_EXPIRED':
      return { entitled: false, reason: 'payment_failed' };
    case 'PAUSED':
      return { entitled: false, reason: 'paused' };
    case 'CANCELED':
    default:
      return { entitled: false, reason: 'canceled' };
  }
}

export function licenseIsActive(license: LicenseSnapshot | null, now: Date = new Date()): boolean {
  return !!license && license.status === 'ACTIVE' && (!license.expiresAt || license.expiresAt.getTime() >= now.getTime());
}

export function userEntitlement(
  input: { role: string; license: LicenseSnapshot | null; subscription: SubscriptionSnapshot | null },
  now: Date = new Date(),
): Entitlement {
  if (input.role === 'ADMIN') return { entitled: true, reason: 'platform_admin' };
  if (licenseIsActive(input.license, now)) return { entitled: true, reason: 'license' };
  return subscriptionEntitlement(input.subscription, now);
}

/** Map a Stripe subscription status string onto the stored enum. Unknown values deny access. */
export function fromStripeStatus(status: string): SubscriptionStatus {
  const map: Record<string, SubscriptionStatus> = {
    incomplete: 'INCOMPLETE',
    incomplete_expired: 'INCOMPLETE_EXPIRED',
    trialing: 'TRIALING',
    active: 'ACTIVE',
    past_due: 'PAST_DUE',
    canceled: 'CANCELED',
    unpaid: 'UNPAID',
    paused: 'PAUSED',
  };
  return map[status] ?? 'CANCELED';
}
