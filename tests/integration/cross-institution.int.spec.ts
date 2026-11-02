/**
 * Cross-institution reporting on a real MySQL (Phase 8.5; SRS 26.9.1 and 24, CR-18; RNG-GOV-030…035,
 * RNG-RPT-118…128; RPT-009…012):
 * - aggregates for a stated selection and period with a reason, totals and averages;
 * - every access recorded, refusals included: a role without the entitlement, a selection too large;
 * - a drill-through is its own recorded access, for the platform administrator only;
 * - the access record reads and exports for the operator who holds access.view.
 */
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { newPublicIdPair } from '../../utils/idGenerator';
import { adminUrl } from './db';
import { schoolFixture, type Auth } from './school';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!adminUrl)('cross-institution reporting on real MySQL', () => {
  let f: Awaited<ReturnType<typeof schoolFixture>>;
  let otherId: string;
  let support: Auth;
  let recon: Auth;
  let accessId: string;
  const today = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
  const monthAgo = new Date(Date.now() + 330 * 60_000 - 30 * 86_400_000).toISOString().slice(0, 10);
  const post = (path: string, auth: Auth, body: object = {}) =>
    request(f.app).post(`/api/v1${path}`).set(auth).set('Idempotency-Key', randomUUID()).send(body);
  const get = (path: string, auth: Auth = f.ops) =>
    request(f.app).get(`/api/v1${path}`).set(auth).set('X-CampusOne-Surface', 'ops');
  const operator = async (first: string, code: string) => {
    const acct = await f.account(first);
    const role = await f.t.db
      .selectFrom('roles')
      .select('id')
      .where('code', '=', code)
      .executeTakeFirstOrThrow();
    await f.t.db
      .insertInto('operator_accounts')
      .values({ public_id: newPublicIdPair().bin, account_id: acct.id, role_id: String(role.id) })
      .execute();
    return f.signedIn('ops', acct.email);
  };
  const setting = async (key: string, value: number) => {
    const s = (await get('/ops/settings')).body.items.find((x: { key: string }) => x.key === key);
    const r = await request(f.app)
      .put(`/api/v1/ops/settings/${key}`)
      .set(f.ops)
      .set('If-Match', `"v${s.version}"`)
      .send({ value, reason: 'Cross-institution test' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  };
  const compare = (auth: Auth, extra: object = {}) =>
    post('/ops/cross-institution-reports', auth, {
      selection: { institutionIds: [f.school.id, otherId] },
      period: { from: monthAgo, to: today },
      reason: 'Quarterly review of school activity',
      ...extra,
    });

  beforeAll(async () => {
    f = await schoolFixture('Comparison School');
    await f.student('Asha');
    await f.payer('Ravi', 0);
    const plans = (await get('/ops/plans')).body.items;
    const other = await post('/ops/institutions', f.ops, {
      name: `Second School ${randomUUID().slice(0, 6)}`,
      address: 'Car Street, Mangaluru',
      city: 'Mangaluru',
      primaryContact: {
        name: 'Meera Shetty',
        email: 'office@second.example.in',
        mobile: '9845099999',
      },
      adminEmail: (await f.account('MEERA')).email,
      planId: plans[0].id,
    });
    expect(other.status, JSON.stringify(other.body)).toBe(201);
    otherId = other.body.id;
    support = await operator('SUNIL', 'SUPPORT_OFFICER');
    recon = await operator('RAHUL', 'RECON_OFFICER');
  }, 240_000);
  afterAll(async () => {
    await f?.t.drop();
  });

  it('compares a stated selection with totals and averages, and records the access', async () => {
    const r = await compare(f.ops);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.accessNo).toMatch(/^ACC-\d{2}-\d{4,}$/);
    expect(r.body.rows).toHaveLength(2);
    const mine = r.body.rows.find(
      (x: { institutionId: string }) => x.institutionId === f.school.id,
    );
    const theirs = r.body.rows.find((x: { institutionId: string }) => x.institutionId === otherId);
    expect(mine.values.membersActive).toBeGreaterThanOrEqual(2);
    expect(theirs.values.membersActive).toBeLessThan(mine.values.membersActive);
    expect(r.body.columns.map((c: { key: string }) => c.key)).toEqual(
      expect.arrayContaining(['membersActive', 'feesCollected', 'dispatches', 'ticketsOpen']),
    );
    expect(r.body.totals.membersActive).toBe(
      mine.values.membersActive + theirs.values.membersActive,
    );
    expect(r.body.averages.membersActive).toBe(
      Math.round(((mine.values.membersActive + theirs.values.membersActive) / 2) * 10) / 10,
    );
    accessId = r.body.accessId;
    expect((await compare(f.ops, { reason: 'short' })).body.errors[0].code).toBe('RPT.XI_REASON');
    expect((await compare(f.ops, { selection: {} })).body.errors[0].code).toBe('RPT.XI_SELECTION');
  });

  it('refuses a role without the entitlement and a selection too large — and records both', async () => {
    const refused = await compare(support);
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('RPT.XI_NOT_ENTITLED');
    expect(refused.body.rows).toBeUndefined();
    await setting('xi.selection.max', 1);
    const big = await compare(f.ops);
    expect(big.body).toMatchObject({ code: 'RPT.XI_SELECTION_TOO_LARGE', params: { max: 1 } });
    await setting('xi.selection.max', 25);
    const log = await get('/ops/access-records?outcome=Refused');
    expect(log.status, JSON.stringify(log.body)).toBe(200);
    expect(
      log.body.items.map((x: { actor: { role: string }; note: string }) => [x.actor.role, x.note]),
    ).toEqual(
      expect.arrayContaining([
        ['SUPPORT_OFFICER', 'RPT.XI_NOT_ENTITLED'],
        ['PLATFORM_ADMIN', 'RPT.XI_SELECTION_TOO_LARGE'],
      ]),
    );
    expect((await get('/ops/access-records', support)).status).toBe(403);
  });

  it('drills into one institution as a separate access, for the platform administrator only', async () => {
    const d = await post(`/ops/cross-institution-reports/${accessId}/drill-throughs`, f.ops, {
      institutionId: f.school.id,
      reason: 'Check member numbers by type',
    });
    expect(d.status, JSON.stringify(d.body)).toBe(201);
    expect(d.body.figures.breakdowns.membersByType.length).toBeGreaterThan(0);
    expect(
      (
        await post(`/ops/cross-institution-reports/${accessId}/drill-throughs`, f.ops, {
          institutionId: randomUUID(),
          reason: 'Check member numbers by type',
        })
      ).body.code,
    ).toBe('RPT.XI_NOT_IN_SELECTION');
    // The reconciliation officer may compare but not drill through (Q10a).
    const own = await compare(recon);
    expect(own.status, JSON.stringify(own.body)).toBe(201);
    const refused = await post(
      `/ops/cross-institution-reports/${own.body.accessId}/drill-throughs`,
      recon,
      { institutionId: f.school.id, reason: 'Check member numbers by type' },
    );
    expect(refused.body.code).toBe('RPT.XI_NOT_ENTITLED');
    // Another platform administrator's comparison is not theirs to drill into.
    const priya = await operator('PRIYA', 'PLATFORM_ADMIN');
    expect(
      (
        await post(`/ops/cross-institution-reports/${accessId}/drill-throughs`, priya, {
          institutionId: f.school.id,
          reason: 'Check member numbers by type',
        })
      ).body.code,
    ).toBe('RPT.ACCESS_NOT_FOUND');
    const log = (await get('/ops/access-records')).body.items as {
      kind: string;
      outcome: string;
      parentAccessNo: string | null;
      institutions: string[];
    }[];
    expect(log.filter((x) => x.kind === 'Drill-through')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ outcome: 'Returned', parentAccessNo: expect.any(String) }),
        expect.objectContaining({ outcome: 'Refused' }),
      ]),
    );
  });

  it('exports the access record for the operator who asked', async () => {
    const x = await post('/ops/access-records/exports', f.ops, { filters: {} });
    expect(x.status, JSON.stringify(x.body)).toBe(202);
    let e = await get(`/exports/${x.body.exportId}`);
    for (let i = 0; i < 20 && e.body.status !== 'READY'; i++) {
      await wait(100);
      e = await get(`/exports/${x.body.exportId}`);
    }
    expect(e.body, JSON.stringify(e.body)).toMatchObject({ status: 'READY' });
    expect(e.body.rows).toBeGreaterThanOrEqual(5);
    const csv = (await request(f.app).get(e.body.file.url).buffer(true)).text;
    expect(csv).toContain('Access,Kind,Of,Time,Actor,Role');
    expect(csv).toContain('SUPPORT_OFFICER');
    expect((await get(`/exports/${x.body.exportId}`, recon)).status).toBe(404);
  });
});
