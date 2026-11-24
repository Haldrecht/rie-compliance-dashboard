# Dashboard entry-route contract (for the marketing website)

Reviewed 2026-11-24 against implementation `0432db3be861e8b574b110fa4d5ba81933d4b09c`,
published branch `feat/o2c-vertical-slice` ([draft PR #1](https://github.com/Haldrecht/rie-compliance-dashboard/pull/1)).
Local worktree branch: `feat/o2c-vertical-slice-haldrecht`. No staging deployment or genuine Stripe
purchase is evidenced. Deployment statements below describe the previous engineering record, not a fresh
production probe. See [the Codex handoff](O2C-CODEX-HANDOFF.md) for verification provenance and ownership.

> **Purchase links on the website must stay disabled** until the full journey has passed on staging with a
> real Stripe test-mode purchase (see "Release gate" below). Until then the website keeps `appUrl` empty.

## Verification status per route

| Route | Locally (browser test, production build, Postgres, Stripe **stand-in**) | Staging (real Stripe test mode) | Production |
| --- | --- | --- | --- |
| `/register` | Verified in CI at the implementation SHA above | **Not verified** | Previously recorded: old build shows "registration disabled" |
| `/login` | Verified in CI at the implementation SHA above | **Not verified** | Previously recorded: old build has no database configured |
| `/billing` | Verified in CI at the implementation SHA above | **Not verified** | Previously recorded: route absent |

## Origin

There is **no verified HTTPS dashboard origin in the handoff evidence**. The previous record says production
serves an older build and staging has not been created. The website's `appUrl` must remain empty until the release gate passes; at that point this
document will name the verified origin. The origin will be a bare `https://` origin (the website rejects
anything else, and Stripe webhooks require https).

## Mapping to the website's config (Haldrecht/haldrecht PR #3, `RieConfig`)

| Website key | Value | Notes |
| --- | --- | --- |
| `appUrl` | *(empty until the release gate passes)* | Then: the verified `https://` dashboard origin. |
| `startPad` | `/register` | New customer: registration, then Stripe Checkout. |
| `loginPad` | `/login` | Existing customer. |
| *(optional, not in RieConfig yet)* | `/billing` | Returning customer: payment status, invoices, Stripe Customer Portal. |

The website never calls Stripe, creates sessions or shows its own price logic; the dashboard does all of that.
UTM and other unknown query parameters are ignored by these routes.

## Behavior the website can rely on

**New customer** — `/register` → account and organization created (exactly once) → `/billing?start=1` →
Stripe Checkout → `/payment/success?session_id=…` → access confirmed by the server → `/rie/new` (RI&E wizard).

**Signup closed** — `GET {origin}/api/auth/register` returns `{"enabled": false}`; `/register` then shows
"Account aanmaken uitgeschakeld". The website should show a contact CTA instead of "Buy" in that case.

**Existing customer** — `/login` → paid organization: `/dashboard` (or `/rie/new` if no RI&E yet);
unpaid or lapsed: `/billing`.

**Checkout cancelled** — Stripe's cancel button returns to `/billing?canceled=1`: "De betaling is
geannuleerd. Er is niets in rekening gebracht." The customer stays signed in and can retry with
"Betalen via Stripe"; the same Stripe customer is reused. Abandoned sessions expire at Stripe with no charge.

**Payment declined** — the customer stays on Stripe Checkout with Stripe's error; no access is granted.

**Paid but no access yet** (webhook delayed or lost, tab closed, other device) — access is recovered without
support: the success page reconciles its checkout session with Stripe, and `/billing` (also reached via
`/login`) asks Stripe for the organization's own subscriptions. A second purchase is refused
(`already_subscribed`) while Stripe has an active subscription. Reaching the success URL by itself grants
nothing.

**Failed renewal** — access continues until 7 days after the paid period ends while Stripe retries; then
`/billing` shows "De laatste betaling is mislukt". A successful retry restores access.

**Cancellation** — via the Stripe Customer Portal from `/billing` ("Betaalgegevens, facturen en opzeggen"),
at period end. After the period: `/billing` shows "beëindigd"; data and invoices are kept.

## Release gate (when the website may enable purchase links)

All of the following on the staging deployment, recorded in PR #1:
1. `scripts/staging-preflight.mjs --probe` passes against the staging origin.
2. One real Stripe test-mode purchase by a synthetic customer through `/register`.
3. `npm run verify:sandbox -- <customer email>` passes (database agrees with Stripe).
4. RI&E completed and PDF/Word reports downloaded on staging.
5. Owner approval.

## API (dashboard-internal; listed so nothing is duplicated on the website)

| Method | Path | Auth | Result |
| --- | --- | --- | --- |
| GET | `/api/auth/register` | none | `{enabled}` |
| POST | `/api/auth/register` | none | 201 `{user, token, entitlement, next: "/billing"}`; 403 `signup_disabled`; 409 `email_taken`; 400 `invalid_input` |
| POST | `/api/auth/login` | none | 200 `{user, token, entitlement}` |
| POST | `/api/billing/checkout` | Bearer | 200 `{url, sessionId}`; 409 `already_subscribed`; 503 `billing_unavailable` |
| GET | `/api/billing/status[?session_id]` | Bearer | `{entitled, reason, subscription, canManageBilling}` |
| POST | `/api/billing/portal` | Bearer | 200 `{url}`; 409 `no_billing_account` |
| GET | `/api/billing/invoices` | Bearer | `{invoices}` for the caller's organization |
| POST | `/api/billing/webhook` | Stripe signature | Stripe only (legacy alias `/api/payment/webhook`) |
| GET | `/api/health` | none | 200 `{status:"ok", database:"up"}`; 503 when the database is down |

Customer data routes (`/api/dashboard`, `/api/assessments`, `/api/reports/rie`, `/api/risks`, `/api/actions`)
answer 402 `subscription_required` for organizations without a paid subscription.
