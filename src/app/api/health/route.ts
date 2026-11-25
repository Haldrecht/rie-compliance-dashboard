import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

export const dynamic = 'force-dynamic';

// GET /api/health — liveness for monitoring. Public, so it reveals only up/down: no error text,
// connection details or environment information.
export async function GET() {
  let database: 'up' | 'down' | 'unconfigured' = 'unconfigured';
  if (prisma && process.env.DATABASE_URL) {
    try {
      await prisma.$queryRaw`SELECT 1`;
      database = 'up';
    } catch {
      database = 'down';
    }
  }
  const ok = database === 'up';
  return NextResponse.json(
    { status: ok ? 'ok' : 'degraded', database, timestamp: new Date().toISOString() },
    { status: ok ? 200 : 503, headers: { 'Cache-Control': 'no-store' } },
  );
}
