import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { generateToken, hashPassword } from '@/lib/auth';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';

// Self-service signup: creates the organization and its first user (MANAGER) together.
// The account has no access to customer data until the organization's subscription is paid.
// Disabled unless PUBLIC_SIGNUP_ENABLED=true, so existing deployments keep admin-only provisioning.

const registerSchema = z.object({
  email: z.string().trim().toLowerCase().email('Ongeldig e-mailadres'),
  name: z.string().trim().min(2, 'Naam moet minimaal 2 tekens zijn'),
  password: z.string().min(8, 'Wachtwoord moet minimaal 8 tekens zijn'),
  companyName: z.string().trim().min(1, 'Bedrijfsnaam is verplicht').max(200),
  kvkNumber: z.string().trim().regex(/^\d{8}$/, 'KvK-nummer heeft 8 cijfers').optional(),
});

// Not exported: Next.js route modules may only export HTTP handlers and route config.
function signupEnabled(env: NodeJS.ProcessEnv = process.env) {
  return env.PUBLIC_SIGNUP_ENABLED === 'true';
}

export async function POST(request: NextRequest) {
  if (!signupEnabled()) {
    return NextResponse.json(
      { error: 'Registratie is uitgeschakeld. Neem contact op met de beheerder.', code: 'signup_disabled' },
      { status: 403 },
    );
  }
  if (!prisma) {
    return NextResponse.json({ error: 'Database niet geconfigureerd' }, { status: 503 });
  }

  const parsed = registerSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'Ongeldige gegevens', code: 'invalid_input' },
      { status: 400 },
    );
  }
  const { email, name, password, companyName, kvkNumber } = parsed.data;

  const existing = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (existing) {
    return NextResponse.json({ error: 'E-mailadres is al in gebruik', code: 'email_taken' }, { status: 409 });
  }

  const passwordHash = await hashPassword(password);
  try {
    const user = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const company = await tx.company.create({
        data: { name: companyName, email, kvkNumber: kvkNumber ?? null, country: 'Netherlands' },
        select: { id: true },
      });
      return tx.user.create({
        data: { email, name, password: passwordHash, role: 'MANAGER', companyId: company.id },
        select: { id: true, email: true, name: true, role: true, companyId: true, onboardingCompleted: true },
      });
    });
    const token = generateToken({ userId: user.id, email: user.email, role: user.role, companyId: user.companyId ?? undefined });
    return NextResponse.json(
      { user, token, entitlement: { entitled: false, reason: 'no_subscription' }, next: '/billing' },
      { status: 201 },
    );
  } catch (error) {
    if ((error as { code?: string }).code === 'P2002') {
      return NextResponse.json({ error: 'E-mailadres is al in gebruik', code: 'email_taken' }, { status: 409 });
    }
    console.error('Registration failed:', (error as Error).message);
    return NextResponse.json({ error: 'Interne serverfout' }, { status: 500 });
  }
}

// GET /api/auth/register — whether self-service signup is open (for the register page and the website).
export async function GET() {
  return NextResponse.json({ enabled: signupEnabled() });
}
