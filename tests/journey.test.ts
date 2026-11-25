import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import { POST as register } from '@/app/api/auth/register/route';
import { POST as login } from '@/app/api/auth/login/route';
import { POST as checkout } from '@/app/api/billing/checkout/route';
import { GET as billingStatus } from '@/app/api/billing/status/route';
import { POST as webhook } from '@/app/api/billing/webhook/route';
import { GET as dashboard } from '@/app/api/dashboard/route';
import { GET as listAssessments, POST as createAssessment } from '@/app/api/assessments/route';
import { POST as report } from '@/app/api/reports/rie/route';
import { installFakeStripe, req, resetDb, wizardPayload } from './helpers/app';
import { signedEvent, type FakeStripe } from './helpers/fake-stripe';

// One synthetic customer, end to end, through the real route handlers:
// Registration -> Organization -> Stripe test checkout -> verified payment -> entitlement ->
// dashboard -> RI&E assessment -> report.

let stripe: FakeStripe;

beforeEach(async () => {
  await resetDb();
  stripe = installFakeStripe();
});

const customer = {
  email: 'Inkoop@Bouwbedrijf-Synthetisch.test',
  name: 'Sanne Synthetisch',
  password: 'correct-horse-battery',
  companyName: 'Bouwbedrijf Synthetisch B.V.',
  kvkNumber: '12345678',
};

describe('order-to-cash customer journey', () => {
  it('takes a new customer from registration to a downloaded RI&E report', async () => {
    // 1. Registration creates the organization and its first member.
    const reg = await register(req('POST', '/api/auth/register', { body: customer }));
    expect(reg.status).toBe(201);
    const regBody = await reg.json();
    expect(regBody.next).toBe('/billing');
    expect(regBody.entitlement.entitled).toBe(false);
    const token: string = regBody.token;
    const companyId: string = regBody.user.companyId;
    expect(companyId).toBeTruthy();
    const company = await prisma.company.findUnique({ where: { id: companyId } });
    expect(company?.name).toBe(customer.companyName);
    expect(regBody.user.email).toBe(customer.email.toLowerCase());

    // 2. Before payment: signed in, but no access to customer data.
    expect((await dashboard(req('GET', '/api/dashboard', { token }))).status).toBe(402);
    const createBefore = await createAssessment(req('POST', '/api/assessments', { token, body: wizardPayload(customer.companyName) }));
    expect(createBefore.status).toBe(402);
    expect((await createBefore.json()).code).toBe('subscription_required');

    // Login (mixed-case email) works before payment so the customer can reach checkout.
    const signIn = await login(req('POST', '/api/auth/login', { body: { email: customer.email, password: customer.password } }));
    expect(signIn.status).toBe(200);
    expect((await signIn.json()).entitlement).toEqual({ entitled: false, reason: 'no_subscription' });

    // 3. Checkout uses the organization's own Stripe customer and the configured test Price.
    const co = await checkout(req('POST', '/api/billing/checkout', { token, body: { companyId: 'someone-else', userId: 'x' } }));
    expect(co.status).toBe(200);
    const { url, sessionId } = await co.json();
    expect(url).toMatch(/^https:\/\/checkout\.stripe\.test\//);
    const session = stripe.sessions.get(sessionId)!;
    expect(session.params.mode).toBe('subscription');
    expect(session.params.line_items).toEqual([{ price: 'price_RIE2026TEST', quantity: 1 }]);
    expect(session.client_reference_id).toBe(companyId); // body-supplied ids are ignored
    expect(session.params.success_url).toBe('https://dashboard.test.example/payment/success?session_id={CHECKOUT_SESSION_ID}');
    expect(session.params.cancel_url).toBe('https://dashboard.test.example/billing?canceled=1');
    const stored = await prisma.company.findUnique({ where: { id: companyId } });
    expect(session.customer).toBe(stored?.stripeCustomerId);

    // A second checkout attempt (e.g. after abandoning the first) reuses the same Stripe customer.
    const again = await checkout(req('POST', '/api/billing/checkout', { token }));
    const againSession = stripe.sessions.get((await again.json()).sessionId)!;
    expect(againSession.customer).toBe(session.customer);
    expect(stripe.customers.size).toBe(1);

    // 4. Customer pays on Stripe; Stripe sends a signed checkout.session.completed.
    const { session: paid } = stripe.completeCheckout(sessionId);
    const delivery = signedEvent('checkout.session.completed', paid);
    const hook = await webhook(req('POST', '/api/billing/webhook', { raw: delivery.payload, headers: { 'stripe-signature': delivery.header } }));
    expect(hook.status).toBe(200);
    expect(await hook.json()).toMatchObject({ received: true, status: 'processed' });

    // 5. Entitlement is active.
    const status = await (await billingStatus(req('GET', `/api/billing/status?session_id=${sessionId}`, { token }))).json();
    expect(status).toMatchObject({ entitled: true, reason: 'subscription_active', subscription: { status: 'ACTIVE', cancelAtPeriodEnd: false } });

    // 6. Dashboard access.
    const dash = await dashboard(req('GET', '/api/dashboard', { token }));
    expect(dash.status).toBe(200);

    // 7. Complete a basic RI&E.
    const created = await createAssessment(req('POST', '/api/assessments', { token, body: wizardPayload(customer.companyName) }));
    expect(created.status).toBe(201);
    const assessment = await created.json();
    expect(assessment.riskCount).toBe(4);
    const risks = await prisma.risk.findMany({ where: { assessmentId: assessment.id }, orderBy: { title: 'asc' } });
    expect(risks.map((r: { title: string; category: string; riskLevel: string }) => [r.title, r.category, r.riskLevel])).toEqual([
      ['Oplosmiddelen', 'CHEMICAL_BIOLOGICAL', 'MEDIUM'],
      ['Tillen', 'PHYSICAL_STRAIN', 'LOW'],
      ['Vallen van hoogte', 'PHYSICAL_WORKSPACE', 'CRITICAL'],
      ['Werkdruk', 'ENVIRONMENTAL', 'HIGH'],
    ]);
    expect(risks.every((r: { companyId: string }) => r.companyId === companyId)).toBe(true);

    const listed = await (await listAssessments(req('GET', '/api/assessments', { token }))).json();
    expect(listed.assessments).toHaveLength(1);

    // 8. Retrieve the report, as PDF and as Word.
    const pdf = await report(req('POST', '/api/reports/rie', { token, body: { assessmentId: assessment.id, format: 'pdf' } }));
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get('content-type')).toBe('application/pdf');
    const pdfBytes = Buffer.from(await pdf.arrayBuffer());
    expect(pdfBytes.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.headers.get('content-disposition')).toContain('attachment;');

    const docx = await report(req('POST', '/api/reports/rie', { token, body: { assessmentId: assessment.id, format: 'docx' } }));
    expect(docx.status).toBe(200);
    const docxBytes = Buffer.from(await docx.arrayBuffer());
    expect(docxBytes.subarray(0, 2).toString()).toBe('PK'); // OOXML zip container
  });

  it('grants access from the checkout return even when the webhook has not arrived (recovery path)', async () => {
    const reg = await (await register(req('POST', '/api/auth/register', { body: { ...customer, email: 'late@webhook.test' } }))).json();
    const { sessionId } = await (await checkout(req('POST', '/api/billing/checkout', { token: reg.token }))).json();
    stripe.completeCheckout(sessionId);

    const status = await (await billingStatus(req('GET', `/api/billing/status?session_id=${sessionId}`, { token: reg.token }))).json();
    expect(status).toMatchObject({ entitled: true, reconcile: 'applied' });

    // The webhook arriving later is harmless.
    const { payload, header } = signedEvent('checkout.session.completed', stripe.sessions.get(sessionId));
    const hook = await webhook(req('POST', '/api/billing/webhook', { raw: payload, headers: { 'stripe-signature': header } }));
    expect(hook.status).toBe(200);
    expect(await prisma.subscription.count()).toBe(1);
  });

  it('does not accept another organization\'s checkout session on the return page', async () => {
    const a = await (await register(req('POST', '/api/auth/register', { body: { ...customer, email: 'a@org.test', companyName: 'Org A' } }))).json();
    const b = await (await register(req('POST', '/api/auth/register', { body: { ...customer, email: 'b@org.test', companyName: 'Org B' } }))).json();
    const { sessionId } = await (await checkout(req('POST', '/api/billing/checkout', { token: a.token }))).json();
    stripe.completeCheckout(sessionId);

    const stolen = await (await billingStatus(req('GET', `/api/billing/status?session_id=${sessionId}`, { token: b.token }))).json();
    expect(stolen).toMatchObject({ entitled: false, reconcile: 'foreign' });
  });

  it('refuses a second checkout for an organization that is already subscribed', async () => {
    const reg = await (await register(req('POST', '/api/auth/register', { body: { ...customer, email: 'twice@org.test' } }))).json();
    const { sessionId } = await (await checkout(req('POST', '/api/billing/checkout', { token: reg.token }))).json();
    stripe.completeCheckout(sessionId);
    await billingStatus(req('GET', `/api/billing/status?session_id=${sessionId}`, { token: reg.token }));
    const again = await checkout(req('POST', '/api/billing/checkout', { token: reg.token }));
    expect(again.status).toBe(409);
    expect((await again.json()).code).toBe('already_subscribed');
  });
});
