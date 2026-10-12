/**
 * A school's own payment gateways on a real MySQL (INS-038…041; client 2026-10-09): the
 * Institution Administrator and the Accountant add and change them, others can't; every credential
 * is stored encrypted and never returned; one default per school; a credential check per gateway.
 */
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { adminUrl } from './db';
import { schoolFixture, type Auth } from './school';
import { newPublicIdPair, uuidToBin } from '../../utils/idGenerator';

describe.skipIf(!adminUrl)('school payment gateways on real MySQL', () => {
  let f: Awaited<ReturnType<typeof schoolFixture>>;
  let accountant: Auth;
  let frontDesk: Auth;

  /** A staff member of the school with one console role. */
  async function staff(roleCode: string): Promise<Auth> {
    const a = await f.account(roleCode === 'ACCOUNTANT' ? 'LATHA' : 'RAMU');
    const type = await f.t.db
      .selectFrom('user_types')
      .select('id')
      .where('public_id', '=', uuidToBin(f.teacherTypeId))
      .executeTakeFirstOrThrow();
    const prof = await f.t.db
      .insertInto('member_profiles')
      .values({
        public_id: newPublicIdPair().bin,
        institution_id: f.school.rowId,
        account_id: a.id,
        user_type_id: String(type.id),
        first_name: 'STAFF',
        last_name: null,
        employee_no: null,
        admission_no: null,
      })
      .executeTakeFirstOrThrow();
    const role = await f.t.db
      .selectFrom('roles')
      .select('id')
      .where('code', '=', roleCode)
      .executeTakeFirstOrThrow();
    await f.t.db
      .insertInto('profile_roles')
      .values({
        institution_id: f.school.rowId,
        profile_id: String(prof.insertId),
        role_id: String(role.id),
      })
      .execute();
    return f.signedIn('console', a.email);
  }

  beforeAll(async () => {
    f = await schoolFixture('Gateway Vidya Kendra');
    accountant = await staff('ACCOUNTANT');
    frontDesk = await staff('FRONT_DESK');
  }, 240_000);
  afterAll(async () => {
    await f?.t.drop();
  });

  const base = '/api/v1/console/payment-gateways';
  const add = (auth: Auth, body: object) =>
    request(f.app).post(base).set(auth).set('Idempotency-Key', randomUUID()).send(body);

  it('lets the administrator and the accountant manage gateways, and nobody else', async () => {
    expect((await request(f.app).get(base).set(frontDesk)).status).toBe(403);
    expect((await request(f.app).get(base).set(accountant)).status).toBe(200);
    expect((await request(f.app).get(base).set(f.school.con)).status).toBe(200);
    expect((await add(frontDesk, {})).status).toBe(403);
  });

  it('stores every credential encrypted and never returns it; one default per school', async () => {
    const SECRET = 'first-secret-123';
    const HOOK = 'first-hook-secret';
    const first = await add(accountant, {
      label: 'School fees',
      keyId: 'rzp_test_AAAAAAA111',
      keySecret: SECRET,
      webhookSecret: HOOK,
      merchantId: 'MERCHANT9',
    });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body).toMatchObject({
      provider: 'RAZORPAY',
      providerName: 'Razorpay',
      label: 'School fees',
      keyIdHint: 'rzp_test_••••111',
      environment: 'TEST',
      status: 'ACTIVE',
      isDefault: true,
      hasWebhookSecret: true,
      hasMerchantId: true,
    });
    expect(first.body.webhookUrl).toMatch(
      new RegExp(`/api/v1/partners/gateway/webhooks/${first.body.id}$`),
    );
    // The first check ran (offline in tests: not accepted).
    expect(first.body.lastCheck).toMatchObject({ ok: false });
    const text = JSON.stringify(first.body);
    for (const s of [SECRET, HOOK, 'rzp_test_AAAAAAA111', 'MERCHANT9']) {
      expect(text).not.toContain(s);
    }
    const row = await f.t.db
      .selectFrom('institution_payment_gateways')
      .selectAll()
      .where('public_id', '=', uuidToBin(first.body.id))
      .executeTakeFirstOrThrow();
    const stored = Buffer.concat([
      row.key_id_enc,
      row.key_secret_enc,
      row.webhook_secret_enc!,
      row.merchant_id_enc!,
    ]).toString('latin1');
    for (const s of [SECRET, HOOK, 'rzp_test_AAAAAAA111', 'MERCHANT9']) {
      expect(stored).not.toContain(s);
    }
    const audit = await f.t.db
      .selectFrom('audit_log')
      .select(['after_state'])
      .where('action', '=', 'PAYMENT_GATEWAY_ADDED')
      .where('entity_ref', '=', uuidToBin(first.body.id))
      .executeTakeFirstOrThrow();
    expect(JSON.stringify(audit.after_state)).not.toContain(SECRET);

    // Wrong forms and test keys are named.
    const bad = await add(f.school.con, { label: 'x', keyId: 'pk_live_1', keySecret: 'short' });
    expect(bad.status).toBe(422);
    expect(bad.body.errors.map((e: { field: string }) => e.field).sort()).toEqual([
      'keyId',
      'keySecret',
      'label',
    ]);

    // A second gateway; making it the default takes it from the first.
    const second = await add(f.school.con, {
      label: 'Transport fees',
      keyId: 'rzp_live_BBBBBBB222',
      keySecret: 'second-secret-456',
    });
    expect(second.body).toMatchObject({ isDefault: false, environment: 'LIVE' });
    const stale = await request(f.app)
      .patch(`${base}/${second.body.id}`)
      .set(f.school.con)
      .set('If-Match', '"v999"')
      .send({ isDefault: true });
    expect(stale.status).toBe(412);
    const made = await request(f.app)
      .patch(`${base}/${second.body.id}`)
      .set(f.school.con)
      .set('If-Match', `"v${second.body.version}"`)
      .send({ isDefault: true, label: 'Transport' });
    expect(made.status, JSON.stringify(made.body)).toBe(200);
    expect(made.body).toMatchObject({ isDefault: true, label: 'Transport' });
    let list = (await request(f.app).get(base).set(accountant)).body.items;
    expect(list.map((g: { label: string; isDefault: boolean }) => [g.label, g.isDefault])).toEqual([
      ['Transport', true],
      ['School fees', false],
    ]);

    // A new secret replaces the old one; leaving it out keeps it; the old check no longer applies.
    const before = row.key_secret_enc.toString('hex');
    const kept = await request(f.app)
      .patch(`${base}/${first.body.id}`)
      .set(accountant)
      .set('If-Match', `"v${list[1].version}"`)
      .send({ label: 'School fees (main)' });
    const unchanged = await f.t.db
      .selectFrom('institution_payment_gateways')
      .select(['key_secret_enc'])
      .where('public_id', '=', uuidToBin(first.body.id))
      .executeTakeFirstOrThrow();
    expect(unchanged.key_secret_enc.toString('hex')).toBe(before);
    const replaced = await request(f.app)
      .patch(`${base}/${first.body.id}`)
      .set(accountant)
      .set('If-Match', `"v${kept.body.version}"`)
      .send({ keySecret: 'a-brand-new-secret' });
    expect(replaced.body.lastCheck).toBeNull();

    // Disabling the default hands it to the newest active gateway.
    list = (await request(f.app).get(base).set(accountant)).body.items;
    const transport = list.find((g: { label: string }) => g.label === 'Transport');
    const off = await request(f.app)
      .patch(`${base}/${transport.id}`)
      .set(f.school.con)
      .set('If-Match', `"v${transport.version}"`)
      .send({ status: 'DISABLED' });
    expect(off.body).toMatchObject({ status: 'DISABLED', isDefault: false });
    list = (await request(f.app).get(base).set(accountant)).body.items;
    expect(list.find((g: { label: string }) => g.label === 'School fees (main)').isDefault).toBe(
      true,
    );
    const disabledDefault = await request(f.app)
      .patch(`${base}/${transport.id}`)
      .set(f.school.con)
      .set('If-Match', `"v${off.body.version}"`)
      .send({ isDefault: true });
    expect(disabledDefault.body.code).toBe('PG.DEFAULT_DISABLED');
  });

  it("never shows another school's gateway", async () => {
    const other = await schoolFixture('Other Vidya Kendra');
    try {
      const mine = (await request(f.app).get(base).set(f.school.con)).body.items[0];
      const theirs = await request(other.app)
        .patch(`${base}/${mine.id}`)
        .set(other.school.con)
        .set('If-Match', `"v${mine.version}"`)
        .send({ label: 'Taken over' });
      expect(theirs.status).toBe(404);
      expect((await request(other.app).get(base).set(other.school.con)).body.items).toEqual([]);
    } finally {
      await other.t.drop();
    }
  }, 240_000);
});
