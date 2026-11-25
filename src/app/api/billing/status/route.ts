import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { requireCustomer, loadEntitlement } from '@/lib/tenant';
import { billingConfig, stripeGateway } from '@/lib/billing/stripe';
import { reconcileCheckoutSession, reconcileCustomer } from '@/lib/billing/checkout';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET /api/billing/status[?session_id=cs_...] — the organization's entitlement.
// With session_id (the Checkout return), the session is reconciled from Stripe first, so access is
// granted even if the webhook has not arrived yet.
export async function GET(request: NextRequest) {
  const guard = await requireCustomer(request, { requireEntitlement: false });
  if (!guard.ok) return guard.response;
  const { ctx } = guard;

  const sessionId = request.nextUrl.searchParams.get('session_id');
  let reconcile: string | undefined;
  if (!ctx.entitlement.entitled && !sessionId) {
    // Paid-but-no-access recovery without a session id (closed tab, other device, lost webhook).
    try {
      const config = billingConfig();
      const recovered = await reconcileCustomer(prisma, stripeGateway(config.secretKey), ctx.companyId);
      if (recovered !== 'none') reconcile = `customer:${recovered}`;
    } catch (error) {
      console.error('Customer reconciliation failed:', (error as Error).message);
    }
  }
  if (sessionId && !ctx.entitlement.entitled) {
    try {
      const config = billingConfig();
      reconcile = await reconcileCheckoutSession(prisma, stripeGateway(config.secretKey), ctx.companyId, sessionId);
    } catch (error) {
      console.error('Checkout reconciliation failed:', (error as Error).message);
      reconcile = 'error';
    }
  }

  const loaded = await loadEntitlement(ctx.userId);
  const company = await prisma.company.findUnique({ where: { id: ctx.companyId }, select: { stripeCustomerId: true } });
  const subscription = loaded?.subscription ?? null;
  return NextResponse.json({
    entitled: loaded?.entitlement.entitled ?? false,
    reason: loaded?.entitlement.reason ?? 'no_subscription',
    subscription: subscription && {
      status: subscription.status,
      currentPeriodEnd: subscription.currentPeriodEnd,
      cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
    },
    canManageBilling: !!company?.stripeCustomerId,
    ...(reconcile ? { reconcile } : {}),
  });
}
