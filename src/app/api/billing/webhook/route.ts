import { NextRequest, NextResponse } from 'next/server';
import type Stripe from 'stripe';
import { prisma } from '@/lib/db';
import { billingConfig, BillingConfigError, stripeGateway } from '@/lib/billing/stripe';
import { processStripeEvent } from '@/lib/billing/webhook';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST /api/billing/webhook (also served at the legacy /api/payment/webhook).
// 400 = bad signature (Stripe will not succeed on retry); 5xx = transient, Stripe retries.
export async function POST(request: NextRequest) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  const signature = request.headers.get('stripe-signature');
  if (!secret) {
    console.error('STRIPE_WEBHOOK_SECRET is not set');
    return NextResponse.json({ error: 'Webhook not configured' }, { status: 503 });
  }
  if (!signature) return NextResponse.json({ error: 'Missing signature' }, { status: 400 });
  if (!prisma) return NextResponse.json({ error: 'Database not available' }, { status: 503 });

  let config;
  try {
    config = billingConfig();
  } catch (error) {
    if (error instanceof BillingConfigError) {
      console.error('Billing not configured:', error.message);
      return NextResponse.json({ error: 'Billing not configured' }, { status: 503 });
    }
    throw error;
  }
  const stripe = stripeGateway(config.secretKey);
  const body = await request.text();

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, signature, secret);
  } catch {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 });
  }

  try {
    const result = await processStripeEvent(prisma, stripe, event);
    return NextResponse.json({ received: true, ...result });
  } catch (error) {
    console.error(`Webhook ${event.type} ${event.id} failed:`, (error as Error).message);
    return NextResponse.json({ error: 'Processing failed' }, { status: 500 });
  }
}
