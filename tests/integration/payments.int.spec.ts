/**
 * The payment engine, merchants and QR codes on a real MySQL (Phase 3.3; SRS 9.2–9.6, 9.11, 12;
 * PAY-001/002, PAY-007…011, PAY-013/014, PAY-016…024, PAY-029…031):
 * - the console registers a merchant (encrypted bank account, wallet opened), generates its codes
 *   once per kind and switches its channels;
 * - a member pays with the PIN: the ledger pair is posted, the receipt shares the RPEP reference, the
 *   payer, the merchant and guardians are told; a retry with the same key returns the first payment;
 * - guards and pre-checks refuse without a record; validations keep a failed attempt with its step;
 * - a dynamic request is paid exactly once even when two payers race; parallel payments never
 *   overdraw.
 */
import { randomInt, randomUUID } from 'node:crypto';
import request from 'supertest';
import { onboardStaff } from './staff';
import type { Express } from 'express';
import { sql } from 'kysely';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { io as connect } from 'socket.io-client';
import { startRealtime } from '../../services/realtime.service';
import { adminUrl, createTestDatabase, type TestDatabase } from './db';
import { buildHttpApp, codeOf } from './http-app';
import { newPublicIdPair, uuidToBin } from '../../utils/idGenerator';
import { hashSecret } from '../../utils/password';

/** PANs are unique per platform: a counter keeps sign-ups in one file from colliding. */
let panSeq = randomInt(0, 5_000);
const uniquePan = () => `ABCDE${String(++panSeq % 10_000).padStart(4, '0')}F`;
const PASSWORD = 'CampusOne@2026';
const PIN = '4826';
const mobile = () => `9${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`;
const inr = (amount: string) => ({ amount, currency: 'INR' });

describe.skipIf(!adminUrl)('payments, merchants and QR on real MySQL', () => {
  let t: TestDatabase;
  let h: Awaited<ReturnType<typeof buildHttpApp>>;
  let app: Express;
  let school: { id: string; rowId: string; con: Record<string, string> };
  let teacherTypeId = '';

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

  /** A member signed up on `mob`; returns the tokens (the profile comes with IDN-014 + refresh). */
  async function signUp(mob: string) {
    const start = await request(app)
      .post('/api/v1/auth/member/signup/otp')
      .send({ mobile: mob, consentVersion: '2026.10' });
    const verify = await request(app)
      .post('/api/v1/auth/member/signup/otp/verify')
      .send({ challengeId: start.body.challengeId, otp: codeOf(h.sms.sent.at(-1)) });
    const created = await request(app)
      .post('/api/v1/auth/member/signup')
      .set('Idempotency-Key', randomUUID())
      .send({
        signupToken: verify.body.signupToken,
        mobile: mob,
        consentVersion: '2026.10',
        termsVersion: '2026.10',
        termsAccepted: true,
        pan: uniquePan(),
        firstName: 'Asha',
        lastName: 'Rao',
        gender: 'FEMALE',
        dob: '1990-04-12',
        idDocType: 'AADHAAR',
        idDocNumber: `${randomInt(2, 10)}${String(randomInt(0, 1e11)).padStart(11, '0')}`,
        email: `asha.${randomInt(0, 1e9)}@example.in`,
        password: PASSWORD,
        securityQuestion: 'FIRST_SCHOOL',
        securityAnswer: 'vidyaniketan',
        device: { installId: randomUUID() },
      });
    expect(created.status).toBe(201);
    return {
      access: created.body.accessToken as string,
      refresh: created.body.refreshToken as string,
    };
  }

  /** The member's session on `profileId` (IDN-014, then a refreshed token carrying it). */
  async function onProfile(tokens: { access: string; refresh: string }, profileId: string) {
    const set = await request(app)
      .put('/api/v1/me/active-profile')
      .set({ Authorization: `Bearer ${tokens.access}` })
      .send({ profileId });
    expect(set.status).toBe(200);
    const r = await request(app)
      .post('/api/v1/auth/token/refresh')
      .send({ refreshToken: tokens.refresh });
    expect(r.status).toBe(200);
    return { Authorization: `Bearer ${r.body.accessToken as string}` };
  }

  async function profileRow(publicId: string) {
    return t.db
      .selectFrom('member_profiles')
      .select(['id', 'account_id'])
      .where('public_id', '=', uuidToBin(publicId))
      .executeTakeFirstOrThrow();
  }

  const walletOf = async (profileRowId: string, kind: 'CAMPUS' | 'MERCHANT') =>
    String(
      (
        await t.db
          .selectFrom('wallets')
          .select('id')
          .where('owner_profile_id', '=', profileRowId)
          .where('kind', '=', kind)
          .executeTakeFirstOrThrow()
      ).id,
    );
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
  const credit = (walletId: string, paise: number) =>
    t.db.transaction().execute((trx) =>
      h.services.ledger.post(trx, {
        institutionId: school.rowId,
        type: 'ADJUSTMENT',
        channel: 'BACK_OFFICE',
        amountPaise: paise,
        idempotencyKey: randomUUID(),
        debit: { account: 'ADJUSTMENT', institutionId: school.rowId },
        credit: { walletId },
        narration: 'Opening balance',
      }),
    );
  const attempts = (payerRowId: string) =>
    t.db
      .selectFrom('payment_attempts')
      .selectAll()
      .where('payer_profile_id', '=', payerRowId)
      .orderBy('id')
      .execute();

  /** A payer of the school: account, profile, active session, PIN set, wallet funded. */
  async function payer(name: string, paise: number) {
    const mob = mobile();
    const tokens = await signUp(mob);
    const r = await onboardStaff(app, school.con, {
      userTypeId: teacherTypeId,
      firstName: name,
      mobile: mob,
    });
    expect(r.status).toBe(201);
    const auth = await onProfile(tokens, r.body.id);
    expect((await request(app).post('/api/v1/me/tpin').set(auth).send({ pin: PIN })).status).toBe(
      201,
    );
    const row = await profileRow(r.body.id);
    const wallet = await walletOf(String(row.id), 'CAMPUS');
    if (paise) await credit(wallet, paise);
    return {
      id: r.body.id as string,
      rowId: String(row.id),
      accountId: String(row.account_id),
      auth,
      wallet,
      mobile: mob,
    };
  }

  /** A merchant registered by the console, signed in on its own app. */
  async function merchant(displayName: string, opts: { subType?: 'REGULAR' | 'VENDOR' } = {}) {
    const mob = mobile();
    const tokens = await signUp(mob);
    const r = await request(app)
      .post('/api/v1/console/merchants')
      .set(school.con)
      .set('Idempotency-Key', randomUUID())
      .send({
        displayName,
        operatorFirstName: 'Ravi',
        operatorLastName: 'Kumar',
        subType: opts.subType ?? 'REGULAR',
        mobile: mob,
        email: `counter.${randomInt(0, 1e9)}@example.in`,
        acceptsAllowance: opts.subType !== 'VENDOR',
        bank: { holderName: 'Ravi Kumar', accountNumber: '123456781234', ifsc: 'SBIN0001234' },
      });
    expect(r.status).toBe(201);
    const row = await profileRow(r.body.merchantId);
    const qr = await request(app)
      .post(`/api/v1/console/merchants/${r.body.merchantId}/qr-codes`)
      .set(school.con)
      .set('Idempotency-Key', randomUUID())
      .send({ kind: 'PAYMENT' });
    expect(qr.status).toBe(201);
    return {
      id: r.body.merchantId as string,
      uniqueId: r.body.uniqueId as string,
      rowId: String(row.id),
      wallet: await walletOf(String(row.id), 'MERCHANT'),
      qr: qr.body as { id: string; payload: string; version: number },
      auth: await onProfile(tokens, r.body.merchantId),
    };
  }

  const payStatic = (
    who: { auth: Record<string, string> },
    payload: string,
    amount: string,
    o: { pin?: string; key?: string } = {},
  ) =>
    request(app)
      .post('/api/v1/me/payments')
      .set(who.auth)
      .set('Idempotency-Key', o.key ?? randomUUID())
      .send({ qrPayload: payload, amount: inr(amount), pin: o.pin ?? PIN });

  beforeAll(async () => {
    t = await createTestDatabase();
    h = await buildHttpApp(t);
    app = h.app;
    const op = await account('ARJUN');
    const role = await t.db
      .selectFrom('roles')
      .select('id')
      .where('code', '=', 'PLATFORM_ADMIN')
      .executeTakeFirstOrThrow();
    await t.db
      .insertInto('operator_accounts')
      .values({ public_id: newPublicIdPair().bin, account_id: op.id, role_id: String(role.id) })
      .execute();
    const ops = await signedIn('ops', op.email);
    const admin = await account('LAKSHMI');
    const plans = (await request(app).get('/api/v1/ops/plans').set(ops)).body.items;
    const tag = randomInt(0, 1e9);
    const reg = await request(app)
      .post('/api/v1/ops/institutions')
      .set(ops)
      .set('Idempotency-Key', randomUUID())
      .send({
        name: `Pay School ${tag}`,
        address: `Temple Road ${tag}, Udupi`,
        city: 'Udupi',
        primaryContact: {
          name: 'Lakshmi Rao',
          email: `office.${tag}@udupi.example.in`,
          mobile: '9845012345',
        },
        adminEmail: admin.email,
        planId: plans[0].id,
      });
    const id = reg.body.id as string;
    const version = (await request(app).get(`/api/v1/ops/institutions/${id}`).set(ops)).body
      .version;
    await request(app)
      .put(`/api/v1/ops/institutions/${id}/bank-arrangement`)
      .set(ops)
      .set('If-Match', `"v${version}"`)
      .send({
        corporateCode: `P${String(randomInt(0, 999)).padStart(3, '0')}`,
        poolAccountRef: 'POOLPAY0001',
      });
    for (const step of ['toggles', 'year', 'feeacct']) {
      await request(app).post(`/api/v1/ops/institutions/${id}/checklist/${step}`).set(ops).send({});
    }
    await request(app)
      .post(`/api/v1/ops/institutions/${id}/lifecycle-events`)
      .set(ops)
      .set('Idempotency-Key', randomUUID())
      .send({ action: 'ACTIVATE', reason: 'Onboarding complete for the test' });
    const row = await t.db
      .selectFrom('institutions')
      .select('id')
      .where('public_id', '=', uuidToBin(id))
      .executeTakeFirstOrThrow();
    school = { id, rowId: String(row.id), con: await signedIn('console', admin.email) };
    for (const [name, category, departments] of [
      ['Teacher', 'TEACHER', ['Primary']],
      ['Merchant', 'MERCHANT', ['Canteen']],
    ] as const) {
      await request(app)
        .post('/api/v1/console/user-types')
        .set(school.con)
        .set('Idempotency-Key', randomUUID())
        .send({ name, category, departments });
    }
    teacherTypeId = (
      await request(app).get('/api/v1/console/user-types').set(school.con)
    ).body.items.find((x: { name: string }) => x.name === 'Teacher').id;
  }, 180_000);
  afterAll(async () => {
    await t?.drop();
  });

  it('registers a merchant with its wallet, masked bank account and codes once per kind (PAY-016…024, 029, 031)', async () => {
    const m = await merchant('Fresh Fruits Counter');
    expect(m.uniqueId).toMatch(/^MERFREPAY\d{5}\d{4}$/);
    const enc = await t.db
      .selectFrom('merchants')
      .select(['acct_enc', 'acct_last4'])
      .where('profile_id', '=', m.rowId)
      .executeTakeFirstOrThrow();
    expect(enc.acct_last4).toBe('1234');
    expect(enc.acct_enc!.toString('latin1')).not.toContain('123456781234');

    const list = await request(app).get('/api/v1/console/merchants?q=Fresh').set(school.con);
    expect(list.status).toBe(200);
    expect(list.body.items[0]).toMatchObject({
      displayName: 'Fresh Fruits Counter',
      subType: 'REGULAR',
      status: 'ACTIVE',
    });
    expect(list.body.kpis.total).toBeGreaterThanOrEqual(1);

    const detail = await request(app).get(`/api/v1/console/merchants/${m.id}`).set(school.con);
    expect(detail.body.bank).toMatchObject({
      accountNumber: expect.stringMatching(/1234$/),
      ifsc: 'SBIN0001234',
      bankName: 'State Bank of India',
    });
    expect(JSON.stringify(detail.body)).not.toContain('123456781234');
    expect(detail.body.wallet.status).toBe('ACTIVE');
    expect(detail.body.qrCodes[0]).toMatchObject({ kind: 'PAYMENT', status: 'ACTIVE' });
    expect(detail.body.qrCodes[0].svg).toContain('<svg');
    expect(detail.headers['etag']).toBe(`"v${detail.body.version}"`);

    const again = await request(app)
      .post(`/api/v1/console/merchants/${m.id}/qr-codes`)
      .set(school.con)
      .set('Idempotency-Key', randomUUID())
      .send({ kind: 'PAYMENT' });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('MER.QR_EXISTS');

    const v = await merchant('Lab Supplies Vendor', { subType: 'VENDOR' });
    const alw = await request(app)
      .post(`/api/v1/console/merchants/${v.id}/qr-codes`)
      .set(school.con)
      .set('Idempotency-Key', randomUUID())
      .send({ kind: 'ALLOWANCE' });
    expect(alw.body.code).toBe('MER.QR_KIND_NOT_ACCEPTED');

    const rename = (name: string, version: number) =>
      request(app)
        .patch(`/api/v1/console/merchants/${m.id}`)
        .set(school.con)
        .set('If-Match', `"v${version}"`)
        .send({ displayName: name });
    expect((await rename('Lab Supplies Vendor', detail.body.version)).body.errors[0].code).toBe(
      'MER.NAME_TAKEN',
    );
    expect((await rename('Fruit Corner', detail.body.version - 1)).status).toBe(412);
    const renamed = await rename('Fruit Corner', detail.body.version);
    expect(renamed.body.displayName).toBe('Fruit Corner');

    const card = await request(app)
      .get(`/api/v1/console/qr-codes/${m.qr.id}/card.pdf`)
      .set(school.con);
    expect(card.headers['content-type']).toBe('application/pdf');
    expect(card.body.subarray(0, 4).toString()).toBe('%PDF');
    const mail = await request(app)
      .post('/api/v1/console/qr-codes/emails')
      .set(school.con)
      .set('Idempotency-Key', randomUUID())
      .send({ merchantIds: [m.id] });
    expect(mail.body).toEqual({ sent: 1, skipped: 0 });
  });

  it('pays a merchant with the PIN: balanced ledger, shared reference, notifications, exactly once (PAY-001/002)', async () => {
    const m = await merchant('Campus Canteen');
    const p = await payer('Kiran', 50_000);
    const resolved = await request(app)
      .post('/api/v1/me/payments/resolve')
      .set(p.auth)
      .send({ qrPayload: m.qr.payload });
    expect(resolved.status).toBe(200);
    expect(resolved.body).toMatchObject({
      kind: 'PAYMENT',
      merchant: { name: 'Campus Canteen', subType: 'REGULAR' },
      request: null,
    });
    expect(resolved.body.stages).toEqual([
      'identify',
      'institution',
      'permission',
      'amount',
      'walletsActive',
      'balance',
      'post',
    ]);

    const key = randomUUID();
    const paid = await payStatic(p, m.qr.payload, '60.00', { key });
    expect(paid.status).toBe(201);
    expect(paid.body.receipt).toMatchObject({
      status: 'SUCCESS',
      channel: 'STATIC_QR',
      amount: inr('60.00'),
      merchant: { name: 'Campus Canteen' },
      balanceAfter: inr('440.00'),
    });
    const ref = paid.body.receipt.reference as string;
    expect(ref).toMatch(/^RPEP[A-Z0-9]{23}\d{8}$/);
    expect(await balance(p.wallet)).toBe(44_000);
    expect(await balance(m.wallet)).toBe(6_000);

    const txn = await t.db
      .selectFrom('ledger_transactions')
      .select(['id', 'type', 'channel', 'amount_paise'])
      .where('reference', '=', ref)
      .executeTakeFirstOrThrow();
    expect(txn).toMatchObject({ type: 'PAYMENT', channel: 'STATIC_QR' });
    const entries = await t.db
      .selectFrom('ledger_entries')
      .selectAll()
      .where('ledger_txn_id', '=', txn.id)
      .execute();
    expect(entries.map((e) => e.direction).sort()).toEqual(['C', 'D']);
    expect(entries.every((e) => Number(e.amount_paise) === 6_000)).toBe(true);

    const notes = await t.db
      .selectFrom('notifications')
      .select(['account_id', 'title_key'])
      .where('category', '=', 'PAYMENT')
      .where('body', '=', ref)
      .execute();
    expect(notes.map((n) => n.title_key).sort()).toEqual([
      'NTF.PAYMENT_RECEIVED',
      'NTF.PAYMENT_SENT',
    ]);

    // The receipt is the member's transaction view (WAL-004) under the same reference.
    const receipt = await request(app).get(`/api/v1/me/transactions/${ref}`).set(p.auth);
    expect(receipt.status).toBe(200);

    // A retry with the same key returns the first payment; nothing moves twice.
    const retry = await payStatic(p, m.qr.payload, '60.00', { key });
    expect(retry.status).toBe(201);
    expect(retry.body.receipt.reference).toBe(ref);
    expect(await balance(p.wallet)).toBe(44_000);
    expect((await attempts(p.rowId)).filter((a) => a.status === 'SUCCESS')).toHaveLength(1);

    // The merchant sees it on its home and collections (PAY-007, PAY-014).
    const home = await request(app).get('/api/v1/merchant/home').set(m.auth);
    expect(home.body.today).toEqual({ gross: inr('60.00'), count: 1 });
    const cols = await request(app).get('/api/v1/merchant/collections').set(m.auth);
    expect(cols.body.items[0]).toMatchObject({ reference: ref, status: 'SUCCESS', payer: 'Kiran' });
    expect(cols.body.totals).toEqual({ amount: inr('60.00'), count: 1 });
    expect((await request(app).get('/api/v1/merchant/home').set(p.auth)).body.code).toBe(
      'MER.NOT_MERCHANT',
    );
  });

  it('refuses at each step: guards and pre-checks write nothing, validations keep a failed attempt', async () => {
    const m = await merchant('Book Corner');
    const p = await payer('Meera', 10_000);

    // G6 — a wrong PIN: refused before anything is written.
    const wrong = await payStatic(p, m.qr.payload, '10.00', { pin: '9999' });
    expect(wrong.status).toBe(422);
    expect(wrong.body).toMatchObject({ code: 'VALIDATION.FAILED', check: 'G6' });
    expect(wrong.body.errors[0]).toMatchObject({ field: 'pin', code: 'IDN.TPIN_WRONG' });
    // G2 — above the static QR maximum.
    const big = await payStatic(p, m.qr.payload, '10000.01');
    expect(big.body).toMatchObject({
      code: 'PAY.LIMIT_EXCEEDED',
      check: 'G2',
      stage: 'amount',
      params: { max: '₹10,000' },
    });
    expect(await attempts(p.rowId)).toHaveLength(0);

    // V13 — short of balance: the attempt is kept as a failure, nothing moves.
    const short = await payStatic(p, m.qr.payload, '150.00');
    expect(short.status).toBe(409);
    expect(short.body).toMatchObject({
      code: 'PAY.INSUFFICIENT_BALANCE',
      check: 'V13',
      stage: 'balance',
      params: { balance: '₹100.00', shortfall: '₹50.00' },
    });
    expect(short.body.attempt.reference).toMatch(/^RPEP/);
    const kept = await attempts(p.rowId);
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({
      status: 'FAILURE',
      failed_check: 'V13',
      failure_code: 'PAY.INSUFFICIENT_BALANCE',
    });
    expect(await balance(p.wallet)).toBe(10_000);

    // V5 — payments turned off for the profile (IDN-056).
    const prof = await request(app).get(`/api/v1/console/members/${p.id}`).set(school.con);
    const off = await request(app)
      .put(`/api/v1/console/members/${p.id}/transaction-permission`)
      .set(school.con)
      .set('If-Match', `"v${prof.body.version}"`)
      .send({ enabled: false, reason: 'Parent asked to pause payments' });
    expect(off.status).toBe(200);
    const v5 = await payStatic(p, m.qr.payload, '10.00');
    expect(v5.body).toMatchObject({
      code: 'PAY.NO_TXN_PERMISSION',
      check: 'V5',
      stage: 'permission',
    });
    expect((await attempts(p.rowId)).at(-1)).toMatchObject({
      status: 'FAILURE',
      failed_check: 'V5',
    });

    // An inactive code refuses payments (OI-PAY-01), and a deactivated merchant's wallet (G5).
    const q2 = await merchant('Stationery Stall');
    const p2 = await payer('Nikhil', 10_000);
    const deact = await request(app)
      .patch(`/api/v1/console/qr-codes/${q2.qr.id}`)
      .set(school.con)
      .set('If-Match', `"v${q2.qr.version}"`)
      .send({ status: 'INACTIVE', reason: 'Printed code damaged at the counter' });
    expect(deact.body.status).toBe('INACTIVE');
    expect((await payStatic(p2, q2.qr.payload, '5.00')).body.code).toBe('PAY.QR_INACTIVE');
    expect(
      (
        await request(app)
          .post('/api/v1/me/payments/resolve')
          .set(p2.auth)
          .send({ qrPayload: q2.qr.payload })
      ).body.code,
    ).toBe('PAY.QR_INACTIVE');
    await request(app)
      .patch(`/api/v1/console/qr-codes/${q2.qr.id}`)
      .set(school.con)
      .set('If-Match', `"v${deact.body.version}"`)
      .send({ status: 'ACTIVE' });
    const status = await request(app)
      .post(`/api/v1/console/merchants/${q2.id}/status`)
      .set(school.con)
      .send({ to: 'INACTIVE', reason: 'Contract ended for the stall' });
    expect(status.body.status).toBe('INACTIVE');
    const g5 = await payStatic(p2, q2.qr.payload, '5.00');
    expect(g5.body).toMatchObject({ code: 'PAY.PAYEE_WALLET_INACTIVE', check: 'G5' });
    expect(await attempts(p2.rowId)).toHaveLength(0);

    // Not a CampusOne code, or another institution's code: not recognised.
    expect(
      (
        await request(app)
          .post('/api/v1/me/payments/resolve')
          .set(p2.auth)
          .send({ qrPayload: 'upi://pay?pa=x' })
      ).status,
    ).toBe(404);
    expect((await payStatic(p2, `campusone://pay/s/${'A'.repeat(26)}`, '5.00')).body.code).toBe(
      'PAY.QR_UNKNOWN',
    );
  });

  it('pays a dynamic request exactly once when two payers race; cancels and expires requests (PAY-009…011)', async () => {
    const m = await merchant('Juice Bar');
    const off = await request(app)
      .post('/api/v1/merchant/payment-requests')
      .set(m.auth)
      .set('Idempotency-Key', randomUUID())
      .send({ kind: 'DYNAMIC_QR', amount: inr('45.00') });
    expect(off.body).toMatchObject({
      code: 'PAY.CHANNEL_DISABLED',
      params: { channel: 'a dynamic QR' },
    });
    const d = await request(app).get(`/api/v1/console/merchants/${m.id}`).set(school.con);
    await request(app)
      .put(`/api/v1/console/merchants/${m.id}/channels`)
      .set(school.con)
      .set('If-Match', `"v${d.body.version}"`)
      .send({ dynamicQr: true, nfc: false });
    const req = await request(app)
      .post('/api/v1/merchant/payment-requests')
      .set(m.auth)
      .set('Idempotency-Key', randomUUID())
      .send({ kind: 'DYNAMIC_QR', amount: inr('45.00') });
    expect(req.status).toBe(201);
    expect(req.body.qrPayload).toMatch(/^campusone:\/\/pay\/d\/[A-Z2-7]{26}$/);
    expect(req.body.ttlSeconds).toBe(120);

    const a = await payer('Anil', 10_000);
    const b = await payer('Bina', 10_000);
    const seen = await request(app)
      .post('/api/v1/me/payments/resolve')
      .set(a.auth)
      .send({ qrPayload: req.body.qrPayload });
    expect(seen.body).toMatchObject({
      kind: 'DYNAMIC',
      request: { id: req.body.requestId, amount: inr('45.00') },
    });
    const body = { qrPayload: req.body.qrPayload, pin: PIN };
    const results = await Promise.all(
      [a, b].map((x) =>
        request(app)
          .post('/api/v1/me/payments')
          .set(x.auth)
          .set('Idempotency-Key', randomUUID())
          .send(body),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    const loser = results.find((r) => r.status === 409)!;
    expect(['PAY.REQUEST_PAID']).toContain(loser.body.code);
    expect(['P6', 'P7']).toContain(loser.body.check);
    expect((await balance(a.wallet)) + (await balance(b.wallet))).toBe(20_000 - 4_500);

    const st = await request(app)
      .get(`/api/v1/merchant/payment-requests/${req.body.requestId}`)
      .set(m.auth);
    expect(st.body).toMatchObject({ status: 'SUCCESS', amount: inr('45.00') });
    expect(['Anil', 'Bina']).toContain(st.body.payer);
    expect(st.body.receipt.reference).toMatch(/^RPEP/);

    // Cancel a pending request; cancelling twice is refused.
    const second = await request(app)
      .post('/api/v1/merchant/payment-requests')
      .set(m.auth)
      .set('Idempotency-Key', randomUUID())
      .send({ kind: 'DYNAMIC_QR', amount: inr('12.00') });
    const cancel = () =>
      request(app)
        .post(`/api/v1/merchant/payment-requests/${second.body.requestId}/cancellation`)
        .set(m.auth);
    expect((await cancel()).body.status).toBe('CANCELLED');
    expect((await cancel()).body.code).toBe('PAY.REQUEST_NOT_PENDING');
    expect(
      (
        await request(app)
          .post('/api/v1/me/payments/resolve')
          .set(a.auth)
          .send({ qrPayload: second.body.qrPayload })
      ).body.code,
    ).toBe('PAY.REQUEST_EXPIRED');

    // An expired request: derived from the expiry time, refused with the configured minutes.
    const third = await request(app)
      .post('/api/v1/merchant/payment-requests')
      .set(m.auth)
      .set('Idempotency-Key', randomUUID())
      .send({ kind: 'DYNAMIC_QR', amount: inr('8.00') });
    await t.db
      .updateTable('payment_requests')
      .set({ expires_at: sql<Date>`UTC_TIMESTAMP(3) - INTERVAL 1 SECOND` })
      .where('public_id', '=', uuidToBin(third.body.requestId))
      .execute();
    expect(
      (
        await request(app)
          .get(`/api/v1/merchant/payment-requests/${third.body.requestId}`)
          .set(m.auth)
      ).body.status,
    ).toBe('EXPIRED');
    const late = await request(app)
      .post('/api/v1/me/payments')
      .set(a.auth)
      .set('Idempotency-Key', randomUUID())
      .send({ qrPayload: third.body.qrPayload, pin: PIN });
    expect(late.body).toMatchObject({
      code: 'PAY.REQUEST_EXPIRED',
      check: 'P6',
      params: { minutes: 2 },
    });
  });

  it('never overdraws under parallel payments from one wallet', async () => {
    const m = await merchant('Snack Shack');
    const p = await payer('Ravi', 1_000);
    const results = await Promise.all(
      Array.from({ length: 16 }, () => payStatic(p, m.qr.payload, '1.00')),
    );
    const ok = results.filter((r) => r.status === 201).length;
    expect(ok).toBe(10);
    expect(
      results
        .filter((r) => r.status === 409)
        .every((r) => r.body.code === 'PAY.INSUFFICIENT_BALANCE'),
    ).toBe(true);
    expect(await balance(p.wallet)).toBe(0);
    expect(await balance(m.wallet)).toBe(1_000);
    const rows = await attempts(p.rowId);
    expect(rows.filter((r) => r.status === 'SUCCESS')).toHaveLength(10);
    expect(rows.filter((r) => r.status === 'FAILURE').every((r) => r.failed_check === 'V13')).toBe(
      true,
    );
  }, 60_000);

  it('sends money to a member found by mobile: feature, recipient checks, limit, RPET reference (WAL-006/007)', async () => {
    const transfers = (on: boolean) =>
      t.db
        .insertInto('feature_toggles')
        .values({ institution_id: school.rowId, feature_key: 'transfers', enabled: on })
        .onDuplicateKeyUpdate({ enabled: on })
        .execute();
    const a = await payer('Sunil', 20_000);
    const b = await payer('Rekha', 0);
    const lookup = (who: { auth: Record<string, string> }, mob: string) =>
      request(app)
        .post('/api/v1/me/transfers/recipient-lookup')
        .set(who.auth)
        .send({ mobile: mob });
    const send = (amount: string, key = randomUUID(), to = b.id) =>
      request(app)
        .post('/api/v1/me/transfers')
        .set(a.auth)
        .set('Idempotency-Key', key)
        .send({ toProfileId: to, amount: inr(amount), note: 'Lunch money', pin: PIN });

    await transfers(false);
    expect((await lookup(a, b.mobile)).body.code).toBe('PAY.TRANSFERS_OFF');
    await transfers(true);
    const found = await lookup(a, b.mobile);
    expect(found.status).toBe(200);
    expect(found.body.candidates).toEqual([
      expect.objectContaining({
        profileId: b.id,
        name: 'Rekha',
        wallet: expect.stringMatching(/^•••• \d{4}$/),
      }),
    ]);
    expect((await lookup(a, a.mobile)).body.code).toBe('PAY.SELF_TRANSFER');
    const none = await lookup(a, mobile());
    expect(none.status).toBe(404);
    expect(none.body.code).toBe('PAY.RECIPIENT_NOT_FOUND');

    const big = await send('10000.01');
    expect(big.body).toMatchObject({
      code: 'PAY.TRANSFER_LIMIT',
      check: 'G2',
      params: { max: '₹10,000' },
    });
    const key = randomUUID();
    const sent = await send('50.00', key);
    expect(sent.status).toBe(201);
    expect(sent.body.receipt).toMatchObject({
      status: 'SUCCESS',
      amount: inr('50.00'),
      to: { name: 'Rekha' },
      note: 'Lunch money',
      balanceAfter: inr('150.00'),
    });
    expect(sent.body.receipt.reference).toMatch(/^RPET[A-Z0-9]{23}\d{8}$/);
    expect(sent.body.stages).toEqual([
      'amount',
      'identify',
      'walletsActive',
      'permission',
      'balance',
      'post',
    ]);
    expect(await balance(a.wallet)).toBe(15_000);
    expect(await balance(b.wallet)).toBe(5_000);
    const txn = await t.db
      .selectFrom('ledger_transactions')
      .select(['type', 'channel'])
      .where('reference', '=', sent.body.receipt.reference)
      .executeTakeFirstOrThrow();
    expect(txn).toEqual({ type: 'TRANSFER', channel: 'TRANSFER' });
    const notes = await t.db
      .selectFrom('notifications')
      .select('title_key')
      .where('body', '=', sent.body.receipt.reference)
      .execute();
    expect(notes.map((n) => n.title_key).sort()).toEqual([
      'NTF.TRANSFER_RECEIVED',
      'NTF.TRANSFER_SENT',
    ]);
    expect((await send('50.00', key)).body.receipt.reference).toBe(sent.body.receipt.reference);
    expect(await balance(a.wallet)).toBe(15_000);

    // A recipient who can't receive: refused before anything is written (G5, CR-08).
    const off = await request(app)
      .post(`/api/v1/console/members/${b.id}/status-changes`)
      .set(school.con)
      .set('Idempotency-Key', randomUUID())
      .send({ to: 'INACTIVE', reason: 'Left the school this term' });
    expect(off.status).toBeLessThan(300);
    expect((await lookup(a, b.mobile)).body).toMatchObject({
      code: 'PAY.RECIPIENT_CANNOT_RECEIVE',
      params: { name: 'Rekha' },
    });
    const refused = await send('5.00');
    expect(refused.body).toMatchObject({ code: 'PAY.RECIPIENT_CANNOT_RECEIVE', check: 'G5' });
    expect(await balance(a.wallet)).toBe(15_000);
  });

  it('tells both parties in realtime once the payment commits (COM-025 payment.completed)', async () => {
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const rt = startRealtime({
      server,
      db: t.db,
      verifier: h.security.verifier,
      revocations: h.security.revocations,
      loggers: h.services.loggers,
      corsOrigins: [],
      pollMs: 0,
    });
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const m = await merchant('Tea Point');
      const p = await payer('Usha', 10_000);
      const socketOf = (auth: Record<string, string>) =>
        new Promise<ReturnType<typeof connect>>((resolve, reject) => {
          const sk = connect(url, {
            path: '/realtime',
            auth: { token: auth['Authorization']!.slice(7) },
            transports: ['websocket'],
            reconnection: false,
          });
          sk.on('ready', () => resolve(sk));
          sk.on('connect_error', reject);
        });
      const [ps, ms] = await Promise.all([socketOf(p.auth), socketOf(m.auth)]);
      const got = (sk: ReturnType<typeof connect>) =>
        new Promise<unknown>((resolve) => sk.once('payment.completed', resolve));
      const both = Promise.all([got(ps), got(ms)]);
      const paid = await payStatic(p, m.qr.payload, '15.00');
      expect(paid.status).toBe(201);
      expect(await rt.relayOnce()).toBeGreaterThanOrEqual(1);
      const [a, b] = await both;
      expect(a).toEqual({ reference: paid.body.receipt.reference, channel: 'STATIC_QR' });
      expect(b).toEqual(a);
      ps.disconnect();
      ms.disconnect();
    } finally {
      await rt.close();
    }
  });
});
