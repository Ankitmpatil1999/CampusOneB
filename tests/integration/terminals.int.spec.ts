/**
 * Terminals, readers and campus cards on a real MySQL (Phase 4.1; CR-10, 9.5, 21.2–21.7):
 * pairing once, signed sign-in with a single-use nonce, purpose and status re-checked on every call;
 * a card written once per member, blocked, re-issued only after the console authorises it, reported
 * lost by the member; an NFC tap pays the merchant's request once and refuses a replayed nonce.
 */
import { createHmac, randomInt, randomUUID } from 'node:crypto';
import request from 'supertest';
import { onboardStaff } from './staff';
import type { Express } from 'express';
import { sql } from 'kysely';
import { adminUrl, createTestDatabase, type TestDatabase } from './db';
import { buildHttpApp, codeOf } from './http-app';
import { newPublicIdPair, uuidToBin } from '../../utils/idGenerator';
import { hashSecret } from '../../utils/password';

const PASSWORD = 'CampusOne@2026';
let panSeq = randomInt(0, 5_000);
const mobile = () => `9${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`;

describe.skipIf(!adminUrl)('terminals, readers and cards on real MySQL', () => {
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
    return { email };
  }
  async function signedIn(surface: 'ops' | 'console', email: string) {
    const base = surface === 'ops' ? '/api/v1/ops/auth' : '/api/v1/auth/console';
    const s1 = await request(app).post(`${base}/signin`).send({ email, password: PASSWORD });
    const r = await request(app)
      .post(`${base}/otp/verify`)
      .send({ challengeId: s1.body.challengeId, otp: codeOf(h.sms.sent.at(-1)) });
    const cookies = ([] as string[])
      .concat(r.headers['set-cookie'] ?? [])
      .map((c) => c.split(';')[0] ?? '');
    return { Cookie: cookies.join('; '), 'X-CSRF-Token': r.body.csrfToken as string };
  }
  /** A member with a CampusOne account and an active profile; returns its app session. */
  async function member(name: string) {
    const mob = mobile();
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
        pan: `ABCDE${String(++panSeq % 10_000).padStart(4, '0')}F`,
        firstName: name,
        lastName: 'Rao',
        gender: 'FEMALE',
        dob: '1990-04-12',
        idDocType: 'AADHAAR',
        idDocNumber: `${randomInt(2, 10)}${String(randomInt(0, 1e11)).padStart(11, '0')}`,
        email: `${name.toLowerCase()}.${randomInt(0, 1e9)}@example.in`,
        password: PASSWORD,
        securityQuestion: 'FIRST_SCHOOL',
        securityAnswer: 'vidyaniketan',
        device: { installId: randomUUID() },
      });
    expect(created.status).toBe(201);
    const p = await onboardStaff(app, school.con, {
      userTypeId: teacherTypeId,
      firstName: name,
      mobile: mob,
    });
    await request(app)
      .put('/api/v1/me/active-profile')
      .set({ Authorization: `Bearer ${created.body.accessToken}` })
      .send({ profileId: p.body.id });
    const refreshed = await request(app)
      .post('/api/v1/auth/token/refresh')
      .send({ refreshToken: created.body.refreshToken });
    return {
      id: p.body.id as string,
      auth: { Authorization: `Bearer ${refreshed.body.accessToken as string}` },
    };
  }
  /** A registered, paired and signed-in terminal of a purpose. */
  async function terminal(purpose: string, extra: Record<string, unknown> = {}) {
    const reg = await request(app)
      .post('/api/v1/console/readers')
      .set(school.con)
      .set('Idempotency-Key', randomUUID())
      .send({ name: `${purpose} ${randomInt(0, 1e6)}`, location: 'Main block', purpose, ...extra });
    expect(reg.status).toBe(201);
    const code = await request(app)
      .post(`/api/v1/console/readers/${reg.body.readerId}/pairing-codes`)
      .set(school.con)
      .set('Idempotency-Key', randomUUID());
    const fp = `device-${randomUUID()}`;
    const paired = await request(app)
      .post('/api/v1/terminal/pairing')
      .send({ pairingCode: code.body.code, deviceFingerprint: fp });
    expect(paired.status).toBe(201);
    const signIn = (o: { nonce?: string; fp?: string; secret?: string } = {}) => {
      const nonce = o.nonce ?? `${Math.floor(Date.now() / 1000)}.${randomUUID()}`;
      const signature = createHmac('sha256', o.secret ?? paired.body.credential)
        .update(`${paired.body.terminalId}.${nonce}`)
        .digest('hex');
      return request(app)
        .post('/api/v1/terminal/auth/signin')
        .send({
          terminalId: paired.body.terminalId,
          deviceFingerprint: o.fp ?? fp,
          nonce,
          signature,
        });
    };
    const session = await signIn();
    expect(session.status).toBe(200);
    return {
      id: reg.body.readerId as string,
      code: code.body.code as string,
      signIn,
      auth: { Authorization: `Bearer ${session.body.accessToken as string}` },
    };
  }

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
    const opRow = await t.db
      .selectFrom('platform_accounts')
      .select('id')
      .where('email', '=', op.email)
      .executeTakeFirstOrThrow();
    await t.db
      .insertInto('operator_accounts')
      .values({
        public_id: newPublicIdPair().bin,
        account_id: String(opRow.id),
        role_id: String(role.id),
      })
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
        name: `Card School ${tag}`,
        address: `Hill Road ${tag}, Madikeri`,
        city: 'Madikeri',
        primaryContact: {
          name: 'Lakshmi Rao',
          email: `office.${tag}@madikeri.example.in`,
          mobile: '9845012345',
        },
        adminEmail: admin.email,
        planId: plans.at(-1).id,
      });
    const id = reg.body.id as string;
    for (const step of ['toggles', 'year', 'feeacct']) {
      await request(app).post(`/api/v1/ops/institutions/${id}/checklist/${step}`).set(ops).send({});
    }
    const v = (await request(app).get(`/api/v1/ops/institutions/${id}`).set(ops)).body.version;
    await request(app)
      .put(`/api/v1/ops/institutions/${id}/bank-arrangement`)
      .set(ops)
      .set('If-Match', `"v${v}"`)
      .send({
        corporateCode: `C${String(randomInt(0, 999)).padStart(3, '0')}`,
        poolAccountRef: 'POOLCARD0001',
      });
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

  it('pairs once and signs in with a single-use signed nonce; purpose and status are checked on every call (IDN-040/041, INS-030…034)', async () => {
    const issue = await terminal('CARD_ISSUE');
    // The code is used once.
    expect(
      (
        await request(app)
          .post('/api/v1/terminal/pairing')
          .send({ pairingCode: issue.code, deviceFingerprint: 'x' })
      ).body.code,
    ).toBe('TRM.PAIRING_CODE_INVALID');
    // Wrong device, wrong signature, a replayed nonce, a stale nonce.
    expect((await issue.signIn({ fp: 'another-device' })).body.code).toBe('TRM.DEVICE_MISMATCH');
    expect((await issue.signIn({ secret: 'wrong' })).body.code).toBe('TRM.SIGNATURE_INVALID');
    const nonce = `${Math.floor(Date.now() / 1000)}.${randomUUID()}`;
    expect((await issue.signIn({ nonce })).status).toBe(200);
    expect((await issue.signIn({ nonce })).body.code).toBe('TRM.SIGNATURE_INVALID');
    expect(
      (await issue.signIn({ nonce: `${Math.floor(Date.now() / 1000) - 3600}.x` })).status,
    ).toBe(401);
    // An expired pairing code.
    const r2 = await request(app)
      .post('/api/v1/console/readers')
      .set(school.con)
      .set('Idempotency-Key', randomUUID())
      .send({ name: 'Gate 2', purpose: 'BALANCE_CHECK' });
    const c2 = await request(app)
      .post(`/api/v1/console/readers/${r2.body.readerId}/pairing-codes`)
      .set(school.con)
      .set('Idempotency-Key', randomUUID());
    await t.db
      .updateTable('terminals')
      .set({ pairing_expires_at: sql<Date>`UTC_TIMESTAMP(3) - INTERVAL 1 SECOND` })
      .where('public_id', '=', uuidToBin(r2.body.readerId))
      .execute();
    expect(
      (
        await request(app)
          .post('/api/v1/terminal/pairing')
          .send({ pairingCode: c2.body.code, deviceFingerprint: 'x' })
      ).body.code,
    ).toBe('TRM.PAIRING_CODE_EXPIRED');
    // A purpose that needs a binding.
    const bad = await request(app)
      .post('/api/v1/console/readers')
      .set(school.con)
      .set('Idempotency-Key', randomUUID())
      .send({ name: 'Counter', purpose: 'COUPON' });
    expect(bad.body.errors[0]).toMatchObject({ field: 'merchantId', code: 'VALIDATION.REQUIRED' });

    const kiosk = await terminal('BALANCE_CHECK');
    const list = await request(app)
      .get('/api/v1/console/readers?purpose=BALANCE_CHECK')
      .set(school.con);
    expect(list.body.items.find((x: { id: string }) => x.id === kiosk.id)).toMatchObject({
      status: 'ACTIVE',
      paired: true,
    });
    // The kiosk can't write cards; a disabled terminal is refused whatever token it holds.
    const m = await member('Gowri');
    expect(
      (
        await request(app)
          .post('/api/v1/terminal/reader/card-writes')
          .set(kiosk.auth)
          .set('Idempotency-Key', randomUUID())
          .send({ memberId: m.id, hardwareUid: '04A1B2C3' })
      ).body.code,
    ).toBe('TRM.WRONG_PURPOSE');
    await request(app)
      .post(`/api/v1/console/readers/${kiosk.id}/status`)
      .set(school.con)
      .send({ enabled: false, reason: 'Moved to storage' });
    expect(
      (
        await request(app)
          .post('/api/v1/terminal/reader/balance-checks')
          .set(kiosk.auth)
          .send({ cardToken: 'NFC0000000000000' })
      ).body.code,
    ).toBe('TRM.TERMINAL_DISABLED');
    expect((await kiosk.signIn()).body.code).toBe('TRM.SIGNATURE_INVALID');
  });

  it('writes one card per member, blocks it, re-issues only after the console authorises it; the member reports it lost (ATT-003…007, ATT-024/025)', async () => {
    const writer = await terminal('CARD_ISSUE');
    const kiosk = await terminal('BALANCE_CHECK');
    const m = await member('Harish');
    const write = () =>
      request(app)
        .post('/api/v1/terminal/reader/card-writes')
        .set(writer.auth)
        .set('Idempotency-Key', randomUUID())
        .send({ memberId: m.id, hardwareUid: '04a1b2c3d4' });
    const first = await write();
    expect(first.status).toBe(201);
    expect(first.body.cardToken).toMatch(/^NFC[A-Z0-9]{13}$/);
    expect((await write()).body).toMatchObject({
      code: 'ATT.CARD_ACTIVE_EXISTS',
      params: { name: 'Harish' },
    });

    const bal = await request(app)
      .post('/api/v1/terminal/reader/balance-checks')
      .set(kiosk.auth)
      .send({ cardToken: first.body.cardToken });
    expect(bal.body).toMatchObject({
      member: { id: m.id, name: 'Harish' },
      campus: { balance: { amount: '0.00' }, status: 'ACTIVE' },
    });

    const cards = await request(app).get('/api/v1/console/cards?q=Harish').set(school.con);
    expect(cards.body.items[0]).toMatchObject({
      status: 'ACTIVE',
      issueReason: 'NEW_REGISTRATION',
      reissueCount: 0,
    });
    expect(cards.body.items[0].token).toMatch(/^NFC••••[A-Z0-9]{4}$/);
    const cardId = cards.body.items[0].id as string;
    await request(app)
      .post(`/api/v1/console/cards/${cardId}/status`)
      .set(school.con)
      .send({ action: 'BLOCK', reason: 'Found in the playground' });
    expect(
      (
        await request(app)
          .post('/api/v1/terminal/reader/balance-checks')
          .set(kiosk.auth)
          .send({ cardToken: first.body.cardToken })
      ).body.code,
    ).toBe('ATT.CARD_NOT_ACTIVE');
    // Without a console re-issue the reader can't write a replacement.
    expect((await write()).body.code).toBe('ATT.CARD_WRITE_REQUIRED');
    const re = await request(app)
      .post(`/api/v1/console/cards/${cardId}/reissue`)
      .set(school.con)
      .set('Idempotency-Key', randomUUID())
      .send({ reasonCode: 'LOST' });
    expect(re.body.pairingForWrite.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    const second = await write();
    expect(second.status).toBe(201);
    const mine = await request(app).get('/api/v1/me/card').set(m.auth);
    expect(mine.body.card).toMatchObject({
      status: 'ACTIVE',
      issueReason: 'LOST',
      reissueCount: 1,
    });
    expect(
      (
        await request(app)
          .post('/api/v1/me/card/loss-reports')
          .set(m.auth)
          .set('Idempotency-Key', randomUUID())
          .send({ reason: 'Lost on the bus' })
      ).status,
    ).toBe(201);
    expect((await request(app).get('/api/v1/me/card').set(m.auth)).body.card).toMatchObject({
      status: 'INACTIVE',
      statusReason: 'Lost on the bus',
    });
    expect(
      (
        await request(app)
          .post('/api/v1/me/card/loss-reports')
          .set(m.auth)
          .set('Idempotency-Key', randomUUID())
          .send({})
      ).body.code,
    ).toBe('ATT.CARD_ALREADY_BLOCKED');

    // ATT-027: the console of the desktop app issues on its own USB reader, same rules.
    const n = await member('Nalini');
    const fromConsole = () =>
      request(app)
        .post('/api/v1/console/cards')
        .set(school.con)
        .set('Idempotency-Key', randomUUID())
        .send({ memberId: n.id, hardwareUid: '04c0ffee' });
    const issued = await fromConsole();
    expect(issued.status).toBe(201);
    expect(issued.body.cardToken).toMatch(/^NFC[A-Z0-9]{13}$/);
    expect((await fromConsole()).body.code).toBe('ATT.CARD_ACTIVE_EXISTS');
    const tapped = await request(app)
      .post('/api/v1/terminal/reader/balance-checks')
      .set(kiosk.auth)
      .send({ cardToken: issued.body.cardToken.toLowerCase() });
    expect(tapped.body).toMatchObject({ member: { id: n.id, name: 'Nalini' } });
    const row = await t.db
      .selectFrom('cards')
      .select(['hardware_uid', 'issued_by_terminal'])
      .where('token', '=', issued.body.cardToken)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ hardware_uid: '04C0FFEE', issued_by_terminal: null });
  });

  it("pays a merchant's NFC request once by a card tap; a reused or wrong nonce is a replay (PAY-012)", async () => {
    const writer = await terminal('CARD_ISSUE');
    const payer = await member('Indira');
    const card = await request(app)
      .post('/api/v1/terminal/reader/card-writes')
      .set(writer.auth)
      .set('Idempotency-Key', randomUUID())
      .send({ memberId: payer.id, hardwareUid: '04ffeedd' });
    const wallet = await t.db
      .selectFrom('wallets as w')
      .innerJoin('member_profiles as m', 'm.id', 'w.owner_profile_id')
      .select('w.id')
      .where('m.public_id', '=', uuidToBin(payer.id))
      .where('w.kind', '=', 'CAMPUS')
      .executeTakeFirstOrThrow();
    await t.db.transaction().execute((trx) =>
      h.services.ledger.post(trx, {
        institutionId: school.rowId,
        type: 'ADJUSTMENT',
        channel: 'BACK_OFFICE',
        amountPaise: 10_000,
        idempotencyKey: randomUUID(),
        debit: { account: 'ADJUSTMENT', institutionId: school.rowId },
        credit: { walletId: String(wallet.id) },
        narration: 'Opening balance',
      }),
    );
    // The merchant, signed in on its own app, with NFC switched on.
    const merMobile = mobile();
    const start = await request(app)
      .post('/api/v1/auth/member/signup/otp')
      .send({ mobile: merMobile, consentVersion: '2026.10' });
    const verify = await request(app)
      .post('/api/v1/auth/member/signup/otp/verify')
      .send({ challengeId: start.body.challengeId, otp: codeOf(h.sms.sent.at(-1)) });
    const acc = await request(app)
      .post('/api/v1/auth/member/signup')
      .set('Idempotency-Key', randomUUID())
      .send({
        signupToken: verify.body.signupToken,
        mobile: merMobile,
        consentVersion: '2026.10',
        termsVersion: '2026.10',
        termsAccepted: true,
        pan: `ABCDE${String(++panSeq % 10_000).padStart(4, '0')}F`,
        firstName: 'Ravi',
        lastName: 'Kumar',
        gender: 'MALE',
        dob: '1985-01-01',
        idDocType: 'AADHAAR',
        idDocNumber: `${randomInt(2, 10)}${String(randomInt(0, 1e11)).padStart(11, '0')}`,
        email: `ravi.${randomInt(0, 1e9)}@example.in`,
        password: PASSWORD,
        securityQuestion: 'FIRST_SCHOOL',
        securityAnswer: 'vidyaniketan',
        device: { installId: randomUUID() },
      });
    const mer = await request(app)
      .post('/api/v1/console/merchants')
      .set(school.con)
      .set('Idempotency-Key', randomUUID())
      .send({
        displayName: 'Tuck Shop',
        operatorFirstName: 'Ravi',
        subType: 'REGULAR',
        mobile: merMobile,
      });
    const d = await request(app)
      .get(`/api/v1/console/merchants/${mer.body.merchantId}`)
      .set(school.con);
    await request(app)
      .put(`/api/v1/console/merchants/${mer.body.merchantId}/channels`)
      .set(school.con)
      .set('If-Match', `"v${d.body.version}"`)
      .send({ dynamicQr: false, nfc: true });
    await request(app)
      .put('/api/v1/me/active-profile')
      .set({ Authorization: `Bearer ${acc.body.accessToken}` })
      .send({ profileId: mer.body.merchantId });
    const merAuth = {
      Authorization: `Bearer ${(await request(app).post('/api/v1/auth/token/refresh').send({ refreshToken: acc.body.refreshToken })).body.accessToken}`,
    };
    const req = await request(app)
      .post('/api/v1/merchant/payment-requests')
      .set(merAuth)
      .set('Idempotency-Key', randomUUID())
      .send({ kind: 'NFC', amount: { amount: '30.00', currency: 'INR' } });
    expect(req.status).toBe(201);
    expect(req.body.nonce).toBeTruthy();
    const tap = (nonce: string) =>
      request(app)
        .post(`/api/v1/merchant/payment-requests/${req.body.requestId}/nfc-taps`)
        .set(merAuth)
        .set('Idempotency-Key', randomUUID())
        .send({ cardToken: card.body.cardToken, nonce });
    expect((await tap('not-the-nonce')).body.code).toBe('PAY.NONCE_REPLAY');
    const paid = await tap(req.body.nonce);
    expect(paid.status).toBe(200);
    expect(paid.body.receipt).toMatchObject({
      status: 'SUCCESS',
      channel: 'NFC',
      amount: { amount: '30.00', currency: 'INR' },
    });
    expect((await tap(req.body.nonce)).body.code).toBe('PAY.NONCE_REPLAY');
    const st = await request(app)
      .get(`/api/v1/merchant/payment-requests/${req.body.requestId}`)
      .set(merAuth);
    expect(st.body).toMatchObject({ status: 'SUCCESS', payer: 'Indira' });
  });
});
