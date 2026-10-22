/**
 * An active school on a real MySQL for the Phase 4 suites: an operator registers and activates it, its
 * administrator signs in on the console, and the helpers make payers (PIN set, wallet funded) and
 * merchants (wallet, Payment QR, own app). The same steps as payments.int.spec.ts, shared.
 */
import { createHmac, randomInt, randomUUID } from 'node:crypto';
import request from 'supertest';
import { onboardStaff } from './staff';
import { expect } from 'vitest';
import { createTestDatabase, type TestDatabase } from './db';
import { buildHttpApp, codeOf } from './http-app';
import { newPublicIdPair, uuidToBin } from '../../utils/idGenerator';
import { hashSecret } from '../../utils/password';
import { hasAadhaarCheckDigit } from '../../utils/validators';

let panSeq = randomInt(0, 5_000);
const uniquePan = () => `ABCDE${String(++panSeq % 10_000).padStart(4, '0')}F`;
export const PASSWORD = 'Ringpe@2026';
export const PIN = '4826';
export const mobile = () => `9${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`;
/** A valid, random Aadhaar number: eleven digits and the one Verhoeff check digit that fits. */
export const aadhaar = () => {
  const base = `${randomInt(2, 10)}${String(randomInt(0, 10_000_000_000)).padStart(10, '0')}`;
  for (let d = 0; d < 10; d++) if (hasAadhaarCheckDigit(`${base}${d}`)) return `${base}${d}`;
  throw new Error('no Verhoeff check digit');
};
export const inr = (amount: string) => ({ amount, currency: 'INR' });

export type Auth = Record<string, string>;
export interface Payer {
  id: string;
  rowId: string;
  accountId: string;
  auth: Auth;
  wallet: string;
  mobile: string;
}
export interface Merchant {
  id: string;
  uniqueId: string;
  rowId: string;
  wallet: string;
  qr: { id: string; payload: string; version: number };
  auth: Auth;
}

export async function schoolFixture(name: string) {
  const t: TestDatabase = await createTestDatabase();
  const h = await buildHttpApp(t);
  const app = h.app;

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

  async function signedIn(surface: 'ops' | 'console', email: string): Promise<Auth> {
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

  /** The newest code sent to `mob` (sign-ups may run in parallel). */
  const codeTo = (mob: string) => codeOf(h.sms.sent.findLast((m) => m.to.endsWith(mob)));

  async function signUp(mob: string, firstName = 'Asha') {
    const installId = randomUUID();
    const start = await request(app)
      .post('/api/v1/auth/member/signup/otp')
      .send({ mobile: mob, consentVersion: '2026.10' });
    const verify = await request(app)
      .post('/api/v1/auth/member/signup/otp/verify')
      .send({ challengeId: start.body.challengeId, otp: codeTo(mob) });
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
        firstName,
        lastName: 'Rao',
        gender: 'FEMALE',
        dob: '1990-04-12',
        idDocType: 'AADHAAR',
        idDocNumber: `${randomInt(2, 10)}${String(randomInt(0, 1e11)).padStart(11, '0')}`,
        email: `${firstName.toLowerCase()}.${randomInt(0, 1e9)}@example.in`,
        password: PASSWORD,
        securityQuestion: 'FIRST_SCHOOL',
        securityAnswer: 'vidyaniketan',
        device: { installId },
      });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    return {
      access: created.body.accessToken as string,
      refresh: created.body.refreshToken as string,
      installId,
    };
  }

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

  const profileRow = (publicId: string) =>
    t.db
      .selectFrom('member_profiles')
      .select(['id', 'account_id'])
      .where('public_id', '=', uuidToBin(publicId))
      .executeTakeFirstOrThrow();

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

  // --- the school -----------------------------------------------------------------------------------
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
      name: `${name} ${tag}`,
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
  expect(reg.status).toBe(201);
  const id = reg.body.id as string;
  const version = (await request(app).get(`/api/v1/ops/institutions/${id}`).set(ops)).body.version;
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
  const school = {
    id,
    rowId: String(row.id),
    adminEmail: admin.email,
    con: await signedIn('console', admin.email),
  };
  for (const [typeName, category, departments] of [
    ['Teacher', 'TEACHER', ['Primary']],
    ['Merchant', 'MERCHANT', ['Canteen']],
  ] as const) {
    await request(app)
      .post('/api/v1/console/user-types')
      .set(school.con)
      .set('Idempotency-Key', randomUUID())
      .send({ name: typeName, category, departments });
  }
  const teacherTypeId = (
    await request(app).get('/api/v1/console/user-types').set(school.con)
  ).body.items.find((x: { name: string }) => x.name === 'Teacher').id as string;

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

  /** A payer of the school: account, profile, active session, PIN set, wallet funded. */
  async function payer(firstName: string, paise: number): Promise<Payer> {
    const mob = mobile();
    const tokens = await signUp(mob, firstName);
    const r = await onboardStaff(app, school.con, {
      userTypeId: teacherTypeId,
      firstName,
      mobile: mob,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const auth = await onProfile(tokens, r.body.id);
    expect((await request(app).post('/api/v1/me/tpin').set(auth).send({ pin: PIN })).status).toBe(
      201,
    );
    const p = await profileRow(r.body.id);
    const wallet = await walletOf(String(p.id), 'CAMPUS');
    if (paise) await credit(wallet, paise);
    return {
      id: r.body.id as string,
      rowId: String(p.id),
      accountId: String(p.account_id),
      auth,
      wallet,
      mobile: mob,
    };
  }

  /** Switches one of the institution's features (7.5) on or off. */
  async function feature(key: string, enabled: boolean) {
    await t.db
      .insertInto('feature_toggles')
      .values({ institution_id: school.rowId, feature_key: key, enabled: enabled ? 1 : 0 })
      .onDuplicateKeyUpdate({ enabled: enabled ? 1 : 0 })
      .execute();
  }

  let studentSetup: { typeId: string; sectionId: string } | null = null;
  let admissionSeq = 0;
  /** The Parent user type and a Grade 6 A, once (onboarding made the Student type). */
  async function ensureStudents() {
    if (!studentSetup) {
      await request(app)
        .post('/api/v1/console/user-types')
        .set(school.con)
        .set('Idempotency-Key', randomUUID())
        .send({ name: 'Parent', category: 'PARENT', departments: ['Parents'] });
      const cls = await request(app)
        .post('/api/v1/console/classes')
        .set(school.con)
        .set('Idempotency-Key', randomUUID())
        .send({ name: 'Grade 6', sections: [{ name: 'A' }] });
      expect(cls.status, JSON.stringify(cls.body)).toBe(201);
      const types = (await request(app).get('/api/v1/console/user-types').set(school.con)).body
        .items as { id: string; name: string }[];
      studentSetup = {
        typeId: types.find((x) => x.name === 'Student')!.id,
        sectionId: cls.body.sections[0].id as string,
      };
    }
    return studentSetup;
  }

  /**
   * A child without a phone, onboarded with a guardian's mobile: the child sits on the guardian's
   * account (BR-02, CR-04). Returns the child's profile id.
   */
  async function ward(firstName: string, guardianMobile: string) {
    const st = await ensureStudents();
    const r = await request(app)
      .post('/api/v1/console/members')
      .set(school.con)
      .set('Idempotency-Key', randomUUID())
      .send({
        userTypeId: st.typeId,
        firstName,
        lastName: 'Rao',
        gender: 'MALE',
        dateOfBirth: '2015-06-01',
        admissionNo: `ADM/${++admissionSeq}/${randomInt(0, 1e6)}`,
        sectionId: st.sectionId,
        guardians: [
          {
            firstName: 'Guardian',
            lastName: 'Rao',
            mobile: guardianMobile,
            email: `guardian.${guardianMobile}@example.in`,
            relation: 'FATHER',
          },
        ],
      });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.id as string;
  }

  /** A student with their own mobile, signed in on their profile, PIN set (wallets as payer). */
  async function student(
    firstName: string,
    paise = 0,
  ): Promise<Payer & { allowanceWallet: string }> {
    const studentSetup = await ensureStudents();
    const mob = mobile();
    const tokens = await signUp(mob, firstName);
    const r = await request(app)
      .post('/api/v1/console/members')
      .set(school.con)
      .set('Idempotency-Key', randomUUID())
      .send({
        userTypeId: studentSetup.typeId,
        firstName,
        lastName: 'Rao',
        gender: 'FEMALE',
        dateOfBirth: '2014-04-12',
        admissionNo: `ADM/${++admissionSeq}/${randomInt(0, 1e6)}`,
        sectionId: studentSetup.sectionId,
        mobile: mob,
      });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const auth = await onProfile(tokens, r.body.id);
    expect((await request(app).post('/api/v1/me/tpin').set(auth).send({ pin: PIN })).status).toBe(
      201,
    );
    const p = await profileRow(r.body.id);
    const wallet = await walletOf(String(p.id), 'CAMPUS');
    if (paise) await credit(wallet, paise);
    const allowanceWallet = String(
      (
        await t.db
          .selectFrom('wallets')
          .select('id')
          .where('owner_profile_id', '=', String(p.id))
          .where('kind', '=', 'ALLOWANCE')
          .executeTakeFirstOrThrow()
      ).id,
    );
    return {
      id: r.body.id as string,
      rowId: String(p.id),
      accountId: String(p.account_id),
      auth,
      wallet,
      allowanceWallet,
      mobile: mob,
    };
  }

  /** A merchant registered by the console with a Payment QR, signed in on its own app. */
  async function merchant(
    displayName: string,
    opts: { subType?: 'REGULAR' | 'VENDOR' } = {},
  ): Promise<Merchant> {
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
        acceptsCoupon: opts.subType !== 'VENDOR',
        bank: { holderName: 'Ravi Kumar', accountNumber: '123456781234', ifsc: 'SBIN0001234' },
      });
    expect(r.status).toBe(201);
    const p = await profileRow(r.body.merchantId);
    const qr = await request(app)
      .post(`/api/v1/console/merchants/${r.body.merchantId}/qr-codes`)
      .set(school.con)
      .set('Idempotency-Key', randomUUID())
      .send({ kind: 'PAYMENT' });
    expect(qr.status).toBe(201);
    return {
      id: r.body.merchantId as string,
      uniqueId: r.body.uniqueId as string,
      rowId: String(p.id),
      wallet: await walletOf(String(p.id), 'MERCHANT'),
      qr: qr.body as Merchant['qr'],
      auth: await onProfile(tokens, r.body.merchantId),
    };
  }

  /** A reader registered by the console, paired and signed in (CR-10; INS-031, IDN-040/041). */
  async function terminal(purpose: string, extra: Record<string, unknown> = {}) {
    const reg = await request(app)
      .post('/api/v1/console/readers')
      .set(school.con)
      .set('Idempotency-Key', randomUUID())
      .send({ name: `${purpose} ${randomInt(0, 1e6)}`, location: 'Main block', purpose, ...extra });
    expect(reg.status, JSON.stringify(reg.body)).toBe(201);
    const code = await request(app)
      .post(`/api/v1/console/readers/${reg.body.readerId}/pairing-codes`)
      .set(school.con)
      .set('Idempotency-Key', randomUUID());
    const fp = `device-${randomUUID()}`;
    const paired = await request(app)
      .post('/api/v1/terminal/pairing')
      .send({ pairingCode: code.body.code, deviceFingerprint: fp });
    expect(paired.status).toBe(201);
    const nonce = `${Math.floor(Date.now() / 1000)}.${randomUUID()}`;
    const session = await request(app)
      .post('/api/v1/terminal/auth/signin')
      .send({
        terminalId: paired.body.terminalId,
        deviceFingerprint: fp,
        nonce,
        signature: createHmac('sha256', paired.body.credential)
          .update(`${paired.body.terminalId}.${nonce}`)
          .digest('hex'),
      });
    expect(session.status).toBe(200);
    return {
      id: reg.body.readerId as string,
      auth: { Authorization: `Bearer ${session.body.accessToken as string}` } as Auth,
      /** The device secret (signs offline captures, 12.10). */
      credential: paired.body.credential as string,
    };
  }

  /** An Active campus card for a member (written directly: the card-issue reader's test is 4.1). */
  async function card(profileRowId: string) {
    const token = `NFC${String(randomInt(0, 1e9)).padStart(13, '0')}`;
    await t.db
      .insertInto('cards')
      .values({
        public_id: newPublicIdPair().bin,
        institution_id: school.rowId,
        profile_id: profileRowId,
        token,
        status: 'ACTIVE',
        issue_reason: 'NEW_REGISTRATION',
      })
      .execute();
    return token;
  }

  return {
    t,
    h,
    app,
    ensureStudents,
    ops,
    school,
    teacherTypeId,
    account,
    signedIn,
    signUp,
    onProfile,
    profileRow,
    walletOf,
    balance,
    credit,
    payer,
    student,
    ward,
    feature,
    merchant,
    terminal,
    card,
  };
}
