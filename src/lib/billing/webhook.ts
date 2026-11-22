import type Stripe from 'stripe';
import type { PrismaClient } from '@prisma/client';
import { applySubscription, type SyncOutcome } from './sync';
import type { StripeGateway } from './stripe';

// Stripe webhook processing.
//
// - Signature is verified by the route before this runs.
// - Duplicate delivery: an event id already recorded in stripe_events is acknowledged without work.
// - Out-of-order delivery: the event payload is treated only as a hint; the subscription is re-fetched
//   from Stripe and applied with a version check (see sync.ts), so order does not matter.
// - Failure: any thrown error propagates so the route answers 5xx and Stripe retries. The event is
//   recorded only after its effects are committed, so a retry re-runs the (idempotent) work.

export interface WebhookResult {
  status: 'processed' | 'duplicate' | 'ignored';
  detail?: string;
}

const SUBSCRIPTION_EVENTS = new Set([
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'customer.subscription.paused',
  'customer.subscription.resumed',
]);

function idOf(value: string | { id: string } | null | undefined): string | null {
  if (!value) return null;
  return typeof value === 'string' ? value : value.id;
}

/** Subscription id on an invoice: `invoice.subscription` (older APIs) or `parent.subscription_details` (2025+). */
function invoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
  const legacy = idOf((invoice as unknown as { subscription?: string | { id: string } | null }).subscription);
  if (legacy) return legacy;
  const parent = (invoice as unknown as { parent?: { subscription_details?: { subscription?: string | { id: string } } } }).parent;
  return idOf(parent?.subscription_details?.subscription ?? null);
}

async function syncById(prisma: PrismaClient, stripe: StripeGateway, subscriptionId: string, now: () => number): Promise<SyncOutcome> {
  const fresh = await stripe.subscriptions.retrieve(subscriptionId);
  return applySubscription(prisma, fresh as Stripe.Subscription, now());
}

export async function processStripeEvent(
  prisma: PrismaClient,
  stripe: StripeGateway,
  event: Stripe.Event,
  now: () => number = () => Math.floor(Date.now() / 1000),
): Promise<WebhookResult> {
  const seen = await prisma.stripeEvent.findUnique({ where: { id: event.id }, select: { id: true } });
  if (seen) return { status: 'duplicate' };

  let result: WebhookResult;
  if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
    const session = event.data.object as Stripe.Checkout.Session;
    const companyId = session.client_reference_id || session.metadata?.companyId || null;
    const customerId = idOf(session.customer);
    const subscriptionId = idOf(session.subscription);
    if (!companyId || session.mode !== 'subscription' || !subscriptionId) {
      result = { status: 'ignored', detail: 'not an RI&E subscription checkout' };
    } else {
      const company = await prisma.company.findUnique({ where: { id: companyId }, select: { id: true, stripeCustomerId: true } });
      if (!company) {
        result = { status: 'ignored', detail: 'unknown organization' };
      } else if (company.stripeCustomerId && customerId && company.stripeCustomerId !== customerId) {
        // Never let a checkout for a different Stripe customer take over an organization.
        result = { status: 'ignored', detail: 'customer does not match organization' };
      } else {
        if (customerId && !company.stripeCustomerId) {
          await prisma.company.update({ where: { id: company.id }, data: { stripeCustomerId: customerId } });
        }
        const outcome = await syncById(prisma, stripe, subscriptionId, now);
        result = outcome === 'unmatched' ? { status: 'ignored', detail: 'subscription not linked' } : { status: 'processed', detail: outcome };
      }
    }
  } else if (SUBSCRIPTION_EVENTS.has(event.type)) {
    const sub = event.data.object as Stripe.Subscription;
    const outcome = await syncById(prisma, stripe, sub.id, now);
    result = outcome === 'unmatched' ? { status: 'ignored', detail: 'unknown organization' } : { status: 'processed', detail: outcome };
  } else if (event.type === 'invoice.paid' || event.type === 'invoice.payment_failed' || event.type === 'invoice.payment_action_required') {
    const subscriptionId = invoiceSubscriptionId(event.data.object as Stripe.Invoice);
    if (!subscriptionId) {
      result = { status: 'ignored', detail: 'invoice without subscription' };
    } else {
      const outcome = await syncById(prisma, stripe, subscriptionId, now);
      result = outcome === 'unmatched' ? { status: 'ignored', detail: 'unknown organization' } : { status: 'processed', detail: outcome };
    }
  } else {
    result = { status: 'ignored', detail: 'event type not handled' };
  }

  try {
    await prisma.stripeEvent.create({
      data: { id: event.id, type: event.type, outcome: result.status, detail: result.detail ?? null },
    });
  } catch (error) {
    // A concurrent delivery of the same event recorded it first; the work above is idempotent.
    if ((error as { code?: string }).code !== 'P2002') throw error;
    return { status: 'duplicate' };
  }
  return result;
}
