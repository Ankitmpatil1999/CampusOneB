/**
 * Plans on a real MySQL (SAS-027…029; FR-SAS-05; prototype o.plans; client 2026-10-03 "give a
 * provision to change and add the plans"): the default plans as version 1; adding a plan; changing a
 * plan adds a version; an institution whose period has started keeps its version until renewal,
 * one that hasn't started follows the new terms.
 */
import { randomInt, randomUUID } from 'node:crypto';
import request from 'supertest';
import type { Express } from 'express';
import { adminUrl, createTestDatabase, insertInstitution, type TestDatabase } from './db';
import { buildHttpApp, codeOf } from './http-app';
import { newPublicIdPair } from '../../utils/idGenerator';
import { hashSecret } from '../../utils/password';

const PASSWORD = 'Ringpe@2026';

describe.skipIf(!adminUrl)('plans on real MySQL', () => {
  let t: TestDatabase;
  let h: Awaited<ReturnType<typeof buildHttpApp>>;
  let app: Express;
  let ops: Record<string, string>;

  beforeAll(async () => {
    t = await createTestDatabase();
    h = await buildHttpApp(t);
    app = h.app;
    ops = await operator('PLATFORM_ADMIN');
  }, 120_000);
  afterAll(async () => {
    await t?.drop();
  });

  async function operator(role: string) {
    const email = `ops.${randomInt(0, 1e9)}@ringpe.example`;
    const acc = await t.db
      .insertInto('platform_accounts')
      .values({
        public_id: newPublicIdPair().bin,
        mobile: `9${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`,
        email,
        first_name: 'ARJUN',
        last_name: 'MEHTA',
      })
      .executeTakeFirstOrThrow();
    await t.db
      .insertInto('account_credentials')
      .values({
        account_id: String(acc.insertId),
        kind: 'PASSWORD',
        hash: await hashSecret(PASSWORD),
      })
      .execute();
    const r = await t.db
      .selectFrom('roles')
      .select('id')
      .where('code', '=', role)
      .executeTakeFirstOrThrow();
    await t.db
      .insertInto('operator_accounts')
      .values({
        public_id: newPublicIdPair().bin,
        account_id: String(acc.insertId),
        role_id: String(r.id),
      })
      .execute();
    const step1 = await request(app)
      .post('/api/v1/ops/auth/signin')
      .send({ email, password: PASSWORD });
    const v = await request(app)
      .post('/api/v1/ops/auth/otp/verify')
      .send({ challengeId: step1.body.challengeId, otp: codeOf(h.sms.sent.at(-1)) });
    const cookies = ([] as string[])
      .concat(v.headers['set-cookie'] ?? [])
      .map((c) => c.split(';')[0] ?? '');
    return { Cookie: cookies.join('; '), 'X-CSRF-Token': v.body.csrfToken as string };
  }

  const body = (over: object = {}) => ({
    name: `Campus Starter ${randomInt(0, 1e6)}`,
    description: 'Small schools',
    cycle: 'MONTHLY',
    price: { amount: '4500.00', currency: 'INR' },
    trialDays: 30,
    modules: ['Fees', 'Attendance', 'Wallet and payments'],
    allowances: { members: 500, sms: 2000, whatsapp: 0, storageGb: 10 },
    platformFee: {
      flat: { amount: '1.00', currency: 'INR' },
      upTo: { amount: '100.00', currency: 'INR' },
      percent: '0.50',
    },
    ...over,
  });

  it('lists the default plans as version 1 and adds a plan (SAS-027, SAS-028)', async () => {
    const list = await request(app).get('/api/v1/ops/plans').set(ops);
    expect(list.body.modules).toHaveLength(10);
    const plus = list.body.items.find((p: { code: string }) => p.code === 'PL-PLUS');
    expect(plus).toMatchObject({
      version: 1,
      cycle: 'ANNUAL',
      price: { amount: '180000.00', currency: 'INR' },
      trialDays: 30,
      platformFee: {
        flat: { amount: '1.00', currency: 'INR' },
        upTo: { amount: '100.00', currency: 'INR' },
        percent: '0.50',
      },
    });

    const add = (b: object) =>
      request(app).post('/api/v1/ops/plans').set(ops).set('Idempotency-Key', randomUUID()).send(b);
    const created = await add(body({ name: 'Campus Starter' }));
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      name: 'Campus Starter',
      version: 1,
      modules: ['Attendance', 'Fees', 'Wallet and payments'],
      institutions: 0,
    });
    expect((await add(body({ name: 'campus starter' }))).body).toMatchObject({
      code: 'SAS.PLAN_NAME_TAKEN',
      detail: 'Another plan already has this name',
    });
    expect((await add(body({ modules: [] }))).body.errors[0]).toMatchObject({
      field: 'modules',
      code: 'SAS.MODULES_REQUIRED',
    });
    const bad = await add(body({ price: { amount: '0.00', currency: 'INR' } }));
    expect(bad.status).toBe(422);
    // A role without plans.edit can read but not add.
    const support = await operator('SUPPORT_OFFICER');
    expect((await request(app).get('/api/v1/ops/plans').set(support)).status).toBe(200);
    expect(
      (
        await request(app)
          .post('/api/v1/ops/plans')
          .set(support)
          .set('Idempotency-Key', randomUUID())
          .send(body())
      ).status,
    ).toBe(403);
  });

  it('changes terms as a new version; a started period keeps its version until renewal (SAS-029)', async () => {
    const created = await request(app)
      .post('/api/v1/ops/plans')
      .set(ops)
      .set('Idempotency-Key', randomUUID())
      .send(body({ modules: ['Fees', 'Transport', 'Wallet and payments'] }));
    const plan = created.body as { id: string; etag: number; name: string };
    const row = await t.db
      .selectFrom('plans')
      .select(['id', 'current_version_id'])
      .where('public_id', '=', Buffer.from(plan.id.replace(/-/g, ''), 'hex'))
      .executeTakeFirstOrThrow();
    // Two institutions on version 1: one whose period has started, one still onboarding.
    const started = await insertInstitution(t.db);
    const onboarding = await insertInstitution(t.db);
    for (const [inst, status] of [
      [started, 'ACTIVE'],
      [onboarding, null],
    ] as const) {
      await t.db
        .insertInto('subscriptions')
        .values({
          institution_id: inst.id,
          plan_id: row.id,
          plan_version_id: row.current_version_id!,
          status,
        })
        .execute();
    }

    const change = (etag: number, b: object) =>
      request(app)
        .patch(`/api/v1/ops/plans/${plan.id}`)
        .set(ops)
        .set('If-Match', `"v${etag}"`)
        .send(b);
    const changed = await change(
      plan.etag,
      body({
        name: plan.name,
        price: { amount: '5000.00', currency: 'INR' },
        modules: ['Fees', 'Wallet and payments'],
      }),
    );
    expect(changed.status).toBe(200);
    expect(changed.body).toMatchObject({
      version: 2,
      price: { amount: '5000.00', currency: 'INR' },
      removedModules: ['Transport'],
      institutions: 2,
    });
    expect((await change(plan.etag, body({ name: plan.name }))).status).toBe(412);
    // Renaming only keeps the version.
    const renamed = await change(
      changed.body.etag,
      body({
        name: `${plan.name} Plus`,
        price: { amount: '5000.00', currency: 'INR' },
        modules: ['Fees', 'Wallet and payments'],
      }),
    );
    expect(renamed.body).toMatchObject({ version: 2, name: `${plan.name} Plus` });

    // The started institution keeps Transport (version 1); the onboarding one follows version 2.
    const transport = async (inst: { publicId: string }) =>
      (
        (await request(app).get(`/api/v1/ops/institutions/${inst.publicId}/features`).set(ops)).body
          .features as { key: string; lock: { kind: string } | null }[]
      ).find((f) => f.key === 'transport')?.lock;
    expect(await transport(started)).toBeNull();
    expect(await transport(onboarding)).toMatchObject({ kind: 'PLAN' });
  });
});
