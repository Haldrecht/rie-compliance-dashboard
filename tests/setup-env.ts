import path from 'node:path';

// Synthetic configuration only: no real keys. The Stripe API is replaced by a fake in the tests;
// webhook signatures are generated and verified with Stripe's real library code.
process.env.DATABASE_URL = `file:${path.resolve(__dirname, '../node_modules/.prisma-test/test.db')}`;
process.env.JWT_SECRET = 'test-jwt-secret';
process.env.STRIPE_SECRET_KEY = 'sk_test_synthetic';
process.env.STRIPE_PRICE_ID = 'price_RIE2026TEST';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_synthetic_test_secret';
process.env.NEXT_PUBLIC_APP_URL = 'https://dashboard.test.example';
process.env.PUBLIC_SIGNUP_ENABLED = 'true';
