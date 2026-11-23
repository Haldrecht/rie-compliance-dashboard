# Dashboard entry points and checkout contract (for the marketing website)

Status: implemented on branch `feat/o2c-vertical-slice`. Verified by `npm test` (SQLite and Postgres) and
by the browser journey `npm run test:e2e` (real browser, production build, Postgres, Stripe stand-in).
Not yet deployed, and not yet run against a real Stripe sandbox (no test keys available).
Production base URL: `https://rie-compliance-dashboard.vercel.app` (live, but currently serving a build
that predates this branch, so these routes are not available there until it is deployed).

The website only links to the dashboard. It does not call Stripe, create sessions or handle prices:
checkout is always started by the dashboard for a signed-in organization.

## Links the website may use

| Purpose | URL | Notes |
| --- | --- | --- |
| Buy / start trial CTA | `{BASE}/register` | Creates organization + first user, then sends the customer to Stripe Checkout. |
| Existing customer | `{BASE}/login` | Unpaid or lapsed organizations are sent to `/billing` after login. |
| Billing management (returning customer) | `{BASE}/billing` | Requires sign-in. Unpaid: "Betalen via Stripe". Paid or lapsed: invoices plus "Betaalgegevens, facturen en opzeggen" (Stripe Customer Portal). |

Do not link to `/payment/success`, `/billing?start=1`, `/dashboard`, `/rie/new` or `/reports/rie` from the
website; the dashboard routes customers there itself.

Verified on 2026-11-23 against this branch: `/register`, `/login` and `/billing` exist and behave as
described (browser test `e2e/customer-journey.spec.ts`). They are not live on the production URL yet.

Query parameters the dashboard understands on `/register`: `canceled=true` (shows "payment canceled").
Unknown parameters are ignored, so UTM tags are safe.

## Is signup open?

`GET {BASE}/api/auth/register` → `{"enabled": true|false}` (no auth, no side effects).
When `false`, `/register` shows "Account aanmaken uitgeschakeld"; the website should show a contact CTA
instead of "Buy". Signup is controlled by the dashboard env var `PUBLIC_SIGNUP_ENABLED`.

## Journey and redirects (all on the dashboard domain)

1. `/register` → `POST /api/auth/register` → signed in → `/billing?start=1`
2. `/billing?start=1` → `POST /api/billing/checkout` → redirect to Stripe Checkout (hosted)
3. Stripe success → `/payment/success?session_id=cs_...` → confirms with `GET /api/billing/status?session_id=...`
   (webhook or direct reconciliation) → "RI&E starten" → `/rie/new`
4. Stripe cancel → `/billing?canceled=1`
5. `/rie/new` (wizard) → `POST /api/assessments` → `/dashboard`
6. `/reports/rie` → `POST /api/reports/rie` → PDF or Word download

## API (dashboard-internal; listed so nothing is duplicated on the website)

| Method | Path | Auth | Result |
| --- | --- | --- | --- |
| GET | `/api/auth/register` | none | `{enabled}` |
| POST | `/api/auth/register` | none | 201 `{user, token, entitlement, next: "/billing"}`; 403 `signup_disabled`; 409 `email_taken`; 400 `invalid_input` |
| POST | `/api/auth/login` | none | 200 `{user, token, entitlement}` |
| POST | `/api/billing/checkout` | Bearer | 200 `{url, sessionId}`; 409 `already_subscribed`; 503 `billing_unavailable` |
| GET | `/api/billing/status[?session_id]` | Bearer | `{entitled, reason, subscription}` |
| POST | `/api/billing/portal` | Bearer | 200 `{url}` (Stripe Customer Portal); 409 `no_billing_account` |
| GET | `/api/billing/invoices` | Bearer | `{invoices: [...]}` for the caller's organization (also when lapsed) |
| POST | `/api/billing/webhook` | Stripe signature | Stripe only (legacy alias `/api/payment/webhook`) |
| GET | `/api/health` | none | 200 `{status: "ok", database: "up"}` or 503 when the database is down |

Data routes (`/api/dashboard`, `/api/assessments`, `/api/reports/rie`, `/api/risks`, `/api/actions`) answer
402 `subscription_required` for organizations without a paid subscription.

## Product and price

One product: RI&E Compliance Dashboard, yearly subscription per organization. The Stripe Price is set by
`STRIPE_PRICE_ID` in the dashboard environment; the website should show the price shown on that Stripe
Price (the code no longer hard-codes €499). Promotion codes are accepted at checkout.

## Configuration the website needs

Only the dashboard base URL. Use one variable on the website, for example
`NEXT_PUBLIC_DASHBOARD_URL=https://<dashboard host>`, and build the three links from it. Until the
staging deployment exists, there is no verified staging host to put there.
