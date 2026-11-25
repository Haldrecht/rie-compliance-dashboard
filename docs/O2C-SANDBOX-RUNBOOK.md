# Order-to-cash: staging and real Stripe sandbox purchase

Goal: one real Stripe **test-mode** purchase on a staging deployment that is fully separate from
production, verified independently. Nothing here touches production, live keys or real money.

## Status (2026-11-23)

Verified without credentials: see "Evidence" in PR #1 (tests on SQLite and Postgres, migrations, browser
journey with a Stripe stand-in). **Not verified: anything involving real Stripe or a deployed staging app.**

What the Stripe stand-in (`e2e/stripe-standin.mjs`) does **not** prove:
- that Stripe accepts the app's Checkout, Portal and API parameters (`tax_id_collection`,
  `customer_update`, `billing_address_collection`, `locale: nl`, the portal configuration);
- real webhook payload shapes for our pinned SDK API version, delivery from the internet to Vercel,
  signature secrets from a real endpoint, and Stripe's retry behavior;
- Stripe-side flows: 3-D Secure, Smart Retries, test clocks, tax calculation, invoice PDFs;
- the hosted Checkout and Customer Portal pages themselves.

## Authorization needed from the owner

1. **Stripe**: use (or create) a Stripe account's **test mode** for HALDRECHT and provide a test secret key
   (`sk_test_…`, preferably a restricted key) through a secure channel (not chat, not Git). Confirm the
   yearly price in EUR (cents) for the test Price.
2. **Staging database**: approve creating one disposable Postgres database for staging (e.g. a separate
   Supabase project on the free tier, or a Neon branch). It must not be, or be copied from, production.
3. **Staging deployment**: approve a Vercel **Preview** deployment of branch `feat/o2c-vertical-slice` in project
   `rie-compliance-dashboard` with **Preview-scoped** environment variables only (Production scope untouched),
   and decide how Stripe reaches the webhook if Deployment Protection is on (protection bypass for
   automation, or protection off for this preview).
4. **The transaction**: approve one test-mode purchase with Stripe's test card by a synthetic customer.

No paid service is required (Stripe test mode, Vercel Preview and a free-tier database are free).

## Configuration (exact)

| Variable (Preview scope) | Value | Source |
| --- | --- | --- |
| `DATABASE_URL` | staging Postgres URL | step 1 |
| `JWT_SECRET` | `openssl rand -base64 48` | generate; never reuse production's |
| `STRIPE_SECRET_KEY` | `sk_test_…` / `rk_test_…` | owner |
| `STRIPE_PRICE_ID` | `price_…` | `sandbox:setup` output |
| `STRIPE_PORTAL_CONFIGURATION_ID` | `bpc_…` | `sandbox:setup` output |
| `STRIPE_WEBHOOK_SECRET` | `whsec_…` | file written by `sandbox:setup` |
| `NEXT_PUBLIC_APP_URL` | `https://<preview host>` | Vercel |
| `PUBLIC_SIGNUP_ENABLED` | `true` | |

Must **not** be set on staging: `STRIPE_API_BASE`, `NEXT_PUBLIC_DEMO_MODE`, `STRIPE_ALLOW_LIVE`.

Restricted-key permissions if a restricted key is used: Customers (write), Checkout Sessions (write),
Subscriptions (read), Invoices (read), Customer Portal (write); for the one-time setup additionally Products,
Prices, Portal configurations and Webhook endpoints (write).

## Procedure

1. **Database** (staging only; non-destructive on an empty database):
   ```
   DATABASE_URL=<staging> npx prisma db push --schema prisma/schema.postgres.prisma --skip-generate
   ```
   On a database that already has the old schema, apply instead, in order:
   `supabase/migrations/20261122200000_o2c_billing.sql`, `supabase/migrations/20261123010000_o2c_invoices.sql`
   (both idempotent; CI verifies they produce exactly the Prisma schema).
2. **Deploy** the Preview with the variables above (Stripe values can be filled after step 3, then redeploy).
3. **Stripe test-mode objects** (idempotent; refuses live keys; never prints secrets):
   ```
   STRIPE_SECRET_KEY=sk_test_… npm run sandbox:setup -- \
     --origin https://<preview host> --amount <cents> --secret-file ~/.config/haldrecht/staging-whsec
   ```
   Creates/reuses the Product, yearly EUR Price (`rie_dashboard_yearly_eur`), a Customer Portal configuration
   (card update, invoices, cancel at period end) and the webhook endpoint with every event the app handles.
4. **Preflight** with the staging variables in an env file outside the repo:
   ```
   STAGING_DATABASE_CONFIRMED=<host:port/db of the staging database> \
     node --env-file=<staging.env> scripts/staging-preflight.mjs --probe
   ```
   Fails if the key is live, the database is not explicitly confirmed as staging, the origin is not https,
   a test-only switch is on, or the deployed webhook is blocked by deployment protection.
5. **Purchase** (browser, synthetic customer, e.g. `qa+o2c1@haldrecht.test`, organization "QA Sandbox BV"):
   `/register` → Stripe Checkout with `4242 4242 4242 4242`, any future date, any CVC → "Betaling ontvangen" →
   RI&E with two risks → log out and in → `/risks` → PDF and Word from `/reports/rie` → `/billing` invoice →
   Customer Portal opens.
6. **Verify independently**:
   ```
   DATABASE_URL=<staging> STRIPE_SECRET_KEY=sk_test_… STRIPE_PRICE_ID=price_… \
     npm run verify:sandbox -- qa+o2c1@haldrecht.test
   ```
   Must exit 0. Record the JSON output, preview URL and PR head SHA in PR #1.
7. **Failure scenarios** (optional, same staging):
   declined card `4000 0000 0000 0002`; failed renewal with a Stripe test clock and card
   `4000 0000 0000 0341`; cancel in the portal; resend an event from the Stripe Dashboard (expect
   `{"status":"duplicate"}`).

## Teardown

Delete the Preview's environment variables and the staging database, disable the webhook endpoint in Stripe
test mode. Test-mode objects can stay; they cost nothing.
