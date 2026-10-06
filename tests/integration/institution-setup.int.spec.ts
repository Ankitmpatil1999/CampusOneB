/**
 * Institution set-up on a real MySQL (INS-014…019; SRS 7.3, 7.12.1; prototype c.roles, c.fields):
 * user types always keep a department, names fixed once used, departments with members kept;
 * institution-defined fields with the prototype's rules, the active limit, the identity-document
 * acknowledgement, type fixed once values exist; one institution never reaches another's set-up.
 */
import { randomInt, randomUUID } from 'node:crypto';
import request from 'supertest';
import type { Express } from 'express';
import { adminUrl, createTestDatabase, insertInstitution, type TestDatabase } from './db';
import { buildHttpApp, codeOf } from './http-app';
import { newPublicIdPair } from '../../utils/idGenerator';
import { hashSecret } from '../../utils/password';

const PASSWORD = 'Tvps@2026';

describe.skipIf(!adminUrl)('institution set-up on real MySQL', () => {
  let t: TestDatabase;
  let h: Awaited<ReturnType<typeof buildHttpApp>>;
  let app: Express;
  let hash: string;

  beforeAll(async () => {
    t = await createTestDatabase();
    h = await buildHttpApp(t);
    app = h.app;
    hash = await hashSecret(PASSWORD);
  }, 120_000);
  afterAll(async () => {
    await t?.drop();
  });

  /** An active school with an Institution Administrator signed in to its console. */
  async function school() {
    const inst = await insertInstitution(t.db);
    await t.db
      .updateTable('institutions')
      .set({ status: 'ACTIVE' })
      .where('id', '=', inst.id)
      .execute();
    const type = await t.db
      .insertInto('user_types')
      .values({
        public_id: newPublicIdPair().bin,
        institution_id: inst.id,
        name: 'Staff',
        category: 'STAFF',
        created_by: null,
      })
      .executeTakeFirstOrThrow();
    const dept = await t.db
      .insertInto('departments')
      .values({
        public_id: newPublicIdPair().bin,
        institution_id: inst.id,
        user_type_id: String(type.insertId),
        name: 'Administration',
      })
      .executeTakeFirstOrThrow();
    const email = `admin.${randomInt(0, 1e9)}@school.example.in`;
    const acc = await t.db
      .insertInto('platform_accounts')
      .values({
        public_id: newPublicIdPair().bin,
        mobile: `9${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`,
        email,
        first_name: 'PRAKASH',
        last_name: 'SHETTY',
      })
      .executeTakeFirstOrThrow();
    await t.db
      .insertInto('account_credentials')
      .values({ account_id: String(acc.insertId), kind: 'PASSWORD', hash })
      .execute();
    const prof = await t.db
      .insertInto('member_profiles')
      .values({
        public_id: newPublicIdPair().bin,
        institution_id: inst.id,
        account_id: String(acc.insertId),
        user_type_id: String(type.insertId),
        department_id: String(dept.insertId),
        first_name: 'PRAKASH',
        last_name: null,
        employee_no: null,
        admission_no: null,
      })
      .executeTakeFirstOrThrow();
    const role = await t.db
      .selectFrom('roles')
      .select('id')
      .where('code', '=', 'INSTITUTION_ADMIN')
      .executeTakeFirstOrThrow();
    await t.db
      .insertInto('profile_roles')
      .values({
        institution_id: inst.id,
        profile_id: String(prof.insertId),
        role_id: String(role.id),
      })
      .execute();
    const step1 = await request(app)
      .post('/api/v1/auth/console/signin')
      .send({ email, password: PASSWORD });
    const r = await request(app)
      .post('/api/v1/auth/console/otp/verify')
      .send({ challengeId: step1.body.challengeId, otp: codeOf(h.sms.sent.at(-1)) });
    expect(r.status).toBe(200);
    const cookies = ([] as string[])
      .concat(r.headers['set-cookie'] ?? [])
      .map((c) => c.split(';')[0] ?? '');
    return {
      inst,
      headers: { Cookie: cookies.join('; '), 'X-CSRF-Token': r.body.csrfToken as string },
    };
  }

  it('keeps every user type with a department; names fixed once used (INS-014…016)', async () => {
    const { headers } = await school();
    const list = async () =>
      (await request(app).get('/api/v1/console/user-types').set(headers)).body.items as {
        id: string;
        name: string;
        category: string;
        members: number;
        version: number;
        departments: { id: string; name: string; members: number }[];
      }[];
    const create = (body: object) =>
      request(app)
        .post('/api/v1/console/user-types')
        .set(headers)
        .set('Idempotency-Key', randomUUID())
        .send(body);

    const staff = (await list())[0]!;
    expect(staff).toMatchObject({
      name: 'Staff',
      members: 1,
      departments: [{ name: 'Administration', members: 1 }],
    });
    const created = await create({
      name: 'Hostel warden',
      category: 'STAFF',
      departments: ["Boys' hostel", 'Girls hostel'],
    });
    expect(created.status).toBe(201);
    expect((await create({ name: 'hostel WARDEN', departments: ['X'] })).body).toMatchObject({
      code: 'INS.USER_TYPE_TAKEN',
      detail: 'A user type called “hostel WARDEN” already exists',
    });
    expect((await create({ name: 'Visitors', departments: [] })).body).toMatchObject({
      code: 'INS.DEPARTMENT_REQUIRED',
      detail: 'Please enter both a role name and at least one department.',
    });
    const bad = await create({ name: 'Bad <type>', departments: ['A'] });
    expect(bad.body.errors[0]).toMatchObject({ field: 'name', code: 'INS.USER_TYPE_NAME_FORMAT' });

    const change = (id: string, version: number, body: object) =>
      request(app)
        .patch(`/api/v1/console/user-types/${id}`)
        .set(headers)
        .set('If-Match', `"v${version}"`)
        .send(body);
    expect((await change(staff.id, staff.version, { name: 'Employees' })).body.code).toBe(
      'INS.USER_TYPE_NAME_FIXED',
    );
    expect(
      (await change(staff.id, staff.version, { removeDepartments: [staff.departments[0]!.id] }))
        .body,
    ).toMatchObject({
      code: 'INS.DEPARTMENT_IN_USE',
      detail: 'Members are in Administration, so it can’t be removed.',
    });
    const warden = (await list()).find((x) => x.name === 'Hostel warden')!;
    const renamed = await change(warden.id, warden.version, {
      name: 'Hostel wardens',
      addDepartments: ['Annexe'],
      removeDepartments: [warden.departments[1]!.id],
    });
    expect(renamed.status).toBe(200);
    const after = (await list()).find((x) => x.name === 'Hostel wardens')!;
    expect(after.departments.map((d) => d.name)).toEqual(["Boys' hostel", 'Annexe']);
    expect((await change(warden.id, warden.version, { addDepartments: ['Late'] })).status).toBe(
      412,
    );
    expect(
      (
        await change(after.id, after.version, {
          removeDepartments: after.departments.map((d) => d.id),
        })
      ).body.code,
    ).toBe('INS.DEPARTMENT_REQUIRED');
  });

  it('defines institution fields with the prototype rules, limit and acknowledgement (INS-017…019)', async () => {
    const { inst, headers } = await school();
    const create = (body: object) =>
      request(app)
        .post('/api/v1/console/custom-fields')
        .set(headers)
        .set('Idempotency-Key', randomUUID())
        .send({
          entity: 'MEMBER',
          type: 'TEXT',
          required: false,
          unique: false,
          listColumn: false,
          filter: false,
          active: true,
          noIdDocAck: true,
          ...body,
        });
    const house = await create({
      label: 'House',
      type: 'DROPDOWN',
      options: ['Kaveri', 'Tunga', 'Sharavathi'],
      filter: true,
      listColumn: true,
    });
    expect(house.status).toBe(201);
    expect(house.body).toMatchObject({
      entityLabel: 'Member',
      typeLabel: 'Dropdown',
      options: ['Kaveri', 'Tunga', 'Sharavathi'],
      status: 'ACTIVE',
      values: 0,
      definedBy: 'PRAKASH SHETTY',
    });
    const code = async (body: object) => {
      const r = await create(body);
      return r.body.errors?.[0]?.code ?? r.body.code;
    };
    expect(await code({ label: 'Blood group', noIdDocAck: false })).toBe('CF.ACK_REQUIRED');
    expect(await code({ label: 'Aadhaar number' })).toBe('CF.ID_DOCUMENT_LABEL');
    expect(await code({ label: 'Club', type: 'MULTI_SELECT', options: ['Chess'] })).toBe(
      'CF.OPTIONS_TOO_FEW',
    );
    expect(await code({ label: 'Club', type: 'MULTI_SELECT', options: ['Chess', 'chess'] })).toBe(
      'CF.OPTIONS_DUPLICATE',
    );
    expect(await code({ label: 'Nickname', options: ['A', 'B'] })).toBe('CF.OPTIONS_NOT_ALLOWED');
    expect(await code({ label: 'Nickname', filter: true })).toBe('CF.FILTER_TYPE');
    expect(await code({ label: 'Hosteller', type: 'YES_NO', unique: true })).toBe('CF.UNIQUE_TYPE');
    expect((await create({ label: 'house' })).body).toMatchObject({
      code: 'CF.LABEL_TAKEN',
      detail: 'Member already has a field called “house”',
    });

    // The active limit per entity (15, a setting) counts active fields only.
    for (let i = 1; i <= 15; i++)
      expect((await create({ entity: 'MERCHANT', label: `Note ${i}` })).status).toBe(201);
    expect((await create({ entity: 'MERCHANT', label: 'Note 16' })).body).toMatchObject({
      code: 'CF.LIMIT_REACHED',
      detail: 'Merchant already has 15 active fields — deactivate one first',
    });
    const inactive = await create({ entity: 'MERCHANT', label: 'Note 16', active: false });
    expect(inactive.body.status).toBe('INACTIVE');
    const patch = (id: string, version: number, body: object) =>
      request(app)
        .patch(`/api/v1/console/custom-fields/${id}`)
        .set(headers)
        .set('If-Match', `"v${version}"`)
        .send(body);
    expect((await patch(inactive.body.id, inactive.body.version, { active: true })).body.code).toBe(
      'CF.LIMIT_REACHED',
    );

    // Deactivation keeps values; type and entity are fixed once values exist.
    const fieldRow = await t.db
      .selectFrom('custom_field_definitions')
      .select('id')
      .where('label', '=', 'House')
      .where('institution_id', '=', inst.id)
      .executeTakeFirstOrThrow();
    await t.db
      .insertInto('custom_field_values')
      .values({
        institution_id: inst.id,
        field_id: String(fieldRow.id),
        entity_ref: newPublicIdPair().bin,
        value_text: 'Tunga',
        value_number: null,
        value_date: null,
        value_bool: null,
        unique_key: null,
      })
      .execute();
    expect(
      (
        await patch(house.body.id, house.body.version, {
          type: 'TEXT',
          options: [],
          filter: false,
          noIdDocAck: true,
        })
      ).body.code,
    ).toBe('CF.TYPE_FIXED');
    const renamed = await patch(house.body.id, house.body.version, {
      label: 'School house',
      options: ['Kaveri', 'Tunga'],
      noIdDocAck: true,
    });
    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({
      label: 'School house',
      options: ['Kaveri', 'Tunga'],
      values: 1,
    });
    const off = await patch(house.body.id, renamed.body.version, { active: false });
    expect(off.body).toMatchObject({ status: 'INACTIVE', values: 1 });
    expect(
      (await patch(house.body.id, off.body.version, { label: 'X House' })).body.errors[0].code,
    ).toBe('CF.ACK_REQUIRED');

    // Another institution neither sees nor reaches these fields.
    const other = await school();
    const theirs = await request(app).get('/api/v1/console/custom-fields').set(other.headers);
    expect(theirs.body.items).toEqual([]);
    const reach = await request(app)
      .patch(`/api/v1/console/custom-fields/${house.body.id}`)
      .set(other.headers)
      .set('If-Match', `"v${off.body.version}"`)
      .send({ active: true });
    expect(reach.status).toBe(404);
  }, 60_000);
});
