import { describe, expect, it } from 'vitest';
import { PAST_DUE_GRACE_DAYS, fromStripeStatus, subscriptionEntitlement, userEntitlement } from '@/lib/billing/entitlement';
import { billingConfig, BillingConfigError } from '@/lib/billing/stripe';
import { riskLevelFor, riskRowsFromWizard, toDbCategory, validateWizardPayload } from '@/lib/rie/assessment';

const now = new Date('2026-11-22T12:00:00Z');
const day = 86_400_000;

describe('entitlement rules', () => {
  it.each([
    ['ACTIVE', true],
    ['TRIALING', true],
    ['INCOMPLETE', false],
    ['INCOMPLETE_EXPIRED', false],
    ['UNPAID', false],
    ['CANCELED', false],
    ['PAUSED', false],
  ] as const)('%s -> entitled=%s', (status, entitled) => {
    expect(subscriptionEntitlement({ status, currentPeriodEnd: new Date(now.getTime() + day) }, now).entitled).toBe(entitled);
  });

  it('past due: entitled within the grace window only', () => {
    const end = new Date(now.getTime() - (PAST_DUE_GRACE_DAYS - 1) * day);
    expect(subscriptionEntitlement({ status: 'PAST_DUE', currentPeriodEnd: end }, now)).toEqual({ entitled: true, reason: 'subscription_past_due_grace' });
    const old = new Date(now.getTime() - (PAST_DUE_GRACE_DAYS + 1) * day);
    expect(subscriptionEntitlement({ status: 'PAST_DUE', currentPeriodEnd: old }, now)).toEqual({ entitled: false, reason: 'payment_failed' });
    expect(subscriptionEntitlement({ status: 'PAST_DUE', currentPeriodEnd: null }, now).entitled).toBe(false);
  });

  it('no subscription is not entitled', () => {
    expect(subscriptionEntitlement(null, now)).toEqual({ entitled: false, reason: 'no_subscription' });
  });

  it('admins and active licenses are entitled; expired licenses fall through to the subscription', () => {
    expect(userEntitlement({ role: 'ADMIN', license: null, subscription: null }, now).entitled).toBe(true);
    expect(userEntitlement({ role: 'MANAGER', license: { status: 'ACTIVE', expiresAt: null }, subscription: null }, now).reason).toBe('license');
    expect(userEntitlement({ role: 'MANAGER', license: { status: 'ACTIVE', expiresAt: new Date(now.getTime() - day) }, subscription: null }, now).entitled).toBe(false);
    expect(userEntitlement({ role: 'MANAGER', license: { status: 'SUSPENDED', expiresAt: null }, subscription: { status: 'ACTIVE', currentPeriodEnd: null } }, now).reason).toBe('subscription_active');
  });

  it('unknown Stripe statuses deny access', () => {
    expect(fromStripeStatus('active')).toBe('ACTIVE');
    expect(fromStripeStatus('something_new')).toBe('CANCELED');
  });
});

describe('billing configuration', () => {
  const base = { STRIPE_SECRET_KEY: 'sk_test_abc', STRIPE_PRICE_ID: 'price_123', NEXT_PUBLIC_APP_URL: 'https://app.example/' } as unknown as NodeJS.ProcessEnv;

  it('accepts test keys and normalizes the app URL', () => {
    expect(billingConfig(base)).toEqual({ secretKey: 'sk_test_abc', priceId: 'price_123', appUrl: 'https://app.example' });
  });

  it('refuses live keys unless explicitly allowed', () => {
    expect(() => billingConfig({ ...base, STRIPE_SECRET_KEY: 'sk_live_abc' })).toThrow(BillingConfigError);
    expect(() => billingConfig({ ...base, STRIPE_SECRET_KEY: 'rk_live_abc' })).toThrow(/Live Stripe keys are refused/);
    expect(billingConfig({ ...base, STRIPE_SECRET_KEY: 'sk_live_abc', STRIPE_ALLOW_LIVE: 'true' }).secretKey).toBe('sk_live_abc');
  });

  it('requires a configured Price (no ad-hoc price data)', () => {
    expect(() => billingConfig({ ...base, STRIPE_PRICE_ID: '' })).toThrow(/STRIPE_PRICE_ID/);
    expect(() => billingConfig({ ...base, STRIPE_SECRET_KEY: '' })).toThrow(/STRIPE_SECRET_KEY/);
  });
});

describe('RI&E wizard mapping', () => {
  it('maps every wizard category to a valid database category', () => {
    expect(['PHYSICAL', 'CHEMICAL', 'BIOLOGICAL', 'ERGONOMIC', 'PSYCHOSOCIAL', 'ORGANIZATIONAL'].map(toDbCategory)).toEqual([
      'PHYSICAL_WORKSPACE', 'CHEMICAL_BIOLOGICAL', 'CHEMICAL_BIOLOGICAL', 'PHYSICAL_STRAIN', 'PSYCHOSOCIAL', 'ENVIRONMENTAL',
    ]);
    expect(toDbCategory('SAFETY_RISKS')).toBe('SAFETY_RISKS');
    expect(toDbCategory('nonsense')).toBe('PHYSICAL_WORKSPACE');
  });

  it('recomputes risk level from clamped scores instead of trusting the client', () => {
    const rows = riskRowsFromWizard({ workAreas: [{ name: 'A', risks: [{ title: 't', probability: 99, severity: 5, score: 1 } as never] }] });
    expect(rows[0]).toMatchObject({ probability: 5, impact: 5, riskLevel: 'CRITICAL', location: 'A' });
    expect([riskLevelFor(4), riskLevelFor(5), riskLevelFor(10), riskLevelFor(16)]).toEqual(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
  });

  it('validates the payload shape and size', () => {
    expect(validateWizardPayload(null)).toBeTruthy();
    expect(validateWizardPayload({ company: { companyName: 'X' }, goalAndScope: {}, workAreas: [] })).toBeNull();
    const huge = { company: { companyName: 'X' }, goalAndScope: {}, workAreas: [{ risks: Array.from({ length: 501 }, () => ({})) }] };
    expect(validateWizardPayload(huge)).toMatch(/Maximaal/);
  });
});
