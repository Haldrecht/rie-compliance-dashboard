// Local stand-in for the parts of Stripe the dashboard uses, for browser acceptance tests only.
//
// THIS IS NOT STRIPE. It speaks the same REST shapes for the calls the app makes, serves a minimal
// hosted "checkout" page, and delivers webhooks signed with Stripe's own library so the app's real
// signature verification runs. A genuine sandbox purchase still requires Stripe test keys; see
// docs/O2C-SANDBOX-RUNBOOK.md.
//
// To exercise idempotency and ordering against the running app, every webhook is delivered twice
// concurrently, and checkout completion is followed by a stale (older) duplicate subscription event.

import http from 'node:http';
import Stripe from 'stripe';

const PORT = Number(process.env.STANDIN_PORT || 12211);
const APP = process.env.APP_URL || 'http://127.0.0.1:3200';
const SECRET = process.env.STRIPE_WEBHOOK_SECRET;
if (!SECRET) throw new Error('STRIPE_WEBHOOK_SECRET is required');
const webhooks = new Stripe('sk_test_standin').webhooks;

const db = { customers: new Map(), sessions: new Map(), subscriptions: new Map(), invoices: new Map(), events: [] };
let seq = 0;
// Unique per process, like real Stripe ids, so repeated runs against one database never collide.
const runTag = Date.now().toString(36);
const id = (p) => `${p}_standin${runTag}${String(++seq).padStart(6, '0')}`;
const now = () => Math.floor(Date.now() / 1000);

// Stripe SDK sends application/x-www-form-urlencoded with bracket notation: a[b][0][c]=v
function parseForm(body) {
  const out = {};
  for (const [rawKey, value] of new URLSearchParams(body)) {
    const keys = rawKey.replace(/\]/g, '').split('[');
    let node = out;
    keys.forEach((k, i) => {
      const last = i === keys.length - 1;
      const nextIsIndex = !last && /^\d+$/.test(keys[i + 1]);
      if (last) node[k] = value;
      else node = node[k] ??= nextIsIndex ? [] : {};
    });
  }
  return out;
}

async function deliver(type, object, created = now()) {
  const event = { id: id('evt'), object: 'event', type, created, api_version: '2025-10-29.clover', livemode: false, data: { object } };
  db.events.push({ id: event.id, type });
  const payload = JSON.stringify(event);
  const header = webhooks.generateTestHeaderString({ payload, secret: SECRET });
  const post = () => fetch(`${APP}/api/billing/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': header }, body: payload })
    .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
  const results = await Promise.all([post(), post()]); // duplicate, concurrent delivery
  db.events.at(-1).deliveries = results;
  return results;
}

function makeInvoice(sub, status) {
  const t = now();
  const inv = {
    id: id('in'), object: 'invoice', customer: sub.customer, number: `RIE-STANDIN-${String(db.invoices.size + 1).padStart(4, '0')}`,
    status, currency: 'eur', subtotal: 49900, total_taxes: [{ amount: 10479 }], total: 60379,
    amount_due: 60379, amount_paid: status === 'paid' ? 60379 : 0,
    hosted_invoice_url: `http://127.0.0.1:${PORT}/invoice/${seq}`, invoice_pdf: null,
    period_start: t, period_end: t + 365 * 86400, created: t,
    status_transitions: { finalized_at: t, paid_at: status === 'paid' ? t : null },
    parent: { subscription_details: { subscription: sub.id } },
  };
  db.invoices.set(inv.id, inv);
  return inv;
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function html(res, status, body) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><html lang="nl"><head><meta charset="utf-8"><title>Stripe stand-in checkout</title></head><body style="font-family:sans-serif;max-width:420px;margin:40px auto">${body}</body></html>`);
}

const notFound = (res, what) => json(res, 404, { error: { type: 'invalid_request_error', message: `No such ${what}` } });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  let body = '';
  for await (const chunk of req) body += chunk;
  const p = url.pathname;
  const m = (re) => p.match(re);
  let r;
  try {
    // ---- REST API used by the app (via STRIPE_API_BASE) ----
    if (req.method === 'POST' && p === '/v1/customers') {
      const params = parseForm(body);
      const key = req.headers['idempotency-key'];
      const existing = key && [...db.customers.values()].find((c) => c.idempotencyKey === key);
      if (existing) return json(res, 200, existing);
      const customer = { id: id('cus'), object: 'customer', email: params.email, name: params.name, metadata: params.metadata ?? {}, idempotencyKey: key };
      db.customers.set(customer.id, customer);
      return json(res, 200, customer);
    }
    if (req.method === 'POST' && p === '/v1/checkout/sessions') {
      const params = parseForm(body);
      const sid = id('cs_test');
      const session = {
        id: sid, object: 'checkout.session', mode: params.mode, status: 'open', payment_status: 'unpaid',
        customer: params.customer, client_reference_id: params.client_reference_id, metadata: params.metadata ?? {},
        subscription: null, url: `http://127.0.0.1:${PORT}/pay/${sid}`, params,
      };
      db.sessions.set(sid, session);
      return json(res, 200, session);
    }
    if (req.method === 'GET' && (r = m(/^\/v1\/checkout\/sessions\/([^/]+)$/))) {
      const s = db.sessions.get(r[1]);
      return s ? json(res, 200, s) : notFound(res, 'checkout.session');
    }
    if (req.method === 'GET' && (r = m(/^\/v1\/subscriptions\/([^/]+)$/))) {
      const s = db.subscriptions.get(r[1]);
      return s ? json(res, 200, s) : notFound(res, 'subscription');
    }
    if (req.method === 'GET' && (r = m(/^\/v1\/invoices\/([^/]+)$/))) {
      const i = db.invoices.get(r[1]);
      return i ? json(res, 200, i) : notFound(res, 'invoice');
    }
    if (req.method === 'POST' && p === '/v1/billing_portal/sessions') {
      const params = parseForm(body);
      return json(res, 200, { id: id('bps'), object: 'billing_portal.session', customer: params.customer, return_url: params.return_url, url: `http://127.0.0.1:${PORT}/portal/${params.customer}?return=${encodeURIComponent(params.return_url)}` });
    }

    // ---- Hosted pages (what the customer's browser sees) ----
    if (req.method === 'GET' && (r = m(/^\/pay\/([^/]+)$/))) {
      const s = db.sessions.get(r[1]);
      if (!s) return html(res, 404, '<p>Onbekende sessie</p>');
      const error = url.searchParams.get('error');
      return html(res, 200, `
        <p style="background:#fef3c7;padding:8px">Lokale Stripe-vervanger voor tests — geen echte betaling</p>
        <h1>Betalen</h1>
        <p>Prijs: ${s.params.line_items?.[0]?.price}</p>
        ${error ? `<p role="alert" style="color:#b91c1c">${error}</p>` : ''}
        <form method="post" action="/pay/${s.id}">
          <label>Kaartnummer <input name="card" aria-label="Kaartnummer" autocomplete="off"></label>
          <button type="submit">Betalen</button>
        </form>
        <p><a href="${s.params.cancel_url}">Annuleren</a></p>`);
    }
    if (req.method === 'POST' && (r = m(/^\/pay\/([^/]+)$/))) {
      const s = db.sessions.get(r[1]);
      if (!s) return html(res, 404, '<p>Onbekende sessie</p>');
      const card = new URLSearchParams(body).get('card')?.replace(/\s/g, '') ?? '';
      if (card === '4000000000000002') {
        res.writeHead(303, { location: `/pay/${s.id}?error=${encodeURIComponent('Uw kaart is geweigerd.')}` });
        return res.end();
      }
      if (card !== '4242424242424242') {
        res.writeHead(303, { location: `/pay/${s.id}?error=${encodeURIComponent('Ongeldig kaartnummer.')}` });
        return res.end();
      }
      const t = now();
      const sub = {
        id: id('sub'), object: 'subscription', customer: s.customer, status: 'active', cancel_at_period_end: false,
        metadata: s.params.subscription_data?.metadata ?? {},
        items: { object: 'list', data: [{ id: id('si'), price: { id: s.params.line_items[0].price }, current_period_end: t + 365 * 86400 }] },
      };
      db.subscriptions.set(sub.id, sub);
      Object.assign(s, { status: 'complete', payment_status: 'paid', subscription: sub.id });
      const inv = makeInvoice(sub, 'paid');
      // Stripe's usual order is not guaranteed; deliver invoice before checkout, then a stale event.
      await deliver('invoice.paid', inv);
      await deliver('checkout.session.completed', s);
      await deliver('customer.subscription.created', { ...sub, status: 'incomplete' }, t - 60);
      res.writeHead(303, { location: s.params.success_url.replace('{CHECKOUT_SESSION_ID}', s.id) });
      return res.end();
    }
    if (req.method === 'GET' && (r = m(/^\/portal\/([^/]+)$/))) {
      return html(res, 200, `<p>Lokale Stripe-vervanger: klantportaal</p><a href="${url.searchParams.get('return')}">Terug</a>`);
    }

    // ---- Test control (scenarios Stripe would trigger) ----
    if (req.method === 'POST' && p === '/__test/subscription') {
      const params = JSON.parse(body || '{}');
      const sub = [...db.subscriptions.values()].find((s) => s.customer === params.customer);
      if (!sub) return notFound(res, 'subscription for customer');
      if (params.status) sub.status = params.status;
      if (params.periodEnd) sub.items.data[0].current_period_end = params.periodEnd;
      if (params.cancelAtPeriodEnd !== undefined) sub.cancel_at_period_end = params.cancelAtPeriodEnd;
      let results;
      if (params.failInvoice) {
        const inv = makeInvoice(sub, 'open');
        results = await deliver('invoice.payment_failed', inv);
      } else {
        results = await deliver(sub.status === 'canceled' ? 'customer.subscription.deleted' : 'customer.subscription.updated', sub);
      }
      return json(res, 200, { subscription: sub.id, status: sub.status, deliveries: results });
    }
    if (req.method === 'GET' && p === '/__test/events') return json(res, 200, db.events);
    if (req.method === 'GET' && p === '/__test/health') return json(res, 200, { ok: true });
    return notFound(res, p);
  } catch (error) {
    console.error(error);
    return json(res, 500, { error: { message: String(error) } });
  }
});

server.listen(PORT, '127.0.0.1', () => console.log(`stripe stand-in on http://127.0.0.1:${PORT} -> ${APP}`));
