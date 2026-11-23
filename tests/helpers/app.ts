import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { setStripeGatewayForTests } from '@/lib/billing/stripe';
import { FakeStripe } from './fake-stripe';

export const BASE = 'https://dashboard.test.example';

export function req(method: string, path: string, opts: { token?: string; body?: unknown; raw?: string; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  let body: string | undefined;
  if (opts.raw !== undefined) body = opts.raw;
  else if (opts.body !== undefined) {
    body = JSON.stringify(opts.body);
    headers['content-type'] = 'application/json';
  }
  return new NextRequest(new URL(path, BASE), { method, headers, body });
}

export async function resetDb() {
  // Children before parents.
  await prisma.stripeEvent.deleteMany();
  await prisma.invoice.deleteMany();
  await prisma.subscription.deleteMany();
  await prisma.riskComment.deleteMany();
  await prisma.countermeasure.deleteMany();
  await prisma.action.deleteMany();
  await prisma.risk.deleteMany();
  await prisma.assessmentApproval.deleteMany();
  await prisma.assessment.deleteMany();
  await prisma.license.deleteMany();
  await prisma.user.deleteMany();
  await prisma.company.deleteMany();
}

export function installFakeStripe() {
  const fake = new FakeStripe();
  setStripeGatewayForTests(fake.gateway());
  return fake;
}

/** A synthetic RI&E wizard payload in the exact shape src/app/rie/new/page.tsx sends. */
export function wizardPayload(companyName: string) {
  return {
    title: `RI&E ${companyName} 2026`,
    rieData: {
      company: { companyName, address: 'Teststraat 1, Utrecht', employeeCount: 12, industry: 'Bouw', assessmentDate: '2026-11-22', executedBy: 'Synthetische Klant', version: '1.0' },
      goalAndScope: { goals: ["Alle arbeidsrisico's in kaart brengen", 'Plan van Aanpak opstellen'], scope: { locations: ['Utrecht'] } },
      managementSystem: {},
      riskMethod: { probabilityScale: 5, severityScale: 5 },
      workAreas: [
        {
          name: 'Algemeen',
          risks: [
            { riskId: 'r1', category: 'PHYSICAL', title: 'Vallen van hoogte', description: 'Werken op steigers', location: 'Bouwplaats', probability: 4, severity: 5, score: 20 },
            { riskId: 'r2', category: 'CHEMICAL', title: 'Oplosmiddelen', description: 'Dampen bij verfwerk', location: 'Werkplaats', probability: 3, severity: 3, score: 9 },
            { riskId: 'r3', category: 'ERGONOMIC', title: 'Tillen', description: 'Zware materialen', location: 'Magazijn', probability: 2, severity: 2, score: 4 },
            { riskId: 'r4', category: 'ORGANIZATIONAL', title: 'Werkdruk', description: 'Lange diensten', location: 'Kantoor', probability: 3, severity: 4, currentMeasures: ['Roosterbeleid'] },
          ],
        },
      ],
      planOfApproach: [],
      involvement: {},
      documentChecklist: {},
    },
  };
}
