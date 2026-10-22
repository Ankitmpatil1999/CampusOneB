/**
 * The class-teacher, subject-teacher and timetable sheets on a real MySQL (client 2026-10-21; SRS
 * 20.7–20.8; ACA-083…086):
 * - templates list the year as it is, a teacher by employee ID or mobile number;
 * - a check saves nothing; a commit saves the accepted rows; the same sheet again changes nothing;
 * - class teachers: taken sections need replace, one class-section per teacher once the sheet is
 *   applied (so two teachers can swap sections in one sheet);
 * - subject teachers: only mapped subjects, existing assignments left as they are;
 * - timetables: each section gets exactly the sheet's week, a section with a refused row is skipped
 *   whole, and no teacher is in two places in one period of the year.
 */
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { adminUrl } from './db';
import { schoolFixture, type Payer } from './school';

interface SheetRow {
  row: number;
  accepted: boolean;
  outcome: string | null;
  code: string | null;
  params: Record<string, string>;
  teacherName: string | null;
}

describe.skipIf(!adminUrl)('teacher-assignment and timetable sheets on real MySQL', () => {
  let f: Awaited<ReturnType<typeof schoolFixture>>;
  let con: Record<string, string>;
  let meena: Payer;
  let ravi: Payer;
  let pupil: Payer;
  let g8: { id: string; sections: { id: string; name: string }[] };
  const send = (method: 'post' | 'put', path: string, body: object = {}, ver?: number) => {
    let r = request(f.app)
      [method](`/api/v1/console${path}`)
      .set(con)
      .set('Idempotency-Key', randomUUID());
    if (ver !== undefined) r = r.set('If-Match', `"v${ver}"`);
    return r.send(body);
  };
  const get = (path: string) => request(f.app).get(`/api/v1/console${path}`).set(con);
  const sheet = (path: string, csv: string, fields: Record<string, string>) => {
    let r = request(f.app)
      .post(`/api/v1/console${path}`)
      .set(con)
      .set('Idempotency-Key', randomUUID());
    for (const [k, v] of Object.entries(fields)) r = r.field(k, v);
    return r.attach('file', Buffer.from(csv), 'sheet.csv');
  };
  const codes = (rows: SheetRow[]) => rows.map((r) => r.code ?? r.outcome);
  const section = (name: string) => g8.sections.find((s) => s.name === name)!.id;
  const classTeachers = async () =>
    (
      (await get('/teacher-assignments?kind=CLASS_TEACHER')).body.classTeachers as {
        section: { id: string };
        assignment: { teacher: { name: string } } | null;
      }[]
    )
      .filter((c) => g8.sections.some((s) => s.id === c.section.id))
      .map((c) => [
        g8.sections.find((s) => s.id === c.section.id)!.name,
        c.assignment?.teacher.name,
      ])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])));

  beforeAll(async () => {
    f = await schoolFixture('Sheets School');
    con = f.school.con;
    meena = await f.payer('Meena', 0);
    ravi = await f.payer('Ravi', 0);
    pupil = await f.student('Pupil');
    // Meena is named by her employee ID, Ravi by his mobile number.
    await f.t.db
      .updateTable('member_profiles')
      .set({ employee_no: 'T-100' })
      .where('id', '=', meena.rowId)
      .execute();
    const c8 = await send('post', '/classes', {
      name: 'Grade 8',
      sections: [{ name: 'A' }, { name: 'B' }, { name: 'C' }],
    });
    expect(c8.status, JSON.stringify(c8.body)).toBe(201);
    g8 = c8.body;
    expect(
      (await send('post', '/classes', { name: 'Grade 9', sections: [{ name: 'A' }] })).status,
    ).toBe(201);
    const math = await send('post', '/subjects', { code: 'MATH', name: 'Mathematics' });
    const eng = await send('post', '/subjects', { code: 'ENG', name: 'English' });
    const mapping = await get(`/classes/${g8.id}/subjects`);
    const mapped = await send(
      'put',
      `/classes/${g8.id}/subjects`,
      { subjectIds: [math.body.id, eng.body.id] },
      mapping.body.version,
    );
    expect(mapped.status, JSON.stringify(mapped.body)).toBe(200);
    const bell = await get('/periods');
    const periods = await send(
      'put',
      '/periods',
      {
        periods: [
          { name: 'Period 1', startsAt: '09:00', endsAt: '09:40', isBreak: false },
          { name: 'Short break', startsAt: '09:40', endsAt: '09:55', isBreak: true },
          { name: 'Period 2', startsAt: '09:55', endsAt: '10:35', isBreak: false },
        ],
      },
      bell.body.version,
    );
    expect(periods.status, JSON.stringify(periods.body)).toBe(200);
  }, 240_000);
  afterAll(async () => {
    await f?.t.drop();
  });

  it('checks, saves and swaps class teachers with the screen’s rules', async () => {
    const template = await get('/teacher-assignments/uploads/template?kind=CLASS_TEACHER');
    expect(template.status).toBe(200);
    expect(template.headers['content-type']).toContain('text/csv');
    expect(template.text).toContain('class,section,teacher,teacher_name');
    expect(template.text).toContain('Grade 8,A,,');

    expect(
      (
        await sheet('/teacher-assignments/uploads', 'class,teacher\r\nGrade 8,T-100\r\n', {
          kind: 'CLASS_TEACHER',
          commit: 'false',
        })
      ).body.errors[0].code,
    ).toBe('UPL.HEADER_MISMATCH');

    const csv = [
      'class,section,teacher,teacher_name',
      'Grade 8,A,t-100,Meena',
      `Grade 8,B,+91 ${ravi.mobile},Ravi`,
      'Grade 8,C,T-100,Meena again',
      'Grade 8,C,,',
      'Grade 10,A,T-100,',
      'Grade 8,D,T-100,',
      `Grade 8,C,${pupil.mobile},A student`,
      'Grade 8,C,EMP-404,Nobody',
    ].join('\r\n');
    const check = await sheet('/teacher-assignments/uploads', csv, {
      kind: 'CLASS_TEACHER',
      commit: 'false',
    });
    expect(check.status, JSON.stringify(check.body)).toBe(200);
    expect(check.body).toMatchObject({ committed: false, created: 2, replaced: 0, unchanged: 1 });
    expect(codes(check.body.rows)).toEqual([
      'NEW',
      'NEW',
      'ACA.CLASS_TEACHER_ONE_CLASS',
      'UNCHANGED',
      'UPL.CLASS_UNKNOWN',
      'UPL.SECTION_UNKNOWN',
      'ACA.NOT_A_TEACHER',
      'UPL.TEACHER_UNKNOWN',
    ]);
    expect(check.body.rows[0].teacherName).toBe('Meena');
    expect(check.body.rows[2].params).toMatchObject({ name: 'Meena', section: 'Grade 8 A' });
    expect(await classTeachers()).toEqual([
      ['A', undefined],
      ['B', undefined],
      ['C', undefined],
    ]);

    const saved = await sheet('/teacher-assignments/uploads', csv, {
      kind: 'CLASS_TEACHER',
      commit: 'true',
    });
    expect(saved.body).toMatchObject({ committed: true, created: 2 });
    expect(await classTeachers()).toEqual([
      ['A', 'Meena'],
      ['B', 'Ravi'],
      ['C', undefined],
    ]);

    // Swapping needs replace; then both moves are checked against the year as the sheet leaves it.
    const swap = ['class,section,teacher', `Grade 8,A,${ravi.mobile}`, 'Grade 8,B,T-100'].join(
      '\n',
    );
    const taken = await sheet('/teacher-assignments/uploads', swap, {
      kind: 'CLASS_TEACHER',
      commit: 'true',
    });
    expect(codes(taken.body.rows)).toEqual(['ACA.CLASS_TEACHER_TAKEN', 'ACA.CLASS_TEACHER_TAKEN']);
    expect(taken.body.created).toBe(0);
    const swapped = await sheet('/teacher-assignments/uploads', swap, {
      kind: 'CLASS_TEACHER',
      replace: 'true',
      commit: 'true',
    });
    expect(swapped.body).toMatchObject({ created: 2, replaced: 2, rejected: 0 });
    expect(await classTeachers()).toEqual([
      ['A', 'Ravi'],
      ['B', 'Meena'],
      ['C', undefined],
    ]);
    // Moving Meena to C while she keeps B is refused; the sheet as uploaded again changes nothing.
    const again = await sheet('/teacher-assignments/uploads', `${swap}\nGrade 8,C,T-100`, {
      kind: 'CLASS_TEACHER',
      replace: 'true',
      commit: 'true',
    });
    expect(codes(again.body.rows)).toEqual([
      'UNCHANGED',
      'UNCHANGED',
      'ACA.CLASS_TEACHER_ONE_CLASS',
    ]);
    expect(again.body.created).toBe(0);
  });

  it('adds subject teachers for mapped subjects only, leaving existing ones as they are', async () => {
    const template = await get('/teacher-assignments/uploads/template?kind=SUBJECT_TEACHER');
    expect(template.text).toContain('class,sections,subject,teacher,teacher_name');
    expect(template.text).toContain('Grade 8,"A, B, C",Mathematics,,');

    const csv = [
      'class,sections,subject,teacher',
      'Grade 8,"A, B",MATH,T-100',
      `Grade 8,C,english,${ravi.mobile}`,
      'Grade 8,A,Science,T-100',
      'Grade 9,A,MATH,T-100',
      'Grade 8,"b, a",Mathematics,T-100',
      'Grade 8,,MATH,T-100',
    ].join('\n');
    const saved = await sheet('/teacher-assignments/uploads', csv, {
      kind: 'SUBJECT_TEACHER',
      commit: 'true',
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(codes(saved.body.rows)).toEqual([
      'NEW',
      'NEW',
      'UPL.SUBJECT_UNKNOWN',
      'ACA.SUBJECT_NOT_MAPPED',
      'ACA.ROW_REPEATED',
      'UPL.SECTION_REQUIRED',
    ]);
    expect(saved.body.created).toBe(3);
    const list = await get('/teacher-assignments?kind=SUBJECT_TEACHER');
    expect(list.body.subjectTeachers).toHaveLength(3);
    const twice = await sheet(
      '/teacher-assignments/uploads',
      csv.split('\n').slice(0, 3).join('\n'),
      {
        kind: 'SUBJECT_TEACHER',
        commit: 'true',
      },
    );
    expect(codes(twice.body.rows)).toEqual(['UNCHANGED', 'UNCHANGED']);
    expect(twice.body.created).toBe(0);
  });

  it('replaces each section’s week whole, skips a section with a refused row and finds clashes', async () => {
    const template = await get('/timetables/uploads/template');
    expect(template.text).toContain('class,section,day,period,subject,teacher,teacher_name');
    expect(template.text).toContain('Grade 8,A,Monday,Period 1,,,');
    expect(template.text).not.toContain('Short break');

    const csv = [
      'class,section,day,period,subject,teacher',
      'Grade 8,A,Monday,Period 1,MATH,T-100',
      'Grade 8,A,mon,Period 2,,',
      'Grade 8,B,1,Period 1,Mathematics,T-100',
      'Grade 8,B,Tuesday,Period 2,MATH,T-100',
      `Grade 8,C,Monday,Short break,English,${ravi.mobile}`,
      `Grade 8,C,Funday,Period 1,English,${ravi.mobile}`,
      'Grade 8,C,Tuesday,Period 1,English,',
    ].join('\n');
    const check = await sheet('/timetables/uploads', csv, { commit: 'false' });
    expect(check.status, JSON.stringify(check.body)).toBe(200);
    expect(check.body).toMatchObject({ sections: 1, skippedSections: 2, lessons: 1 });
    expect(codes(check.body.rows)).toEqual([
      'LESSON',
      'FREE',
      'ACA.TEACHER_CLASH',
      'UPL.SECTION_SKIPPED',
      'ACA.BREAK_PERIOD',
      'UPL.DAY_UNKNOWN',
      'UPL.LESSON_INCOMPLETE',
    ]);
    expect(check.body.rows[2].params).toMatchObject({ name: 'Meena', section: 'Grade 8 A' });
    expect((await get(`/timetables/${section('A')}`)).body.slots).toHaveLength(0);

    const saved = await sheet('/timetables/uploads', csv, { commit: 'true' });
    expect(saved.body).toMatchObject({ committed: true, sections: 1, lessons: 1 });
    expect((await get(`/timetables/${section('A')}`)).body.slots).toEqual([
      expect.objectContaining({ day: 1, teacher: expect.objectContaining({ name: 'Meena' }) }),
    ]);
    expect((await get(`/timetables/${section('B')}`)).body.slots).toHaveLength(0);

    // Meena's Monday first period moves from A to B in one sheet: no clash once it is applied.
    const move = [
      'class,section,day,period,subject,teacher',
      'Grade 8,A,Monday,Period 1,,',
      'Grade 8,B,Monday,Period 1,MATH,T-100',
      'Grade 8,C,Tuesday,Period 1,English,T-100',
    ].join('\n');
    const moved = await sheet('/timetables/uploads', move, { commit: 'true' });
    expect(codes(moved.body.rows)).toEqual(['FREE', 'LESSON', 'ACA.TEACHER_NOT_ASSIGNED']);
    expect(moved.body).toMatchObject({ sections: 2, skippedSections: 1 });
    expect((await get(`/timetables/${section('A')}`)).body.slots).toHaveLength(0);
    expect((await get(`/timetables/${section('B')}`)).body.slots).toHaveLength(1);
    // A section not in the sheet keeps its week and still takes its teacher.
    const clash = await sheet(
      '/timetables/uploads',
      'class,section,day,period,subject,teacher\nGrade 8,A,Monday,Period 1,MATH,T-100\n',
      { commit: 'true' },
    );
    expect(codes(clash.body.rows)).toEqual(['ACA.TEACHER_CLASH']);
    expect(clash.body.rows[0].params).toMatchObject({ section: 'Grade 8 B' });
    expect((await get(`/timetables/${section('B')}`)).body.slots).toHaveLength(1);
  });
});
