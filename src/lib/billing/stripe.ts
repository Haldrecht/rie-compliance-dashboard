import Stripe from 'stripe';

// Stripe configuration. Billing is test mode only unless STRIPE_ALLOW_LIVE=true is set deliberately.

export class BillingConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BillingConfigError';
  }
}

export interface BillingConfig {
  secretKey: string;
  priceId: string;
  appUrl: string;
}

export function billingConfig(env: NodeJS.ProcessEnv = process.env): BillingConfig {
  const secretKey = env.STRIPE_SECRET_KEY ?? '';
  const priceId = env.STRIPE_PRICE_ID ?? '';
  if (!secretKey) throw new BillingConfigError('STRIPE_SECRET_KEY is not set');
  const live = secretKey.startsWith('sk_live_') || secretKey.startsWith('rk_live_');
  if (live && env.STRIPE_ALLOW_LIVE !== 'true') {
    throw new BillingConfigError('Live Stripe keys are refused: set STRIPE_ALLOW_LIVE=true only after production billing is approved');
  }
  if (!/^price_[A-Za-z0-9]+$/.test(priceId)) {
    throw new BillingConfigError('STRIPE_PRICE_ID must be the test-mode Price id of the RI&E subscription product');
  }
  const appUrl = (env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000').replace(/\/+$/, '');
  return { secretKey, priceId, appUrl };
}

let cached: { key: string; client: Stripe } | null = null;

/** The minimal Stripe surface the billing code uses, so tests can inject a fake. */
export interface StripeGateway {
  customers: { create: Stripe['customers']['create'] };
  checkout: { sessions: { create: Stripe['checkout']['sessions']['create']; retrieve: Stripe['checkout']['sessions']['retrieve'] } };
  subscriptions: { retrieve: Stripe['subscriptions']['retrieve'] };
  webhooks: { constructEvent: Stripe['webhooks']['constructEvent'] };
}

let override: StripeGateway | null = null;

/** Test hook: replace the Stripe client. Pass null to restore. */
export function setStripeGatewayForTests(gateway: StripeGateway | null) {
  override = gateway;
}

export function stripeGateway(secretKey: string): StripeGateway {
  if (override) return override;
  if (!cached || cached.key !== secretKey) {
    cached = { key: secretKey, client: new Stripe(secretKey, { maxNetworkRetries: 2 }) };
  }
  return cached.client;
}
