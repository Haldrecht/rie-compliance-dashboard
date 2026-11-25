import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { withCustomer } from '@/lib/tenant';
import { calculateRiskLevel } from '@/lib/utils';

// GET /api/risks - Get all risks for the company
export const GET = withCustomer(async (request: NextRequest, user) => {
  try {
    const { searchParams } = new URL(request.url);
    const category = searchParams.get('category');
    const status = searchParams.get('status');
    const riskLevel = searchParams.get('riskLevel');
    const page = parseInt(searchParams.get('page') || '1');
    const limit = parseInt(searchParams.get('limit') || '10');

    const where: any = {
      companyId: user.companyId,
    };

    if (category) {
      where.category = category;
    }
    if (status) {
      where.status = status;
    }
    if (riskLevel) {
      where.riskLevel = riskLevel;
    }

    const risks = await prisma.risk.findMany({
      where,
      include: {
        countermeasures: true,
        actions: true,
        comments: {
          include: {
            user: {
              select: { name: true, email: true }
            }
          }
        }
      },
      orderBy: { createdDate: 'desc' }, // Risk has createdDate, not createdAt
      skip: (page - 1) * limit,
      take: limit,
    });

    const total = await prisma.risk.count({ where });

    return NextResponse.json({
      risks,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error('Error fetching risks:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
});

// POST /api/risks - Create a new risk
export const POST = withCustomer(async (request: NextRequest, user) => {
  try {
    const body = await request.json();
    const {
      assessmentId,
      category,
      title,
      description,
      location,
      department,
      probability,
      impact,
      exposedEmployees,
      currentMeasures,
      proposedMeasures,
      attachments,
    } = body;

    // Validate required fields
    if (!category || !title || !description || !location || !probability || !impact) {
      return NextResponse.json(
        { error: 'Missing required fields' },
        { status: 400 }
      );
    }

    // The assessment must belong to the caller's organization.
    const ownsAssessment = typeof assessmentId === 'string'
      && await prisma.assessment.count({ where: { id: assessmentId, companyId: user.companyId } }) === 1;
    if (!ownsAssessment) {
      return NextResponse.json({ error: 'Assessment not found' }, { status: 404 });
    }

    // Calculate risk level
    const riskLevel = calculateRiskLevel(probability, impact);

    const risk = await prisma.risk.create({
      data: {
        assessmentId,
        companyId: user.companyId!,
        category,
        title,
        description,
        location,
        department,
        probability,
        impact,
        riskLevel,
        exposedEmployees: exposedEmployees || 0,
        currentMeasures: currentMeasures || [],
        proposedMeasures: proposedMeasures || [],
        attachments: attachments || [],
      },
      include: {
        countermeasures: true,
        actions: true,
      },
    });

    return NextResponse.json(risk, { status: 201 });
  } catch (error) {
    console.error('Error creating risk:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
});
