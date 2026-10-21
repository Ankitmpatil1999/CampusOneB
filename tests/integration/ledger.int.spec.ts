/**
 * Wallets and the ledger on a real MySQL (Phase 3.1; RNG-GOV-015…017; WAL-001…005, WAL-008/009,
 * RPT-006): every profile gets its wallets, postings balance, a key posts exactly once, parallel
 * debits never overdraw, the ledger refuses updates and deletes, wallets follow their holder, and
 * the member sees balances, the statement, the receipt and the virtual account.
 */
import { randomInt, randomUUID } from 'node:crypto';
import request from 'supertest';
import { onboardStaff } from './staff';
import type { Express } from 'express';
import { sql } from 'kysely';
import { adminUrl, createTestDatabase, type TestDatabase } from './db';
import { buildHttpApp, codeOf } from './http-app';
import { newPublicIdPair, uuidToBin } from '../../utils/idGenerator';
import { hashSecret } from '../../utils/password';

/** PANs are unique per platform: a counter keeps sign-ups in one file from colliding. */
let panSeq = randomInt(0, 5_000);
const uniquePan = () => `ABCDE${String(++panSeq % 10_000).padStart(4, '0')}F`;
const PASSWORD = 'Ringpe@2026';
const mobile = () => `9${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`;

describe.skipIf(!adminUrl)('wallets and the ledger on real MySQL', () => {
  let t: TestDatabase;
  let h: Awaited<ReturnType<typeof buildHttpApp>>;
  let app: Express;
  let ops: Record<string, string>;
  let school: { id: string; rowId: string; con: Record<string, string> };
  let teacherTypeId = '';

  async function account(first: string, mob = mobile()) {
    const email = `${first.toLowerCase()}.${randomInt(0, 1e9)}@example.in`;
    const r = await t.db
      .insertInto('platform_accounts')
      .values({
        public_id: newPublicIdPair().bin,
        mobile: mob,
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
    return { id: String(r.insertId), email, mobile: mob };
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

  async function member(mob: string) {
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
    return { Authorization: `Bearer ${created.body.accessToken}` };
  }

  /** A profile of the school with its wallets (onboarded through the console). */
  async function profile(firstName: string, mob = mobile()) {
    const r = await onboardStaff(app, school.con, {
      userTypeId: teacherTypeId,
      firstName,
      mobile: mob,
    });
    expect(r.status).toBe(201);
    const row = await t.db
      .selectFrom('member_profiles')
      .select('id')
      .where('public_id', '=', uuidToBin(r.body.id))
      .executeTakeFirstOrThrow();
    const wallets = await t.db
      .selectFrom('wallets')
      .select(['id', 'kind', 'status', 'wallet_no'])
      .where('owner_profile_id', '=', String(row.id))
      .execute();
    return { id: r.body.id as string, rowId: String(row.id), wallets };
  }

  const campus = (p: { wallets: { id: string; kind: string }[] }) =>
    String(p.wallets.find((w) => w.kind === 'CAMPUS')!.id);
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
  /** Money in from the institution's adjustment account (the bank rail arrives in 3.5). */
  const credit = (walletId: string, paise: number, key = randomUUID()) =>
    t.db.transaction().execute((trx) =>
      h.services.ledger.post(trx, {
        institutionId: school.rowId,
        type: 'ADJUSTMENT',
        channel: 'BACK_OFFICE',
        amountPaise: paise,
        idempotencyKey: key,
        debit: { account: 'ADJUSTMENT', institutionId: school.rowId },
        credit: { walletId },
        narration: 'Opening balance',
      }),
    );

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
    ops = await signedIn('ops', op.email);
    const admin = await account('LAKSHMI');
    const plans = (await request(app).get('/api/v1/ops/plans').set(ops)).body.items;
    const tag = randomInt(0, 1e9);
    const reg = await request(app)
      .post('/api/v1/ops/institutions')
      .set(ops)
      .set('Idempotency-Key', randomUUID())
      .send({
        name: `Ledger School ${tag}`,
        address: `Main Road ${tag}, Sagar`,
        city: 'Sagar',
        primaryContact: {
          name: 'Lakshmi Rao',
          email: `office.${tag}@sagar.example.in`,
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
        corporateCode: `L${String(randomInt(0, 999)).padStart(3, '0')}`,
        poolAccountRef: 'POOLLED0001',
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
    await request(app)
      .post('/api/v1/console/user-types')
      .set(school.con)
      .set('Idempotency-Key', randomUUID())
      .send({ name: 'Teacher', category: 'TEACHER', departments: ['Primary'] });
    teacherTypeId = (
      await request(app).get('/api/v1/console/user-types').set(school.con)
    ).body.items.find((x: { name: string }) => x.name === 'Teacher').id;
  }, 180_000);
  afterAll(async () => {
    await t?.drop();
  });

  it('opens a campus wallet, an inactive allowance wallet and a virtual account for every profile', async () => {
    const p = await profile('Kavya');
    expect(p.wallets.map((w) => [w.kind, w.status]).sort()).toEqual([
      ['ALLOWANCE', 'INACTIVE'],
      ['CAMPUS', 'ACTIVE'],
    ]);
    expect(p.wallets.find((w) => w.kind === 'CAMPUS')!.wallet_no).toMatch(/^5555\d{5}$/);
    expect(p.wallets.find((w) => w.kind === 'ALLOWANCE')!.wallet_no).toMatch(/^565656\d{9}$/);
    const va = await t.db
      .selectFrom('virtual_accounts')
      .select('va_number')
      .where('wallet_id', '=', campus(p))
      .executeTakeFirst();
    expect(va?.va_number).toMatch(/^L\d{3}5555\d{5}$/);
    // The administrator's profile, created before the corporate code, got its account too.
    const admins = await t.db
      .selectFrom('virtual_accounts')
      .select(sql<number>`COUNT(*)`.as('n'))
      .where('institution_id', '=', school.rowId)
      .executeTakeFirst();
    expect(Number(admins?.n)).toBeGreaterThanOrEqual(2);
  });

  it('posts balanced pairs exactly once and refuses an overdraw or a self-payment', async () => {
    const p = await profile('Meena');
    const key = randomUUID();
    const first = await credit(campus(p), 100_000, key);
    expect(first.replayed).toBe(false);
    expect(first.reference).toMatch(/^RPAD[A-Z0-9]{23}\d{8}$/);
    const again = await credit(campus(p), 999_999, key);
    expect(again).toMatchObject({ replayed: true, txnId: first.txnId });
    expect(await balance(campus(p))).toBe(100_000);
    const sums = await t.db
      .selectFrom('ledger_entries')
      .select(['direction', sql<string>`SUM(amount_paise)`.as('total')])
      .where('ledger_txn_id', '=', first.txnId)
      .groupBy('direction')
      .execute();
    expect(sums.map((s) => [s.direction, Number(s.total)]).sort()).toEqual([
      ['C', 100_000],
      ['D', 100_000],
    ]);
    const q = await profile('Ravi');
    const over = t.db.transaction().execute((trx) =>
      h.services.ledger.post(trx, {
        institutionId: school.rowId,
        type: 'TRANSFER',
        channel: 'TRANSFER',
        amountPaise: 100_001,
        idempotencyKey: randomUUID(),
        debit: { walletId: campus(p) },
        credit: { walletId: campus(q) },
        narration: 'Too much',
      }),
    );
    await expect(over).rejects.toMatchObject({ code: 'PAY.INSUFFICIENT_BALANCE' });
    const self = t.db.transaction().execute((trx) =>
      h.services.ledger.post(trx, {
        institutionId: school.rowId,
        type: 'TRANSFER',
        channel: 'TRANSFER',
        amountPaise: 100,
        idempotencyKey: randomUUID(),
        debit: { walletId: campus(p) },
        credit: { walletId: campus(p) },
        narration: 'Self',
      }),
    );
    await expect(self).rejects.toMatchObject({ code: 'PAY.SELF_PAYMENT' });
    expect(await balance(campus(p))).toBe(100_000);
  });

  it('never overdraws under 50 parallel debits, and opposite transfers never deadlock', async () => {
    const a = await profile('Asha');
    const b = await profile('Bhavya');
    await credit(campus(a), 100_000);
    await credit(campus(b), 100_000);
    const debit = (from: string, to: string, paise: number) =>
      t.db.transaction().execute((trx) =>
        h.services.ledger.post(trx, {
          institutionId: school.rowId,
          type: 'TRANSFER',
          channel: 'TRANSFER',
          amountPaise: paise,
          idempotencyKey: randomUUID(),
          debit: { walletId: from },
          credit: { walletId: to },
          narration: 'Parallel',
        }),
      );
    const results = await Promise.allSettled(
      Array.from({ length: 50 }, (_, i) =>
        i % 2 ? debit(campus(a), campus(b), 3_000) : debit(campus(b), campus(a), 2_000),
      ),
    );
    const failed = results.filter((r) => r.status === 'rejected');
    for (const f of failed) {
      expect((f as PromiseRejectedResult).reason).toMatchObject({
        code: 'PAY.INSUFFICIENT_BALANCE',
      });
    }
    const [ba, bb] = [await balance(campus(a)), await balance(campus(b))];
    expect(ba).toBeGreaterThanOrEqual(0);
    expect(bb).toBeGreaterThanOrEqual(0);
    expect(ba + bb).toBe(200_000);
    // Every wallet entry's running balance matches the wallet.
    const last = await t.db
      .selectFrom('ledger_entries')
      .select('balance_after_paise')
      .where('wallet_id', '=', campus(a))
      .orderBy('id', 'desc')
      .limit(1)
      .executeTakeFirstOrThrow();
    expect(Number(last.balance_after_paise)).toBe(ba);
  }, 60_000);

  it('refuses to change or remove ledger rows', async () => {
    const p = await profile('Nisha');
    const posted = await credit(campus(p), 5_000);
    await expect(
      sql`UPDATE ledger_entries SET amount_paise = 1 WHERE ledger_txn_id = ${posted.txnId}`.execute(
        t.db,
      ),
    ).rejects.toThrow(/append-only/);
    await expect(
      sql`DELETE FROM ledger_transactions WHERE id = ${posted.txnId}`.execute(t.db),
    ).rejects.toThrow(/append-only/);
  });

  it('keeps wallets with their holder: deactivated, then active again', async () => {
    const p = await profile('Latha');
    const off = await request(app)
      .post(`/api/v1/console/members/${p.id}/status-changes`)
      .set(school.con)
      .set('Idempotency-Key', randomUUID())
      .send({ to: 'INACTIVE', reason: 'Left at the end of term' });
    expect(off.status).toBe(200);
    const status = async () =>
      (
        await t.db
          .selectFrom('wallets')
          .select(['kind', 'status'])
          .where('owner_profile_id', '=', p.rowId)
          .execute()
      )
        .map((w) => [w.kind, w.status])
        .sort();
    expect(await status()).toEqual([
      ['ALLOWANCE', 'INACTIVE'],
      ['CAMPUS', 'INACTIVE'],
    ]);
    await request(app)
      .post(`/api/v1/console/members/${p.id}/status-changes`)
      .set(school.con)
      .set('Idempotency-Key', randomUUID())
      .send({ to: 'ACTIVE' });
    // The allowance wallet was never credited, so it stays Inactive (RC-02).
    expect(await status()).toEqual([
      ['ALLOWANCE', 'INACTIVE'],
      ['CAMPUS', 'ACTIVE'],
    ]);
  });

  it('shows the member their wallets, statement, receipt, virtual account and home', async () => {
    const mob = mobile();
    const auth = await member(mob);
    const p = await profile('Asha', mob);
    const posted = await credit(campus(p), 25_050);
    const mine = await request(app).get('/api/v1/me/wallets').set(auth);
    expect(mine.status).toBe(200);
    const wallet = mine.body.wallets.find((w: { kind: string }) => w.kind === 'CAMPUS');
    expect(wallet).toMatchObject({
      status: 'ACTIVE',
      balance: { amount: '250.50', currency: 'INR' },
      spentToday: { amount: '0.00', currency: 'INR' },
    });
    const st = await request(app).get(`/api/v1/me/wallets/${wallet.id}/statement`).set(auth);
    expect(st.body.items[0]).toMatchObject({
      reference: posted.reference,
      direction: 'CREDIT',
      amount: { amount: '250.50' },
      balanceAfter: { amount: '250.50' },
    });
    expect(st.body.closingBalance).toEqual({ amount: '250.50', currency: 'INR' });
    const receipt = await request(app).get(`/api/v1/me/transactions/${posted.reference}`).set(auth);
    expect(receipt.body).toMatchObject({
      status: 'SUCCESS',
      direction: 'CREDIT',
      to: { name: 'Asha' },
    });
    const pdf = await request(app)
      .get(`/api/v1/me/transactions/${posted.reference}/receipt.pdf`)
      .set(auth)
      .buffer(true)
      .parse((res, done) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => done(null, Buffer.concat(chunks)));
      });
    expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    const va = await request(app).get(`/api/v1/me/wallets/${wallet.id}/virtual-account`).set(auth);
    expect(va.body).toMatchObject({
      vaNumber: wallet.virtualAccount,
      example: true,
      ifsc: 'EXMP0000001',
    });
    const home = await request(app).get('/api/v1/me/home').set(auth);
    expect(home.body.recent[0].reference).toBe(posted.reference);

    // Someone else's wallet and movement are not found.
    const other = await member(mobile());
    expect(
      (await request(app).get(`/api/v1/me/wallets/${wallet.id}/statement`).set(other)).status,
    ).toBe(404);
    expect(
      (await request(app).get(`/api/v1/me/transactions/${posted.reference}`).set(other)).status,
    ).toBe(404);

    // The console sees the member's wallets and statement.
    const cw = await request(app).get(`/api/v1/console/members/${p.id}/wallets`).set(school.con);
    expect(cw.body.wallets.find((w: { kind: string }) => w.kind === 'CAMPUS').balance.amount).toBe(
      '250.50',
    );
    const cs = await request(app).get(`/api/v1/console/members/${p.id}/statement`).set(school.con);
    expect(cs.body.items).toHaveLength(1);
  });

  it('sets, checks, changes and resets the transaction PIN; caps the day; revokes the permission (3.2)', async () => {
    const mob = mobile();
    const auth = await member(mob);
    const p = await profile('Pooja', mob);
    const acc = await t.db
      .selectFrom('platform_accounts')
      .select('id')
      .where('mobile', '=', mob)
      .executeTakeFirstOrThrow();
    const status = async () =>
      (await request(app).get('/api/v1/me/payment-security').set(auth)).body;
    expect((await status()).tpin).toEqual({ set: false, lockedUntil: null });
    const set = (pin: string) => request(app).post('/api/v1/me/tpin').set(auth).send({ pin });
    expect((await set('1234')).body.errors[0].code).toBe('IDN.TPIN_WEAK');
    expect((await set('7777')).body.errors[0].code).toBe('IDN.TPIN_WEAK');
    expect((await set('4821')).status).toBe(201);
    expect((await set('4822')).body.code).toBe('IDN.TPIN_ALREADY_SET');
    // The engine's check: two wrong PINs count down, the third locks.
    const verify = (pin: string) => h.services.paymentSecurity.verifyPin(String(acc.id), pin);
    await expect(verify('4821')).resolves.toBeUndefined();
    await expect(verify('5000')).rejects.toMatchObject({
      errors: [{ code: 'IDN.TPIN_WRONG', params: { left: 2 } }],
    });
    await expect(verify('5001')).rejects.toMatchObject({
      errors: [{ code: 'IDN.TPIN_WRONG', params: { left: 1 } }],
    });
    await expect(verify('5002')).rejects.toMatchObject({ code: 'IDN.TPIN_LOCKED' });
    await expect(verify('4821')).rejects.toMatchObject({ code: 'IDN.TPIN_LOCKED' });
    expect((await status()).tpin.lockedUntil).not.toBeNull();
    // Forgot PIN: the security answer and a code, then a new PIN (not the old one).
    const otp = await request(app).post('/api/v1/me/tpin/reset/otp').set(auth).send({});
    expect(otp.status).toBe(202);
    const code = codeOf(h.sms.sent.at(-1));
    const reset = (newPin: string) =>
      request(app).post('/api/v1/me/tpin/reset').set(auth).send({
        securityAnswer: 'vidyaniketan',
        challengeId: otp.body.challengeId,
        otp: code,
        newPin,
      });
    expect((await reset('4821')).body.errors[0].code).toBe('IDN.TPIN_REUSED');
    expect((await reset('5930')).status).toBe(204);
    await expect(verify('5930')).resolves.toBeUndefined();
    const change = await request(app)
      .put('/api/v1/me/tpin')
      .set(auth)
      .send({ currentPin: '5930', newPin: '4821' });
    expect(change.body.errors[0].code).toBe('IDN.TPIN_REUSED');
    expect(
      (
        await request(app)
          .put('/api/v1/me/tpin')
          .set(auth)
          .send({ currentPin: '5930', newPin: '6142' })
      ).status,
    ).toBe(204);

    // The cap: ₹100 and 2 payments a day.
    const cap = await request(app)
      .put('/api/v1/me/spending-cap')
      .set(auth)
      .set('If-Match', '"v0"')
      .send({ enabled: true, amount: '100.00', count: 2 });
    expect(cap.body).toMatchObject({
      enabled: true,
      amount: { amount: '100.00' },
      count: 2,
      version: 1,
    });
    await credit(campus(p), 50_000);
    const other = await profile('Rekha');
    const pay = (paise: number) =>
      t.db.transaction().execute(async (trx) => {
        await h.services.paymentSecurity.checkCap(trx, String(acc.id), paise);
        return h.services.ledger.post(trx, {
          institutionId: school.rowId,
          type: 'TRANSFER',
          channel: 'TRANSFER',
          amountPaise: paise,
          idempotencyKey: randomUUID(),
          debit: { walletId: campus(p) },
          credit: { walletId: campus(other) },
          narration: 'Capped',
        });
      });
    await pay(6_000);
    await expect(pay(5_000)).rejects.toMatchObject({ code: 'IDN.CAP_EXCEEDED' });
    await pay(4_000);
    await expect(pay(100)).rejects.toMatchObject({ code: 'IDN.CAP_EXCEEDED' });

    // The console revokes the transaction permission with a reason (If-Match).
    const detail = await request(app).get(`/api/v1/console/members/${p.id}`).set(school.con);
    const revoke = await request(app)
      .put(`/api/v1/console/members/${p.id}/transaction-permission`)
      .set(school.con)
      .set('If-Match', `"v${detail.body.version}"`)
      .send({ enabled: false, reason: 'Parent asked to pause payments' });
    expect(revoke.status).toBe(200);
    expect(revoke.body).toMatchObject({ enabled: false, version: detail.body.version + 1 });
    const row = await t.db
      .selectFrom('member_profiles')
      .select('txn_permission')
      .where('id', '=', p.rowId)
      .executeTakeFirstOrThrow();
    expect(Number(row.txn_permission)).toBe(0);
  });
});
