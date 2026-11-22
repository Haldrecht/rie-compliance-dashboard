import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { requireCustomer } from '@/lib/tenant';
import { riskRowsFromWizard, validateWizardPayload } from '@/lib/rie/assessment';

export const runtime = 'nodejs';

// GET /api/assessments — the caller's organization's assessments (newest first), for the report page.
export async function GET(request: NextRequest) {
  const guard = await requireCustomer(request);
  if (!guard.ok) return guard.response;
  const assessments = await prisma.assessment.findMany({
    where: { companyId: guard.ctx.companyId },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      title: true,
      status: true,
      version: true,
      startDate: true,
      createdAt: true,
      _count: { select: { risks: true } },
    },
  });
  return NextResponse.json({
    assessments: assessments.map(({ _count, ...a }: { _count: { risks: number } } & Record<string, unknown>) => ({ ...a, riskCount: _count.risks })),
  });
}

// POST /api/assessments — save a completed RI&E wizard for the caller's organization.
export async function POST(request: NextRequest) {
  const guard = await requireCustomer(request);
  if (!guard.ok) return guard.response;
  const { ctx } = guard;

  const body = await request.json().catch(() => null);
  const title = typeof body?.title === 'string' ? body.title.trim().slice(0, 300) : '';
  const rieData = body?.rieData;
  if (!title || !rieData) {
    return NextResponse.json({ error: 'Missing required fields: title, rieData' }, { status: 400 });
  }
  const invalid = validateWizardPayload(rieData);
  if (invalid) return NextResponse.json({ error: invalid }, { status: 400 });

  const startDate = body?.startDate ? new Date(body.startDate) : new Date();
  if (Number.isNaN(startDate.getTime())) return NextResponse.json({ error: 'Ongeldige startdatum' }, { status: 400 });

  const rows = riskRowsFromWizard(rieData);
  try {
    const assessment = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const created = await tx.assessment.create({
        data: {
          companyId: ctx.companyId,
          assessorId: ctx.userId,
          title,
          description: Array.isArray(rieData.goalAndScope?.goals) ? rieData.goalAndScope.goals.join(', ').slice(0, 500) : null,
          rieData,
          status: 'COMPLETED',
          version: 1,
          startDate,
        },
      });
      for (const row of rows) {
        await tx.risk.create({
          data: {
            assessmentId: created.id,
            companyId: ctx.companyId,
            category: row.category,
            title: row.title,
            description: row.description,
            location: row.location,
            probability: row.probability,
            impact: row.impact,
            riskLevel: row.riskLevel,
            currentMeasures: row.currentMeasures === null ? Prisma.DbNull : (row.currentMeasures as Prisma.InputJsonValue),
            status: 'active',
          },
        });
      }
      return created;
    });
    return NextResponse.json({ ...assessment, riskCount: rows.length }, { status: 201 });
  } catch (error) {
    console.error('Error creating RI&E assessment:', (error as Error).message);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
