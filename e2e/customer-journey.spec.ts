import { expect, test, type Page } from '@playwright/test';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from 'pg';

// Browser acceptance test of the order-to-cash journey with a synthetic customer.
// Real: browser, Next.js production server, Postgres, webhook signature verification, PDF/Word output.
// Stand-in: Stripe (e2e/stripe-standin.mjs). This does not prove a Stripe sandbox purchase.

const APP = 'http://127.0.0.1:3200';
const STANDIN = 'http://127.0.0.1:12211';
const run = Date.now().toString(36);
const customer = {
  companyName: `Synthetisch Installatiebedrijf ${run} BV`,
  kvk: '87654321',
  name: 'Eva Synthetisch',
  email: `eva.${run}@synthetisch.test`,
  password: 'Sterk-wachtwoord-2026',
};
const risks = [
  { category: 'PHYSICAL', description: `Werken op hoogte zonder randbeveiliging ${run}`, location: 'Dak hal 2', e: 5, w: 4 },
  { category: 'PSYCHOSOCIAL', description: `Hoge werkdruk in planning ${run}`, location: 'Kantoor', e: 3, w: 3 },
];

let db: Client;
const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows as T[];

test.beforeAll(async () => {
  db = new Client({ connectionString: process.env.E2E_DATABASE_URL });
  await db.connect();
});
test.afterAll(async () => db?.end());

async function companyId() {
  const rows = await q<{ id: string }>('select id from companies where name = $1', [customer.companyName]);
  expect(rows).toHaveLength(1); // provisioned exactly once
  return rows[0].id;
}

async function stripeCustomer() {
  return (await q<{ stripeCustomerId: string }>('select "stripeCustomerId" from companies where name = $1', [customer.companyName]))[0].stripeCustomerId;
}

async function standin(pathname: string, body?: unknown) {
  const res = await fetch(`${STANDIN}${pathname}`, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) });
  return res.json();
}

/** Input that follows a wizard label (the wizard's labels are not associated with their inputs). */
const afterLabel = (page: Page, text: string) => page.locator(`label:text-is("${text}")`).locator('xpath=following-sibling::*[1]');

test.describe.serial('order-to-cash customer journey', () => {
  let token = '';
  let assessmentId = '';

  test('registration creates the organization exactly once and leads to checkout', async ({ page }) => {
    await page.goto('/register');
    await page.getByLabel('Organisatienaam').fill(customer.companyName);
    await page.getByLabel('KvK-nummer (optioneel)').fill(customer.kvk);
    await page.getByLabel('Uw naam').fill(customer.name);
    await page.getByLabel('Zakelijk e-mailadres').fill(customer.email);
    await page.getByLabel('Wachtwoord (minimaal 8 tekens)').fill(customer.password);
    await page.getByRole('button', { name: 'Doorgaan naar betalen' }).click();

    await page.waitForURL(`${STANDIN}/pay/**`);
    await expect(page.getByText('Lokale Stripe-vervanger voor tests')).toBeVisible();
    await expect(page.getByText('price_E2ERIEYEARLY')).toBeVisible(); // configured Price, not ad-hoc data

    const id = await companyId();
    const users = await q<{ role: string; companyId: string }>('select role, "companyId" from users where email = $1', [customer.email]);
    expect(users).toEqual([{ role: 'MANAGER', companyId: id }]);
    expect(await stripeCustomer()).toMatch(/^cus_/);
  });

  test('a declined card grants nothing; reaching the success URL by hand grants nothing', async ({ page }) => {
    await loginAndGoToCheckout(page);
    await page.getByLabel('Kaartnummer').fill('4000 0000 0000 0002');
    await page.getByRole('button', { name: 'Betalen' }).click();
    await expect(page.getByRole('alert')).toHaveText('Uw kaart is geweigerd.');
    expect(await q('select 1 from subscriptions where "companyId" = $1', [await companyId()])).toHaveLength(0);

    // Typing the success URL with a made-up session must not provision access.
    await page.goto('/payment/success?session_id=cs_test_forged');
    await expect(page.getByRole('heading', { name: 'Betaling wordt verwerkt' })).toBeVisible({ timeout: 60_000 });
    await page.goto('/dashboard');
    await page.waitForURL('**/billing');
  });

  test('successful payment: verified webhooks, one subscription, one invoice, access granted', async ({ page }) => {
    await loginAndGoToCheckout(page);
    await page.getByLabel('Kaartnummer').fill('4242 4242 4242 4242');
    await page.getByRole('button', { name: 'Betalen' }).click();
    await page.waitForURL('**/payment/success?session_id=cs_test_**');
    await expect(page.getByRole('heading', { name: 'Betaling ontvangen' })).toBeVisible();

    const id = await companyId();
    const subs = await q<{ status: string; stripePriceId: string; stripeCustomerId: string }>('select status, "stripePriceId", "stripeCustomerId" from subscriptions where "companyId" = $1', [id]);
    expect(subs).toEqual([{ status: 'ACTIVE', stripePriceId: 'price_E2ERIEYEARLY', stripeCustomerId: await stripeCustomer() }]);
    const invoices = await q<{ status: string; total: number; tax: number; currency: string }>('select status, total, tax, currency from invoices where "companyId" = $1', [id]);
    expect(invoices).toEqual([{ status: 'paid', total: 60379, tax: 10479, currency: 'eur' }]);

    // Every webhook was delivered twice concurrently; each event is recorded once and all deliveries got 2xx.
    const events = (await standin('/__test/events')) as Array<{ id: string; type: string; deliveries: Array<{ status: number }> }>;
    expect(events.map((e) => e.type)).toEqual(['invoice.paid', 'checkout.session.completed', 'customer.subscription.created']);
    for (const e of events) expect(e.deliveries.map((d) => d.status)).toEqual([200, 200]);
    const ledger = await q<{ n: string }>('select count(*)::text as n from stripe_events where id = any($1)', [events.map((e) => e.id)]);
    expect(ledger[0].n).toBe(String(events.length));
    // The stale "created: incomplete" event arrived last but did not downgrade the subscription (verified above: ACTIVE).

    token = await page.evaluate(() => localStorage.getItem('auth_token') ?? '');
    expect(token).not.toBe('');
  });

  test('customer completes a basic RI&E in the wizard', async ({ page }) => {
    await login(page);
    await page.waitForURL('**/rie/new');
    await afterLabel(page, 'Titel RI&E *').fill(`RI&E ${customer.companyName}`);
    await afterLabel(page, 'Bedrijfsnaam *').fill(customer.companyName);
    await page.getByRole('button', { name: 'Volgende' }).click();

    for (const r of risks) {
      await page.locator('select').filter({ has: page.locator('option', { hasText: 'Selecteer categorie' }) }).selectOption(r.category);
      await page.getByPlaceholder('Bijvoorbeeld: Oncomfortabele werkplek').fill(r.description);
      await page.getByPlaceholder('Bijvoorbeeld: Kantoor verdieping 2').fill(r.location);
      await page.getByRole('button', { name: 'Risico Toevoegen' }).click();
      await expect(page.getByText(r.description).first()).toBeVisible();
    }
    await page.getByRole('button', { name: 'Volgende' }).click();

    // Step 3: score each risk (Ernst, Waarschijnlijkheid).
    for (const [i, r] of risks.entries()) {
      // The innermost bordered block for this risk (outer cards also match, and come first in DOM order).
      const block = page.locator('div.border', { has: page.getByRole('heading', { name: `Risico ${i + 1}: ${r.description}` }) }).last();
      await block.locator(`input[type=radio][value="${r.e}"]`).first().check();
      await block.locator(`input[type=radio][value="${r.w}"]`).nth(1).check();
    }
    for (let step = 3; step < 8; step += 1) await page.getByRole('button', { name: 'Volgende' }).click();
    await page.getByRole('button', { name: 'Opslaan' }).click();
    await page.waitForURL('**/dashboard');

    const rows = await q<{ id: string }>('select id from assessments where "companyId" = $1', [await companyId()]);
    expect(rows).toHaveLength(1);
    assessmentId = rows[0].id;
    const stored = await q<{ title: string; riskLevel: string; probability: number; impact: number }>(
      'select title, "riskLevel", probability, impact from risks where "assessmentId" = $1 order by title', [assessmentId]);
    expect(stored).toEqual([
      { title: risks[1].description, riskLevel: 'MEDIUM', probability: 3, impact: 3 },
      { title: risks[0].description, riskLevel: 'CRITICAL', probability: 4, impact: 5 },
    ]);
  });

  test('risk data persists after logout and login, and the reports reflect it', async ({ page }) => {
    await login(page);
    await page.waitForURL('**/dashboard');
    await page.getByRole('button', { name: 'Uitloggen' }).click();
    await page.waitForURL('**/login');
    await login(page);
    await page.waitForURL('**/dashboard');
    // Next.js renders an empty route-announcer alert; only alerts with text are errors.
    await expect(page.getByRole('alert').filter({ hasText: /\S/ })).toHaveCount(0);
    await expect(page.getByText('Algemene Compliance Score')).toBeVisible();

    await page.goto('/risks');
    for (const r of risks) await expect(page.getByText(r.description).first()).toBeVisible();

    await page.goto('/reports/rie');
    await expect(page.getByText(`RI&E ${customer.companyName}`)).toBeVisible();
    const dir = mkdtempSync(path.join(tmpdir(), 'rie-e2e-'));

    const [pdf] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'PDF' }).click()]);
    const pdfPath = path.join(dir, 'report.pdf');
    await pdf.saveAs(pdfPath);
    const pdfText = readFileSync(pdfPath).toString('latin1');
    expect(pdfText.startsWith('%PDF-')).toBe(true);
    expect(pdfText).toContain(customer.companyName);

    const [docx] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Word' }).click()]);
    const docxPath = path.join(dir, 'report.docx');
    await docx.saveAs(docxPath);
    const xml = execFileSync('unzip', ['-p', docxPath, 'word/document.xml']).toString('utf8');
    expect(xml).toContain(customer.companyName);
    for (const r of risks) expect(xml).toContain(r.description);
  });

  test('the invoice record is visible on the billing page', async ({ page }) => {
    await login(page);
    await page.waitForURL('**/dashboard');
    await page.goto('/billing');
    const list = page.getByRole('list', { name: 'Facturen' });
    await expect(list.getByText(/^RIE-STANDIN-0001/)).toBeVisible();
    await expect(list.getByText('Betaald')).toBeVisible();
    await expect(list.getByText(/603,79/)).toBeVisible();
    await page.getByRole('button', { name: 'Betaalgegevens, facturen en opzeggen' }).click();
    await page.waitForURL(`${STANDIN}/portal/**`);
  });

  test('failed renewal past the grace period removes access; payment recovery restores it', async ({ page }) => {
    const cus = await stripeCustomer();
    const longAgo = Math.floor(Date.now() / 1000) - 8 * 86400;
    const failed = await standin('/__test/subscription', { customer: cus, status: 'past_due', periodEnd: longAgo, failInvoice: true });
    expect(failed.deliveries.map((d: { status: number }) => d.status)).toEqual([200, 200]);

    await login(page);
    await page.waitForURL('**/billing');
    await expect(page.getByText('De laatste betaling is mislukt')).toBeVisible();
    const openInvoices = await q('select 1 from invoices where "companyId" = $1 and status = $2', [await companyId(), 'open']);
    expect(openInvoices).toHaveLength(1);

    await standin('/__test/subscription', { customer: cus, status: 'active', periodEnd: Math.floor(Date.now() / 1000) + 365 * 86400 });
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/dashboard$/);
  });

  test('cancellation removes access but keeps the data and invoices', async ({ page }) => {
    await standin('/__test/subscription', { customer: await stripeCustomer(), status: 'canceled' });
    await login(page);
    await page.waitForURL('**/billing');
    await expect(page.getByText('Het abonnement van uw organisatie is beëindigd.')).toBeVisible();
    await expect(page.getByRole('list', { name: 'Facturen' }).getByText(/^RIE-STANDIN-0001/)).toBeVisible();
    expect(await q('select 1 from risks where "assessmentId" = $1', [assessmentId])).toHaveLength(2);
    const status = await (await fetch(`${APP}/api/reports/rie`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ assessmentId, format: 'pdf' }),
    })).status;
    expect(status).toBe(402);
  });

  test('another organization cannot reach this customer\'s data', async () => {
    const other = await fetch(`${APP}/api/auth/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: `mallory.${run}@other.test`, name: 'Mallory Ander', password: 'Ander-wachtwoord-1', companyName: `Ander Bedrijf ${run}` }),
    }).then((r) => r.json());
    // Give the intruder a paid subscription so 402 cannot mask a missing tenant check.
    await db.query(
      `insert into subscriptions (id, "companyId", "stripeSubscriptionId", "stripeCustomerId", status, "syncedAt", "updatedAt")
       values ($1, $2, $3, 'cus_mallory', 'ACTIVE', 1, now())`, [`sub_row_${run}`, other.user.companyId, `sub_mallory_${run}`]);
    const auth = { authorization: `Bearer ${other.token}`, 'content-type': 'application/json' };
    const list = await (await fetch(`${APP}/api/assessments`, { headers: auth })).json();
    expect(list.assessments).toEqual([]);
    expect((await fetch(`${APP}/api/reports/rie`, { method: 'POST', headers: auth, body: JSON.stringify({ assessmentId, format: 'pdf' }) })).status).toBe(404);
    const riskId = (await q<{ id: string }>('select id from risks where "assessmentId" = $1 limit 1', [assessmentId]))[0].id;
    expect((await fetch(`${APP}/api/risks/${riskId}`, { headers: auth })).status).toBe(404);
    expect((await fetch(`${APP}/api/risks/${riskId}`, { method: 'DELETE', headers: auth })).status).toBe(404);
    const invoices = await (await fetch(`${APP}/api/billing/invoices`, { headers: auth })).json();
    expect(invoices.invoices).toEqual([]);
  });

  async function login(page: Page) {
    await page.goto('/login');
    await page.getByPlaceholder('naam@bedrijf.nl').fill(customer.email);
    await page.getByPlaceholder('••••••••').fill(customer.password);
    await page.getByRole('button', { name: /inloggen/i }).click();
  }

  async function loginAndGoToCheckout(page: Page) {
    await login(page);
    await page.waitForURL('**/billing');
    await page.getByRole('button', { name: 'Betalen via Stripe' }).click();
    await page.waitForURL(`${STANDIN}/pay/**`);
  }
});

test('database unavailable: clear failure, never sample data', async ({ page }) => {
  // A second production server whose database is unreachable.
  const server = spawn('npx', ['next', 'start', '-p', '3201', '-H', '127.0.0.1'], {
    env: { ...process.env, DATABASE_URL: 'postgresql://nobody@127.0.0.1:1/none', JWT_SECRET: 'e2e-jwt-secret', NEXT_TELEMETRY_DISABLED: '1' },
    stdio: 'ignore',
  });
  try {
    const base = 'http://127.0.0.1:3201';
    await expect.poll(async () => (await fetch(`${base}/login`).catch(() => null))?.status ?? 0, { timeout: 60_000 }).toBe(200);
    const health = await fetch(`${base}/api/health`);
    expect(health.status).toBe(503);
    expect(await health.json()).toMatchObject({ status: 'degraded', database: 'down' });

    await page.goto(`${base}/login`);
    await page.getByPlaceholder('naam@bedrijf.nl').fill(customer.email);
    await page.getByPlaceholder('••••••••').fill(customer.password);
    await page.getByRole('button', { name: /inloggen/i }).click();
    await expect(page.locator('.text-red-600').first()).toBeVisible();
    await expect(page).toHaveURL(/\/login$/);

    // A signed-in browser whose server loses the database sees an error, not sample data.
    const jwt = execFileSync('node', ['-e', `console.log(require('jsonwebtoken').sign({userId:'u1',email:'x@y.z',role:'MANAGER'},'e2e-jwt-secret'))`]).toString().trim();
    await page.evaluate(([t]) => {
      localStorage.setItem('auth_token', t);
      localStorage.setItem('auth_user', JSON.stringify({ id: 'u1', email: 'x@y.z', name: 'X', role: 'MANAGER', onboardingCompleted: true }));
    }, [jwt]);
    await page.goto(`${base}/dashboard`);
    await expect(page.getByText('Demo-omgeving')).toHaveCount(0);
    await expect(page.getByText('Algemene Compliance Score')).toHaveCount(0);
  } finally {
    server.kill();
  }
});

test('paid but webhook lost and tab closed: access is recovered, no second purchase', async ({ page, browser }) => {
  const who = { email: `lost.${run}@synthetisch.test`, password: 'Verloren-webhook-1' };
  await page.goto('/register');
  await page.getByLabel('Organisatienaam').fill(`Verloren Webhook ${run} BV`);
  await page.getByLabel('Uw naam').fill('Lars Synthetisch');
  await page.getByLabel('Zakelijk e-mailadres').fill(who.email);
  await page.getByLabel('Wachtwoord (minimaal 8 tekens)').fill(who.password);
  await page.getByRole('button', { name: 'Doorgaan naar betalen' }).click();
  await page.waitForURL(`${STANDIN}/pay/**`);

  await standin('/__test/drop-webhooks', { drop: true });
  try {
    // The browser never reaches the success page (closed tab / lost connection).
    await page.route('**/payment/success**', (route) => route.abort());
    await page.getByLabel('Kaartnummer').fill('4242 4242 4242 4242');
    await page.getByRole('button', { name: 'Betalen' }).click().catch(() => {});
    // Wait until the stand-in has completed the payment (its webhooks were dropped), then close the tab
    // while the success page is still blocked, so nothing reconciles from the browser.
    await expect.poll(async () => ((await standin('/__test/events')) as Array<{ id: string }>).filter((e) => e.id === 'dropped').length).toBeGreaterThanOrEqual(3);
    await page.close();
    const company = (await q<{ id: string }>('select id from companies where name = $1', [`Verloren Webhook ${run} BV`]))[0];
    expect(await q('select 1 from subscriptions where "companyId" = $1', [company.id])).toHaveLength(0);

    // Later, from another device (fresh browser context, nothing stored): sign in and open billing.
    const device = await browser.newContext({ baseURL: APP });
    page = await device.newPage();
    await page.goto('/login');
    await page.getByPlaceholder('naam@bedrijf.nl').fill(who.email);
    await page.getByPlaceholder('••••••••').fill(who.password);
    await page.getByRole('button', { name: /inloggen/i }).click();
    await page.waitForURL('**/billing');
    await expect(page.getByText('Uw organisatie heeft een actief abonnement.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Betalen via Stripe' })).toHaveCount(0);
    const subs = await q<{ status: string }>('select status from subscriptions where "companyId" = $1', [company.id]);
    expect(subs).toEqual([{ status: 'ACTIVE' }]);
    await page.getByRole('button', { name: 'Naar het dashboard' }).click();
    await page.waitForURL(/\/(dashboard|rie\/new)$/);
  } finally {
    await standin('/__test/drop-webhooks', { drop: false });
  }
});

test('staging preflight probe agrees with the running application', async () => {
  const { probeOrigin } = await import('../scripts/staging-preflight.mjs');
  const checks: Array<{ name: string; ok: boolean; detail?: string }> = await probeOrigin(APP);
  expect(checks.filter((c) => !c.ok)).toEqual([]);
});
