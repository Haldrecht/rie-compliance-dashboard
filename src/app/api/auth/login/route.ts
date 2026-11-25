import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { verifyPassword, generateToken } from '@/lib/auth';
import { loadEntitlement } from '@/lib/tenant';
import { z } from 'zod';

const loginSchema = z.object({
  email: z.string().email('Ongeldig e-mailadres'),
  password: z.string().min(1, 'Wachtwoord is verplicht'),
});

export async function POST(request: NextRequest) {
  try {
    if (!prisma || !process.env.DATABASE_URL) {
      return NextResponse.json(
        { error: 'Database niet geconfigureerd' },
        { status: 503 }
      );
    }

    const body = await request.json();
    const validation = loginSchema.safeParse(body);

    if (!validation.success) {
      return NextResponse.json(
        { error: 'Ongeldige gegevens', details: validation.error.issues },
        { status: 400 }
      );
    }

    const { email, password } = validation.data;

    // Find user with password (self-registered emails are stored lower-case)
    const userSelect = {
      id: true,
      email: true,
      name: true,
      password: true,
      role: true,
      companyId: true,
      onboardingCompleted: true,
    } as const;
    const user =
      (await prisma.user.findUnique({ where: { email }, select: userSelect })) ??
      (email !== email.toLowerCase()
        ? await prisma.user.findUnique({ where: { email: email.toLowerCase() }, select: userSelect })
        : null);

    if (!user) {
      return NextResponse.json(
        { error: 'Ongeldig e-mailadres of wachtwoord' },
        { status: 401 }
      );
    }

    // Verify password
    const isValidPassword = await verifyPassword(password, user.password);

    if (!isValidPassword) {
      return NextResponse.json(
        { error: 'Ongeldig e-mailadres of wachtwoord' },
        { status: 401 }
      );
    }

    // Access is decided per request by the tenant guard. Signing in is allowed for members of an
    // organization even before payment, so they can reach checkout; users with neither an organization
    // nor an active license (and not ADMIN) still cannot sign in, as before.
    const access = await loadEntitlement(user.id);
    if (!access?.entitlement.entitled && !user.companyId) {
      return NextResponse.json(
        { error: 'Geen actieve licentie. Neem contact op met de beheerder.' },
        { status: 403 }
      );
    }

    // Generate JWT token
    const token = generateToken({
      userId: user.id,
      email: user.email,
      role: user.role,
      companyId: user.companyId || undefined,
    });

    // Return user without password
    const { password: _, ...userWithoutPassword } = user;

    return NextResponse.json({
      message: 'Inloggen succesvol',
      user: userWithoutPassword,
      token,
      entitlement: access?.entitlement ?? { entitled: false, reason: 'no_subscription' },
    });
  } catch (error: any) {
    console.error('Login error:', error);
    console.error('Error details:', {
      message: error?.message,
      code: error?.code,
      stack: error?.stack,
      name: error?.name,
    });
    
    // Check for specific database errors
    let errorMessage = 'Interne serverfout';
    let errorCode = error?.code;
    
    if (error?.code === 'P2025') {
      errorMessage = 'Gebruiker niet gevonden';
    } else if (error?.code === 'P2002') {
      errorMessage = 'Database constraint violation';
    } else if (error?.message?.includes('column') && error?.message?.includes('does not exist')) {
      errorMessage = 'Database schema mismatch - column missing';
      errorCode = 'SCHEMA_MISMATCH';
    } else if (error?.message?.includes('Unknown argument')) {
      errorMessage = 'Prisma client out of sync with database schema';
      errorCode = 'PRISMA_MISMATCH';
    } else if (error?.message?.includes('connect') || error?.message?.includes('connection')) {
      errorMessage = 'Database connection failed';
      errorCode = 'CONNECTION_ERROR';
    } else if (error?.message?.includes('enum')) {
      errorMessage = 'Database schema fout. Neem contact op met de beheerder.';
    } else if (error?.message) {
      errorMessage = error.message;
    }
    
    return NextResponse.json(
      { 
        error: errorMessage,
        code: errorCode,
        details: process.env.NODE_ENV === 'development' ? {
          message: error?.message,
          code: error?.code,
          stack: error?.stack?.split('\n').slice(0, 5),
        } : undefined,
        // Always include some diagnostic info in production
        diagnostic: {
          hasPrisma: !!prisma,
          hasDatabaseUrl: !!process.env.DATABASE_URL,
          databaseUrlFormat: process.env.DATABASE_URL?.substring(0, 20) + '...',
        }
      },
      { status: 500 }
    );
  }
}


