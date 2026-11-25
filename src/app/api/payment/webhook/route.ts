// Legacy webhook path kept so an endpoint already registered in Stripe keeps working.
export { POST } from '@/app/api/billing/webhook/route';

// Segment config must be literal in each route file for Next.js to read it.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
