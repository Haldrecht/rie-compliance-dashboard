// Legacy path. The old handler trusted a userId from the request body; it now uses the authenticated
// organization exactly like /api/billing/checkout.
export { POST } from '@/app/api/billing/checkout/route';

// Segment config must be literal in each route file for Next.js to read it.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
