/**
 * One family per mobile number at a school, on a real MySQL (client 2026-10-22: "a shared mobile
 * number causes unrelated parent/student accounts to be auto-linked"):
 * - the family lookup (IDN-090) tells a new mobile, a family — its children here, its parents, the
 *   parents as its admission had them — or a staff member working here, for the forms to fill in;
 * - a brother or sister with the same parent (the same name and mobile) joins that family;
 * - another family's parent on that mobile, or a student given another family's mobile as their
 *   own, is refused (IDN.MOBILE_OTHER_FAMILY) instead of joining the two families on one account;
 * - a teacher who is also a parent is that same person;
 * - what another institution has on a mobile plays no part and is never shown, and an admission's
 *   verified primary contact is the school's parent on that mobile whatever the name (client
 *   2026-10-27).
 */
import { randomInt, randomUUID } from 'node:crypto';
import request from 'supertest';
import { adminUrl, insertInstitution } from './db';
import { mobile, schoolFixture, type Payer } from './school';
import { newPublicIdPair } from '../../utils/idGenerator';

describe.skipIf(!adminUrl)('one family per mobile at a school (client 2026-10-22)', () => {
  let f: Awaited<ReturnType<typeof schoolFixture>>;
  let ravi: Payer;
  let student: { typeId: string; sectionId: string };
  const family = mobile();

  const lookup = (m: string) =>
    request(f.app)
      .post('/api/v1/console/members/family-lookup')
      .set(f.school.con)
      .send({ mobile: m });
  /** A child onboarded with one guardian (and, optionally, their own mobile). */
  const child = (
    firstName: string,
    guardian: { firstName: string; lastName: string; mobile: string },
    own?: string,
  ) =>
    request(f.app)
      .post('/api/v1/console/members')
      .set(f.school.con)
      .set('Idempotency-Key', randomUUID())
      .send({
        userTypeId: student.typeId,
        firstName,
        lastName: guardian.lastName,
        gender: 'MALE',
        dateOfBirth: '2016-02-01',
        admissionNo: `FAM/${randomInt(0, 1e9)}`,
        sectionId: student.sectionId,
        ...(own ? { mobile: own } : {}),
        guardians: [
          {
            ...guardian,
            email: `${guardian.firstName.toLowerCase()}.${guardian.mobile}@example.in`,
            relation: 'FATHER',
          },
        ],
      });

  beforeAll(async () => {
    f = await schoolFixture('Family');
    ravi = await f.payer('Ravi', 0);
    // The fixture's first child: Aarav, under "Guardian Rao" on the family's mobile.
    await f.ward('Aarav', family);
    const types = (await request(f.app).get('/api/v1/console/user-types').set(f.school.con)).body
      .items as { id: string; name: string }[];
    const classes = (await request(f.app).get('/api/v1/console/classes').set(f.school.con)).body
      .items as { sections: { id: string }[] }[];
    student = {
      typeId: types.find((x) => x.name === 'Student')!.id,
      sectionId: classes.find((c) => c.sections.length)!.sections[0]!.id,
    };
  }, 240_000);
  afterAll(async () => {
    await f?.t.drop();
  });

  it('tells a new mobile, a family with its children and parents, and a staff member', async () => {
    const fresh = await lookup(mobile());
    expect(fresh.status, JSON.stringify(fresh.body)).toBe(200);
    expect(fresh.body).toMatchObject({ status: 'NEW', family: null, staff: null });

    const known = await lookup(family);
    expect(known.body).toMatchObject({
      status: 'FAMILY',
      family: {
        children: [expect.objectContaining({ name: 'Aarav Rao' })],
        parents: [
          expect.objectContaining({
            name: 'Guardian Rao',
            relation: 'FATHER',
            mobile: family,
            onThisMobile: true,
          }),
        ],
        father: { name: 'Guardian Rao', mobile: family },
        primary: 'FATHER',
      },
    });
    expect(known.body.family.children[0].grade).toBeTruthy();
    // Never an identity number.
    expect(JSON.stringify(known.body)).not.toMatch(/aadhaar|pan"/i);

    const staff = await lookup(ravi.mobile);
    expect(staff.body).toMatchObject({
      status: 'STAFF',
      family: null,
      staff: expect.objectContaining({ firstName: expect.stringMatching(/^Ravi/i) }),
    });
    expect((await lookup('12345')).status).toBe(422);
  });

  it('joins a brother to the same parent, refuses another family on that mobile', async () => {
    const brother = await child('Vihaan', {
      firstName: 'Guardian',
      lastName: 'Rao',
      mobile: family,
    });
    expect(brother.status, JSON.stringify(brother.body)).toBe(201);
    const after = await lookup(family);
    expect(after.body.family.children.map((c: { name: string }) => c.name).sort()).toEqual([
      'Aarav Rao',
      'Vihaan Rao',
    ]);
    expect(after.body.family.parents).toHaveLength(1);

    // Another father typed with this family's mobile: refused, naming whose mobile it is.
    const other = await child('Kabir', { firstName: 'Suresh', lastName: 'Patil', mobile: family });
    expect(other.status, JSON.stringify(other.body)).toBe(409);
    expect(other.body).toMatchObject({
      code: 'IDN.MOBILE_OTHER_FAMILY',
      errors: [{ field: 'guardians.0.mobile', params: { name: 'Guardian Rao' } }],
    });
    // A student given another family's mobile as their own: refused too.
    const own = await child(
      'Ishaan',
      { firstName: 'Mahesh', lastName: 'Gowda', mobile: mobile() },
      family,
    );
    expect(own.status, JSON.stringify(own.body)).toBe(409);
    expect(own.body.errors[0]).toMatchObject({ field: 'mobile', code: 'IDN.MOBILE_OTHER_FAMILY' });
    expect((await lookup(family)).body.family.children).toHaveLength(2);
  });

  it('takes a teacher as their child’s parent, not someone else on the teacher’s mobile', async () => {
    const t = (await lookup(ravi.mobile)).body.staff as { firstName: string; lastName: string };
    const ok = await child('Anika', {
      firstName: t.firstName,
      lastName: t.lastName ?? 'Rao',
      mobile: ravi.mobile,
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    const refused = await child('Diya', {
      firstName: 'Prakash',
      lastName: 'Shetty',
      mobile: ravi.mobile,
    });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('IDN.MOBILE_OTHER_FAMILY');
  });

  /** Another institution, where these mobiles are used too (client 2026-10-27). */
  async function elsewhere(people: { mobile: string; firstName: string; category: string }[]) {
    const inst = await insertInstitution(f.t.db);
    for (const p of people) {
      const type = await f.t.db
        .insertInto('user_types')
        .values({
          public_id: newPublicIdPair().bin,
          institution_id: inst.id,
          name: `${p.category} ${randomInt(0, 1e6)}`,
          category: p.category as never,
        })
        .executeTakeFirstOrThrow();
      await f.t.db
        .insertInto('member_profiles')
        .values({
          public_id: newPublicIdPair().bin,
          institution_id: inst.id,
          user_type_id: String(type.insertId),
          first_name: p.firstName,
          last_name: 'NAIK',
          contact_mobile: p.mobile,
        })
        .execute();
    }
  }

  it('leaves out, and never shows, what another institution has on the mobile (client 2026-10-27)', async () => {
    const theirs = mobile();
    await elsewhere([
      { mobile: theirs, firstName: 'SUNIL', category: 'PARENT' },
      { mobile: family, firstName: 'KIRAN', category: 'STUDENT' },
      { mobile: family, firstName: 'MANJULA', category: 'PARENT' },
    ]);
    // Known only elsewhere: new here, no OTHER_INSTITUTION any more.
    const fresh = await lookup(theirs);
    expect(fresh.status).toBe(200);
    expect(fresh.body).toEqual({
      mobile: theirs,
      status: 'NEW',
      account: false,
      family: null,
      staff: null,
    });
    // A family here and there: this school's children and parents only.
    const known = await lookup(family);
    expect(known.body.status).toBe('FAMILY');
    expect(JSON.stringify(known.body)).not.toMatch(/kiran|manjula|naik/i);
    expect(known.body.family.parents).toHaveLength(1);
    const eligibility = await request(f.app)
      .post('/api/v1/console/members/eligibility')
      .set(f.school.con)
      .send({ mobile: theirs });
    expect(eligibility.body).toEqual({
      eligible: true,
      code: 'IDN.NEW_PERSON',
      account: false,
      elsewhere: true,
      profiles: [],
    });
  });

  it("links an admission's verified primary contact to the school's parent on that mobile, whatever the name (client 2026-10-27)", async () => {
    const members = f.h.services.members;
    const inst = await f.t.db
      .selectFrom('institutions')
      .select(['id', 'short_name'])
      .where('id', '=', f.school.rowId)
      .executeTakeFirstOrThrow();
    const make = (
      firstName: string,
      g: { firstName: string; lastName: string; mobile: string; verified?: boolean },
    ) =>
      f.t.db.transaction().execute((trx) =>
        members.createMember(
          trx,
          { id: String(inst.id), short_name: inst.short_name },
          newPublicIdPair(),
          {
            userTypeId: student.typeId,
            firstName,
            lastName: 'Rao',
            gender: 'MALE',
            dateOfBirth: '2017-03-01',
            admissionNo: `VER/${randomInt(0, 1e9)}`,
            sectionId: student.sectionId,
            guardians: [
              { ...g, email: `${firstName.toLowerCase()}@example.in`, relation: 'MOTHER' },
            ],
          },
          null,
        ),
      );
    // The family's mobile under another name: refused as typed in the console…
    await expect(
      make('Rohan', { firstName: 'Latha', lastName: 'Rao', mobile: family }),
    ).rejects.toMatchObject({
      code: 'IDN.MOBILE_OTHER_FAMILY',
    });
    // …but the admission's verified contact is that family's parent: no second parent profile.
    const joined = await make('Rohan', {
      firstName: 'Latha',
      lastName: 'Rao',
      mobile: family,
      verified: true,
    });
    expect(joined.guardians).toEqual([]);
    const after = await lookup(family);
    expect(after.body.family.parents).toHaveLength(1);
    expect(after.body.family.children.map((c: { name: string }) => c.name)).toContain('Rohan Rao');

    // A teacher's mobile without a parent profile: a Parent profile under the teacher's account.
    const meena = await f.payer('Meena', 0);
    await expect(
      make('Tara', { firstName: 'Suma', lastName: 'Bhat', mobile: meena.mobile }),
    ).rejects.toMatchObject({ code: 'IDN.MOBILE_OTHER_FAMILY' });
    const accounts = async () =>
      (
        await f.t.db
          .selectFrom('platform_accounts')
          .select('id')
          .where('mobile', '=', meena.mobile)
          .execute()
      ).length;
    expect(await accounts()).toBe(1);
    const parent = await make('Tara', {
      firstName: 'Suma',
      lastName: 'Bhat',
      mobile: meena.mobile,
      verified: true,
    });
    expect(parent.guardians).toHaveLength(1);
    const row = await f.profileRow(parent.guardians[0]!);
    expect(String(row.account_id)).toBe(meena.accountId);
    expect(await accounts()).toBe(1);
  });
});
