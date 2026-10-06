/**
 * Teachers on the web (Phase 10.1; client request 2026-10-05) on a real MySQL: the school gives a
 * teacher the Teacher console role; the teacher signs in to the console with the app account's e-mail
 * and password and a code, and works on the same teacher routes as in the app — their own sections
 * only. Without the teaching grant, or from another surface, the routes stay shut.
 */
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { adminUrl } from './db';
import { schoolFixture, type Auth, type Payer } from './school';

const istToday = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());

describe.skipIf(!adminUrl)('teachers on the web on real MySQL', () => {
  let f: Awaited<ReturnType<typeof schoolFixture>>;
  let con: Auth;
  let meena: Payer;
  let ravi: Payer;
  let asha: Payer;
  let bala: Payer;
  let meenaWeb: Auth;
  let raviWeb: Auth;
  let examId = '';
  const send = (method: 'post' | 'put', path: string, body: object, auth: Auth = con) =>
    request(f.app)
      [method](`/api/v1${path}`)
      .set(auth)
      .set('Idempotency-Key', randomUUID())
      .send(body);
  const get = (path: string, auth: Auth = con) => request(f.app).get(`/api/v1${path}`).set(auth);
  const without = (auth: Auth, header: string) =>
    Object.fromEntries(Object.entries(auth).filter(([k]) => k !== header));

  /** The Teacher role for a staff profile, then a console session as that person. */
  const teacherOnWeb = async (p: Payer) => {
    const roles = await get('/console/roles');
    const teacher = roles.body.items.find((r: { code: string }) => r.code === 'TEACHER');
    expect(teacher).toMatchObject({ assignable: true });
    const set = await request(f.app)
      .put(`/api/v1/console/staff-accounts/${p.id}/roles`)
      .set(con)
      .send({ roleIds: [teacher.id] });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    const acc = await f.t.db
      .selectFrom('platform_accounts')
      .select('email')
      .where('id', '=', p.accountId)
      .executeTakeFirstOrThrow();
    const cookies = await f.signedIn('console', acc.email!);
    // Teacher routes are outside /console: the web names its cookie session's surface.
    return { ...cookies, 'X-RingPe-Surface': 'console' };
  };

  beforeAll(async () => {
    f = await schoolFixture('Teacher Web School');
    con = f.school.con;
    meena = await f.payer('Meena', 0);
    ravi = await f.payer('Ravi', 0);
    asha = await f.student('Asha');
    bala = await f.student('Bala');
    const grade6 = (await get('/console/classes')).body.items.find(
      (c: { name: string }) => c.name === 'Grade 6',
    ) as { id: string; sections: { id: string }[] };
    const subject = await send('post', '/console/subjects', { code: 'MAT', name: 'Mathematics' });
    expect(subject.status, JSON.stringify(subject.body)).toBe(201);
    const mapping = await get(`/console/classes/${grade6.id}/subjects`);
    const mapped = await request(f.app)
      .put(`/api/v1/console/classes/${grade6.id}/subjects`)
      .set(con)
      .set('If-Match', `"v${mapping.body.version}"`)
      .send({ subjectIds: [subject.body.id] });
    expect(mapped.status, JSON.stringify(mapped.body)).toBe(200);
    const assigned = await send('post', '/console/teacher-assignments', {
      kind: 'SUBJECT_TEACHER',
      teacherId: meena.id,
      subjectId: subject.body.id,
      sectionIds: [grade6.sections[0]!.id],
    });
    expect(assigned.status, JSON.stringify(assigned.body)).toBe(201);
    const name = await send('post', '/console/exam-names', { name: 'Unit Test 1' });
    const exam = await send('post', '/console/exams', {
      examNameId: name.body.id,
      sectionIds: [grade6.sections[0]!.id],
      items: [{ subjectId: subject.body.id, date: istToday(), maxMarks: 50, passMarks: 18 }],
    });
    expect(exam.status, JSON.stringify(exam.body)).toBe(201);
    meenaWeb = await teacherOnWeb(meena);
    raviWeb = await teacherOnWeb(ravi);
  }, 300_000);
  afterAll(async () => {
    await f?.t.drop();
  });

  it('opens the console to a teacher with the teaching grants only', async () => {
    const s = await get('/console/session', meenaWeb);
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    expect(s.body.subTasks).toEqual(
      expect.arrayContaining(['task.teaching', 'teaching.view', 'teaching.marks']),
    );
    expect(s.body.subTasks).not.toContain('home.view');
    // The console's own pages stay shut to the Teacher role.
    expect((await get('/console/members', meenaWeb)).status).toBe(403);
  });

  it('enters marks from the web for the teacher’s own section only', async () => {
    const mine = await get('/teacher/exams', meenaWeb);
    expect(mine.status, JSON.stringify(mine.body)).toBe(200);
    expect(mine.body.items.map((e: { subject: { name: string } }) => e.subject.name)).toEqual([
      'Mathematics',
    ]);
    examId = mine.body.items[0].id;
    const grid = await get(`/teacher/exams?examId=${examId}`, meenaWeb);
    expect(grid.body.grid.rows.map((r: { student: { name: string } }) => r.student.name)).toEqual([
      'Asha Rao',
      'Bala Rao',
    ]);
    const put = (auth: Auth, version: number) =>
      request(f.app)
        .put(`/api/v1/teacher/exams/${examId}/marks`)
        .set(auth)
        .set('Idempotency-Key', randomUUID())
        .set('If-Match', `"v${version}"`)
        .send({
          marks: [
            { studentId: asha.id, marks: 41.5 },
            { studentId: bala.id, absent: true },
          ],
        });
    const saved = await put(meenaWeb, grid.body.grid.version);
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.summary).toMatchObject({ entered: 2 });
    // Another teacher with the same role, but not this class's.
    expect((await get('/teacher/exams', raviWeb)).body.items).toEqual([]);
    expect((await put(raviWeb, saved.body.version ?? 0)).body.code).toBe('ACA.NOT_YOUR_CLASS');
  });

  it('keeps the teacher routes shut without the grant, the surface name or CSRF', async () => {
    // The administrator's console session has no teaching grant.
    expect((await get('/teacher/exams', { ...con, 'X-RingPe-Surface': 'console' })).status).toBe(
      403,
    );
    // The cookie session is read only when the web names its surface.
    expect((await get('/teacher/exams', without(meenaWeb, 'X-RingPe-Surface'))).status).toBe(401);
    // A change without the CSRF header is refused.
    const r = await request(f.app)
      .put(`/api/v1/teacher/exams/${examId}/marks`)
      .set(without(meenaWeb, 'X-CSRF-Token'))
      .set('Idempotency-Key', randomUUID())
      .set('If-Match', '"v1"')
      .send({ marks: [] });
    expect(r.status).toBe(403);
  });
});
