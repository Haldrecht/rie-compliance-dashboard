import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { requireCustomer } from '@/lib/tenant';
import { billingConfig, BillingConfigError, stripeGateway } from '@/lib/billing/stripe';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST /api/billing/portal — Stripe Customer Portal for the caller's organization: update card,
// download invoices, cancel. Changes made there come back through the webhook.
export async function POST(request: NextRequest) {
  const guard = await requireCustomer(request, { requireEntitlement: false });
  if (!guard.ok) return guard.response;
  const company = await prisma.company.findUnique({ where: { id: guard.ctx.companyId }, select: { stripeCustomerId: true } });
  if (!company?.stripeCustomerId) {
    return NextResponse.json({ error: 'Er is nog geen betaling voor deze organisatie', code: 'no_billing_account' }, { status: 409 });
  }
  try {
    const config = billingConfig();
    const session = await stripeGateway(config.secretKey).billingPortal.sessions.create({
      customer: company.stripeCustomerId,
      return_url: `${config.appUrl}/billing`,
      locale: 'nl',
    });
    return NextResponse.json({ url: session.url });
  } catch (error) {
    if (error instanceof BillingConfigError) {
      console.error('Billing not configured:', error.message);
      return NextResponse.json({ error: 'Betalen is tijdelijk niet beschikbaar', code: 'billing_unavailable' }, { status: 503 });
    }
    console.error('Billing portal failed:', (error as Error).message);
    return NextResponse.json({ error: 'Abonnementsbeheer kon niet worden geopend', code: 'portal_failed' }, { status: 502 });
  }
}
