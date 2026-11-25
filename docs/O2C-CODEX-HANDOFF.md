# RI&E O2C engineering handoff

Recorded 2026-11-24. This session ends after publishing documentation; the next worker takes exclusive
ownership. No application changes, deployment, merge, production database changes or charges were made.
The business milestone is **one genuine Stripe test-mode purchase with correctly provisioned RI&E access**.

## Repository and preserved state

- Repository: https://github.com/Haldrecht/rie-compliance-dashboard
- Exact worktree: `/Users/ramonsanders/Documents/ChatGPT/Projects/Haldrecht/rie-compliance-dashboard.o2c`
- Local branch: `feat/o2c-vertical-slice-haldrecht`; upstream: `haldrecht/feat/o2c-vertical-slice`.
- Draft PR: https://github.com/Haldrecht/rie-compliance-dashboard/pull/1 (base `main`). Keep draft.
- Application head inspected: `0432db3be861e8b574b110fa4d5ba81933d4b09c`. GitHub PR head and
  `git ls-remote haldrecht refs/heads/feat/o2c-vertical-slice` exactly matched it on 2026-11-24.
- Final handoff head is the documentation commit containing this file (`git rev-parse HEAD`);
  its parent is the application head above. No self-referential SHA is embedded here.
- Initial tracked/untracked status was clean; no intended application changes were unpublished.
  Only these handoff documents were added/edited by this session. Check final publication using commands below.
- Sibling worktree `rie-compliance-dashboard` is on `main` at `e3a2227`; leave it alone.
- `origin` points to **rindex1/rie-compliance-dashboard**, not Haldrecht. Push explicitly to `haldrecht`.
- Ignored local state was retained: `.next/`, `node_modules/`, `e2e-results/`, `.DS_Store`,
  `next-env.d.ts`, `tsconfig.tsbuildinfo`. No ignored env file appeared in the inventory; no credentials
  were opened or copied. Generated test data in `node_modules/.prisma-test` was recreated by the test harness.
- Local evidence archive (not published):
  `/Users/ramonsanders/Documents/ChatGPT/Projects/Haldrecht/o2c-handoff-evidence/20261124/` contains
  `unit-tests.log`, `ci.log` and `prior-local-e2e-results.json`. Canonical passing CI evidence remains
  on GitHub; these logs and generated outputs are explicitly local-only. An offline Git bundle and
  final publication receipt are saved here after the documentation commit.
- No other Claude/Codex process with this repository as its cwd was found during the handoff. This is
  a point-in-time observation, not an ownership lock. No second worker was started.

Application history, newest first:

| Commit | Result |
| --- | --- |
| `0432db3` | Fix unpaid-login redirect race to `/billing` |
| `d83a151` | Closed-tab recovery simulated by stand-in, without browser routing |
| `1d6b5b4` | Paid-but-no-access recovery and reproducible sandbox setup |
| `4a8b014` | Website `RieConfig` entry-route mapping |
| `b31bbb6` | Browser CI pinned to Ubuntu 24.04 |
| `89c23a1` | Browser journey, invoices, Customer Portal |
| `7929d24` | O2C vertical slice |
| `38d878a` | Initial import |

## Architecture and implementation map

- Next.js 15.5.29 App Router, React 19, TypeScript, Prisma 6.16, Stripe SDK 19.2 (lockfile pins exact
  packages). `src/lib/db.ts` initializes Prisma when configured. PostgreSQL production model is
  `prisma/schema.postgres.prisma`; `prisma/schema.prisma` serves the local SQLite path. CI uses Node 22;
  this handoff's local tests used Node 24.19.0 / npm 11.17.0.
- Registration: `src/app/api/auth/register/route.ts` requires `PUBLIC_SIGNUP_ENABLED=true`, validates
  input with Zod, normalizes email, hashes passwords with bcrypt, and creates company + first MANAGER
  in one transaction. Email uniqueness handles repeat/racing registration. It returns a JWT with
  **no paid entitlement**. `register/page.tsx` sends the signed-in customer to `/billing?start=1`.
- Authentication/navigation: `src/lib/auth.ts`, `src/contexts/AuthContext.tsx`, login and success pages.
  Production refuses JWT signing/verification without `JWT_SECRET`. Bearer JWTs are kept in browser
  localStorage. Unpaid login works so customers can reach billing; customer data remains gated.
- Billing: `src/lib/billing/{stripe,checkout,sync,webhook,invoices,entitlement}.ts` and
  `src/app/api/billing/{checkout,status,webhook,portal,invoices}/route.ts`. Checkout uses a configured
  yearly Price, subscription mode and company metadata. One customer per company uses Stripe's
  idempotency key plus a conditional database write. Checkout sessions themselves are not given an
  idempotency key; active-subscription recovery prevents repeat buying after a completed purchase.
  Legacy `/api/payment/create-checkout` and `/api/payment/webhook` alias the billing handlers.
- Provisioning/access: registration provisions the account/tenant; Stripe synchronization provisions
  the company's subscription entitlement. It does not create another user or RI&E automatically.
  `/api/auth/provision` is the existing manual channel: provision token, or an active ADMIN/SUPERUSER
  license with its account-limit policy. It can create user/company/license transactionally. This
  legacy administrative channel is outside the customer-data tenant guard; it has not received a
  comprehensive authorization review in this handoff.
- Persistence: additive SQL in `supabase/migrations/20261122200000_o2c_billing.sql` and
  `20261123010000_o2c_invoices.sql` adds `companies.stripeCustomerId`, `subscriptions`, `stripe_events`,
  `invoices`. Company/customer/subscription/invoice uniqueness and event IDs support idempotency.
  Existing manual `License` access remains. Do not assume `prisma migrate deploy` applies these SQL
  files: follow the runbook's empty-database or existing-schema procedure explicitly.
- Webhooks: verify raw-body signatures with Stripe's SDK; missing/bad signatures fail, missing secret
  returns 503. Fetch fresh subscriptions/invoices from Stripe; conditionally apply snapshots by
  `syncedAt`, reject older writes, protect a live replacement from a terminal old subscription, then
  record the event. Failure returns 5xx so Stripe retries. Effects and ledger insertion are separate,
  idempotent operations, not one transaction; do not describe this as exactly-once delivery.
- Recovery: success-page session reconciliation checks the caller's company. Billing status also lists
  the company's own Stripe subscriptions if access is missing, covering lost webhook + closed tab.
  Another checkout is refused while an active/trialing/past-due subscription exists in Stripe.
- Entitlements: platform ADMIN, active unexpired manual license, ACTIVE/TRIALING subscription, or
  PAST_DUE until seven days after period end. Other/unknown statuses deny. CANCELED denies; cancellation
  scheduled at period end retains the active status until Stripe changes it. Reaching the success URL
  alone grants nothing. Invoice/portal access remains available after entitlement lapses.
- Tenant isolation: `src/lib/tenant.ts` reloads user membership and role from the database on every
  customer-data request, ignoring token company claims. Customer queries scope to `ctx.companyId`;
  linked assessment/risk/assignee IDs must belong to that company. Missing company denies instead of
  widening queries. Protected data routes return 402 when unpaid. Tests cover forged tokens,
  cross-company reads/writes/reports/invoices, and organization-less users. This is application-layer
  isolation; the handoff does not claim a database RLS audit.
- Product flow: paid customer completes `/rie/new`; server validates categories, scores and ownership,
  persists assessments/risks/actions; `/reports/rie` generates PDF/Word from persisted tenant data.
  Website entry points and release gate: [O2C-ROUTE-CONTRACT.md](O2C-ROUTE-CONTRACT.md).

## Verification and failures

Authoritative implementation CI: [run 45217864413](https://github.com/Haldrecht/rie-compliance-dashboard/actions/runs/45217864413)
at `0432db3`, completed 2026-11-23. Job metadata and logs were independently read on 2026-11-24.

| Check | Command / evidence | Result |
| --- | --- | --- |
| Fresh local SQLite + fake Stripe | `env -u TEST_DATABASE_URL npm test` | 69/69, 6 files, 16.27s, exit 0 |
| CI SQLite + fake Stripe | `npm ci`, `npm test` | 69/69 |
| CI Postgres 15 + fake Stripe, including concurrency | `TEST_DATABASE_URL=<disposable-pg> npm test` | 69/69 |
| CI schema upgrade | Apply both SQL files twice to `main` schema; `prisma migrate diff --exit-code` | Pass, no difference |
| CI builds | `npx next build` | Pass in SQLite/build and browser jobs |
| CI Chromium / Postgres / Stripe stand-in | `E2E_DATABASE_URL=<disposable-pg> npm run test:e2e` | 12/12, 51.7s |
| This handoff's whitespace validation | `git diff --check` | Pass |

The browser suite covers registration/retry, decline and forged success URL, payment with duplicate
out-of-order signed events, one subscription/invoice, two-risk RI&E, logout/login persistence, PDF/Word
downloads and content, invoices/portal redirect, failed renewal/recovery, cancellation retaining data,
cross-tenant denial, database outage without sample data, lost-webhook/closed-tab recovery and preflight.
These are CI browser results, not a new manual browser run in this session.

Preserved local cached `e2e-results/results.json` is a **different, failed run** from 2026-11-23T15:45:06Z:
zero executed tests, webServer startup exit 1; no further root cause is present in that report.
SHA256 `cb484b7a9c63a2aa7d199bf8d50506222ab0b6d966141c874efe8568d88a88d0`.
It does not contradict the later successful CI run. No local Postgres/browser/build rerun was needed
to repeat existing head-specific CI evidence. Expected constraint/retry errors in the local unit log
are assertions exercised by passing tests, not outstanding test failures.

Inherited failures **reported by the existing PR body**, not rerun here: `npx tsc --noEmit` has 45
errors (59 on main; reported in untouched files); production `npm audit --omit=dev` has 6 findings
(19 on main, including 3 critical). Changed-code ESLint was reported with no new errors; no exact
file-list command was retained, so this is not a claim that full `npm run lint` passes.
`next.config.ts` ignores build-time TypeScript/ESLint errors, so build success does not clear these.
Production work also lacks password reset, email verification and team invites/email provider.

**No genuine Stripe sandbox verification exists.** Unit tests inject fake gateways; browser tests
point the real SDK at `e2e/stripe-standin.mjs`. Real SDK signature checking is tested locally, but real
Checkout/Portal parameter acceptance, hosted UI, webhook payloads/delivery through Vercel, 3DS,
Smart Retries, test clocks, tax and Stripe invoice PDFs remain unverified. No verified staging origin
is recorded. Do not enable the website's purchase CTA.

## Fresh worker: independently executable next task

First read this file, the route contract and [O2C-SANDBOX-RUNBOOK.md](O2C-SANDBOX-RUNBOOK.md).
Check no other worker owns the worktree; do not reset, clean, switch branches or overwrite changes.
Read any newly applicable AGENTS.md. The next task requiring **no staging approval** is a read-only
takeover/publication check and local test reproduction:

```sh
cd /Users/ramonsanders/Documents/ChatGPT/Projects/Haldrecht/rie-compliance-dashboard.o2c
git status --short --branch
git rev-parse HEAD
git log -2 --oneline
git ls-remote haldrecht refs/heads/feat/o2c-vertical-slice
gh pr view 1 --repo Haldrecht/rie-compliance-dashboard --json url,isDraft,headRefOid,statusCheckRollup
env -u TEST_DATABASE_URL npm test
```

Compare local SHA, remote SHA and PR SHA before edits. On a fresh clone, use remote Haldrecht and
branch `feat/o2c-vertical-slice`, run `npm ci` with Node 22; this runs Prisma generation, not a database
migration. Avoid `npm run dev`: it automatically runs `prisma db push`. Tests with TEST_DATABASE_URL
modify their target database; only use a confirmed disposable test database.

For browser reproduction use `.github/workflows/ci.yml` verbatim: disposable Postgres 15, Node 22,
`npm ci`, `npx playwright install --with-deps chromium`, apply the Postgres Prisma schema to that empty
database with `DATABASE_URL=<disposable-pg> npx prisma db push --schema prisma/schema.postgres.prisma --skip-generate`,
`npx next build`, then `E2E_DATABASE_URL=<disposable-pg> npm run test:e2e`. Ports 3200, 3201 and 12211
must be free. Preserve existing `e2e-results/` before rerunning; Playwright replaces its output.

## Precise owner blockers for the milestone

The current session is **not authorized to deploy or transact**. A fresh worker needs explicit owner
authorization for these concrete staging steps, as detailed in the runbook:

1. HALDRECHT Stripe test/restricted-test secret key through a secure secret channel, approved yearly
   EUR amount in cents, and permission to create/reuse test Product, Price, Portal and webhook objects.
2. One isolated disposable Postgres database, never production or a copy of production, and permission
   to create/apply the staging schema. Confirm its `host:port/db` independently.
3. Approved Vercel **Preview** of remote branch `feat/o2c-vertical-slice`, Preview-only env variables,
   fresh JWT secret, exact HTTPS origin, and a Deployment Protection policy that lets Stripe reach
   `/api/billing/webhook`. Do not alter Production scope.
4. Approval for one synthetic customer's **test-mode** card purchase, then verification and RI&E/report
   checks. This is a simulated payment through real Stripe, not a live charge.

After approval, follow the runbook: setup → preview/preflight → purchase →
`npm run verify:sandbox -- <synthetic-email>` with STRIPE_PRICE_ID explicitly set → confirm RI&E access,
report downloads, invoice and Portal. Save origin, exact deployed SHA, Stripe/DB evidence and browser
results. The verifier's webhook check is database-wide, not customer-specific: corroborate the
synthetic customer's own subscription/invoice/event linkage and actual access before declaring success.
No merge, production changes, live keys or real charges are authorized. Website release needs owner
approval after the route contract's full staging release gate passes.
