/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-this-alias -- test double that mimics the loosely typed Stripe SDK surface */
import Stripe from 'stripe';
import type { StripeGateway } from '@/lib/billing/stripe';

// In-memory stand-in for the Stripe API calls the app makes. Webhook construction uses Stripe's real
// signature verification, so signed payloads are checked exactly as in production.

const realWebhooks = new Stripe('sk_test_synthetic').webhooks;

type Sub = {
  id: string;
  object: 'subscription';
  customer: string;
  status: string;
  created: number;
  cancel_at_period_end: boolean;
  metadata: Record<string, string>;
  items: { data: Array<{ price: { id: string }; current_period_end: number }> };
};

export class FakeStripe {
  customers = new Map<string, { id: string; metadata: Record<string, string> }>();
  sessions = new Map<string, Record<string, any>>();
  subscriptions = new Map<string, Sub>();
  invoices = new Map<string, Record<string, any>>();
  idempotency = new Map<string, string>();
  calls: string[] = [];
  private n = 0;
  private id(prefix: string) {
    this.n += 1;
    return `${prefix}_${String(this.n).padStart(6, '0')}`;
  }

  gateway(): StripeGateway {
    const self = this;
    return {
      customers: {
        create: (async (params: any, options?: any) => {
          self.calls.push('customers.create');
          const key = options?.idempotencyKey;
          if (key && self.idempotency.has(key)) return self.customers.get(self.idempotency.get(key)!);
          const customer = { id: self.id('cus'), metadata: params.metadata ?? {} };
          self.customers.set(customer.id, customer);
          if (key) self.idempotency.set(key, customer.id);
          return customer;
        }) as any,
      },
      checkout: {
        sessions: {
          create: (async (params: any) => {
            self.calls.push('checkout.sessions.create');
            const session = {
              id: self.id('cs_test'),
              object: 'checkout.session',
              status: 'open',
              mode: params.mode,
              customer: params.customer,
              client_reference_id: params.client_reference_id,
              metadata: params.metadata,
              subscription: null as string | null,
              params,
            };
            session.params = params;
            (session as any).url = `https://checkout.stripe.test/c/pay/${session.id}`;
            self.sessions.set(session.id, session);
            return session;
          }) as any,
          retrieve: (async (id: string) => {
            const s = self.sessions.get(id);
            if (!s) throw new Error(`No such checkout.session: ${id}`);
            return s;
          }) as any,
        },
      },
      subscriptions: {
        retrieve: (async (id: string) => {
          self.calls.push('subscriptions.retrieve');
          const s = self.subscriptions.get(id);
          if (!s) throw new Error(`No such subscription: ${id}`);
          return structuredClone(s);
        }) as any,
        list: (async (params: any) => {
          self.calls.push('subscriptions.list');
          const data = [...self.subscriptions.values()].filter((s) => s.customer === params.customer).map((s) => structuredClone(s));
          return { object: 'list', data, has_more: false };
        }) as any,
      },
      invoices: {
        retrieve: (async (id: string) => {
          self.calls.push('invoices.retrieve');
          const inv = self.invoices.get(id);
          if (!inv) throw new Error(`No such invoice: ${id}`);
          return structuredClone(inv);
        }) as any,
      },
      billingPortal: {
        sessions: {
          create: (async (params: any) => {
            self.calls.push('billingPortal.sessions.create');
            return { id: self.id('bps'), url: `https://billing.stripe.test/p/session/${params.customer}`, return_url: params.return_url };
          }) as any,
        },
      },
      webhooks: realWebhooks,
    };
  }

  /** Simulate the customer paying on Stripe's hosted page: the session completes with an active subscription. */
  completeCheckout(sessionId: string, status = 'active') {
    const session = this.sessions.get(sessionId)!;
    const periodEnd = Math.floor(Date.now() / 1000) + 365 * 86400;
    const sub: Sub = {
      id: this.id('sub'),
      object: 'subscription',
      customer: session.customer,
      status,
      created: Math.floor(Date.now() / 1000) + this.n, // strictly increasing, like real creation times
      cancel_at_period_end: false,
      metadata: session.params.subscription_data?.metadata ?? {},
      items: { data: [{ price: { id: session.params.line_items[0].price }, current_period_end: periodEnd }] },
    };
    this.subscriptions.set(sub.id, sub);
    session.status = 'complete';
    session.subscription = sub.id;
    return { session, sub };
  }

  /** Create (or update) an invoice for a subscription, as Stripe does at each billing cycle. */
  invoice(subId: string, patch: Record<string, any> = {}) {
    const sub = this.subscriptions.get(subId)!;
    const id = patch.id ?? this.id('in');
    const now = Math.floor(Date.now() / 1000);
    const existing = this.invoices.get(id) ?? {
      id,
      object: 'invoice',
      customer: sub.customer,
      number: `RIE-${String(this.invoices.size + 1).padStart(4, '0')}`,
      status: 'paid',
      currency: 'eur',
      subtotal: 49900,
      total_taxes: [{ amount: 10479 }],
      total: 60379,
      amount_due: 60379,
      amount_paid: 60379,
      hosted_invoice_url: `https://invoice.stripe.test/i/${id}`,
      invoice_pdf: `https://pay.stripe.test/invoice/${id}/pdf`,
      period_start: now,
      period_end: now + 365 * 86400,
      created: now,
      status_transitions: { finalized_at: now, paid_at: now },
      parent: { subscription_details: { subscription: subId } },
    };
    Object.assign(existing, patch);
    this.invoices.set(id, existing);
    return existing;
  }

  setSubscription(id: string, patch: Partial<Sub> & { periodEnd?: number }) {
    const sub = this.subscriptions.get(id)!;
    const { periodEnd, ...rest } = patch;
    Object.assign(sub, rest);
    if (periodEnd !== undefined) sub.items.data[0].current_period_end = periodEnd;
  }
}

let eventCounter = 0;

/** Build a Stripe event and its valid signature header, as Stripe would deliver it. */
export function signedEvent(type: string, object: unknown, opts: { id?: string; created?: number; secret?: string } = {}) {
  eventCounter += 1;
  const event = {
    id: opts.id ?? `evt_test_${Date.now()}_${eventCounter}`,
    object: 'event',
    type,
    created: opts.created ?? Math.floor(Date.now() / 1000),
    api_version: '2025-10-29.clover',
    livemode: false,
    data: { object },
  };
  const payload = JSON.stringify(event);
  const header = realWebhooks.generateTestHeaderString({
    payload,
    secret: opts.secret ?? process.env.STRIPE_WEBHOOK_SECRET!,
  });
  return { event, payload, header };
}
