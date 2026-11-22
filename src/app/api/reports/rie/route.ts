import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { requireCustomer } from '@/lib/tenant';
import { DocumentGenerator } from '@/lib/document-generator';

export const runtime = 'nodejs';

// POST /api/reports/rie {assessmentId, format: 'pdf'|'docx'} — download a report for one of the
// caller's own organization's assessments.
export async function POST(request: NextRequest) {
  const guard = await requireCustomer(request);
  if (!guard.ok) return guard.response;
  const { ctx } = guard;
  try {
    const body = await request.json().catch(() => ({}));
    const { assessmentId, format = 'docx' } = body;

    if (typeof assessmentId !== 'string' || !assessmentId || (format !== 'pdf' && format !== 'docx')) {
      return NextResponse.json(
        { error: 'assessmentId and format (pdf or docx) are required' },
        { status: 400 }
      );
    }

    // Get assessment data
    const assessment = await prisma.assessment.findFirst({
      where: {
        id: assessmentId,
        companyId: ctx.companyId,
      },
      include: {
        company: true,
        risks: {
          include: {
            countermeasures: true,
            actions: true,
          },
        },
        actions: true,
      },
    });

    if (!assessment) {
      return NextResponse.json(
        { error: 'Assessment not found' },
        { status: 404 }
      );
    }

    // Get assessor info
    const assessor = await prisma.user.findUnique({
      where: { id: assessment.assessorId },
      select: { name: true, email: true },
    });

    const reportData = {
      company: assessment.company,
      assessment: {
        id: assessment.id,
        title: assessment.title,
        description: assessment.description,
        status: assessment.status,
        version: assessment.version,
        startDate: assessment.startDate,
        endDate: assessment.endDate,
        reviewDate: assessment.reviewDate,
        createdAt: assessment.createdAt,
        updatedAt: assessment.updatedAt,
      },
      risks: assessment.risks,
      actions: assessment.actions,
      generatedAt: new Date(),
      assessor: assessor?.name || 'Onbekend',
    };

    let blob: Blob;
    let filename: string;
    let mimeType: string;

    if (format === 'pdf') {
      blob = await DocumentGenerator.generatePDFReport(reportData);
      filename = `RI&E_${safeName(assessment.company.name)}_${new Date().toISOString().split('T')[0]}.pdf`;
      mimeType = 'application/pdf';
    } else {
      blob = await DocumentGenerator.generateRIEReport(reportData);
      filename = `RI&E_${safeName(assessment.company.name)}_${new Date().toISOString().split('T')[0]}.docx`;
      mimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    }

    // Convert blob to buffer
    const buffer = await blob.arrayBuffer();

    return new NextResponse(buffer, {
      headers: {
        'Content-Type': mimeType,
        'Content-Disposition': `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
        'Cache-Control': 'private, no-store',
        'Content-Length': buffer.byteLength.toString(),
      },
    });
  } catch (error) {
    console.error('Error generating RI&E report:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

function safeName(name: string) {
  return name.replace(/[^A-Za-z0-9 _.-]/g, '').trim().slice(0, 80) || 'organisatie';
}
