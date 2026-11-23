# Order-to-cash: staging and Stripe sandbox runbook

Purpose: run one real Stripe test-mode purchase through a staging deployment and verify it
independently. Nothing here touches production or live billing.

## What is already verified (without Stripe credentials)

| Check | Command | Result on 2026-11-23 |
| --- | --- | --- |
| Unit and integration tests, SQLite | `npm test` | 52 passed |
| Same tests on Postgres 15, including concurrent webhook delivery | `TEST_DATABASE_URL=postgresql://… npm test` | 52 passed |
| Migrations on a copy of the current `main` schema: apply twice, no drift | see `.github/workflows/ci.yml` job `postgres` | passed |
| Browser journey: register → checkout → webhooks → RI&E → logout/login → PDF/Word → invoice → failed renewal → cancel → cross-tenant → DB down | `E2E_DATABASE_URL=postgresql://… npm run test:e2e` | 10 passed, 3 consecutive runs |

The browser journey uses `e2e/stripe-standin.mjs`, a local stand-in for Stripe. It is **not** Stripe.
It proves the app's own behavior; only the steps below prove the integration with Stripe.

## 1. Staging infrastructure (needs approval)

None of this exists yet. The Vercel project `rie-compliance-dashboard` currently has no environment
variables at all, and no staging database or Stripe account was available.

1. A dedicated staging Postgres database (for example a separate Supabase project). Not the production one.
2. Apply, in order, against the staging database only:
   1. the existing base schema (`prisma db push --schema prisma/schema.postgres.prisma` on an empty database
      creates everything, including the order-to-cash tables), or, on a copy of production's schema,
   2. `supabase/migrations/20261122200000_o2c_billing.sql` then `supabase/migrations/20261123010000_o2c_invoices.sql`.
3. A Vercel Preview deployment of this branch with **Preview-scoped** variables only:

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | staging database |
| `JWT_SECRET` | new random value (at least 32 bytes) |
| `STRIPE_SECRET_KEY` | `sk_test_…` (live keys are refused by the app) |
| `STRIPE_PRICE_ID` | test-mode Price of the RI&E yearly product |
| `STRIPE_WEBHOOK_SECRET` | signing secret of the webhook endpoint below |
| `NEXT_PUBLIC_APP_URL` | the preview URL |
| `PUBLIC_SIGNUP_ENABLED` | `true` |

Do **not** set `STRIPE_API_BASE`, `NEXT_PUBLIC_DEMO_MODE` or `STRIPE_ALLOW_LIVE`.

## 2. Stripe test mode

1. Product "RI&E Compliance Dashboard", yearly recurring Price in EUR → `STRIPE_PRICE_ID`.
2. Customer Portal: enable it in test mode (Settings → Billing → Customer portal), allow cancellation and
   payment-method updates.
3. Webhook endpoint `https://<preview>/api/billing/webhook` with events:
   `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
   `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`,
   `invoice.finalized`, `invoice.paid`, `invoice.payment_failed`, `invoice.payment_action_required`.
   If Vercel Deployment Protection is on, add a protection bypass for this path or Stripe gets 401.

## 3. The purchase (manual, in a browser)

1. Open `https://<preview>/register`, register a synthetic customer (e.g. `qa+o2c1@haldrecht.test`).
2. On Stripe Checkout pay with `4242 4242 4242 4242`, any future date, any CVC.
3. Expect "Betaling ontvangen" → "RI&E starten". Complete the wizard with two risks.
4. Log out, log in, check `/risks`, download PDF and Word from `/reports/rie`.
5. `/billing` shows the invoice; "Betaalgegevens, facturen en opzeggen" opens the Stripe portal.

## 4. Independent verification

```
DATABASE_URL=<staging> STRIPE_SECRET_KEY=sk_test_… STRIPE_PRICE_ID=price_… \
  npm run verify:sandbox -- qa+o2c1@haldrecht.test
```

This reads the staging database and Stripe's records and checks they agree: one organization, linked
customer, subscription status and price, every finalized invoice recorded with the same amounts, and
processed webhook events. It exits non-zero on any mismatch. It has not been run yet, because no Stripe
test key was available.

## 5. Failure scenarios in the sandbox

- Declined payment: card `4000 0000 0000 0002` → stays on Checkout, no access.
- Failed renewal: Stripe test clocks (Billing → Test clocks) with card `4000 0000 0000 0341`, advance past
  renewal → `invoice.payment_failed` → access ends 7 days after the period end.
- Cancellation: in the portal, cancel immediately → `customer.subscription.deleted` → `/billing` shows
  "beëindigd"; invoices remain visible.
- Duplicate delivery: Stripe Dashboard → Webhooks → event → "Resend" → response `{"status":"duplicate"}`.
