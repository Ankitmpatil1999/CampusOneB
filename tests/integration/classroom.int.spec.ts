/**
 * The teacher's portal, homework and the student's week on a real MySQL (Phase 7.3; SRS 20.13, 20.15,
 * 20.24, 20.25, 20.31; ACA-044…051, ACA-065…069, ACA-075; CR-02, CR-09; OI-ACA-30…35):
 * - the teacher's menu, classes and timetable come from their assignments; rosters open only to an
 *   assigned teacher;
 * - homework is set by the class teacher or the subject's teacher, due after today, for the whole
 *   class or chosen enrolled students, with a file or a link; the families are told;
 * - the student submits once (a file or a link), the teacher reviews (again if needed) and reminds
 *   those who haven't submitted; parents see their child's homework, timetable and calendar.
 */
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { adminUrl } from './db';
import { schoolFixture, type Auth, type Payer } from './school';

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const istDay = (offset = 0) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(
    new Date(Date.now() + offset * 86_400_000),
  );

describe.skipIf(!adminUrl)('teaching and homework on real MySQL', () => {
  let f: Awaited<ReturnType<typeof schoolFixture>>;
  let con: Record<string, string>;
  let meena: Payer;
  let ravi: Payer;
  let sunil: Payer;
  let asha: Payer;
  let bala: Payer;
  let section6A: string;
  let section6B: string;
  let math: string;
  let english: string;
  let year: { id: string; label: string; endsOn: string };
  const console_ = (method: 'post' | 'put', path: string, body: object, ver?: number) => {
    let r = request(f.app)
      [method](`/api/v1/console${path}`)
      .set(con)
      .set('Idempotency-Key', randomUUID());
    if (ver !== undefined) r = r.set('If-Match', `"v${ver}"`);
    return r.send(body);
  };
  const get = (path: string, auth: Auth) => request(f.app).get(`/api/v1${path}`).set(auth);
  const post = (path: string, auth: Auth, body: object = {}) =>
    request(f.app).post(`/api/v1${path}`).set(auth).set('Idempotency-Key', randomUUID()).send(body);
  const upload = async (auth: Auth) => {
    const r = await request(f.app)
      .post('/api/v1/files')
      .set(auth)
      .field('purpose', 'document')
      .attach('file', PDF, 'worksheet.pdf');
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.fileId as string;
  };

  beforeAll(async () => {
    f = await schoolFixture('Classroom School');
    con = f.school.con;
    meena = await f.payer('Meena', 0);
    ravi = await f.payer('Ravi', 0);
    sunil = await f.payer('Sunil', 0);
    asha = await f.student('Asha');
    bala = await f.student('Bala');
    const classes = (await request(f.app).get('/api/v1/console/classes').set(con)).body.items as {
      id: string;
      name: string;
      sections: { id: string; name: string }[];
    }[];
    const g6 = classes.find((c) => c.name === 'Grade 6')!;
    section6A = g6.sections[0]!.id;
    const b = await console_('post', `/classes/${g6.id}/sections`, { name: 'B' });
    expect(b.status, JSON.stringify(b.body)).toBe(201);
    section6B = b.body.sections.find((s: { name: string }) => s.name === 'B').id;
    year = (await request(f.app).get('/api/v1/console/academic-years').set(con)).body.items.find(
      (y: { current: boolean }) => y.current,
    );
    math = (await console_('post', '/subjects', { code: 'MAT', name: 'Mathematics' })).body.id;
    english = (await console_('post', '/subjects', { code: 'ENG', name: 'English' })).body.id;
    const mapping = await request(f.app).get(`/api/v1/console/classes/${g6.id}/subjects`).set(con);
    expect(
      (
        await console_(
          'put',
          `/classes/${g6.id}/subjects`,
          { subjectIds: [math, english] },
          mapping.body.version,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await console_('post', '/teacher-assignments', {
          kind: 'SUBJECT_TEACHER',
          teacherId: meena.id,
          subjectId: math,
          sectionIds: [section6A, section6B],
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await console_('post', '/teacher-assignments', {
          kind: 'CLASS_TEACHER',
          teacherId: ravi.id,
          sectionIds: [section6A],
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await console_('post', '/teacher-assignments', {
          kind: 'SUBJECT_TEACHER',
          teacherId: ravi.id,
          subjectId: english,
          sectionIds: [section6A],
        })
      ).status,
    ).toBe(201);
    const bell = await request(f.app).get('/api/v1/console/periods').set(con);
    const periods = await console_(
      'put',
      '/periods',
      {
        periods: [
          { name: 'Period 1', startsAt: '09:00', endsAt: '09:40', isBreak: false },
          { name: 'Period 2', startsAt: '09:40', endsAt: '10:20', isBreak: false },
        ],
      },
      bell.body.version,
    );
    expect(periods.status, JSON.stringify(periods.body)).toBe(200);
    const [p1, p2] = periods.body.items as { id: string }[];
    const tt = await request(f.app).get(`/api/v1/console/timetables/${section6A}`).set(con);
    const saved = await console_(
      'put',
      `/timetables/${section6A}`,
      {
        slots: [
          { day: 1, periodId: p1!.id, subjectId: math, teacherId: meena.id },
          { day: 1, periodId: p2!.id, subjectId: english, teacherId: ravi.id },
          { day: 3, periodId: p1!.id, subjectId: math, teacherId: meena.id },
        ],
      },
      tt.body.version,
    );
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  }, 240_000);
  afterAll(async () => {
    await f?.t.drop();
  });

  it('builds the teacher’s day, classes, roster and timetable from the assignments', async () => {
    const today = await get('/teacher/today', meena.auth);
    expect(today.status, JSON.stringify(today.body)).toBe(200);
    expect(today.body).toMatchObject({
      assigned: true,
      classTeacherOf: [],
      subjectSections: [
        expect.objectContaining({
          label: 'Grade 6 A',
          subjects: [expect.objectContaining({ name: 'Mathematics' })],
        }),
        expect.objectContaining({ label: 'Grade 6 B' }),
      ],
      homeworkToReview: 0,
    });
    expect((await get('/teacher/today', sunil.auth)).body.assigned).toBe(false);
    expect((await get('/teacher/today', asha.auth)).body.code).toBe('ACA.TEACHERS_ONLY');
    const classes = await get('/teacher/classes', ravi.auth);
    expect(classes.body.items).toEqual([
      expect.objectContaining({ label: 'Grade 6 A', classTeacher: true, students: 2 }),
    ]);
    const roster = await get(`/teacher/classes/${section6A}/students`, ravi.auth);
    expect(roster.status, JSON.stringify(roster.body)).toBe(200);
    expect(roster.body.items).toEqual([
      expect.objectContaining({ name: 'Asha Rao', class: 'Grade 6', section: 'A' }),
      expect.objectContaining({ name: 'Bala Rao', admissionNo: expect.any(String) }),
    ]);
    expect((await get(`/teacher/classes/${section6A}/students`, sunil.auth)).body.code).toBe(
      'ACA.NOT_ASSIGNED',
    );
    const week = await get(`/teacher/timetable?classSectionId=${section6A}`, meena.auth);
    expect(week.body.mine).toHaveLength(2);
    expect(week.body.section.slots).toHaveLength(3);
    const mine = await get('/me/timetable', asha.auth);
    expect(mine.body).toMatchObject({ section: { label: 'Grade 6 A' } });
    expect(mine.body.slots.map((s: { subject: { name: string } }) => s.subject.name)).toEqual([
      'Mathematics',
      'English',
      'Mathematics',
    ]);
  });

  it('sets homework for the class or chosen students, with a file or a link', async () => {
    const due = istDay(2) <= year.endsOn ? istDay(2) : year.endsOn;
    const base = {
      classSectionId: section6A,
      subjectId: math,
      type: 'HOMEWORK',
      title: 'Integers — worksheet 4',
      instructions: 'Solve questions 1–20 on the worksheet. Show every step.',
      dueDate: due,
    };
    expect(
      (await post('/teacher/homework', meena.auth, { ...base, dueDate: istDay(0) })).body.errors[0]
        .code,
    ).toBe('ACA.DUE_IN_PAST');
    expect(
      (await post('/teacher/homework', meena.auth, { ...base, title: 'Hi' })).body.errors[0].code,
    ).toBe('ACA.HW_TITLE');
    expect(
      (await post('/teacher/homework', meena.auth, { ...base, link: 'not a link' })).body.errors[0]
        .code,
    ).toBe('ACA.HW_LINK');
    // English in 6 A: Meena teaches Mathematics only; Ravi, the class teacher, may set any subject.
    expect(
      (await post('/teacher/homework', meena.auth, { ...base, subjectId: english })).body.code,
    ).toBe('ACA.NOT_YOUR_CLASS');
    expect(
      (await post('/teacher/homework', meena.auth, { ...base, studentIds: [ravi.id] })).body
        .errors[0].code,
    ).toBe('ACA.HW_STUDENTS');
    const fileId = await upload(meena.auth);
    const hw = await post('/teacher/homework', meena.auth, { ...base, fileId });
    expect(hw.status, JSON.stringify(hw.body)).toBe(201);
    expect(hw.body).toMatchObject({
      kind: 'HOMEWORK',
      dueDate: due,
      wholeClass: true,
      file: { name: 'worksheet.pdf' },
      counts: { students: 2, reviewed: 0, toReview: 0, notSubmitted: 2 },
    });
    const cw = await post('/teacher/homework', ravi.auth, {
      ...base,
      subjectId: english,
      type: 'CLASSWORK',
      title: 'Letter to the editor',
      instructions: 'Write a 150-word letter about plastic-free campuses.',
      dueDate: istDay(0),
      studentIds: [bala.id],
      link: 'https://example.org/letter-format',
    });
    expect(cw.status, JSON.stringify(cw.body)).toBe(201);
    expect(cw.body).toMatchObject({ wholeClass: false, counts: { students: 1 } });
    const bell = await get('/me/notifications', asha.auth);
    expect(JSON.stringify(bell.body)).toContain('New homework: Integers — worksheet 4');
    const list = await get('/teacher/homework', meena.auth);
    expect(list.body.counts).toMatchObject({ all: 1, homework: 1, review: 0 });
    expect(list.body.choices).toEqual([
      expect.objectContaining({
        section: expect.objectContaining({ label: 'Grade 6 A' }),
        subject: expect.objectContaining({ name: 'Mathematics' }),
      }),
      expect.objectContaining({ section: expect.objectContaining({ label: 'Grade 6 B' }) }),
    ]);
    // Asha sees one pending homework; Bala two (the classwork is only for him).
    expect((await get('/me/homework', asha.auth)).body.counts).toMatchObject({ pending: 1 });
    expect((await get('/me/homework', bala.auth)).body.counts).toMatchObject({
      pending: 2,
      dueToday: 1,
    });
  });

  it('takes one submission per student, reviews it, and reminds the rest', async () => {
    const hw = (await get('/me/homework', asha.auth)).body.items[0] as { id: string };
    const detail = await get(`/me/homework/${hw.id}`, asha.auth);
    expect(detail.body).toMatchObject({
      state: 'PENDING',
      file: { name: 'worksheet.pdf' },
      self: true,
    });
    expect(detail.body.file.url).toMatch(/^\/api\/v1\/files\//);
    expect(
      (await post(`/me/homework/${hw.id}/submissions`, asha.auth, {})).body.errors[0].code,
    ).toBe('ACA.SUBMISSION_EMPTY');
    const fileId = await upload(asha.auth);
    const sub = await post(`/me/homework/${hw.id}/submissions`, asha.auth, {
      fileId,
      note: 'Done',
    });
    expect(sub.status, JSON.stringify(sub.body)).toBe(201);
    expect(sub.body).toMatchObject({
      state: 'SUBMITTED',
      record: 'DONE',
      submission: { late: false },
    });
    expect(
      (
        await post(`/me/homework/${hw.id}/submissions`, asha.auth, {
          link: 'https://example.org/x',
        })
      ).body.code,
    ).toBe('ACA.ALREADY_SUBMITTED');
    // A teacher's profile isn't a student's.
    expect((await get(`/me/homework/${hw.id}`, meena.auth)).body.code).toBe(
      'ACA.NOT_A_STUDENT_PROFILE',
    );

    const subs = await get(`/teacher/homework/${hw.id}/submissions`, meena.auth);
    expect(subs.status, JSON.stringify(subs.body)).toBe(200);
    expect(subs.body.homework.counts).toMatchObject({ toReview: 1, notSubmitted: 1 });
    const row = subs.body.rows.find(
      (r: { student: { name: string } }) => r.student.name === 'Asha Rao',
    );
    expect(row.submission.file.name).toBe('worksheet.pdf');
    expect((await get(`/teacher/homework/${hw.id}/submissions`, sunil.auth)).body.code).toBe(
      'ACA.HW_NOT_FOUND',
    );
    const review = (grade: string, ver: number) =>
      request(f.app)
        .patch(`/api/v1/teacher/submissions/${row.submission.id}`)
        .set(meena.auth)
        .set('If-Match', `"v${ver}"`)
        .send({ grade, feedback: 'Well argued.' });
    expect((await review('', row.submission.version)).body.errors[0].code).toBe('ACA.GRADE');
    const first = await review('A', row.submission.version);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.submission).toMatchObject({ status: 'REVIEWED', grade: 'A' });
    expect((await review('A+', row.submission.version)).status).toBe(412);
    const again = await review('A+', first.body.submission.version);
    expect(again.body.submission.grade).toBe('A+');
    expect((await get('/me/homework?status=REVIEWED', asha.auth)).body.items[0]).toMatchObject({
      state: 'REVIEWED',
      submission: { grade: 'A+', feedback: 'Well argued.' },
    });
    expect(JSON.stringify((await get('/me/notifications', asha.auth)).body)).toContain(
      'Homework reviewed: Integers — worksheet 4',
    );

    const remind = await post(`/teacher/homework/${hw.id}/reminders`, meena.auth);
    expect(remind.status, JSON.stringify(remind.body)).toBe(200);
    expect(remind.body.students).toBe(1);
    expect(JSON.stringify((await get('/me/notifications', bala.auth)).body)).toContain(
      'Reminder: Integers — worksheet 4',
    );
    const today = await get('/teacher/today', meena.auth);
    expect(today.body.homeworkToReview).toBe(0);
  });

  it('shows the member’s calendar for their class, section or themselves', async () => {
    const start = year.endsOn.slice(0, 4) === istDay(0).slice(0, 4) ? istDay(1) : istDay(1);
    const entry = (title: string, audience: object) =>
      console_('post', '/calendar-events', {
        type: 'Event',
        title,
        allDay: true,
        startDate: start,
        endDate: start,
        audience,
      });
    expect((await entry('Sports day', { kind: 'ALL' })).status).toBe(201);
    expect((await entry('Grade 6 A trip', { kind: 'SECTION', ids: [section6A] })).status).toBe(201);
    expect((await entry('Grade 6 B trip', { kind: 'SECTION', ids: [section6B] })).status).toBe(201);
    expect((await entry('Bala’s award', { kind: 'MEMBER', ids: [bala.id] })).status).toBe(201);
    const titles = async (auth: Auth) =>
      ((await get('/me/calendar', auth)).body.items as { title: string }[])
        .map((e) => e.title)
        .sort();
    expect(await titles(asha.auth)).toEqual(['Grade 6 A trip', 'Sports day']);
    expect(await titles(bala.auth)).toEqual(['Bala’s award', 'Grade 6 A trip', 'Sports day']);
    expect(await titles(meena.auth)).toEqual(['Sports day']);
  });
});
