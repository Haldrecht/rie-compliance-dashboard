import type Stripe from 'stripe';
import type { PrismaClient } from '@prisma/client';

// Stores the organization's Stripe invoices so customers can see what they paid for.
// Stripe stays the source of truth: webhooks re-fetch the invoice and this applies it with the same
// version guard as subscriptions, so duplicate or out-of-order deliveries cannot regress it.

function idOf(value: string | { id: string } | null | undefined): string | null {
  if (!value) return null;
  return typeof value === 'string' ? value : value.id;
}

const date = (seconds: number | null | undefined) => (typeof seconds === 'number' && seconds > 0 ? new Date(seconds * 1000) : null);

/** Subscription id on an invoice: `invoice.subscription` (older APIs) or `parent.subscription_details` (2025+). */
export function invoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
  const legacy = idOf((invoice as unknown as { subscription?: string | { id: string } | null }).subscription);
  if (legacy) return legacy;
  const parent = (invoice as unknown as { parent?: { subscription_details?: { subscription?: string | { id: string } } } }).parent;
  return idOf(parent?.subscription_details?.subscription ?? null);
}

/** Tax total: `total_taxes` (2025+) or the legacy `tax` field. */
function taxOf(invoice: Stripe.Invoice): number {
  const totals = (invoice as unknown as { total_taxes?: Array<{ amount: number }> | null }).total_taxes;
  if (Array.isArray(totals)) return totals.reduce((sum, t) => sum + (t.amount ?? 0), 0);
  return (invoice as unknown as { tax?: number | null }).tax ?? 0;
}

async function companyForInvoice(prisma: PrismaClient, invoice: Stripe.Invoice): Promise<string | null> {
  const customerId = idOf(invoice.customer as string | { id: string } | null);
  if (customerId) {
    const company = await prisma.company.findUnique({ where: { stripeCustomerId: customerId }, select: { id: true } });
    if (company) return company.id;
  }
  const subscriptionId = invoiceSubscriptionId(invoice);
  if (subscriptionId) {
    const sub = await prisma.subscription.findUnique({ where: { stripeSubscriptionId: subscriptionId }, select: { companyId: true } });
    if (sub) return sub.companyId;
  }
  return null;
}

export async function applyInvoice(prisma: PrismaClient, invoice: Stripe.Invoice, version: number): Promise<'applied' | 'stale' | 'unmatched' | 'skipped'> {
  if (!invoice.id || invoice.status === 'draft') return 'skipped'; // drafts have no number and may still change
  const companyId = await companyForInvoice(prisma, invoice);
  if (!companyId) return 'unmatched';
  const transitions = (invoice.status_transitions ?? {}) as { finalized_at?: number | null; paid_at?: number | null };
  const data = {
    companyId,
    stripeSubscriptionId: invoiceSubscriptionId(invoice),
    number: invoice.number ?? null,
    status: invoice.status ?? 'open',
    currency: invoice.currency,
    subtotal: invoice.subtotal ?? 0,
    tax: taxOf(invoice),
    total: invoice.total ?? 0,
    amountDue: invoice.amount_due ?? 0,
    amountPaid: invoice.amount_paid ?? 0,
    hostedInvoiceUrl: invoice.hosted_invoice_url ?? null,
    invoicePdf: invoice.invoice_pdf ?? null,
    periodStart: date(invoice.period_start),
    periodEnd: date(invoice.period_end),
    issuedAt: date(transitions.finalized_at) ?? date(invoice.created),
    paidAt: date(transitions.paid_at),
    syncedAt: version,
  };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const updated = await prisma.invoice.updateMany({ where: { stripeInvoiceId: invoice.id, syncedAt: { lte: version } }, data });
    if (updated.count === 1) return 'applied';
    if (await prisma.invoice.count({ where: { stripeInvoiceId: invoice.id } })) return 'stale';
    try {
      await prisma.invoice.create({ data: { stripeInvoiceId: invoice.id, ...data } });
      return 'applied';
    } catch (error) {
      if ((error as { code?: string }).code !== 'P2002') throw error;
    }
  }
  throw new Error(`Could not apply invoice ${invoice.id} after concurrent updates`);
}
