import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import { generateToken, hashPassword } from '@/lib/auth';
import { GET as listAssessments, POST as createAssessment } from '@/app/api/assessments/route';
import { POST as report } from '@/app/api/reports/rie/route';
import { GET as listRisks, POST as createRisk } from '@/app/api/risks/route';
import { GET as getRisk, DELETE as deleteRisk } from '@/app/api/risks/[id]/route';
import { GET as listActions, POST as createAction } from '@/app/api/actions/route';
import { GET as dashboard } from '@/app/api/dashboard/route';
import { installFakeStripe, req, resetDb, wizardPayload } from './helpers/app';

// Two paying organizations; each must see only its own data.

async function org(name: string) {
  const company = await prisma.company.create({ data: { name } });
  await prisma.subscription.create({
    data: {
      companyId: company.id,
      stripeSubscriptionId: `sub_${name.replace(/\W/g, '')}`,
      stripeCustomerId: `cus_${name.replace(/\W/g, '')}`,
      status: 'ACTIVE',
      currentPeriodEnd: new Date(Date.now() + 30 * 86400_000),
    },
  });
  const user = await prisma.user.create({
    data: { email: `${name.replace(/\W/g, '').toLowerCase()}@tenant.test`, name: `${name} Manager`, password: await hashPassword('password-123'), role: 'MANAGER', companyId: company.id },
  });
  const token = generateToken({ userId: user.id, email: user.email, role: user.role, companyId: company.id });
  const created = await (await createAssessment(req('POST', '/api/assessments', { token, body: wizardPayload(name) }))).json();
  const risk = await prisma.risk.findFirstOrThrow({ where: { assessmentId: created.id } });
  return { company, user, token, assessmentId: created.id as string, riskId: risk.id };
}

let a: Awaited<ReturnType<typeof org>>;
let b: Awaited<ReturnType<typeof org>>;

beforeEach(async () => {
  await resetDb();
  installFakeStripe();
  a = await org('Alpha BV');
  b = await org('Beta BV');
});

describe('tenant isolation', () => {
  it('lists only the caller organization\'s assessments, risks and actions', async () => {
    const assessments = (await (await listAssessments(req('GET', '/api/assessments', { token: a.token }))).json()).assessments;
    expect(assessments.map((x: { id: string }) => x.id)).toEqual([a.assessmentId]);
    const risks = (await (await listRisks(req('GET', '/api/risks', { token: a.token }))).json());
    const riskIds = JSON.stringify(risks);
    expect(riskIds).toContain(a.riskId);
    expect(riskIds).not.toContain(b.riskId);
    const actions = await listActions(req('GET', '/api/actions', { token: a.token }));
    expect(actions.status).toBe(200);
  });

  it('refuses another organization\'s report', async () => {
    const res = await report(req('POST', '/api/reports/rie', { token: a.token, body: { assessmentId: b.assessmentId, format: 'pdf' } }));
    expect(res.status).toBe(404);
  });

  it('refuses reading or deleting another organization\'s risk by id', async () => {
    const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
    expect((await getRisk(req('GET', `/api/risks/${a.riskId}`, { token: a.token }), ctx(a.riskId))).status).toBe(200);
    expect((await getRisk(req('GET', `/api/risks/${b.riskId}`, { token: a.token }), ctx(b.riskId))).status).toBe(404);
    expect((await deleteRisk(req('DELETE', `/api/risks/${b.riskId}`, { token: a.token }), ctx(b.riskId))).status).toBe(404);
    expect(await prisma.risk.count({ where: { id: b.riskId } })).toBe(1);
  });

  it('refuses to attach records to another organization\'s assessment, risk or user', async () => {
    const risk = await createRisk(req('POST', '/api/risks', { token: a.token, body: { assessmentId: b.assessmentId, category: 'PSYCHOSOCIAL', title: 'x', description: 'x', location: 'x', probability: 2, impact: 2 } }));
    expect(risk.status).toBe(404);
    for (const link of [{ assessmentId: b.assessmentId }, { riskId: b.riskId }, { assignedToId: b.user.id }]) {
      const action = await createAction(req('POST', '/api/actions', { token: a.token, body: { title: 't', description: 'd', priority: 'HIGH', ...link } }));
      expect(action.status).toBe(404);
    }
    const own = await createAction(req('POST', '/api/actions', { token: a.token, body: { title: 't', description: 'd', priority: 'HIGH', riskId: a.riskId, assignedToId: a.user.id } }));
    expect(own.status).toBe(201);
  });

  it('uses database membership, not token claims: a token claiming another companyId sees only its own organization', async () => {
    const forgedClaims = generateToken({ userId: a.user.id, email: a.user.email, role: 'MANAGER', companyId: b.company.id });
    const listed = (await (await listAssessments(req('GET', '/api/assessments', { token: forgedClaims }))).json()).assessments;
    expect(listed.map((x: { id: string }) => x.id)).toEqual([a.assessmentId]);
  });

  it('denies customer data to a user without an organization instead of leaking every organization', async () => {
    // Before this change, a missing companyId made Prisma drop the filter and return all rows.
    const loner = await prisma.user.create({ data: { email: 'loner@tenant.test', name: 'Loner', password: 'x', role: 'MANAGER' } });
    await prisma.license.create({ data: { userId: loner.id, plan: 'ADMIN', status: 'ACTIVE' } });
    const token = generateToken({ userId: loner.id, email: loner.email, role: loner.role });
    const res = await listRisks(req('GET', '/api/risks', { token }));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('no_organization');
    expect((await report(req('POST', '/api/reports/rie', { token, body: { assessmentId: a.assessmentId, format: 'pdf' } }))).status).toBe(403);
  });

  it('rejects unauthenticated and forged tokens', async () => {
    expect((await dashboard(req('GET', '/api/dashboard'))).status).toBe(401);
    expect((await dashboard(req('GET', '/api/dashboard', { token: 'not-a-jwt' }))).status).toBe(401);
  });

  it('keeps admin-provisioned licensed customers working without a Stripe subscription', async () => {
    const company = await prisma.company.create({ data: { name: 'Legacy BV' } });
    const user = await prisma.user.create({ data: { email: 'legacy@tenant.test', name: 'Legacy', password: 'x', role: 'MANAGER', companyId: company.id } });
    await prisma.license.create({ data: { userId: user.id, plan: 'SUPERUSER', status: 'ACTIVE' } });
    const token = generateToken({ userId: user.id, email: user.email, role: user.role, companyId: company.id });
    expect((await dashboard(req('GET', '/api/dashboard', { token }))).status).toBe(200);
  });
});
