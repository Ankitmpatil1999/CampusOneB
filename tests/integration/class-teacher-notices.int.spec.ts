/**
 * The class teacher is told of each student placed in their section (client 2026-10-26), on a real
 * MySQL: onboarding into the section, a section change on the member's page, a transfer — and nobody
 * when the section has no class teacher or the student stays where they were.
 */
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { adminUrl } from './db';
import { schoolFixture, type Auth, type Payer } from './school';

type Notice = { titleKey: string; title: string; body: string; link: string | null };

describe.skipIf(!adminUrl)('class teacher notices on real MySQL', () => {
  let f: Awaited<ReturnType<typeof schoolFixture>>;
  let con: Record<string, string>;
  let ravi: Payer;
  let meena: Payer;
  let sectionA: string;
  let sectionB: string;
  const get = (path: string, auth: Auth) => request(f.app).get(`/api/v1${path}`).set(auth);
  const post = (path: string, auth: Auth, body: object) =>
    request(f.app).post(`/api/v1${path}`).set(auth).set('Idempotency-Key', randomUUID()).send(body);
  const added = async (who: Payer): Promise<Notice[]> =>
    ((await get('/me/notifications?limit=50', who.auth)).body.items as Notice[]).filter(
      (n) => n.titleKey === 'NTF.CLASS_STUDENT_ADDED',
    );
  const classTeacher = async (teacher: Payer, sectionId: string) =>
    expect(
      (
        await post('/console/teacher-assignments', con, {
          kind: 'CLASS_TEACHER',
          teacherId: teacher.id,
          sectionIds: [sectionId],
        })
      ).status,
    ).toBe(201);
  const moveTo = async (memberId: string, sectionId: string) => {
    const detail = await get(`/console/members/${memberId}`, con);
    const r = await request(f.app)
      .patch(`/api/v1/console/members/${memberId}`)
      .set(con)
      .set('If-Match', `"v${detail.body.version}"`)
      .send({ sectionId });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  };

  beforeAll(async () => {
    f = await schoolFixture('Class Teacher Notices School');
    con = f.school.con;
    ravi = await f.payer('Ravi', 0);
    meena = await f.payer('Meena', 0);
    // The first student makes Grade 6 A; nobody teaches it yet, so nobody is told.
    await f.student('Asha');
    const grade6 = (
      (await get('/console/classes', con)).body.items as {
        id: string;
        name: string;
        sections: { id: string }[];
      }[]
    ).find((c) => c.name === 'Grade 6')!;
    sectionA = grade6.sections[0]!.id;
    const b = await post(`/console/classes/${grade6.id}/sections`, con, { name: 'B' });
    expect(b.status, JSON.stringify(b.body)).toBe(201);
    sectionB = (b.body.sections as { id: string; name: string }[]).find((s) => s.name === 'B')!.id;
    await classTeacher(ravi, sectionA);
  }, 240_000);
  afterAll(async () => {
    await f?.t.drop();
  });

  it('tells the class teacher of a student onboarded into the section, and nobody before', async () => {
    expect(await added(ravi)).toEqual([]);
    const bala = await f.student('Bala');
    const told = await added(ravi);
    expect(told).toHaveLength(1);
    expect(told[0]).toMatchObject({
      title: 'Bala Rao joined your class Grade 6 A',
      link: '/teacher/timetable',
    });
    expect(told[0]!.body).toMatch(/^Grade 6 A · \S+\.$/);
    // Grade 6 B has no class teacher: a move there tells nobody, the old class teacher included.
    await moveTo(bala.id, sectionB);
    expect(await added(ravi)).toHaveLength(1);
    expect(await added(meena)).toEqual([]);
  });

  it('tells the new section’s class teacher of a section change, once', async () => {
    await classTeacher(meena, sectionB);
    const chitra = await f.student('Chitra');
    expect((await added(ravi)).map((n) => n.title)).toContain(
      'Chitra Rao joined your class Grade 6 A',
    );
    await moveTo(chitra.id, sectionB);
    expect((await added(meena)).map((n) => n.title)).toEqual([
      'Chitra Rao joined your class Grade 6 B',
    ]);
    // Saving the member again in the same section is no news.
    await moveTo(chitra.id, sectionB);
    expect(await added(meena)).toHaveLength(1);
  });

  it('tells the class teacher of a transfer into their section', async () => {
    const before = (await added(ravi)).length;
    const list = await get(`/console/enrolments?sectionId=${sectionB}`, con);
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    const enrolment = (list.body.items as { id: string; student: { name: string } }[]).find(
      (x) => x.student.name === 'Chitra Rao',
    )!;
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
    const t = await post(`/console/enrolments/${enrolment.id}/transfers`, con, {
      sectionId: sectionA,
      effectiveOn: today,
      reason: 'Moved to balance the sections',
    });
    expect(t.status, JSON.stringify(t.body)).toBe(200);
    const told = await added(ravi);
    expect(told).toHaveLength(before + 1);
    expect(told[0]!.title).toBe('Chitra Rao joined your class Grade 6 A');
  });
});
