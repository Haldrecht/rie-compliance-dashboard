import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { requireCustomer } from '@/lib/tenant';
import { billingConfig, BillingConfigError, stripeGateway } from '@/lib/billing/stripe';
import { CheckoutError, createCheckoutForCompany } from '@/lib/billing/checkout';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST /api/billing/checkout — start a Stripe Checkout for the caller's own organization.
// Organization and customer come from the session; nothing in the request body selects them.
export async function POST(request: NextRequest) {
  const guard = await requireCustomer(request, { requireEntitlement: false });
  if (!guard.ok) return guard.response;
  const { ctx } = guard;
  try {
    const config = billingConfig();
    const user = await prisma.user.findUnique({ where: { id: ctx.userId }, select: { email: true } });
    const result = await createCheckoutForCompany(prisma, stripeGateway(config.secretKey), config, {
      companyId: ctx.companyId,
      userId: ctx.userId,
      email: user?.email ?? '',
      alreadyEntitled: ctx.entitlement.entitled,
    });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof CheckoutError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    if (error instanceof BillingConfigError) {
      console.error('Billing not configured:', error.message);
      return NextResponse.json({ error: 'Betalen is tijdelijk niet beschikbaar', code: 'billing_unavailable' }, { status: 503 });
    }
    console.error('Checkout failed:', (error as Error).message);
    return NextResponse.json({ error: 'Checkout kon niet worden gestart', code: 'checkout_failed' }, { status: 502 });
  }
}
