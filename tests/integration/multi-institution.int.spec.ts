/**
 * One person, several institutions, on a real MySQL (client 2026-10-27: BR-01 lifted — "a user
 * associated with several institutions must be asked which institution to open when they sign in"):
 * - a member's sign-up, sign-in and device binding answer the institutions of the account's
 *   profiles (IDN-003/006/007); IDN-093 lists them and IDN-094 moves the session to the account's
 *   best profile at another one, which the next token refresh carries;
 * - a console sign-in, on the web or in the staff app, answers the institutions whose console the
 *   account may enter (IDN-033/088); IDN-095 lists them and IDN-096 moves the session to that
 *   institution's console profile, whose sub-tasks the next renewal carries;
 * - an institution the account has nothing at is refused (IDN.INSTITUTION_NOT_LINKED, 404).
 */
import { randomInt, randomUUID } from 'node:crypto';
import request from 'supertest';
import type { Express } from 'express';
import { adminUrl, createTestDatabase, insertInstitution, type TestDatabase } from './db';
import { buildHttpApp, codeOf } from './http-app';
import { newPublicIdPair } from '../../utils/idGenerator';
import { hashSecret } from '../../utils/password';

const PASSWORD = 'Ringpe@2026';
const mobile = () => `9${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`;
let panSeq = randomInt(0, 5_000);

describe.skipIf(!adminUrl)('one person, several institutions (client 2026-10-27)', () => {
  let t: TestDatabase;
  let h: Awaited<ReturnType<typeof buildHttpApp>>;
  let app: Express;
  let hash: string;
  type School = { id: string; publicId: string; types: Record<string, string> };
  let a: School;
  let b: School;
  /** An active institution where the people here have nothing. */
  let c: School;

  beforeAll(async () => {
    t = await createTestDatabase();
    h = await buildHttpApp(t);
    app = h.app;
    hash = await hashSecret(PASSWORD);
    a = await school();
    b = await school();
    c = await school();
  }, 180_000);
  afterAll(async () => {
    await t?.drop();
  });

  /** An active institution with a user type of each category the tests use. */
  async function school(): Promise<School> {
    const inst = await insertInstitution(t.db);
    await t.db
      .updateTable('institutions')
      .set({ status: 'ACTIVE' })
      .where('id', '=', inst.id)
      .execute();
    const types: Record<string, string> = {};
    for (const category of ['STAFF', 'PARENT', 'STUDENT'] as const) {
      const r = await t.db
        .insertInto('user_types')
        .values({
          public_id: newPublicIdPair().bin,
          institution_id: inst.id,
          name: category.charAt(0) + category.slice(1).toLowerCase(),
          category,
        })
        .executeTakeFirstOrThrow();
      types[category] = String(r.insertId);
    }
    return { id: inst.id, publicId: inst.publicId, types };
  }

  async function account(opts: { mobile?: string; email?: string } = {}) {
    const p = newPublicIdPair();
    const r = await t.db
      .insertInto('platform_accounts')
      .values({
        public_id: p.bin,
        mobile: opts.mobile ?? mobile(),
        email: opts.email ?? `asha.${randomInt(0, 1e9)}@example.in`,
        first_name: 'ASHA',
        last_name: 'RAO',
      })
      .executeTakeFirstOrThrow();
    const id = String(r.insertId);
    await t.db
      .insertInto('account_credentials')
      .values({ account_id: id, kind: 'PASSWORD', hash })
      .execute();
    const row = await t.db
      .selectFrom('platform_accounts')
      .select(['mobile', 'email'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    return { id, publicId: p.id, mobile: row.mobile, email: row.email! };
  }

  async function profile(
    s: School,
    category: 'STAFF' | 'PARENT' | 'STUDENT',
    v: { accountId?: string | null; contactMobile?: string; firstName?: string } = {},
  ) {
    const p = newPublicIdPair();
    const r = await t.db
      .insertInto('member_profiles')
      .values({
        public_id: p.bin,
        institution_id: s.id,
        account_id: v.accountId ?? null,
        user_type_id: s.types[category]!,
        first_name: v.firstName ?? 'ASHA',
        last_name: 'RAO',
        contact_mobile: v.contactMobile ?? null,
      })
      .executeTakeFirstOrThrow();
    return { id: String(r.insertId), publicId: p.id };
  }

  const roleId = async (code: string) =>
    String(
      (
        await t.db
          .selectFrom('roles')
          .select('id')
          .where('code', '=', code)
          .executeTakeFirstOrThrow()
      ).id,
    );
  const giveRole = async (s: School, profileId: string, code: string) =>
    t.db
      .insertInto('profile_roles')
      .values({ institution_id: s.id, profile_id: profileId, role_id: await roleId(code) })
      .execute();

  const cookiesOf = (r: request.Response) =>
    ([] as string[]).concat(r.headers['set-cookie'] ?? []).map((x) => x.split(';')[0] ?? '');
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const device = (installId = randomUUID()) => ({ installId, model: 'Pixel 8', os: 'Android 15' });

  async function consoleCode(email: string) {
    const step1 = await request(app)
      .post('/api/v1/auth/console/signin')
      .send({ email, password: PASSWORD });
    expect(step1.status, JSON.stringify(step1.body)).toBe(202);
    return { challengeId: step1.body.challengeId as string, otp: codeOf(h.sms.sent.at(-1)) };
  }

  /** A staff member: a console profile at A (Institution Administrator) and at B (Counsellor). */
  async function teacherAtTwo() {
    const acc = await account({ email: `ravi.${randomInt(0, 1e9)}@school.example.in` });
    const atA = await profile(a, 'STAFF', { accountId: acc.id });
    const atB = await profile(b, 'STAFF', { accountId: acc.id });
    await giveRole(a, atA.id, 'INSTITUTION_ADMIN');
    await giveRole(b, atB.id, 'COUNSELLOR');
    // A profile at C without any role opens no console there.
    await profile(c, 'STAFF', { accountId: acc.id });
    return { acc, atA, atB };
  }

  it('asks a console user which institution to open, and moves the web session there', async () => {
    const { acc, atB } = await teacherAtTwo();
    const verified = await request(app)
      .post('/api/v1/auth/console/otp/verify')
      .send(await consoleCode(acc.email));
    expect(verified.status, JSON.stringify(verified.body)).toBe(200);
    // One entry per institution with a console, the session's first; C (no role) is not one.
    expect(verified.body.institutions).toEqual([
      expect.objectContaining({ id: a.publicId, city: 'Bengaluru', logoUrl: null }),
      expect.objectContaining({ id: b.publicId, shortName: 'TST', logoUrl: null }),
    ]);
    let cookies = cookiesOf(verified);
    const csrf = verified.body.csrfToken as string;
    const session = () => request(app).get('/api/v1/console/session').set('Cookie', cookies);
    const first = await session();
    expect(first.body.institution.id).toBe(a.publicId);
    expect(first.body.subTasks).toContain('members.roles');

    const list = await request(app).get('/api/v1/console/me/institutions').set('Cookie', cookies);
    expect(list.status).toBe(200);
    expect(list.body).toEqual({
      current: a.publicId,
      institutions: verified.body.institutions,
    });

    const put = (institutionId: string) =>
      request(app)
        .put('/api/v1/console/me/institution')
        .set('Cookie', cookies)
        .set('X-CSRF-Token', csrf)
        .send({ institutionId });
    // Nothing at C opens a console, and an unknown institution is the same answer.
    for (const other of [c.publicId, randomUUID()]) {
      const refused = await put(other);
      expect(refused.status).toBe(404);
      expect(refused.body.code).toBe('IDN.INSTITUTION_NOT_LINKED');
    }
    expect((await session()).body.institution.id).toBe(a.publicId);

    const moved = await put(b.publicId.toUpperCase());
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(moved.body).toEqual({ institutionId: b.publicId, profileId: atB.publicId });
    // The renewal carries B and the Counsellor's sub-tasks, not A's administrator's.
    const refreshed = await request(app)
      .post('/api/v1/auth/token/refresh')
      .set('Cookie', cookies)
      .set('X-RingPe-Surface', 'console')
      .set('X-CSRF-Token', csrf)
      .send({});
    expect(refreshed.status, JSON.stringify(refreshed.body)).toBe(200);
    const fresh = cookiesOf(refreshed);
    cookies = [
      ...fresh,
      ...cookies.filter((x) => !fresh.some((f) => f.split('=')[0] === x.split('=')[0])),
    ];
    const now = await session();
    expect(now.status).toBe(200);
    expect(now.body.institution.id).toBe(b.publicId);
    expect(now.body.roles.map((r: { code: string }) => r.code)).toEqual(['COUNSELLOR']);
    expect(now.body.subTasks).toContain('admissions.view');
    expect(now.body.subTasks).not.toContain('members.roles');
    // B's console now: A's administrator pages are closed to this session.
    const roles = await request(app).get('/api/v1/console/staff-accounts').set('Cookie', cookies);
    expect(roles.status).toBe(403);
    const again = await request(app).get('/api/v1/console/me/institutions').set('Cookie', cookies);
    expect(again.body.current).toBe(b.publicId);
  });

  it('asks in the staff app too, and its renewal carries the institution chosen', async () => {
    const { acc } = await teacherAtTwo();
    const signedIn = await request(app)
      .post('/api/v1/auth/staff-app/otp/verify')
      .send(await consoleCode(acc.email));
    expect(signedIn.status, JSON.stringify(signedIn.body)).toBe(200);
    expect(signedIn.body.institutions.map((i: { id: string }) => i.id)).toEqual([
      a.publicId,
      b.publicId,
    ]);
    const moved = await request(app)
      .put('/api/v1/console/me/institution')
      .set(bearer(signedIn.body.accessToken))
      .send({ institutionId: b.publicId });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    const renewed = await request(app)
      .post('/api/v1/auth/staff-app/token/refresh')
      .send({ refreshToken: signedIn.body.refreshToken });
    expect(renewed.status).toBe(200);
    const s = await request(app)
      .get('/api/v1/console/session')
      .set(bearer(renewed.body.accessToken));
    expect(s.body.institution.id).toBe(b.publicId);
    const list = await request(app)
      .get('/api/v1/console/me/institutions')
      .set(bearer(renewed.body.accessToken));
    expect(list.body.current).toBe(b.publicId);
  });

  it('still keeps an account of institutions out of the back office', async () => {
    const { acc } = await teacherAtTwo();
    await t.db
      .insertInto('operator_accounts')
      .values({
        public_id: newPublicIdPair().bin,
        account_id: acc.id,
        role_id: await roleId('PLATFORM_ADMIN'),
      })
      .execute();
    const r = await request(app)
      .post('/api/v1/ops/auth/signin')
      .send({ email: acc.email, password: PASSWORD });
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('IDN.CONSOLE_SIGNIN_REFUSED');
  });

  /** A parent with profiles at A and B; at B a child under the account comes first by age. */
  async function parentAtTwo() {
    const acc = await account();
    const atA = await profile(a, 'PARENT', { accountId: acc.id, contactMobile: acc.mobile });
    const child = await profile(b, 'STUDENT', { accountId: acc.id, firstName: 'AARAV' });
    const atB = await profile(b, 'PARENT', { accountId: acc.id, contactMobile: acc.mobile });
    await t.db
      .insertInto('guardianships')
      .values({
        institution_id: b.id,
        guardian_profile_id: atB.id,
        ward_profile_id: child.id,
        relation: 'MOTHER',
        is_primary_contact: 1,
      })
      .execute();
    return { acc, atA, atB, child };
  }

  it('asks a member which institution to open at sign-in, and moves the session there', async () => {
    const { acc, atA, atB, child } = await parentAtTwo();
    const phone = device();
    // A new phone: the code binds it and the session starts (IDN-007), with the institutions.
    const challenged = await request(app)
      .post('/api/v1/auth/member/signin')
      .send({ mobile: acc.mobile, password: PASSWORD, device: phone });
    expect(challenged.status, JSON.stringify(challenged.body)).toBe(202);
    const bound = await request(app)
      .post('/api/v1/auth/member/device/verify')
      .send({
        deviceChallengeId: challenged.body.deviceChallenge.challengeId,
        otp: codeOf(h.sms.sent.at(-1)),
        device: phone,
      });
    expect(bound.status, JSON.stringify(bound.body)).toBe(200);
    const ids = (body: { institutions: { id: string }[] }) => body.institutions.map((i) => i.id);
    expect(ids(bound.body)).toEqual([a.publicId, b.publicId]);
    // The bound phone signs in at once (IDN-006), with the same list.
    const signedIn = await request(app)
      .post('/api/v1/auth/member/signin')
      .send({ mobile: acc.mobile, password: PASSWORD, device: phone });
    expect(signedIn.status).toBe(200);
    expect(signedIn.body.institutions).toEqual(bound.body.institutions);
    expect(signedIn.body.institutions[1]).toEqual({
      id: b.publicId,
      name: expect.any(String),
      shortName: 'TST',
      city: 'Bengaluru',
      logoUrl: null,
    });
    const auth = bearer(signedIn.body.accessToken);

    const me = await request(app).get('/api/v1/me').set(auth);
    expect(me.body.activeProfileId).toBe(atA.publicId);
    // Every profile, of either institution, names its institution.
    expect(
      me.body.profiles.map((x: { id: string; institution: { id: string } }) => [
        x.id,
        x.institution.id,
      ]),
    ).toEqual([
      [atA.publicId, a.publicId],
      [atB.publicId, b.publicId],
      [child.publicId, b.publicId],
    ]);
    const list = await request(app).get('/api/v1/me/institutions').set(auth);
    expect(list.body).toEqual({ current: a.publicId, institutions: signedIn.body.institutions });

    const put = (institutionId: string) =>
      request(app).put('/api/v1/me/institution').set(auth).send({ institutionId });
    for (const other of [c.publicId, randomUUID()]) {
      const refused = await put(other);
      expect(refused.status).toBe(404);
      expect(refused.body.code).toBe('IDN.INSTITUTION_NOT_LINKED');
    }
    // At B the parent's own profile, not the child that is older on the account.
    const moved = await put(b.publicId);
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(moved.body).toEqual({ activeProfileId: atB.publicId, institutionId: b.publicId });
    const refreshed = await request(app)
      .post('/api/v1/auth/token/refresh')
      .send({ refreshToken: signedIn.body.refreshToken });
    expect(refreshed.status).toBe(200);
    const after = bearer(refreshed.body.accessToken);
    expect((await request(app).get('/api/v1/me').set(after)).body.activeProfileId).toBe(
      atB.publicId,
    );
    expect((await request(app).get('/api/v1/me/institutions').set(after)).body.current).toBe(
      b.publicId,
    );
    // Switching to a child (IDN-014) still works across the list.
    const toChild = await request(app)
      .put('/api/v1/me/active-profile')
      .set(after)
      .send({ profileId: child.publicId });
    expect(toChild.status).toBe(200);
    // A console session never opens the member's switch.
    const consoleToken = (
      await h.security.signer.sign({
        subject: acc.publicId,
        surface: 'console',
        sessionId: randomUUID(),
        institutionId: a.publicId,
        profileId: atA.publicId,
        subTasks: [],
      })
    ).token;
    const wrong = await request(app)
      .put('/api/v1/me/institution')
      .set(bearer(consoleToken))
      .send({ institutionId: b.publicId });
    expect(wrong.status).toBe(403);
  });

  it('answers the institutions at sign-up, as the profiles kept for the mobile link', async () => {
    const mob = mobile();
    // The schools entered this mobile before the person had an account.
    await profile(b, 'PARENT', { contactMobile: mob });
    await profile(a, 'PARENT', { contactMobile: mob });
    const start = await request(app)
      .post('/api/v1/auth/member/signup/otp')
      .send({ mobile: mob, consentVersion: '2026.10' });
    expect(start.status, JSON.stringify(start.body)).toBe(202);
    const code = codeOf(h.sms.sent.findLast((m) => m.to.endsWith(mob)));
    const verify = await request(app)
      .post('/api/v1/auth/member/signup/otp/verify')
      .send({ challengeId: start.body.challengeId, otp: code });
    expect(verify.status).toBe(200);
    const created = await request(app)
      .post('/api/v1/auth/member/signup')
      .set('Idempotency-Key', randomUUID())
      .send({
        signupToken: verify.body.signupToken,
        mobile: mob,
        consentVersion: '2026.10',
        termsVersion: '2026.10',
        termsAccepted: true,
        pan: `ABCDE${String(++panSeq % 10_000).padStart(4, '0')}G`,
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
        device: device(),
      });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    // B entered the mobile first: its profile is the default, and B comes first.
    expect(created.body.institutions.map((i: { id: string }) => i.id)).toEqual([
      b.publicId,
      a.publicId,
    ]);
    // An account without a profile anywhere gets an empty list.
    const lone = await account();
    const phone = device();
    const challenged = await request(app)
      .post('/api/v1/auth/member/signin')
      .send({ mobile: lone.mobile, password: PASSWORD, device: phone });
    const bound = await request(app)
      .post('/api/v1/auth/member/device/verify')
      .send({
        deviceChallengeId: challenged.body.deviceChallenge.challengeId,
        otp: codeOf(h.sms.sent.at(-1)),
        device: phone,
      });
    expect(bound.status).toBe(200);
    expect(bound.body.institutions).toEqual([]);
    const none = await request(app)
      .get('/api/v1/me/institutions')
      .set(bearer(bound.body.accessToken));
    expect(none.body).toEqual({ current: null, institutions: [] });
  });
});
