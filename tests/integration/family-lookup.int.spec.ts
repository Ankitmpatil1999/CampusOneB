/**
 * One family per mobile number at a school, on a real MySQL (client 2026-10-22: "a shared mobile
 * number causes unrelated parent/student accounts to be auto-linked"):
 * - the family lookup (IDN-090) tells a new mobile, a family — its children here, its parents, the
 *   parents as its admission had them — or a staff member working here, for the forms to fill in;
 * - a brother or sister with the same parent (the same name and mobile) joins that family;
 * - another family's parent on that mobile, or a student given another family's mobile as their
 *   own, is refused (IDN.MOBILE_OTHER_FAMILY) instead of joining the two families on one account;
 * - a teacher who is also a parent is that same person.
 */
import { randomInt, randomUUID } from 'node:crypto';
import request from 'supertest';
import { adminUrl } from './db';
import { mobile, schoolFixture, type Payer } from './school';

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
});
