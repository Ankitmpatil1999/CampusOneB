/**
 * Maker-checker on a real MySQL (MKR-001…006, IDN-057, COM-009/010/014/015, GOV-005; section 17,
 * CR-06, CR-08, ADR-0015): a request waits for another Institution Administrator, the maker can't
 * decide it, remarks are mandatory, the effect is applied in the same transaction, a refused effect
 * leaves the request pending with the reason, the checkers and the maker are notified, a member's
 * own correction goes to their school (or to RingPe without one), and another school sees nothing.
 */
import { randomInt, randomUUID } from 'node:crypto';
import request from 'supertest';
import type { Express } from 'express';
import { adminUrl, createTestDatabase, type TestDatabase } from './db';
import { buildHttpApp, codeOf } from './http-app';
import { newPublicIdPair, uuidToBin } from '../../utils/idGenerator';
import { hashSecret } from '../../utils/password';

/** PANs are unique per platform: a counter keeps sign-ups in one file from colliding. */
let panSeq = randomInt(0, 5_000);
const uniquePan = () => `ABCDE${String(++panSeq % 10_000).padStart(4, '0')}F`;
const PASSWORD = 'Ringpe@2026';
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const mobile = () => `9${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`;

describe.skipIf(!adminUrl)('approvals and notifications on real MySQL', () => {
  let t: TestDatabase;
  let h: Awaited<ReturnType<typeof buildHttpApp>>;
  let app: Express;
  let ops: Record<string, string>;
  let a: { id: string; con: Record<string, string>; rowId: string };
  let b: { id: string; con: Record<string, string>; rowId: string };
  /** A second administrator of school A, the checker. */
  let checker: Record<string, string>;
  let teacherType: { id: string; departments: { id: string }[] };

  beforeAll(async () => {
    t = await createTestDatabase();
    h = await buildHttpApp(t);
    app = h.app;
    ops = await signedIn('ops', (await operator()).email);
    a = await school();
    b = await school();
    teacherType = await userType(a.con);
    checker = await secondAdmin();
    // Requests from the administrator wait for a checker in these tests.
    const s = (await request(app).get('/api/v1/ops/settings').set(ops)).body.items.find(
      (x: { key: string }) => x.key === 'mkr.adminSelfApply',
    );
    const off = await request(app)
      .put('/api/v1/ops/settings/mkr.adminSelfApply')
      .set(ops)
      .set('If-Match', `"v${s.version}"`)
      .send({ value: 0, reason: 'Testing the checker path' });
    expect(off.status).toBe(200);
  }, 240_000);
  afterAll(async () => {
    await t?.drop();
  });

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

  async function operator() {
    const acc = await account('ARJUN');
    const role = await t.db
      .selectFrom('roles')
      .select('id')
      .where('code', '=', 'PLATFORM_ADMIN')
      .executeTakeFirstOrThrow();
    await t.db
      .insertInto('operator_accounts')
      .values({ public_id: newPublicIdPair().bin, account_id: acc.id, role_id: String(role.id) })
      .execute();
    return acc;
  }

  async function signedIn(surface: 'ops' | 'console', email: string, password = PASSWORD) {
    const base = surface === 'ops' ? '/api/v1/ops/auth' : '/api/v1/auth/console';
    const step1 = await request(app).post(`${base}/signin`).send({ email, password });
    expect(step1.status).toBe(202);
    const r = await request(app)
      .post(`${base}/otp/verify`)
      .send({ challengeId: step1.body.challengeId, otp: codeOf(h.sms.sent.at(-1)) });
    expect(r.status).toBe(200);
    const cookies = ([] as string[])
      .concat(r.headers['set-cookie'] ?? [])
      .map((c) => c.split(';')[0] ?? '');
    return { Cookie: cookies.join('; '), 'X-CSRF-Token': r.body.csrfToken as string };
  }

  async function school() {
    const admin = await account('LAKSHMI');
    const plans = (await request(app).get('/api/v1/ops/plans').set(ops)).body.items;
    const tag = randomInt(0, 1e9);
    const r = await request(app)
      .post('/api/v1/ops/institutions')
      .set(ops)
      .set('Idempotency-Key', randomUUID())
      .send({
        name: `Sagar Public School ${tag}`,
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
    expect(r.status).toBe(201);
    const id = r.body.id as string;
    const version = (await request(app).get(`/api/v1/ops/institutions/${id}`).set(ops)).body
      .version;
    await request(app)
      .put(`/api/v1/ops/institutions/${id}/bank-arrangement`)
      .set(ops)
      .set('If-Match', `"v${version}"`)
      .send({
        corporateCode: `M${String(randomInt(0, 999)).padStart(3, '0')}`,
        poolAccountRef: 'POOLSPS0001',
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
    return { id, con: await signedIn('console', admin.email), rowId: String(row.id) };
  }

  async function userType(con: Record<string, string>) {
    const r = await request(app)
      .post('/api/v1/console/user-types')
      .set(con)
      .set('Idempotency-Key', randomUUID())
      .send({ name: 'Teacher', category: 'TEACHER', departments: ['Primary'] });
    expect(r.status).toBe(201);
    const list = (await request(app).get('/api/v1/console/user-types').set(con)).body.items;
    return list.find((x: { name: string }) => x.name === 'Teacher');
  }

  /** Another staff member of school A made an Institution Administrator. */
  async function secondAdmin() {
    const acc = await account('MEERA');
    const staff = await request(app)
      .post('/api/v1/console/staff')
      .set(a.con)
      .set('Idempotency-Key', randomUUID())
      .send({
        userTypeId: teacherType.id,
        departmentId: teacherType.departments[0]!.id,
        firstName: 'Meera',
        gender: 'FEMALE',
        dateOfBirth: '1985-03-02',
        mobile: acc.mobile,
        email: acc.email,
        joinedOn: '2026-06-01',
      });
    expect(staff.status).toBe(201);
    expect(staff.body.newAccount).toBe(false);
    const prof = await t.db
      .selectFrom('member_profiles')
      .select('id')
      .where('public_id', '=', uuidToBin(staff.body.id))
      .executeTakeFirstOrThrow();
    const role = await t.db
      .selectFrom('roles')
      .select('id')
      .where('code', '=', 'INSTITUTION_ADMIN')
      .executeTakeFirstOrThrow();
    await t.db
      .insertInto('profile_roles')
      .values({ institution_id: a.rowId, profile_id: String(prof.id), role_id: String(role.id) })
      .execute();
    return signedIn('console', acc.email);
  }

  const teacher = async (firstName: string) => {
    const r = await request(app)
      .post('/api/v1/console/members')
      .set(a.con)
      .set('Idempotency-Key', randomUUID())
      .send({ userTypeId: teacherType.id, firstName, mobile: mobile() });
    expect(r.status).toBe(201);
    return r.body.id as string;
  };
  const decide = (
    con: Record<string, string>,
    id: string,
    version: number | null,
    body: object,
    base = '/api/v1/console',
  ) => {
    const req = request(app)
      .post(`${base}/approvals/${id}/decision`)
      .set(con)
      .set('Idempotency-Key', randomUUID());
    if (version !== null) req.set('If-Match', `"v${version}"`);
    return req.send(body);
  };
  const upload = async (auth: Record<string, string>) => {
    const r = await request(app)
      .post('/api/v1/files')
      .set(auth)
      .set('X-RingPe-Surface', auth['Cookie'] ? 'console' : 'member')
      .field('purpose', 'evidence')
      .attach('file', PDF, 'certificate.pdf');
    expect(r.status).toBe(201);
    return r.body.fileId as string;
  };

  it('queues a suspension for another administrator, who decides it with remarks', async () => {
    const id = await teacher('Kavya');
    const raised = await request(app)
      .post(`/api/v1/console/members/${id}/status-changes`)
      .set(a.con)
      .set('Idempotency-Key', randomUUID())
      .send({ to: 'SUSPENDED', reason: 'Pending an enquiry' });
    expect(raised.status).toBe(202);
    const approvalId = raised.body.approvalId as string;

    // The checker hears about it; the maker sees it as their own request.
    const bell = await request(app).get('/api/v1/console/notifications').set(checker);
    expect(bell.status).toBe(200);
    expect(bell.body.unread).toBeGreaterThanOrEqual(1);
    expect(bell.body.items[0]).toMatchObject({
      category: 'APPROVAL',
      titleKey: 'NTF.APPROVAL_RAISED',
      link: `/console/approvals?open=${approvalId}`,
    });
    expect(bell.body.items[0].title).toMatch(/^APR-\d{4} is waiting for your decision$/);
    const mine = await request(app).get('/api/v1/console/approvals').set(a.con);
    expect(mine.status).toBe(200);
    const row = mine.body.items.find((x: { id: string }) => x.id === approvalId);
    expect(row).toMatchObject({
      module: 'MEMBER_SUSPENSION',
      action: 'Suspend member',
      status: 'PENDING',
      canDecide: false,
      maker: { you: true },
    });
    expect(mine.body.counts.mine).toBeGreaterThanOrEqual(1);

    const own = await decide(a.con, approvalId, row.version, {
      decision: 'APPROVE',
      remarks: 'Looks right',
    });
    expect(own.status).toBe(403);
    expect(own.body.code).toBe('MKR.OWN_APPROVE');

    const detail = await request(app).get(`/api/v1/console/approvals/${approvalId}`).set(checker);
    expect(detail.status).toBe(200);
    expect(detail.body.canDecide).toBe(true);
    expect(detail.body.changes[0]).toEqual({
      label: 'Member status',
      from: 'Active',
      to: 'Suspended',
    });
    expect(detail.body.reason).toBe('Pending an enquiry');
    expect(
      (await decide(checker, approvalId, null, { decision: 'APPROVE', remarks: 'Ok go' })).status,
    ).toBe(428);
    const short = await decide(checker, approvalId, detail.body.version, {
      decision: 'APPROVE',
      remarks: 'ok',
    });
    expect(short.body.errors[0].code).toBe('MKR.REMARKS_TOO_SHORT');

    const done = await decide(checker, approvalId, detail.body.version, {
      decision: 'APPROVE',
      remarks: 'Enquiry confirmed by the principal',
    });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({
      status: 'APPROVED',
      checker: { name: 'Meera Rao' },
      remarks: 'Enquiry confirmed by the principal',
    });
    const m = await request(app).get(`/api/v1/console/members/${id}`).set(a.con);
    expect(m.body).toMatchObject({ status: 'SUSPENDED', pending: { suspension: false } });
    const again = await decide(checker, approvalId, done.body.version, {
      decision: 'REJECT',
      remarks: 'Changed my mind',
    });
    expect(again.body.code).toBe('MKR.ALREADY_DECIDED');

    // The maker is told, and can clear the bell.
    const told = await request(app).get('/api/v1/console/notifications?unread=true').set(a.con);
    expect(
      told.body.items.some(
        (n: { titleKey: string; body: string }) =>
          n.titleKey === 'NTF.APPROVAL_APPROVED' &&
          n.body === 'Suspend member: Enquiry confirmed by the principal',
      ),
    ).toBe(true);
    const read = await request(app)
      .post('/api/v1/console/notifications/read')
      .set(a.con)
      .send({ all: true });
    expect(read.status).toBe(204);
    expect((await request(app).get('/api/v1/console/notifications').set(a.con)).body.unread).toBe(
      0,
    );
  });

  it('corrects a display-only field with evidence; a refused effect keeps the request pending', async () => {
    const id = await teacher('Kavyaa');
    const evidence = await upload(a.con);
    const raise = (body: object) =>
      request(app)
        .post(`/api/v1/console/members/${id}/pii-corrections`)
        .set(a.con)
        .set('Idempotency-Key', randomUUID())
        .send({ reason: 'Spelt this way on the certificate', evidenceFileId: evidence, ...body });
    expect((await raise({ field: 'FULL_NAME', proposedValue: 'Kavyaa' })).body.errors[0].code).toBe(
      'IDN.CORRECTION_SAME',
    );
    expect((await raise({ field: 'ADMISSION_NO', proposedValue: 'X1' })).body.errors[0].code).toBe(
      'IDN.PII_FIELD_NOT_CORRECTABLE',
    );
    const name = await raise({ field: 'FULL_NAME', proposedValue: 'Kavya Rao' });
    expect(name.status).toBe(202);
    expect(name.body).toMatchObject({ applied: false, no: expect.stringMatching(/^APR-\d{4}$/) });
    expect((await raise({ field: 'FULL_NAME', proposedValue: 'Kavya R' })).body.code).toBe(
      'IDN.CORRECTION_PENDING',
    );

    const d = await request(app)
      .get(`/api/v1/console/approvals/${name.body.approvalId}`)
      .set(checker);
    expect(d.body.changes).toEqual([{ label: 'Full name', from: 'Kavyaa', to: 'Kavya Rao' }]);
    expect(d.body.evidence.name).toBe('certificate.pdf');
    expect(d.body.evidence.url).toMatch(/^\/api\/v1\/files\/.+\/content\?exp=/);
    const ok = await decide(checker, name.body.approvalId, d.body.version, {
      decision: 'APPROVE',
      remarks: 'Matches the certificate',
    });
    expect(ok.status).toBe(200);
    const m = await request(app).get(`/api/v1/console/members/${id}`).set(a.con);
    expect(m.body.name).toBe('Kavya Rao');

    // An employee ID taken by someone else meanwhile: the request stays pending with the reason.
    const emp = await raise({ field: 'EMPLOYEE_NO', proposedValue: 'EMP77777' });
    expect(emp.status).toBe(202);
    const other = await teacher('Lata');
    await t.db
      .updateTable('member_profiles')
      .set({ employee_no: 'EMP77777' })
      .where('public_id', '=', uuidToBin(other))
      .execute();
    const v = (
      await request(app).get(`/api/v1/console/approvals/${emp.body.approvalId}`).set(checker)
    ).body.version;
    const refused = await decide(checker, emp.body.approvalId, v, {
      decision: 'APPROVE',
      remarks: 'Approving the new ID',
    });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('MKR.EFFECT_FAILED');
    expect(refused.body.detail).toContain('Employee ID already exists: EMP77777');
    const still = await request(app)
      .get(`/api/v1/console/approvals/${emp.body.approvalId}`)
      .set(checker);
    expect(still.body).toMatchObject({ status: 'PENDING' });
    expect(still.body.lastError).toBe('Employee ID already exists: EMP77777');
    const rejected = await decide(checker, emp.body.approvalId, still.body.version, {
      decision: 'REJECT',
      remarks: 'The ID belongs to Lata',
    });
    expect(rejected.body.status).toBe('REJECTED');

    // The audit trail has the correction with before and after.
    const audit = await request(app)
      .get(`/api/v1/console/audit-events?entity=member&entityId=${id}`)
      .set(a.con);
    expect(audit.status).toBe(200);
    expect(
      audit.body.items.find((x: { action: string }) => x.action === 'MEMBER_PII_CORRECTED'),
    ).toMatchObject({ before: { name: 'Kavyaa' }, after: { name: 'Kavya Rao' } });
  });

  it("sends a member's own correction to their school, or to RingPe without one", async () => {
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
    const correct = async (auth: Record<string, string>) => {
      const r = await request(app)
        .post('/api/v1/me/pii-corrections')
        .set(auth)
        .set('Idempotency-Key', randomUUID())
        .send({
          field: 'DOB',
          proposedValue: '1990-04-21',
          reason: 'Birth certificate shows the 21st',
          evidenceFileId: await upload(auth),
        });
      expect(r.status).toBe(201);
    };

    // A member of school A (a teacher onboarded with the same mobile).
    const mob = mobile();
    const auth = await member(mob);
    const linked = await request(app)
      .post('/api/v1/console/members')
      .set(a.con)
      .set('Idempotency-Key', randomUUID())
      .send({ userTypeId: teacherType.id, firstName: 'Asha', mobile: mob });
    expect(linked.status).toBe(201);
    // The app's Me screen lists the school profile on the account (CR-04).
    const me = await request(app).get('/api/v1/me').set(auth);
    expect(me.body.profiles).toHaveLength(1);
    expect(me.body.profiles[0]).toMatchObject({
      name: 'Asha',
      userType: 'Teacher',
      kind: 'STAFF',
      status: 'ACTIVE',
      memberNo: expect.stringMatching(/-\d{5}$/),
    });
    expect(me.body.activeProfileId).toBe(me.body.profiles[0].id);
    const pick = (profileId: string) =>
      request(app).put('/api/v1/me/active-profile').set(auth).send({ profileId });
    expect((await pick(me.body.profiles[0].id)).body).toEqual({
      activeProfileId: me.body.profiles[0].id,
    });
    expect((await pick(randomUUID())).body.code).toBe('IDN.PROFILE_NOT_LINKED');
    await correct(auth);
    const queue = await request(app).get('/api/v1/console/approvals').set(checker);
    const row = queue.body.items.find(
      (x: { maker: { type: string } }) => x.maker.type === 'member',
    );
    expect(row).toMatchObject({ module: 'PII_CORRECTION', maker: { name: 'Asha Rao' } });
    expect(row.summary).toContain('Date of birth for Asha Rao');
    const ok = await decide(checker, row.id, row.version, {
      decision: 'APPROVE',
      remarks: 'Certificate checked',
    });
    expect(ok.status).toBe(200);
    const acc = await t.db
      .selectFrom('platform_accounts')
      .select('dob')
      .where('mobile', '=', mob)
      .executeTakeFirstOrThrow();
    expect(new Date(acc.dob as Date).toISOString().slice(0, 10)).toBe('1990-04-21');
    const note = await request(app).get('/api/v1/me/notifications').set(auth);
    expect(note.status).toBe(200);
    expect(note.body.items[0]).toMatchObject({
      titleKey: 'NTF.CORRECTION_APPROVED',
      title: 'Your correction was approved',
      body: 'Date of birth: Certificate checked',
    });
    expect(
      (await request(app).post('/api/v1/me/notifications/read').set(auth).send({ all: true }))
        .status,
    ).toBe(204);

    // A member without a school: the back office decides.
    const solo = await member(mobile());
    await correct(solo);
    const platform = await request(app).get('/api/v1/ops/approvals').set(ops);
    expect(platform.status).toBe(200);
    expect(platform.body.canDecide).toBe(true);
    const p = platform.body.items[0];
    expect(p).toMatchObject({ module: 'PII_CORRECTION', status: 'PENDING', no: 'APR-0001' });
    const pd = await request(app).get(`/api/v1/ops/approvals/${p.id}`).set(ops);
    expect(pd.body.changes[0]).toMatchObject({ label: 'Date of birth', to: '21 Apr 1990' });
    const r = await decide(
      ops,
      p.id,
      pd.body.version,
      { decision: 'REJECT', remarks: 'The certificate is not readable' },
      '/api/v1/ops',
    );
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('REJECTED');
    const back = await request(app).get('/api/v1/me/pii-corrections').set(solo);
    expect(back.body.items?.[0] ?? back.body[0]).toMatchObject({ status: 'REJECTED' });
  });

  it("never shows one school's requests or notifications to another", async () => {
    const id = await teacher('Nisha');
    const raised = await request(app)
      .post(`/api/v1/console/members/${id}/delink-requests`)
      .set(a.con)
      .set('Idempotency-Key', randomUUID())
      .send({ reason: 'Moved to another school' });
    expect(raised.status).toBe(202);
    const other = await request(app)
      .get(`/api/v1/console/approvals/${raised.body.approvalId}`)
      .set(b.con);
    expect(other.status).toBe(404);
    const list = await request(app).get('/api/v1/console/approvals').set(b.con);
    expect(list.body.items).toEqual([]);
    expect(
      (
        await decide(b.con, raised.body.approvalId, 1, {
          decision: 'APPROVE',
          remarks: 'Not my school',
        })
      ).status,
    ).toBe(404);
    expect((await request(app).get('/api/v1/console/notifications').set(b.con)).body.items).toEqual(
      [],
    );
  });

  it('lists console roles and staff accounts; sets roles and releases a lock (IDN-038, IDN-060…062)', async () => {
    const roles = await request(app).get('/api/v1/console/roles').set(a.con);
    expect(roles.status).toBe(200);
    const admin = roles.body.items.find((r: { code: string }) => r.code === 'INSTITUTION_ADMIN');
    const desk = roles.body.items.find((r: { code: string }) => r.code === 'FRONT_DESK');
    expect(admin.assignable).toBe(false);
    expect(desk.assignable).toBe(true);

    const acc = await account('GEETHA');
    const staff = await request(app)
      .post('/api/v1/console/staff')
      .set(a.con)
      .set('Idempotency-Key', randomUUID())
      .send({
        userTypeId: teacherType.id,
        departmentId: teacherType.departments[0]!.id,
        firstName: 'Geetha',
        gender: 'FEMALE',
        dateOfBirth: '1988-01-05',
        mobile: acc.mobile,
        email: acc.email,
        joinedOn: '2026-06-01',
      });
    expect(staff.status).toBe(201);
    const rolesUrl = `/api/v1/console/staff-accounts/${staff.body.id}/roles`;
    const set = (roleIds: string[]) => request(app).put(rolesUrl).set(a.con).send({ roleIds });
    expect((await set([admin.id])).body.code).toBe('IDN.ROLE_NOT_ASSIGNABLE');
    const ok = await set([desk.id]);
    expect(ok.status).toBe(200);
    expect(ok.body.roles.map((r: { code: string }) => r.code)).toEqual(['FRONT_DESK']);
    const list = await request(app).get('/api/v1/console/staff-accounts').set(a.con);
    expect(list.body.items.find((x: { id: string }) => x.id === staff.body.id)).toMatchObject({
      name: 'Geetha',
      locked: false,
    });
    // Another school can't touch this staff member.
    expect((await request(app).put(rolesUrl).set(b.con).send({ roleIds: [] })).status).toBe(404);

    await t.db
      .updateTable('platform_accounts')
      .set({ signin_lock: 'LOCKED' })
      .where('id', '=', acc.id)
      .execute();
    expect(
      (await request(app).get('/api/v1/console/staff-accounts').set(a.con)).body.items.find(
        (x: { id: string }) => x.id === staff.body.id,
      ).locked,
    ).toBe(true);
    const unlock = await request(app)
      .post(`/api/v1/console/staff-accounts/${staff.body.id}/unlock`)
      .set(a.con)
      .send({ reason: 'Confirmed by phone with Geetha' });
    expect(unlock.status).toBe(204);
    const row = await t.db
      .selectFrom('platform_accounts')
      .select('signin_lock')
      .where('id', '=', acc.id)
      .executeTakeFirstOrThrow();
    expect(row.signin_lock).toBe('UNLOCKED');
    await signedIn('console', acc.email);
  });

  it('serves the back-office home and search without personal records (RPT-007, RPT-008)', async () => {
    const home = await request(app).get('/api/v1/ops/home').set(ops);
    expect(home.status).toBe(200);
    expect(home.body.kpis.tenants).toBeGreaterThanOrEqual(2);
    expect(
      home.body.byStatus.find((s: { status: string }) => s.status === 'ACTIVE').count,
    ).toBeGreaterThanOrEqual(2);
    expect(home.body.jobs.length).toBeGreaterThan(0);
    const found = await request(app).get('/api/v1/ops/search?q=Sagar').set(ops);
    expect(found.status).toBe(200);
    expect(found.body.institutions.length).toBeGreaterThanOrEqual(2);
    expect(Object.keys(found.body)).toEqual(['institutions', 'invoices']);
    expect((await request(app).get('/api/v1/ops/home').set(a.con)).status).toBeGreaterThanOrEqual(
      401,
    );
  });
});
