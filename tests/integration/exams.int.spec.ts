/**
 * Exams and marks on a real MySQL (Phase 7.2; SRS 20.11, 20.17–20.22; ACA-034…041, ACA-052…054,
 * ACA-063, ACA-070/071; CR-13 RNG-ACA-442/449/450; RC-37):
 * - exam names are unique; exams for several subjects are created all or none, only for subjects the
 *   class studies, inside the year, once per name, section and subject;
 * - only the assigned teacher enters marks, once the exam is held, 0 to the maximum or absent, for
 *   students enrolled in the section that year; the coordinator validates; a changed valid mark returns
 *   to Created; marks and withdrawal are fixed once marks exist;
 * - publication needs every student, tells the families, and the student sees the results by year;
 *   the reports are computed on the server against each exam's own pass marks.
 */
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { adminUrl } from './db';
import { mobile, schoolFixture, type Auth, type Payer } from './school';

const istToday = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());

describe.skipIf(!adminUrl)('exams and marks on real MySQL', () => {
  let f: Awaited<ReturnType<typeof schoolFixture>>;
  let con: Record<string, string>;
  let meena: Payer;
  let ravi: Payer;
  let asha: Payer;
  let bala: Payer;
  let principal: Auth;
  let grade6: { id: string; sections: { id: string; name: string }[] };
  let year: { id: string; label: string; startsOn: string; endsOn: string };
  let math: string;
  let english: string;
  let science: string;
  const send = (
    method: 'post' | 'put' | 'patch',
    path: string,
    body: object = {},
    ver?: number,
    auth: Auth = con,
    surface = 'console',
  ) => {
    let r = request(f.app)
      [method](`/api/v1/${surface}${path}`)
      .set(auth)
      .set('Idempotency-Key', randomUUID());
    if (ver !== undefined) r = r.set('If-Match', `"v${ver}"`);
    return r.send(body);
  };
  const get = (path: string, auth: Auth = con, surface = 'console') =>
    request(f.app).get(`/api/v1/${surface}${path}`).set(auth);
  const member = (path: string, auth: Auth) => request(f.app).get(`/api/v1${path}`).set(auth);

  beforeAll(async () => {
    f = await schoolFixture('Exams School');
    con = f.school.con;
    meena = await f.payer('Meena', 0);
    ravi = await f.payer('Ravi', 0);
    asha = await f.student('Asha');
    bala = await f.student('Bala');
    const classes = (await get('/classes')).body.items as (typeof grade6 & { name: string })[];
    grade6 = classes.find((c) => c.name === 'Grade 6')!;
    year = (await get('/academic-years')).body.items.find((y: { current: boolean }) => y.current);
    const subject = async (code: string, name: string) => {
      const r = await send('post', '/subjects', { code, name });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      return r.body.id as string;
    };
    math = await subject('MAT', 'Mathematics');
    english = await subject('ENG', 'English');
    science = await subject('SCI', 'Science');
    const mapping = await get(`/classes/${grade6.id}/subjects`);
    const mapped = await send(
      'put',
      `/classes/${grade6.id}/subjects`,
      { subjectIds: [math, english] },
      mapping.body.version,
    );
    expect(mapped.status, JSON.stringify(mapped.body)).toBe(200);
    const st = await send('post', '/teacher-assignments', {
      kind: 'SUBJECT_TEACHER',
      teacherId: meena.id,
      subjectId: math,
      sectionIds: [grade6.sections[0]!.id],
    });
    expect(st.status, JSON.stringify(st.body)).toBe(201);
    // A principal: their own user type and profile.
    const pt = await send('post', '/user-types', {
      name: 'Principal',
      category: 'PRINCIPAL',
      departments: ['Leadership'],
    });
    expect(pt.status, JSON.stringify(pt.body)).toBe(201);
    const mob = mobile();
    const tokens = await f.signUp(mob, 'Lakshmi');
    const pr = await send('post', '/members', {
      userTypeId: (await get('/user-types')).body.items.find(
        (x: { name: string }) => x.name === 'Principal',
      ).id,
      firstName: 'Lakshmi',
      mobile: mob,
    });
    expect(pr.status, JSON.stringify(pr.body)).toBe(201);
    principal = await f.onProfile(tokens, pr.body.id);
  }, 240_000);
  afterAll(async () => {
    await f?.t.drop();
  });

  it('creates exams all or none, for mapped subjects inside the year, once per section and subject', async () => {
    const short = await send('post', '/exam-names', { name: 'UT' });
    expect(short.body.errors[0].code).toBe('ACA.EXAM_NAME');
    const ut1 = await send('post', '/exam-names', { name: 'Unit Test 1' });
    expect(ut1.status, JSON.stringify(ut1.body)).toBe(201);
    expect((await send('post', '/exam-names', { name: 'Unit Test 1' })).body.code).toBe(
      'ACA.EXAM_NAME_TAKEN',
    );
    const sectionIds = [grade6.sections[0]!.id];
    const today = istToday();
    const range = await send('post', '/exams', {
      examNameId: ut1.body.id,
      sectionIds,
      items: [{ subjectId: math, date: today, maxMarks: 50, passMarks: 60 }],
    });
    expect(range.body.errors[0].code).toBe('ACA.EXAM_MARKS_RANGE');
    const outside = await send('post', '/exams', {
      examNameId: ut1.body.id,
      sectionIds,
      items: [{ subjectId: math, date: '2099-01-01', maxMarks: 50, passMarks: 18 }],
    });
    expect(outside.body.errors[0].code).toBe('ACA.DATE_OUTSIDE_YEAR');
    const unmapped = await send('post', '/exams', {
      examNameId: ut1.body.id,
      sectionIds,
      items: [{ subjectId: science, date: today, maxMarks: 50, passMarks: 18 }],
    });
    expect(unmapped.body.code).toBe('ACA.SUBJECT_NOT_MAPPED');
    const made = await send('post', '/exams', {
      examNameId: ut1.body.id,
      sectionIds,
      items: [
        {
          subjectId: math,
          date: today,
          startTime: '09:30',
          endTime: '10:30',
          maxMarks: 50,
          passMarks: 18,
        },
        { subjectId: english, date: year.endsOn, maxMarks: 50, passMarks: 18 },
      ],
    });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect(made.body.created).toBe(2);
    const mathExam = made.body.items.find(
      (e: { subject: { name: string } }) => e.subject.name === 'Mathematics',
    );
    expect(mathExam).toMatchObject({
      schedule: 'Today',
      startTime: '09:30',
      maxMarks: 50,
      passMarks: 18,
      marks: { students: 2, entered: 0, status: 'NOT_UPLOADED' },
    });
    // All or none: a second science-free request repeating Mathematics creates nothing.
    const ut2 = await send('post', '/exam-names', { name: 'Unit Test 2' });
    const twice = await send('post', '/exams', {
      examNameId: ut1.body.id,
      sectionIds,
      items: [
        { subjectId: english, date: today, maxMarks: 50, passMarks: 18 },
        { subjectId: math, date: today, maxMarks: 50, passMarks: 18 },
      ],
    });
    expect(twice.body.code).toBe('ACA.EXAM_EXISTS');
    const list = await get(`/exams?examNameId=${ut1.body.id}`);
    expect(list.body.items).toHaveLength(2);
    const names = await get('/exam-names');
    expect(names.body.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'Unit Test 1', examsThisYear: 2 }),
        expect.objectContaining({ id: ut2.body.id, examsThisYear: 0 }),
      ]),
    );
  });

  it('lets only the assigned teacher enter marks once held, validates, and fixes the exam once marked', async () => {
    const mine = await get('/exams', meena.auth, 'teacher');
    expect(mine.status, JSON.stringify(mine.body)).toBe(200);
    expect(mine.body.items.map((e: { subject: { name: string } }) => e.subject.name)).toEqual([
      'Mathematics',
    ]);
    const exam = mine.body.items[0] as { id: string };
    expect((await get('/exams', ravi.auth, 'teacher')).body.items).toEqual([]);
    expect((await get('/academics', meena.auth, 'principal')).body.code).toBe('ACA.PRINCIPAL_ONLY');
    const grid = await get(`/exams?examId=${exam.id}`, meena.auth, 'teacher');
    expect(grid.body.grid.rows.map((r: { student: { name: string } }) => r.student.name)).toEqual([
      'Asha Rao',
      'Bala Rao',
    ]);
    const v = grid.body.grid.version as number;
    const put = (auth: Auth, marks: object[], ver = v, id = exam.id) =>
      send('put', `/exams/${id}/marks`, { marks }, ver, auth, 'teacher');
    expect((await put(ravi.auth, [{ studentId: asha.id, marks: 40 }])).body.code).toBe(
      'ACA.NOT_YOUR_CLASS',
    );
    expect((await put(meena.auth, [{ studentId: asha.id, marks: 51 }])).body.errors[0].code).toBe(
      'ACA.MARK_RANGE',
    );
    expect((await put(meena.auth, [{ studentId: ravi.id, marks: 20 }])).body.errors[0].code).toBe(
      'ACA.MARK_NOT_ENROLLED',
    );
    const saved = await put(meena.auth, [
      { studentId: asha.id, marks: 42.5 },
      { studentId: bala.id, absent: true },
    ]);
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.rows.map((r: { status: string }) => r.status)).toEqual([
      'CREATED',
      'CREATED',
    ]);
    expect(saved.body.summary).toMatchObject({ entered: 2, passed: 1, failed: 0 });
    expect((await put(meena.auth, [{ studentId: asha.id, marks: 40 }])).status).toBe(412);

    // The English exam is at the end of the year: not held yet.
    await send('post', '/teacher-assignments', {
      kind: 'SUBJECT_TEACHER',
      teacherId: meena.id,
      subjectId: english,
      sectionIds: [grade6.sections[0]!.id],
    });
    const all = await get('/exams', meena.auth, 'teacher');
    const eng = all.body.items.find(
      (e: { subject: { name: string } }) => e.subject.name === 'English',
    );
    expect(
      (await put(meena.auth, [{ studentId: asha.id, marks: 40 }], eng.version, eng.id)).body.code,
    ).toBe('ACA.EXAM_NOT_HELD');

    const status = await get('/marks-status');
    expect(status.body.items).toEqual([
      expect.objectContaining({
        examName: 'Unit Test 1',
        due: 1,
        uploaded: 1,
        awaiting: 1,
        missing: 0,
      }),
    ]);
    const exam1 = await get(`/exams?subjectId=${math}`);
    const fixed = await send(
      'patch',
      `/exams/${exam.id}`,
      { maxMarks: 100 },
      exam1.body.items[0].version,
    );
    expect(fixed.body.code).toBe('ACA.EXAM_HAS_MARKS');
    const validated = await send('post', `/exams/${exam.id}/marks-validation`);
    expect(validated.status, JSON.stringify(validated.body)).toBe(200);
    expect(validated.body.marks).toMatchObject({ valid: 2, status: 'VALIDATED' });
    expect((await send('post', `/exams/${exam.id}/marks-validation`)).body.code).toBe(
      'ACA.NOTHING_TO_VALIDATE',
    );
    const marksTable = await get(`/exams/${exam.id}/marks`);
    expect(marksTable.body.grid.rows.map((r: { status: string }) => r.status)).toEqual([
      'VALID',
      'VALID',
    ]);

    // A changed valid mark returns to Created (RC-37); the unchanged one stays Valid.
    const again = await get(`/exams?examId=${exam.id}`, meena.auth, 'teacher');
    const edited = await put(
      meena.auth,
      [
        { studentId: asha.id, marks: 44 },
        { studentId: bala.id, absent: true },
      ],
      again.body.grid.version,
    );
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect(edited.body.rows.map((r: { status: string }) => r.status)).toEqual(['CREATED', 'VALID']);
  });

  it('publishes complete marks, tells the families and shows results by year', async () => {
    const exams = (await get('/exams', meena.auth, 'teacher')).body.items as {
      id: string;
      subject: { name: string };
    }[];
    const mathExam = exams.find((e) => e.subject.name === 'Mathematics')!;
    const engExam = exams.find((e) => e.subject.name === 'English')!;
    expect(
      (
        await send(
          'post',
          `/exams/${engExam.id}/marks-publication`,
          {},
          undefined,
          meena.auth,
          'teacher',
        )
      ).body.code,
    ).toBe('ACA.MARKS_INCOMPLETE');
    // Nothing published yet: the student sees the schedule but no results.
    expect((await member('/me/results', asha.auth)).body.exams).toEqual([]);
    const pub = await send(
      'post',
      `/exams/${mathExam.id}/marks-publication`,
      {},
      undefined,
      meena.auth,
      'teacher',
    );
    expect(pub.status, JSON.stringify(pub.body)).toBe(200);
    expect(pub.body.exam.published).not.toBeNull();
    expect(pub.body.grid.rows.map((r: { status: string }) => r.status)).toEqual(['VALID', 'VALID']);
    const bell = await member('/me/notifications', asha.auth);
    expect(JSON.stringify(bell.body)).toContain('Unit Test 1 marks for Mathematics are out');

    const results = await member('/me/results', asha.auth);
    expect(results.status, JSON.stringify(results.body)).toBe(200);
    expect(results.body.year.label).toBe(year.label);
    expect(results.body.exams).toEqual([
      expect.objectContaining({
        name: 'Unit Test 1',
        percentage: 88,
        subjects: [expect.objectContaining({ marks: 44, maxMarks: 50, standing: 'Passed' })],
      }),
    ]);
    expect((await member('/me/results', bala.auth)).body.exams[0].subjects[0].standing).toBe(
      'Absent',
    );
    const schedule = await member('/me/exams', asha.auth);
    expect(schedule.body.section).toBe('Grade 6 A');
    expect(schedule.body.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          subject: expect.objectContaining({ name: 'Mathematics' }),
          published: true,
        }),
        expect.objectContaining({
          subject: expect.objectContaining({ name: 'English' }),
          schedule: 'Upcoming',
        }),
      ]),
    );
    expect((await member('/me/results', meena.auth)).body.code).toBe('ACA.NOT_A_STUDENT_PROFILE');

    const report = await get('/academic-reports');
    expect(report.status, JSON.stringify(report.body)).toBe(200);
    expect(report.body.subjects).toEqual([
      expect.objectContaining({
        subject: expect.objectContaining({ name: 'Mathematics' }),
        students: 2,
        absent: 1,
        highest: 88,
        average: 88,
        passed: 1,
        failed: 0,
        top: expect.objectContaining({ name: 'Asha Rao' }),
      }),
    ]);
    expect(report.body).toMatchObject({ classAverage: 88, passedEverySubject: 1, pendingMarks: 0 });
    const academics = await get('/academics', principal, 'principal');
    expect(academics.status, JSON.stringify(academics.body)).toBe(200);
    expect(academics.body.sections).toEqual([
      expect.objectContaining({ average: 88, passRate: 100, standing: 'Top Performer' }),
    ]);
  });
});
