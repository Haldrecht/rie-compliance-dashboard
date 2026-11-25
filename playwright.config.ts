import { defineConfig, devices } from '@playwright/test';

// Browser acceptance test: production build (`next start`), real Postgres, and the local Stripe
// stand-in (e2e/stripe-standin.mjs). Requires E2E_DATABASE_URL pointing at a disposable database
// whose schema is applied (see docs/O2C-SANDBOX-RUNBOOK.md). Never point this at production.
const DATABASE_URL = process.env.E2E_DATABASE_URL;
if (!DATABASE_URL) throw new Error('Set E2E_DATABASE_URL to a disposable Postgres database');

export const E2E = {
  app: 'http://127.0.0.1:3200',
  standin: 'http://127.0.0.1:12211',
  webhookSecret: 'whsec_e2e_standin_secret',
  databaseUrl: DATABASE_URL,
};

const appEnv = {
  DATABASE_URL,
  JWT_SECRET: 'e2e-jwt-secret',
  STRIPE_SECRET_KEY: 'sk_test_e2e_standin',
  STRIPE_PRICE_ID: 'price_E2ERIEYEARLY',
  STRIPE_WEBHOOK_SECRET: E2E.webhookSecret,
  STRIPE_API_BASE: E2E.standin,
  NEXT_PUBLIC_APP_URL: E2E.app,
  PUBLIC_SIGNUP_ENABLED: 'true',
  NEXT_TELEMETRY_DISABLED: '1',
};

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  reporter: [['list'], ['json', { outputFile: 'e2e-results/results.json' }]],
  outputDir: 'e2e-results/artifacts',
  use: { baseURL: E2E.app, trace: 'retain-on-failure', screenshot: 'only-on-failure', ...devices['Desktop Chrome'] },
  webServer: [
    {
      command: 'node e2e/stripe-standin.mjs',
      url: `${E2E.standin}/__test/health`,
      env: { STANDIN_PORT: '12211', APP_URL: E2E.app, STRIPE_WEBHOOK_SECRET: E2E.webhookSecret },
      reuseExistingServer: false,
    },
    {
      command: 'npx next start -p 3200 -H 127.0.0.1',
      url: `${E2E.app}/login`,
      env: appEnv,
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
