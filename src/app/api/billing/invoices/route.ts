import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { requireCustomer } from '@/lib/tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET /api/billing/invoices — the caller's organization's invoices, newest first. Available without
// an active subscription, so a lapsed customer can still see and pay what is open.
export async function GET(request: NextRequest) {
  const guard = await requireCustomer(request, { requireEntitlement: false });
  if (!guard.ok) return guard.response;
  const invoices = await prisma.invoice.findMany({
    where: { companyId: guard.ctx.companyId },
    orderBy: [{ issuedAt: 'desc' }, { createdAt: 'desc' }],
    take: 100,
    select: {
      id: true,
      number: true,
      status: true,
      currency: true,
      subtotal: true,
      tax: true,
      total: true,
      amountDue: true,
      amountPaid: true,
      hostedInvoiceUrl: true,
      invoicePdf: true,
      periodStart: true,
      periodEnd: true,
      issuedAt: true,
      paidAt: true,
    },
  });
  return NextResponse.json({ invoices });
}
