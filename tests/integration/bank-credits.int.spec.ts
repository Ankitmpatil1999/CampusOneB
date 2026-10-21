/**
 * Partner clients and bank credits on a real MySQL (Phase 3.5; SRS 8.13, BR-16, CR-08, RC-12;
 * IDN-043, INT-001…008, WAL-010…013, REC-012/017):
 * - an operator creates a client (secret once), tokens are issued or refused and logged, a new token
 *   ends the earlier one, a suspended client gets nothing;
 * - signed calls: wrong signature or stale timestamp refused; validate answers 000/002/003;
 * - notify credits an active wallet once per UTR + bank transaction id, holds a suspended wallet's
 *   credit (released once the wallet is active again), and a held credit is returned only after a
 *   second operator approves;
 * - the ledger check finds no difference, and reports a tampered balance without correcting it.
 */
import { createHmac, randomInt, randomUUID } from 'node:crypto';
import request from 'supertest';
import { onboardStaff } from './staff';
import type { Express } from 'express';
import { adminUrl, createTestDatabase, type TestDatabase } from './db';
import { buildHttpApp, codeOf } from './http-app';
import { newPublicIdPair, uuidToBin } from '../../utils/idGenerator';
import { hashSecret } from '../../utils/password';

const PASSWORD = 'Ringpe@2026';
const mobile = () => `9${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`;

describe.skipIf(!adminUrl)('partner clients and bank credits on real MySQL', () => {
  let t: TestDatabase;
  let h: Awaited<ReturnType<typeof buildHttpApp>>;
  let app: Express;
  let maker: Record<string, string>;
  let checker: Record<string, string>;
  let recon: Record<string, string>;
  let school: { id: string; rowId: string; code: string; con: Record<string, string> };
  let teacherTypeId = '';
  let client: { id: string; clientId: string; secret: string };

  async function account(first: string) {
    const email = `${first.toLowerCase()}.${randomInt(0, 1e9)}@example.in`;
    const r = await t.db
      .insertInto('platform_accounts')
      .values({
        public_id: newPublicIdPair().bin,
        mobile: mobile(),
        email,
        first_name: first,
        last_name: 'RAO',
      })
      .executeTakeFirstOrThrow();
    await t.db
      .insertInto('account_credentials')
      .values({
        account_id: String(r.insertId),
        kind: 'PASSWORD',
        hash: await hashSecret(PASSWORD),
      })
      .execute();
    return { id: String(r.insertId), email };
  }
  async function signedIn(surface: 'ops' | 'console', email: string) {
    const base = surface === 'ops' ? '/api/v1/ops/auth' : '/api/v1/auth/console';
    const step1 = await request(app).post(`${base}/signin`).send({ email, password: PASSWORD });
    const r = await request(app)
      .post(`${base}/otp/verify`)
      .send({ challengeId: step1.body.challengeId, otp: codeOf(h.sms.sent.at(-1)) });
    expect(r.status).toBe(200);
    const cookies = ([] as string[])
      .concat(r.headers['set-cookie'] ?? [])
      .map((c) => c.split(';')[0] ?? '');
    return { Cookie: cookies.join('; '), 'X-CSRF-Token': r.body.csrfToken as string };
  }
  async function operator(first: string, roleCode = 'PLATFORM_ADMIN') {
    const a = await account(first);
    const role = await t.db
      .selectFrom('roles')
      .select('id')
      .where('code', '=', roleCode)
      .executeTakeFirstOrThrow();
    await t.db
      .insertInto('operator_accounts')
      .values({ public_id: newPublicIdPair().bin, account_id: a.id, role_id: String(role.id) })
      .execute();
    return signedIn('ops', a.email);
  }
  /** A member of the school with its campus wallet and virtual account. */
  async function member(name: string) {
    const r = await onboardStaff(app, school.con, {
      userTypeId: teacherTypeId,
      firstName: name,
      mobile: mobile(),
    });
    expect(r.status).toBe(201);
    const w = await t.db
      .selectFrom('member_profiles as m')
      .innerJoin('wallets as w', 'w.owner_profile_id', 'm.id')
      .innerJoin('virtual_accounts as v', 'v.wallet_id', 'w.id')
      .select(['w.id', 'v.va_number'])
      .where('m.public_id', '=', uuidToBin(r.body.id))
      .where('w.kind', '=', 'CAMPUS')
      .executeTakeFirstOrThrow();
    return { id: r.body.id as string, wallet: String(w.id), va: w.va_number };
  }
  const balance = async (walletId: string) =>
    Number(
      (
        await t.db
          .selectFrom('wallet_balances')
          .select('available_paise')
          .where('wallet_id', '=', walletId)
          .executeTakeFirstOrThrow()
      ).available_paise,
    );
  const token = async (o: { secret?: string; scope?: string } = {}) =>
    request(app)
      .post('/api/v1/partners/oauth/token')
      .send({
        grant_type: 'client_credentials',
        client_id: client.clientId,
        client_secret: o.secret ?? client.secret,
        ...(o.scope ? { scope: o.scope } : {}),
      });
  const call = (
    endpoint: 'validate' | 'notify',
    bearer: string,
    body: object,
    o: { ts?: number; secret?: string } = {},
  ) => {
    const raw = JSON.stringify(body);
    const ts = o.ts ?? Math.floor(Date.now() / 1000);
    const sig = createHmac('sha256', o.secret ?? client.secret)
      .update(`${ts}.${raw}`)
      .digest('hex');
    return request(app)
      .post(`/api/v1/partners/bank/va/${endpoint}`)
      .set('Authorization', `Bearer ${bearer}`)
      .set('X-RingPe-Timestamp', String(ts))
      .set('X-RingPe-Signature', `v1=${sig}`)
      .set('Content-Type', 'application/json')
      .send(raw);
  };
  const credit = (
    va: string,
    amount: string,
    o: { utr?: string; txn?: string; requestId?: string } = {},
  ) => ({
    requestId: o.requestId ?? randomUUID(),
    corporateCode: school.code,
    vaNumber: va,
    amount,
    utr: o.utr ?? `UTR${randomInt(0, 1e9)}`,
    bankTxnId: o.txn ?? `BT${randomInt(0, 1e9)}`,
    mode: 'UPI',
    sender: { name: 'Lakshmi Rao', accountLast4: '4321' },
  });

  beforeAll(async () => {
    t = await createTestDatabase();
    h = await buildHttpApp(t);
    app = h.app;
    maker = await operator('ARJUN');
    checker = await operator('PRIYA');
    recon = await operator('RAHUL', 'RECON_OFFICER');
    const admin = await account('LAKSHMI');
    const plans = (await request(app).get('/api/v1/ops/plans').set(maker)).body.items;
    const tag = randomInt(0, 1e9);
    const reg = await request(app)
      .post('/api/v1/ops/institutions')
      .set(maker)
      .set('Idempotency-Key', randomUUID())
      .send({
        name: `Bank School ${tag}`,
        address: `Fort Road ${tag}, Mysuru`,
        city: 'Mysuru',
        primaryContact: {
          name: 'Lakshmi Rao',
          email: `office.${tag}@mysuru.example.in`,
          mobile: '9845012345',
        },
        adminEmail: admin.email,
        planId: plans[0].id,
      });
    const id = reg.body.id as string;
    const version = (await request(app).get(`/api/v1/ops/institutions/${id}`).set(maker)).body
      .version;
    const code = `B${String(randomInt(0, 999)).padStart(3, '0')}`;
    await request(app)
      .put(`/api/v1/ops/institutions/${id}/bank-arrangement`)
      .set(maker)
      .set('If-Match', `"v${version}"`)
      .send({ corporateCode: code, poolAccountRef: 'POOLBANK0001' });
    for (const step of ['toggles', 'year', 'feeacct']) {
      await request(app)
        .post(`/api/v1/ops/institutions/${id}/checklist/${step}`)
        .set(maker)
        .send({});
    }
    await request(app)
      .post(`/api/v1/ops/institutions/${id}/lifecycle-events`)
      .set(maker)
      .set('Idempotency-Key', randomUUID())
      .send({ action: 'ACTIVATE', reason: 'Onboarding complete for the test' });
    const row = await t.db
      .selectFrom('institutions')
      .select('id')
      .where('public_id', '=', uuidToBin(id))
      .executeTakeFirstOrThrow();
    school = { id, rowId: String(row.id), code, con: await signedIn('console', admin.email) };
    await request(app)
      .post('/api/v1/console/user-types')
      .set(school.con)
      .set('Idempotency-Key', randomUUID())
      .send({ name: 'Teacher', category: 'TEACHER', departments: ['Primary'] });
    teacherTypeId = (
      await request(app).get('/api/v1/console/user-types').set(school.con)
    ).body.items.find((x: { name: string }) => x.name === 'Teacher').id;
    const created = await request(app)
      .post('/api/v1/ops/api-clients')
      .set(maker)
      .set('Idempotency-Key', randomUUID())
      .send({
        name: 'Example Sponsor Bank',
        partner: 'SPONSOR_BANK',
        scopes: ['va.validate', 'va.notify'],
        ipAllowlist: ['127.0.0.1', '::1'],
      });
    expect(created.status).toBe(201);
    client = created.body;
  }, 180_000);
  afterAll(async () => {
    await t?.drop();
  });

  it('issues, refuses, logs and ends partner tokens (IDN-043, INT-001…008)', async () => {
    expect(client.clientId).toMatch(/^rpc_[a-z2-7]{26}$/);
    const stored = await t.db
      .selectFrom('api_clients')
      .select('secret_enc')
      .where('client_id', '=', client.clientId)
      .executeTakeFirstOrThrow();
    expect(stored.secret_enc.toString('latin1')).not.toContain(client.secret);

    expect((await token({ secret: 'wrong' })).body).toEqual({ error: 'invalid_client' });
    expect((await token({ scope: 'va.refund' })).body).toEqual({ error: 'invalid_scope' });
    const first = await token();
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      token_type: 'Bearer',
      expires_in: 900,
      scope: 'va.validate va.notify',
    });
    const second = await token({ scope: 'va.validate' });
    // A new token ends the earlier one (27.2).
    const m = await member('Anand');
    const stale = await call('validate', first.body.access_token, credit(m.va, '10.00'));
    expect(stale.status).toBe(401);
    expect(
      (await call('validate', second.body.access_token, credit(m.va, '10.00'))).body.code,
    ).toBe('000');
    expect((await call('notify', second.body.access_token, credit(m.va, '10.00'))).body.code).toBe(
      'INT.SCOPE_MISSING',
    );

    const list = await request(app).get('/api/v1/ops/api-clients').set(maker);
    expect(list.body.items[0]).toMatchObject({
      name: 'Example Sponsor Bank',
      status: 'ACTIVE',
      scopes: ['va.validate', 'va.notify'],
    });
    const log = await request(app).get(`/api/v1/ops/api-clients/${client.id}/tokens`).set(maker);
    expect(
      log.body.items.map(
        (x: { outcome: string; reason: string | null }) => `${x.outcome}:${x.reason ?? ''}`,
      ),
    ).toEqual(['ISSUED:', 'ISSUED:', 'REFUSED:invalid_scope', 'REFUSED:invalid_client']);
    expect(log.body.items.filter((x: { live: boolean }) => x.live)).toHaveLength(1);

    const policy = await request(app).get('/api/v1/ops/token-policy').set(maker);
    expect(policy.body.minutes).toBe(15);
    const changed = await request(app)
      .put('/api/v1/ops/token-policy')
      .set(maker)
      .set('If-Match', `"v${policy.body.version}"`)
      .send({ minutes: 30, reason: 'Longer tokens for the test bank' });
    expect(changed.body.minutes).toBe(30);
    expect((await token()).body.expires_in).toBe(1800);

    // Revoke all, then suspend: no token works, none is issued.
    const live = (await token()).body.access_token as string;
    await request(app)
      .post(`/api/v1/ops/api-clients/${client.id}/token-revocations`)
      .set(maker)
      .send({ reason: 'Key ceremony' });
    expect((await call('validate', live, credit(m.va, '1.00'))).status).toBe(401);
    const c = (await request(app).get('/api/v1/ops/api-clients').set(maker)).body.items[0];
    await request(app)
      .patch(`/api/v1/ops/api-clients/${client.id}`)
      .set(maker)
      .set('If-Match', `"v${c.version}"`)
      .send({ status: 'INACTIVE', reason: 'Paused by the bank' });
    expect((await token()).body).toEqual({ error: 'invalid_client' });
    const back = (await request(app).get('/api/v1/ops/api-clients').set(maker)).body.items[0];
    await request(app)
      .patch(`/api/v1/ops/api-clients/${client.id}`)
      .set(maker)
      .set('If-Match', `"v${back.version}"`)
      .send({ status: 'ACTIVE' });

    // Rotation: the old secret keeps working during the overlap.
    const rotated = await request(app)
      .post(`/api/v1/ops/api-clients/${client.id}/secret-rotations`)
      .set(maker)
      .set('Idempotency-Key', randomUUID())
      .send({ overlapHours: 1 });
    expect(rotated.status).toBe(201);
    expect((await token()).status).toBe(200);
    client = { ...client, secret: rotated.body.secret };
    expect((await token()).status).toBe(200);
  });

  it('validates and credits a virtual account once per UTR + bank transaction id (WAL-012/013)', async () => {
    const bearer = (await token()).body.access_token as string;
    const m = await member('Bhavana');
    // Signature and timestamp.
    const bad = await call('validate', bearer, credit(m.va, '500.00'), {
      secret: 'not-the-secret',
    });
    expect(bad.status).toBe(401);
    expect(bad.body.code).toBe('INT.SIGNATURE_INVALID');
    const old = await call('validate', bearer, credit(m.va, '500.00'), {
      ts: Math.floor(Date.now() / 1000) - 3600,
    });
    expect(old.body).toMatchObject({ code: 'INT.TIMESTAMP_SKEW', params: { seconds: 300 } });
    // Answers.
    expect((await call('validate', bearer, credit(m.va, '500.00'))).body).toEqual({
      code: '000',
      message: 'Success',
    });
    expect(
      (await call('validate', bearer, credit(`${school.code}999999999`, '500.00'))).body.code,
    ).toBe('002');
    expect((await call('validate', bearer, credit(m.va, '0'))).body.code).toBe('003');

    const body = credit(m.va, '500.00');
    const posted = await call('notify', bearer, body);
    expect(posted.status).toBe(200);
    expect(posted.body).toMatchObject({ code: '000', replayed: false });
    expect(posted.body.creditRef).toMatch(/^RPEB[A-Z0-9]{23}\d{8}$/);
    expect(await balance(m.wallet)).toBe(50_000);
    // The same call again: the first answer; the same bank event under a new request id: no second credit.
    expect((await call('notify', bearer, body)).body).toEqual(posted.body);
    const again = await call('notify', bearer, { ...body, requestId: randomUUID() });
    expect(again.body).toMatchObject({
      code: '000',
      creditRef: posted.body.creditRef,
      replayed: true,
    });
    expect(await balance(m.wallet)).toBe(50_000);
    // The same request id with another body is refused.
    expect((await call('notify', bearer, { ...body, amount: '600.00' })).body.code).toBe(
      'INT.REQUEST_REPLAYED',
    );
    expect(
      (
        await call('validate', bearer, {
          ...credit(m.va, '1.00'),
          utr: body.utr,
          bankTxnId: body.bankTxnId,
        })
      ).body.code,
    ).toBe('004');

    const txn = await t.db
      .selectFrom('ledger_transactions')
      .select(['type', 'channel'])
      .where('reference', '=', posted.body.creditRef)
      .executeTakeFirstOrThrow();
    expect(txn).toEqual({ type: 'BANK_CREDIT', channel: 'BANK_VA' });
  });

  it('holds a suspended wallet’s credit, releases it once active, and returns one only after approval (WAL-010/011)', async () => {
    const bearer = (await token()).body.access_token as string;
    const m = await member('Chetan');
    const status = (to: string) =>
      request(app)
        .post(`/api/v1/console/members/${m.id}/status-changes`)
        .set(school.con)
        .set('Idempotency-Key', randomUUID())
        .send({ to, reason: 'Fee dispute under review' });
    expect((await status('SUSPENDED')).status).toBeLessThan(300);

    const held = await call('notify', bearer, credit(m.va, '200.00'));
    expect(held.body.code).toBe('000');
    expect(await balance(m.wallet)).toBe(0);
    const second = await call('notify', bearer, credit(m.va, '75.00'));
    const list = await request(app).get('/api/v1/console/held-credits?status=HELD').set(school.con);
    expect(
      list.body.items.map((x: { amount: { amount: string } }) => x.amount.amount).sort(),
    ).toEqual(['200.00', '75.00']);
    expect(list.body.items[0]).toMatchObject({ status: 'HELD', member: { id: m.id }, mode: 'UPI' });

    // Return the ₹75 one: an operator asks, the same operator can't approve, another one does.
    const ret = list.body.items.find(
      (x: { amount: { amount: string } }) => x.amount.amount === '75.00',
    );
    const asked = await request(app)
      .post(`/api/v1/ops/held-credits/${ret.id}/return`)
      .set(recon)
      .set('Idempotency-Key', randomUUID())
      .send({ reason: 'Remitter asked for the money back', instructionRef: 'INSTR-2026-0042' });
    expect(asked.status).toBe(202);
    const detail = await request(app)
      .get(`/api/v1/ops/approvals/${asked.body.approvalId}`)
      .set(checker);
    const decide = (who: Record<string, string>) =>
      request(app)
        .post(`/api/v1/ops/approvals/${asked.body.approvalId}/decision`)
        .set(who)
        .set('If-Match', `"v${detail.body.version}"`)
        .set('Idempotency-Key', randomUUID())
        .send({ decision: 'APPROVE', remarks: 'Instruction checked' });
    // The maker holds no approval grant; the Platform Administrator decides (maker ≠ checker).
    expect((await decide(recon)).status).toBe(403);
    expect((await decide(checker)).status).toBe(200);

    // Lift the suspension; the release job credits the ₹200 that waited.
    expect((await status('ACTIVE')).status).toBeLessThan(300);
    const items: unknown[] = [];
    await h.services.bankCredits.releaseHeld({ item: (i) => items.push(i) });
    expect(await balance(m.wallet)).toBe(20_000);
    const after = (await request(app).get('/api/v1/console/held-credits').set(school.con)).body
      .items;
    expect(
      after
        .map(
          (x: { status: string; amount: { amount: string } }) => `${x.amount.amount}:${x.status}`,
        )
        .sort(),
    ).toEqual(['200.00:PROCESSED', '75.00:RETURNED']);
    // A returned credit can't be returned again.
    const twice = await request(app)
      .post(`/api/v1/ops/held-credits/${ret.id}/return`)
      .set(recon)
      .set('Idempotency-Key', randomUUID())
      .send({ reason: 'Again', instructionRef: 'INSTR-2' });
    expect(twice.body.code).toBe('WAL.HOLD_NOT_OPEN');
    void second;
  });

  it('checks stored balances against the ledger and reports a difference without correcting it (REC-012/017)', async () => {
    const clean = await request(app).get('/api/v1/ops/recon/balance-vs-ledger').set(recon);
    expect(clean.status).toBe(200);
    expect(clean.body.checked).toBeGreaterThan(0);
    expect(clean.body.differences).toEqual([]);
    const m = await member('Deepa');
    await t.db
      .updateTable('wallet_balances')
      .set({ available_paise: 12_345 })
      .where('wallet_id', '=', m.wallet)
      .execute();
    const found = await request(app).get('/api/v1/console/recon/ledger-check').set(school.con);
    expect(found.body.differences).toEqual([
      expect.objectContaining({
        walletNo: expect.any(String),
        stored: { amount: '123.45', currency: 'INR' },
        differenceSign: 1,
      }),
    ]);
    expect(await balance(m.wallet)).toBe(12_345);
  });
});
