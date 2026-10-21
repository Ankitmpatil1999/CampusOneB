/**
 * Members in the console on a real MySQL (IDN-044…055, IDN-058, IDN-059; ACA-001…003,
 * ACA-009…013; BR-01, CR-06, CR-08, CR-12, CR-13; OI-IDN-20): the academic structure, onboarding a
 * student with a new parent, one institution per person, unique admission numbers, institution
 * fields, edits with If-Match, statuses with the administrator's self-apply and the checker path,
 * de-link, history, search, staff with a temporary password changed at first sign-in, sheets
 * checked before they are committed, and another institution's members never visible.
 */
import { randomInt, randomUUID } from 'node:crypto';
import request from 'supertest';
import { onboardStaff } from './staff';
import type { Express } from 'express';
import { adminUrl, createTestDatabase, type TestDatabase } from './db';
import { buildHttpApp, codeOf } from './http-app';
import { newPublicIdPair, uuidToBin } from '../../utils/idGenerator';
import { hashSecret } from '../../utils/password';

const PASSWORD = 'Ringpe@2026';
const mobile = () => `9${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`;

describe.skipIf(!adminUrl)('members in the console on real MySQL', () => {
  let t: TestDatabase;
  let h: Awaited<ReturnType<typeof buildHttpApp>>;
  let app: Express;
  let ops: Record<string, string>;
  let a: { id: string; con: Record<string, string>; rowId: string };
  let b: { id: string; con: Record<string, string>; rowId: string };
  /** The required "Blood group" field the fields test adds. */
  let blood = '';
  let grade6: { id: string; sections: { id: string; name: string }[]; version: number };

  beforeAll(async () => {
    t = await createTestDatabase();
    h = await buildHttpApp(t);
    app = h.app;
    ops = await signedIn('ops', (await operator()).email);
    a = await school();
    b = await school();
    const cls = await request(app)
      .post('/api/v1/console/classes')
      .set(a.con)
      .set('Idempotency-Key', randomUUID())
      .send({ name: 'Grade 6', sections: [{ name: 'A' }, { name: 'B', capacity: 40 }] });
    expect(cls.status).toBe(201);
    grade6 = cls.body;
  }, 180_000);
  afterAll(async () => {
    await t?.drop();
  });

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

  /** A registered, onboarded and active school with its administrator signed in. */
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

  const TYPES: Record<string, [string, string[]]> = {
    Student: ['STUDENT', ['Primary', 'Middle school']],
    Parent: ['PARENT', ['Parents']],
    Teacher: ['TEACHER', ['Primary', 'Secondary']],
  };
  /** The user type (created the first time it is needed; new schools start with "Staff"). */
  const userType = async (con: Record<string, string>, name: string) => {
    const list = async () =>
      (await request(app).get('/api/v1/console/user-types').set(con)).body.items as {
        id: string;
        name: string;
        departments: { id: string; name: string }[];
      }[];
    let found = (await list()).find((x) => x.name === name);
    if (!found) {
      const [category, departments] = TYPES[name]!;
      const r = await request(app)
        .post('/api/v1/console/user-types')
        .set(con)
        .set('Idempotency-Key', randomUUID())
        .send({ name, category, departments });
      expect(r.status).toBe(201);
      found = (await list()).find((x) => x.name === name);
    }
    return found!;
  };
  const onboard = (con: Record<string, string>, body: object) =>
    request(app)
      .post('/api/v1/console/members')
      .set(con)
      .set('Idempotency-Key', randomUUID())
      .send(body);

  it('starts with the current school year and keeps the classes in order', async () => {
    const years = await request(app).get('/api/v1/console/academic-years').set(a.con);
    expect(years.status).toBe(200);
    expect(years.body.items).toHaveLength(1);
    expect(years.body.items[0]).toMatchObject({ status: 'OPEN', current: true });
    expect(years.body.items[0].label).toMatch(/^\d{4}-\d{2}$/);
    const clash = await request(app)
      .post('/api/v1/console/academic-years')
      .set(a.con)
      .set('Idempotency-Key', randomUUID())
      .send({
        label: '2099-00',
        startsOn: years.body.items[0].startsOn,
        endsOn: years.body.items[0].endsOn,
      });
    expect(clash.body.code).toBe('ACA.YEAR_OVERLAP');

    const taken = await request(app)
      .post('/api/v1/console/classes')
      .set(a.con)
      .set('Idempotency-Key', randomUUID())
      .send({ name: 'grade 6', sections: [{ name: 'A' }] });
    expect(taken.body.code).toBe('ACA.CLASS_NAME_TAKEN');
    const dup = await request(app)
      .post('/api/v1/console/classes')
      .set(a.con)
      .set('Idempotency-Key', randomUUID())
      .send({ name: 'Grade 7', sections: [{ name: 'A' }, { name: 'a' }] });
    expect(dup.body.errors[0].code).toBe('ACA.SECTION_NAMES');
    const list = await request(app).get('/api/v1/console/classes').set(a.con);
    expect(list.body.items.map((c: { name: string }) => c.name)).toEqual(['Grade 6']);
    expect(list.body.items[0].sections.map((s: { name: string }) => s.name)).toEqual(['A', 'B']);
  });

  it('onboards a student with a new parent, one institution per person', async () => {
    const student = await userType(a.con, 'Student');
    await userType(a.con, 'Parent');
    const parentMobile = mobile();
    const r = await onboard(a.con, {
      userTypeId: student.id,
      departmentId: student.departments.find((d) => d.name === 'Middle school')?.id ?? null,
      firstName: 'Aarav',
      lastName: 'Hegde',
      gender: 'MALE',
      dateOfBirth: '2014-04-12',
      admissionNo: 'SPS/2026/0001',
      sectionId: grade6.sections.find((s) => s.name === 'B')!.id,
      guardians: [
        { firstName: 'Mahesh', lastName: 'Hegde', mobile: parentMobile, relation: 'FATHER' },
      ],
    });
    expect(r.status).toBe(201);
    expect(r.body.memberNo).toMatch(/^[A-Z]+-\d{5}$/);
    expect(r.body.guardians).toHaveLength(1);

    const students = await request(app).get('/api/v1/console/members?kind=STUDENTS').set(a.con);
    expect(students.body.items).toHaveLength(1);
    expect(students.body.items[0]).toMatchObject({
      name: 'Aarav Hegde',
      admissionNo: 'SPS/2026/0001',
      grade: { class: 'Grade 6', section: 'B' },
      linked: false,
      status: 'ACTIVE',
    });
    const parents = await request(app).get('/api/v1/console/members?kind=PARENTS').set(a.con);
    expect(parents.body.items[0]).toMatchObject({
      name: 'Mahesh Hegde',
      mobile: parentMobile,
      relation: 'FATHER',
      children: [{ name: 'Aarav', grade: 'Grade 6 B' }],
    });
    expect(parents.body.counts.tabs).toMatchObject({ STUDENTS: 1, PARENTS: 1 });

    // The same admission number again; the parent's mobile in another institution.
    const again = await onboard(a.con, {
      userTypeId: student.id,
      firstName: 'Anika',
      admissionNo: 'SPS/2026/0001',
      sectionId: grade6.sections[0]!.id,
    });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('IDN.ADMISSION_NO_TAKEN');
    const eligibleHere = await request(app)
      .post('/api/v1/console/members/eligibility')
      .set(a.con)
      .send({ mobile: parentMobile });
    expect(eligibleHere.body).toMatchObject({ eligible: true, code: 'IDN.PROFILE_EXISTS_HERE' });
    const elsewhere = await request(app)
      .post('/api/v1/console/members/eligibility')
      .set(b.con)
      .send({ mobile: parentMobile });
    expect(elsewhere.body).toMatchObject({
      eligible: false,
      code: 'IDN.MOBILE_IN_OTHER_INSTITUTION',
    });
    const bParent = await userType(b.con, 'Teacher');
    const refused = await onboardStaff(app, b.con, {
      userTypeId: bParent.id,
      firstName: 'Mahesh',
      mobile: parentMobile,
    });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('IDN.MOBILE_IN_OTHER_INSTITUTION');

    // Another institution's member is not found; search finds by admission number.
    const id = students.body.items[0].id;
    expect((await request(app).get(`/api/v1/console/members/${id}`).set(b.con)).status).toBe(404);
    const found = await request(app).get('/api/v1/console/search?q=0001').set(a.con);
    expect(found.body.members[0]).toMatchObject({ id, detail: 'Grade 6 B' });
  });

  it('opens wallets and virtual accounts for the student only, and links a brother to the same parent (client 2026-10-13)', async () => {
    const student = await userType(a.con, 'Student');
    await userType(a.con, 'Parent');
    const father = mobile();
    const child = (firstName: string, admissionNo: string) =>
      onboard(a.con, {
        userTypeId: student.id,
        firstName,
        lastName: 'Kini',
        admissionNo,
        sectionId: grade6.sections[0]!.id,
        guardians: [{ firstName: 'Ramesh', lastName: 'Kini', mobile: father, relation: 'FATHER' }],
      });
    const diya = await child('Diya', 'SPS/2026/0901');
    expect(diya.status, JSON.stringify(diya.body)).toBe(201);
    expect(diya.body.guardians).toHaveLength(1);
    // Her brother: the same father, linked to his existing profile — not a second one.
    const dev = await child('Dev', 'SPS/2026/0902');
    expect(dev.status, JSON.stringify(dev.body)).toBe(201);
    expect(dev.body.guardians).toEqual([]);

    const parents = await t.db
      .selectFrom('member_profiles as m')
      .innerJoin('user_types as ut', 'ut.id', 'm.user_type_id')
      .select('m.id')
      .where('m.contact_mobile', '=', father)
      .where('ut.category', '=', 'PARENT')
      .execute();
    expect(parents).toHaveLength(1);
    const wards = await t.db
      .selectFrom('guardianships')
      .select('ward_profile_id')
      .where('guardian_profile_id', '=', parents[0]!.id)
      .execute();
    expect(wards).toHaveLength(2);

    // Each child: a campus wallet with its virtual account, and an allowance wallet. The father: none.
    const inst = await t.db
      .selectFrom('institutions')
      .select('corporate_code')
      .where('id', '=', a.rowId)
      .executeTakeFirstOrThrow();
    expect(inst.corporate_code).not.toBeNull();
    const wallets = await t.db
      .selectFrom('wallets as w')
      .innerJoin('member_profiles as m', 'm.id', 'w.owner_profile_id')
      .innerJoin('user_types as ut', 'ut.id', 'm.user_type_id')
      .leftJoin('virtual_accounts as v', 'v.wallet_id', 'w.id')
      .select(['ut.category', 'w.kind', 'v.va_number'])
      .where('m.contact_mobile', '=', father)
      .execute();
    expect(wallets.filter((w) => w.category === 'PARENT')).toEqual([]);
    expect(wallets.filter((w) => w.kind === 'CAMPUS' && w.va_number)).toHaveLength(2);
    expect(wallets.filter((w) => w.kind === 'ALLOWANCE')).toHaveLength(2);

    // Single onboarding is for students; a teacher is onboarded as staff (client 2026-10-19).
    const teacherType = (await userType(a.con, 'Teacher')).id;
    const refused = await onboard(a.con, {
      userTypeId: teacherType,
      firstName: 'Lakshmi',
      lastName: 'Rao',
      mobile: mobile(),
    });
    expect(refused.status).toBe(422);
    expect(refused.body).toMatchObject({
      code: 'IDN.STUDENTS_ONLY',
      errors: [{ field: 'userTypeId', code: 'IDN.STUDENTS_ONLY' }],
    });
    // A teacher keeps a campus wallet with an active virtual account (client 2026-10-14).
    const teacher = await onboardStaff(app, a.con, {
      userTypeId: teacherType,
      firstName: 'Lakshmi',
      lastName: 'Rao',
      mobile: mobile(),
    });
    expect(teacher.status, JSON.stringify(teacher.body)).toBe(201);
    const va = await t.db
      .selectFrom('virtual_accounts as v')
      .innerJoin('wallets as w', 'w.id', 'v.wallet_id')
      .innerJoin('member_profiles as m', 'm.id', 'w.owner_profile_id')
      .select(['w.kind', 'v.status'])
      .where('m.public_id', '=', uuidToBin(teacher.body.id))
      .execute();
    expect(va).toEqual([{ kind: 'CAMPUS', status: 'ACTIVE' }]);
  });

  it('checks institution fields and edits with If-Match', async () => {
    const f = await request(app)
      .post('/api/v1/console/custom-fields')
      .set(a.con)
      .set('Idempotency-Key', randomUUID())
      .send({
        entity: 'MEMBER',
        label: 'Blood group',
        type: 'DROPDOWN',
        options: ['A+', 'B+', 'O+'],
        required: true,
        unique: false,
        listColumn: true,
        filter: true,
        active: true,
        noIdDocAck: true,
      });
    expect(f.status).toBe(201);
    blood = f.body.id;
    const student = await userType(a.con, 'Student');
    const missing = await onboard(a.con, {
      userTypeId: student.id,
      firstName: 'Diya',
      admissionNo: 'SPS/2026/0002',
      sectionId: grade6.sections[0]!.id,
    });
    expect(missing.status).toBe(422);
    expect(missing.body.errors).toContainEqual(
      expect.objectContaining({ field: `customFields.${f.body.id}`, code: 'CF.VALUE_REQUIRED' }),
    );
    const ok = await onboard(a.con, {
      userTypeId: student.id,
      firstName: 'Diya',
      admissionNo: 'SPS/2026/0002',
      sectionId: grade6.sections[0]!.id,
      customFields: { [f.body.id]: 'B+' },
    });
    expect(ok.status).toBe(201);
    const filtered = await request(app)
      .get(`/api/v1/console/members?kind=STUDENTS&cf.${f.body.id}=B%2B`)
      .set(a.con);
    expect(filtered.body.items.map((m: { name: string }) => m.name)).toEqual(['Diya']);
    expect(filtered.body.items[0].customFields[f.body.id]).toBe('B+');

    const detail = await request(app).get(`/api/v1/console/members/${ok.body.id}`).set(a.con);
    expect(detail.headers['etag']).toBe(`"v${detail.body.version}"`);
    const noMatch = await request(app)
      .patch(`/api/v1/console/members/${ok.body.id}`)
      .set(a.con)
      .send({ email: 'diya@example.in' });
    expect(noMatch.status).toBe(428);
    const edit = await request(app)
      .patch(`/api/v1/console/members/${ok.body.id}`)
      .set(a.con)
      .set('If-Match', `"v${detail.body.version}"`)
      .send({ sectionId: grade6.sections[1]!.id, customFields: { [f.body.id]: 'O+' } });
    expect(edit.status).toBe(200);
    expect(edit.body.grade).toMatchObject({ class: 'Grade 6', section: 'B' });
    expect(edit.body.customFields.find((x: { id: string }) => x.id === f.body.id).value).toBe('O+');
    const stale = await request(app)
      .patch(`/api/v1/console/members/${ok.body.id}`)
      .set(a.con)
      .set('If-Match', `"v${detail.body.version}"`)
      .send({ email: 'diya@example.in' });
    expect(stale.status).toBe(412);
    const pii = await request(app)
      .patch(`/api/v1/console/members/${ok.body.id}`)
      .set(a.con)
      .set('If-Match', `"v${edit.body.version}"`)
      .send({ firstName: 'Divya' });
    expect(pii.status).toBe(422);
    const history = await request(app)
      .get(`/api/v1/console/members/${ok.body.id}/history`)
      .set(a.con);
    expect(history.body.items.map((x: { action: string }) => x.action)).toEqual([
      'MEMBER_EDITED',
      'MEMBER_ONBOARDED',
    ]);
  });

  it('changes statuses: deactivate and activate at once; a suspension waits for a checker when self-apply is off', async () => {
    const teacher = await userType(a.con, 'Teacher');
    const m = await onboardStaff(app, a.con, {
      userTypeId: teacher.id,
      firstName: 'Kavya',
      mobile: mobile(),
      customFields: { [blood]: 'A+' },
    });
    expect(m.status).toBe(201);
    const change = (body: object) =>
      request(app)
        .post(`/api/v1/console/members/${m.body.id}/status-changes`)
        .set(a.con)
        .set('Idempotency-Key', randomUUID())
        .send(body);
    expect((await change({ to: 'INACTIVE' })).body.errors[0].code).toBe('IDN.REASON_TOO_SHORT');
    expect((await change({ to: 'INACTIVE', reason: 'Left at the end of term' })).body).toEqual({
      status: 'INACTIVE',
      approvalId: null,
    });
    expect((await change({ to: 'SUSPENDED', reason: 'Pending enquiry' })).body.code).toBe(
      'IDN.STATUS_TRANSITION_INVALID',
    );
    expect((await change({ to: 'ACTIVE' })).body.status).toBe('ACTIVE');

    // The administrator's own suspension applies directly (ADR-0015) …
    expect((await change({ to: 'SUSPENDED', reason: 'Pending an enquiry' })).body.status).toBe(
      'SUSPENDED',
    );
    expect((await change({ to: 'ACTIVE' })).body.status).toBe('ACTIVE');

    // … and goes to a checker when the setting is off.
    const s = (await request(app).get('/api/v1/ops/settings').set(ops)).body.items.find(
      (x: { key: string }) => x.key === 'mkr.adminSelfApply',
    );
    const off = await request(app)
      .put('/api/v1/ops/settings/mkr.adminSelfApply')
      .set(ops)
      .set('If-Match', `"v${s.version}"`)
      .send({ value: 0, reason: 'Testing the checker path' });
    expect(off.status).toBe(200);
    const queued = await change({ to: 'SUSPENDED', reason: 'Pending an enquiry' });
    expect(queued.status).toBe(202);
    expect(queued.body.approvalId).toBeTruthy();
    expect((await change({ to: 'SUSPENDED', reason: 'Pending an enquiry' })).body.code).toBe(
      'IDN.SUSPENSION_PENDING',
    );
    const d = await request(app).get(`/api/v1/console/members/${m.body.id}`).set(a.con);
    expect(d.body).toMatchObject({ status: 'ACTIVE', pending: { suspension: true } });
    await request(app)
      .put('/api/v1/ops/settings/mkr.adminSelfApply')
      .set(ops)
      .set('If-Match', `"v${off.body.version}"`)
      .send({ value: 1, reason: 'Back to the default' });

    const delink = await request(app)
      .post(`/api/v1/console/members/${m.body.id}/delink-requests`)
      .set(a.con)
      .set('Idempotency-Key', randomUUID())
      .send({ reason: 'Moved to another school' });
    expect(delink.body).toEqual({ delinked: true, approvalId: null });
    const after = await request(app).get(`/api/v1/console/members/${m.body.id}`).set(a.con);
    expect(after.body).toMatchObject({ status: 'INACTIVE', account: { linked: false } });
  });

  it('onboards staff with a temporary password changed at first sign-in', async () => {
    const teacher = await userType(a.con, 'Teacher');
    const dep = teacher.departments[0]!.id;
    const email = `kavya.${randomInt(0, 1e9)}@school.example.in`;
    const young = await request(app)
      .post('/api/v1/console/staff')
      .set(a.con)
      .set('Idempotency-Key', randomUUID())
      .send({
        userTypeId: teacher.id,
        departmentId: dep,
        firstName: 'Kavya',
        lastName: 'Rao',
        gender: 'FEMALE',
        dateOfBirth: '2012-01-01',
        mobile: mobile(),
        email,
        joinedOn: '2026-06-01',
        customFields: { [blood]: 'O+' },
      });
    expect(young.body.errors[0].code).toBe('IDN.STAFF_UNDER_18');
    const key = randomUUID();
    const body = {
      userTypeId: teacher.id,
      departmentId: dep,
      firstName: 'Kavya',
      lastName: 'Rao',
      gender: 'FEMALE',
      dateOfBirth: '1990-07-12',
      mobile: mobile(),
      email,
      joinedOn: '2026-06-01',
      customFields: { [blood]: 'O+' },
    };
    const send = () =>
      request(app).post('/api/v1/console/staff').set(a.con).set('Idempotency-Key', key).send(body);
    const r = await send();
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ newAccount: true });
    expect(r.body.employeeNo).toMatch(/^EMP\d{5}$/);
    // Shown once in the answer (client 2026-10-07: e-mail not integrated), not in the e-mail.
    const temp = r.body.temporaryPassword as string;
    expect(temp).toMatch(/^.{10}@1$/);
    const mail = h.email.sent.at(-1)!;
    expect(mail.to).toBe(email);
    expect(mail.text).not.toContain(temp);
    expect(mail.text).toContain('the temporary password your institution gave you');
    // A replay of the same request answers without it.
    const again = await send();
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.body).not.toHaveProperty('temporaryPassword');

    // The staff member needs a console role to enter the console.
    const role = await t.db
      .selectFrom('roles')
      .select('id')
      .where('code', '=', 'FRONT_DESK')
      .executeTakeFirst();
    const prof = await t.db
      .selectFrom('member_profiles')
      .select('id')
      .where('public_id', '=', uuidToBin(r.body.id))
      .executeTakeFirstOrThrow();
    if (role) {
      await t.db
        .insertInto('profile_roles')
        .values({ institution_id: a.rowId, profile_id: String(prof.id), role_id: String(role.id) })
        .execute();
      const step1 = await request(app)
        .post('/api/v1/auth/console/signin')
        .send({ email, password: temp });
      expect(step1.status).toBe(202);
      const v = await request(app)
        .post('/api/v1/auth/console/otp/verify')
        .send({ challengeId: step1.body.challengeId, otp: codeOf(h.sms.sent.at(-1)) });
      expect(v.body).toMatchObject({ passwordChangeRequired: true });
      const reset = await request(app)
        .post('/api/v1/auth/staff/password/reset')
        .send({ resetToken: v.body.resetToken, newPassword: 'Kavya@2026' });
      expect(reset.status).toBe(204);
      await signedIn('console', email, 'Kavya@2026');
    }
  });

  it('onboards staff from a sheet and lists their temporary passwords once (client 2026-10-07)', async () => {
    const teacher = await userType(a.con, 'Teacher');
    const tpl = await request(app)
      .get('/api/v1/console/members/uploads/templates/staff')
      .set(a.con);
    expect(tpl.status).toBe(200);
    const header = tpl.text.replace(String.fromCharCode(0xfeff), '').split('\r\n')[0]!;
    const cols = header.split(',');
    const row = (v: Record<string, string>) => cols.map((c) => v[c] ?? '').join(',');
    const person = (first: string) => ({
      'User type': 'Teacher',
      Department: teacher.departments[0]!.name,
      'First name': first,
      'Last name': 'Hegde',
      Gender: 'Female',
      'Date of birth': '12/07/1990',
      Mobile: mobile(),
      'E-mail': `${first.toLowerCase()}.${randomInt(0, 1e9)}@school.example.in`,
      'Joining date': '01/06/2026',
      'Blood group': 'O+',
    });
    const csv = [header, row(person('Asha')), row(person('Bhavya'))].join('\r\n');
    const up = await request(app)
      .post('/api/v1/console/members/uploads')
      .set(a.con)
      .set('Idempotency-Key', randomUUID())
      .field('kind', 'staff')
      .attach('file', Buffer.from(csv), { filename: 'staff.csv', contentType: 'text/csv' });
    expect(up.status).toBe(201);
    expect(up.body).toMatchObject({ total: 2, accepted: 2 });
    const key = randomUUID();
    const commit = () =>
      request(app)
        .post(`/api/v1/console/members/uploads/${up.body.id}/commit`)
        .set(a.con)
        .set('Idempotency-Key', key)
        .send({ mode: 'ALL' });
    const done = await commit();
    expect(done.status).toBe(200);
    expect(done.body.created).toBe(2);
    expect(done.body.passwords).toHaveLength(2);
    expect(done.body.passwords[0]).toMatchObject({
      name: 'Asha Hegde',
      employeeNo: expect.stringMatching(/^EMP\d{5}$/),
      temporaryPassword: expect.stringMatching(/^.{10}@1$/),
    });
    const again = await commit();
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.body).toEqual({ created: 2, skipped: 0 });
  });

  /** An Aadhaar number (twelve digits, not starting with 0 or 1) and a PAN, each new. */
  const aadhaar = () => `${randomInt(2, 10)}${String(randomInt(0, 1e11)).padStart(11, '0')}`;
  const pan = () => `ABCP${'XYZ'[randomInt(0, 3)]}${String(randomInt(0, 1e4)).padStart(4, '0')}K`;
  /** A student of the members sheet: the admission form filled in (client 2026-10-19). */
  const student = (v: Record<string, string> = {}): Record<string, string> => ({
    Class: 'Grade 6',
    Section: 'A',
    'First name': 'Isha',
    'Last name': 'Rao',
    Gender: 'Female',
    'Date of birth': '21/05/2014',
    'Residential house number and street': '12 4th Cross',
    'Residential area or locality': 'Vinoba Nagar',
    'Residential city or town': 'Shivamogga',
    'Residential state': 'Karnataka',
    'Residential PIN code': '577204',
    'Father full name': 'Suresh Rao',
    'Father mobile': mobile(),
    'Father e-mail': `suresh.${randomInt(0, 1e9)}@example.in`,
    'Father Aadhaar number': aadhaar(),
    'Father PAN': pan(),
    'Mother full name': 'Latha Rao',
    'Mother mobile': mobile(),
    'Mother Aadhaar number': aadhaar(),
    'Mother PAN': pan(),
    'Primary contact': 'Father',
    'Children in the family': 'Single child',
    'Blood group': 'A+',
    ...v,
  });
  async function membersTemplate() {
    const tpl = await request(app)
      .get('/api/v1/console/members/uploads/templates/members')
      .set(a.con);
    expect(tpl.status).toBe(200);
    const lines = tpl.text.replace(String.fromCharCode(0xfeff), '').split('\r\n');
    const cols = lines[0]!.split(',');
    /** A row of the sheet: each column's value by its name (without the required mark). */
    const row = (v: Record<string, string>, sep = ',', only: readonly string[] = cols) =>
      only.map((c) => v[c.replace(/ \*$/, '')] ?? '').join(sep);
    return { tpl, header: lines[0]!, example: lines[1]!, cols, row };
  }
  const sendSheet = (body: Buffer | string, kind = 'members') =>
    request(app)
      .post('/api/v1/console/members/uploads')
      .set(a.con)
      .set('Idempotency-Key', randomUUID())
      .field('kind', kind)
      .attach('file', Buffer.isBuffer(body) ? body : Buffer.from(body), {
        filename: 'sheet.csv',
        contentType: 'text/csv',
      });

  it('takes students on the admission form, checks each row as the form does, and onboards the accepted ones with their application (client 2026-10-19)', async () => {
    const { tpl, header, example, cols, row } = await membersTemplate();
    expect(tpl.headers['content-type']).toContain('text/csv');
    // The form's steps, in order, the required columns marked.
    expect(
      header.startsWith('Academic year,Class *,Section *,Admission number *,Joining date'),
    ).toBe(true);
    for (const c of [
      'First name *',
      'Middle name',
      'Aadhaar number',
      'Residential PIN code *',
      'Correspondence same as residential',
      'Last school attended',
      'Father Aadhaar number *',
      'Mother PAN *',
      'Guardian full name',
      'Primary contact *',
      'Children in the family *',
      'Opt for school transport',
      'Hostel accommodation',
      'Local guardian full name',
      'Reference full name',
    ]) {
      expect(cols).toContain(c);
    }
    // The institution's "Blood group" is the form's column, not a second one.
    expect(cols.filter((c) => c === 'Blood group')).toHaveLength(1);
    // The template's example row passes as it is.
    const sample = await sendSheet(`${header}\r\n${example}`);
    expect(sample.status, JSON.stringify(sample.body)).toBe(201);
    expect(sample.body.rows[0], JSON.stringify(sample.body.rows[0])).toMatchObject({
      accepted: true,
    });

    const meeraFather = mobile();
    const meeraMother = mobile();
    const csv = [
      header,
      row(student({ 'Admission number': 'SPS/2026/0101', 'Aadhaar number': '2345 6789 0124' })),
      row(student({ 'First name': 'Rohan', 'Admission number': 'SPS/2026/0101' })),
      row(
        student({
          'First name': 'Meera',
          'Middle name': 'K',
          Section: 'B',
          'Admission number': 'SPS/2026/0102',
          'Father mobile': meeraFather,
          'Mother mobile': meeraMother,
          'Mother e-mail': `latha.${randomInt(0, 1e9)}@example.in`,
          'Primary contact': 'Mother',
          'Correspondence same as residential': 'No',
          'Correspondence house number and street': '7 Main Road',
          'Correspondence area or locality': 'Gandhi Bazaar',
          'Correspondence city or town': 'Bengaluru',
          'Correspondence state': 'Karnataka',
          'Correspondence PIN code': '560004',
          'Last school attended': 'Little Flower School',
          Board: 'CBSE',
          'Father annual income': '₹600000',
          'Reference full name': 'Anitha Bhat',
          'Reference: how they know the student': 'Class teacher',
          'Reference phone': mobile(),
          'Blood group': 'O+',
        }),
      ),
      row(
        student({ 'First name': 'Tejas', 'Admission number': 'SPS/2026/0103', Class: 'Grade 9' }),
      ),
      row(
        student({
          'First name': 'Kavya',
          'Admission number': 'SPS/2026/0104',
          'Father PAN': '',
          'Mother mobile': '12345',
        }),
      ),
      row(
        student({
          'First name': 'Nikhil',
          'Admission number': 'SPS/2026/0105',
          'Hostel accommodation': 'Maybe',
        }),
      ),
    ].join('\r\n');
    const up = await sendSheet(csv);
    expect(up.status, JSON.stringify(up.body)).toBe(201);
    expect(up.body).toMatchObject({ total: 6, accepted: 2, rejected: 4, status: 'VALIDATED' });
    expect(up.body.rows[1].errors[0]).toMatchObject({ column: 'Admission number' });
    expect(up.body.rows[3].errors[0].column).toBe('Class');
    expect(up.body.rows[4].errors.map((e: { column: string }) => e.column).sort()).toEqual([
      'Father PAN',
      'Mother mobile',
    ]);
    expect(up.body.rows[5].errors).toEqual([
      { column: 'Hostel accommodation', message: 'Write Yes or No.' },
    ]);
    // The report keeps the rows encrypted: no Aadhaar number in it.
    const stored = await t.db
      .selectFrom('member_uploads')
      .select('report')
      .where('public_id', '=', uuidToBin(up.body.id))
      .executeTakeFirstOrThrow();
    expect(JSON.stringify(stored.report)).not.toContain('234567890124');

    const commit = (mode: string) =>
      request(app)
        .post(`/api/v1/console/members/uploads/${up.body.id}/commit`)
        .set(a.con)
        .set('Idempotency-Key', randomUUID())
        .send({ mode });
    expect((await commit('ALL')).body.code).toBe('UPL.HAS_REJECTED');
    const done = await commit('ACCEPTED');
    expect(done.body, JSON.stringify(done.body)).toEqual({ created: 2, skipped: 4 });
    expect((await commit('ACCEPTED')).body.code).toBe('UPL.ALREADY_COMMITTED');
    const found = await request(app).get('/api/v1/console/search?q=Meera').set(a.con);
    expect(found.body.members[0]).toMatchObject({ detail: 'Grade 6 B' });

    // Each student has the approved application an admission leaves, with the form on it.
    const meera = await t.db
      .selectFrom('admission_applications as x')
      .innerJoin('member_profiles as m', 'm.id', 'x.member_profile_id')
      .select([
        'x.id',
        'x.status',
        'x.source',
        'x.admission_no',
        'x.middle_name',
        'x.primary_relation',
        'x.data',
        'x.father_aadhaar_last4',
        'x.mother_pan_enc',
        'm.first_name',
        'm.last_name',
      ])
      .where('x.admission_no', '=', 'SPS/2026/0102')
      .executeTakeFirstOrThrow();
    expect(meera).toMatchObject({
      status: 'APPROVED',
      source: 'IMPORT',
      middle_name: 'K',
      primary_relation: 'MOTHER',
    });
    expect(meera.father_aadhaar_last4).toMatch(/^\d{4}$/);
    expect(meera.mother_pan_enc).not.toBeNull();
    const data = (typeof meera.data === 'string' ? JSON.parse(meera.data) : meera.data) as {
      student: { bloodGroup: string };
      addresses: { sameAsResidential: boolean; correspondence: { city: string } };
      previous: { school: string; board: string };
      parents: { father: { annualIncome: number } };
    };
    expect(data.student.bloodGroup).toBe('O+');
    expect(data.addresses).toMatchObject({
      sameAsResidential: false,
      correspondence: { city: 'Bengaluru' },
    });
    expect(data.previous).toMatchObject({ school: 'Little Flower School', board: 'CBSE' });
    expect(data.parents.father.annualIncome).toBe(600_000);
    const refs = await t.db
      .selectFrom('admission_references')
      .select('name')
      .where('application_id', '=', meera.id)
      .execute();
    expect(refs).toEqual([{ name: 'Anitha Bhat' }]);
    // The parents have RingPe profiles at the school, as on an admission.
    const parents = await t.db
      .selectFrom('member_profiles as m')
      .innerJoin('user_types as ut', 'ut.id', 'm.user_type_id')
      .select('m.contact_mobile')
      .where('m.contact_mobile', 'in', [meeraFather, meeraMother])
      .where('ut.category', '=', 'PARENT')
      .execute();
    expect(parents).toHaveLength(2);

    // Another file's first row.
    const bad = await sendSheet('Name,Class\r\nIsha,6');
    expect(bad.body).toMatchObject({
      code: 'UPL.HEADER_COLUMN',
      detail:
        'Column 1 of the first row should be “Academic year”, but the file has “Name”. Download the template and keep its first row as it is.',
    });
    // The members template from before it was the admission form.
    const old = await sendSheet(
      'User type,First name,Last name,Gender,Date of birth,Mobile,E-mail,Admission number,Grade,Section,Department,Joining date,Parent first name,Parent last name,Parent mobile,Parent relation\r\nStudent,Isha',
    );
    expect(old.body.code).toBe('UPL.OLD_TEMPLATE');
  });

  it('reads the sheets Excel really saves, and says what is wrong with one it cannot (client 2026-10-13)', async () => {
    const { header, cols, row } = await membersTemplate();
    const isha = student({ 'First name': 'Ishani', 'Admission number': 'SPS/2026/0201' });
    // Semicolons (Excel in some regional settings).
    const semi = await sendSheet([cols.join(';'), row(isha, ';')].join('\r\n'));
    expect(semi.status, JSON.stringify(semi.body)).toBe(201);
    expect(semi.body, JSON.stringify(semi.body.rows)).toMatchObject({ total: 1, accepted: 1 });
    // Without the required marks, and with the empty lines Excel leaves.
    const plain = cols.map((c) => c.replace(/ \*$/, ''));
    const unmarked = await sendSheet([plain.join(','), row(isha), ',,,', ''].join('\r\n'));
    expect(unmarked.status, JSON.stringify(unmarked.body)).toBe(201);
    expect(unmarked.body.total).toBe(1);
    // Excel's "Unicode text": UTF-16 with tabs.
    const utf16 = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from([cols.join('\t'), row(isha, '\t')].join('\r\n'), 'utf16le'),
    ]);
    const tabbed = await sendSheet(utf16);
    expect(tabbed.status, JSON.stringify(tabbed.body)).toBe(201);
    expect(tabbed.body.total).toBe(1);

    // The staff template on the members upload.
    const staffTpl = await request(app)
      .get('/api/v1/console/members/uploads/templates/staff')
      .set(a.con);
    const staffHeader = staffTpl.text.replace(String.fromCharCode(0xfeff), '').split('\r\n')[0]!;
    expect((await sendSheet(`${staffHeader}\r\nTeacher`)).body).toMatchObject({
      code: 'UPL.WRONG_TEMPLATE',
      detail:
        'This file is the staff template. Upload it with the staff upload, or download the members template.',
    });
    // The members template on the staff upload.
    expect((await sendSheet(`${header}\r\nx`, 'staff')).body.code).toBe('UPL.WRONG_TEMPLATE');
    // A column no one knows.
    expect((await sendSheet(`${header},Hobby\r\n${row(isha)},Chess`)).body).toMatchObject({
      code: 'UPL.HEADER_UNKNOWN',
      params: { found: 'Hobby' },
    });
    // An Excel workbook instead of the CSV.
    expect((await sendSheet(Buffer.from('PK\u0003\u0004xl/workbook.xml'))).body.code).toBe(
      'UPL.NOT_CSV',
    );
  });
});
