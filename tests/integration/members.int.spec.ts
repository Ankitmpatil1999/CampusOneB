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
        {
          firstName: 'Mahesh',
          lastName: 'Hegde',
          mobile: parentMobile,
          email: 'mahesh.hegde@example.in',
          relation: 'FATHER',
        },
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
    const refused = await onboard(b.con, {
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
    const m = await onboard(a.con, {
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

  it('checks a sheet row by row and onboards the accepted rows only', async () => {
    const tpl = await request(app)
      .get('/api/v1/console/members/uploads/templates/members')
      .set(a.con);
    expect(tpl.status).toBe(200);
    expect(tpl.headers['content-type']).toContain('text/csv');
    const header = tpl.text.replace(String.fromCharCode(0xfeff), '').split('\r\n')[0]!;
    expect(header.startsWith('User type,First name,Last name')).toBe(true);
    const cols = header.split(',');
    const row = (v: Record<string, string>) => cols.map((c) => v[c] ?? '').join(',');
    const csv = [
      header,
      row({
        'User type': 'Student',
        'First name': 'Isha',
        'Admission number': 'SPS/2026/0101',
        Grade: 'Grade 6',
        Section: 'A',
        'Blood group': 'A+',
      }),
      row({
        'User type': 'Student',
        'First name': 'Rohan',
        'Admission number': 'SPS/2026/0101',
        Grade: 'Grade 6',
        Section: 'A',
        'Blood group': 'A+',
      }),
      row({
        'User type': 'Student',
        'First name': 'Meera',
        'Admission number': 'SPS/2026/0102',
        Grade: 'Grade 6',
        Section: 'B',
        'Blood group': 'O+',
        'Parent first name': 'Suresh',
        'Parent mobile': mobile(),
        'Parent relation': 'Father',
        'Parent e-mail': 'suresh@example.in',
      }),
      row({
        'User type': 'Student',
        'First name': 'Tejas',
        'Admission number': 'SPS/2026/0103',
        Grade: 'Grade 9',
        Section: 'A',
        'Blood group': 'A+',
      }),
    ].join('\r\n');
    const up = await request(app)
      .post('/api/v1/console/members/uploads')
      .set(a.con)
      .set('Idempotency-Key', randomUUID())
      .field('kind', 'members')
      .attach('file', Buffer.from(csv), { filename: 'students.csv', contentType: 'text/csv' });
    expect(up.status).toBe(201);
    expect(up.body).toMatchObject({ total: 4, accepted: 2, rejected: 2, status: 'VALIDATED' });
    expect(up.body.rows[1].errors[0].message).toBe(
      'Duplicate admission number in the file: SPS/2026/0101',
    );
    expect(up.body.rows[3].errors[0].column).toBe('Grade');

    const commit = (mode: string) =>
      request(app)
        .post(`/api/v1/console/members/uploads/${up.body.id}/commit`)
        .set(a.con)
        .set('Idempotency-Key', randomUUID())
        .send({ mode });
    expect((await commit('ALL')).body.code).toBe('UPL.HAS_REJECTED');
    expect((await commit('ACCEPTED')).body).toEqual({ created: 2, skipped: 2 });
    expect((await commit('ACCEPTED')).body.code).toBe('UPL.ALREADY_COMMITTED');
    const meera = await request(app).get('/api/v1/console/search?q=Meera').set(a.con);
    expect(meera.body.members[0]).toMatchObject({ detail: 'Grade 6 B' });

    const bad = await request(app)
      .post('/api/v1/console/members/uploads')
      .set(a.con)
      .set('Idempotency-Key', randomUUID())
      .field('kind', 'members')
      .attach('file', Buffer.from('Name,Class\r\nIsha,6'), {
        filename: 'x.csv',
        contentType: 'text/csv',
      });
    // Says which column is wrong (client 2026-10-13).
    expect(bad.body).toMatchObject({
      code: 'UPL.HEADER_COLUMN',
      detail:
        'Column 1 of the first row should be “User type”, but the file has “Name”. Download the template and keep its first row as it is.',
    });
  });

  it('reads the sheets Excel really saves, and says what is wrong with one it cannot (client 2026-10-13)', async () => {
    const send = (body: Buffer | string, kind = 'members') =>
      request(app)
        .post('/api/v1/console/members/uploads')
        .set(a.con)
        .set('Idempotency-Key', randomUUID())
        .field('kind', kind)
        .attach('file', Buffer.isBuffer(body) ? body : Buffer.from(body), {
          filename: 'sheet.csv',
          contentType: 'text/csv',
        });
    const tpl = await request(app)
      .get('/api/v1/console/members/uploads/templates/members')
      .set(a.con);
    const header = tpl.text.replace(String.fromCharCode(0xfeff), '').split('\r\n')[0]!;
    const cols = header.split(',');
    const row = (v: Record<string, string>, sep = ',', only = cols) =>
      only.map((c) => v[c] ?? '').join(sep);
    const isha = {
      'User type': 'Student',
      'First name': 'Isha',
      'Admission number': 'SPS/2026/0201',
      Grade: 'Grade 6',
      Section: 'A',
      'Blood group': 'A+',
    };
    // Semicolons (Excel in some regional settings).
    const semi = await send([cols.join(';'), row(isha, ';')].join('\r\n'));
    expect(semi.status, JSON.stringify(semi.body)).toBe(201);
    expect(semi.body).toMatchObject({ total: 1, accepted: 1 });
    // A template from before the institution's own field was added: read as empty.
    const base = cols.filter((c) => c !== 'Blood group');
    const older = await send([base.join(','), row(isha, ',', base)].join('\r\n'));
    expect(older.status, JSON.stringify(older.body)).toBe(201);
    expect(older.body.total).toBe(1);
    // Excel's "Unicode text": UTF-16 with tabs.
    const utf16 = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from([cols.join('\t'), row(isha, '\t')].join('\r\n'), 'utf16le'),
    ]);
    const tabbed = await send(utf16);
    expect(tabbed.status, JSON.stringify(tabbed.body)).toBe(201);
    expect(tabbed.body.total).toBe(1);

    // The staff template on the members upload.
    const staffTpl = await request(app)
      .get('/api/v1/console/members/uploads/templates/staff')
      .set(a.con);
    const staffHeader = staffTpl.text.replace(String.fromCharCode(0xfeff), '').split('\r\n')[0]!;
    expect((await send(`${staffHeader}\r\nTeacher`)).body).toMatchObject({
      code: 'UPL.WRONG_TEMPLATE',
      detail:
        'This file is the staff template. Upload it with the staff upload, or download the members template.',
    });
    // A column no one knows.
    expect((await send(`${header},Hobby\r\n${row(isha)},Chess`)).body).toMatchObject({
      code: 'UPL.HEADER_UNKNOWN',
      params: { found: 'Hobby' },
    });
    // An Excel workbook instead of the CSV.
    expect((await send(Buffer.from('PK\u0003\u0004xl/workbook.xml'))).body.code).toBe(
      'UPL.NOT_CSV',
    );
  });
});
