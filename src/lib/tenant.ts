import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getUserFromRequest } from '@/lib/auth';
import { userEntitlement, type Entitlement, type SubscriptionStatus } from '@/lib/billing/entitlement';

// Tenant guard for customer data routes.
//
// Membership is read from the database on every request, never from JWT claims, so a token minted
// before a user changed organization (or one without a companyId) cannot widen access. Every customer
// query must filter by `ctx.companyId`, which is always a non-empty string here.

export interface CustomerContext {
  userId: string;
  role: string;
  companyId: string;
  entitlement: Entitlement;
}

type GuardResult = { ok: true; ctx: CustomerContext } | { ok: false; response: NextResponse };

function deny(status: number, error: string, code: string): GuardResult {
  return { ok: false, response: NextResponse.json({ error, code }, { status }) };
}

export async function loadEntitlement(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      role: true,
      companyId: true,
      license: { select: { status: true, expiresAt: true } },
      company: { select: { subscription: { select: { status: true, currentPeriodEnd: true, cancelAtPeriodEnd: true } } } },
    },
  });
  if (!user) return null;
  const subscription = user.company?.subscription ?? null;
  const entitlement = userEntitlement({
    role: user.role,
    license: user.license,
    subscription: subscription ? { status: subscription.status as SubscriptionStatus, currentPeriodEnd: subscription.currentPeriodEnd } : null,
  });
  return { user, subscription, entitlement };
}

/**
 * Resolve the caller's organization. With `requireEntitlement` (the default) an organization without
 * a paid subscription or license gets 402 with code `subscription_required`.
 */
export async function requireCustomer(request: NextRequest, options: { requireEntitlement?: boolean } = {}): Promise<GuardResult> {
  const requireEntitlement = options.requireEntitlement ?? true;
  if (!prisma) return deny(503, 'Database niet geconfigureerd', 'database_unavailable');
  const claims = getUserFromRequest(request);
  if (!claims?.userId) return deny(401, 'Niet geautoriseerd', 'unauthorized');
  const loaded = await loadEntitlement(claims.userId);
  if (!loaded) return deny(401, 'Niet geautoriseerd', 'unauthorized');
  if (!loaded.user.companyId) return deny(403, 'Account is niet gekoppeld aan een organisatie', 'no_organization');
  if (requireEntitlement && !loaded.entitlement.entitled) {
    return deny(402, 'Een actief abonnement is vereist', 'subscription_required');
  }
  return {
    ok: true,
    ctx: { userId: loaded.user.id, role: loaded.user.role, companyId: loaded.user.companyId, entitlement: loaded.entitlement },
  };
}

type RouteContext = { params?: Promise<Record<string, string>> | Record<string, string> };

/**
 * Wrap a route handler with the tenant guard. The handler receives the customer context (whose
 * `companyId` is always set) and the resolved route params (Next.js 15 passes them as a Promise).
 */
export function withCustomer<P extends Record<string, string> = Record<string, string>>(
  handler: (request: NextRequest, customer: CustomerContext, context: { params: P }) => Promise<Response>,
) {
  return async (request: NextRequest, context?: RouteContext): Promise<Response> => {
    const guard = await requireCustomer(request);
    if (!guard.ok) return guard.response;
    const params = ((await context?.params) ?? {}) as P;
    return handler(request, guard.ctx, { params });
  };
}
