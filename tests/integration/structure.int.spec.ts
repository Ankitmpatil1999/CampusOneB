/**
 * The academic structure on a real MySQL (Phase 7.1; SRS 20.2–20.10, 20.40.1; ACA-004…033; CR-13;
 * BR-52; RC-23):
 * - calendar entries stay inside their year, never twice, repeat as asked, delete and restore;
 * - subjects, the class mapping and the bell schedule keep their rules;
 * - one class teacher per section and year; a timetable never puts a teacher in two places in one
 *   period, nor a lesson on a break;
 * - enrolments: one per year, transfers within the class, a closed year refuses writes and takes a
 *   correction only through a checker; the roll-over is proposed, amended and committed as a whole.
 */
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { adminUrl } from './db';
import { schoolFixture, type Payer } from './school';
import type { Principal } from '../../utils/principal';

describe.skipIf(!adminUrl)('academic structure on real MySQL', () => {
  let f: Awaited<ReturnType<typeof schoolFixture>>;
  let con: Record<string, string>;
  let meena: Payer;
  let ravi: Payer;
  let diya: string;
  let kiran: string;
  let grade6: { id: string; version: number; sections: { id: string; name: string }[] };
  let grade7: { id: string; sections: { id: string; name: string }[] };
  let year: { id: string; label: string; startsOn: string; endsOn: string };
  const send = (
    method: 'post' | 'put' | 'patch' | 'delete',
    path: string,
    body: object = {},
    ver?: number,
  ) => {
    let r = request(f.app)
      [method](`/api/v1/console${path}`)
      .set(con)
      .set('Idempotency-Key', randomUUID());
    if (ver !== undefined) r = r.set('If-Match', `"v${ver}"`);
    return r.send(body);
  };
  const get = (path: string) => request(f.app).get(`/api/v1/console${path}`).set(con);

  beforeAll(async () => {
    f = await schoolFixture('Structure School');
    con = f.school.con;
    meena = await f.payer('Meena', 0);
    ravi = await f.payer('Ravi', 0);
    diya = await f.ward('Diya', '9845011111');
    kiran = await f.ward('Kiran', '9845022222');
    const classes = (await get('/classes')).body.items as (typeof grade6)[];
    const g6 = classes.find((c) => (c as unknown as { name: string }).name === 'Grade 6')!;
    const b = await send('post', `/classes/${g6.id}/sections`, { name: 'B' });
    expect(b.status, JSON.stringify(b.body)).toBe(201);
    grade6 = b.body;
    const g7 = await send('post', '/classes', {
      name: 'Grade 7',
      sections: [{ name: 'A' }, { name: 'B' }],
    });
    expect(g7.status, JSON.stringify(g7.body)).toBe(201);
    grade7 = g7.body;
    year = (await get('/academic-years')).body.items.find((y: { current: boolean }) => y.current);
  }, 240_000);
  afterAll(async () => {
    await f?.t.drop();
  });

  it('keeps calendar entries inside their year, never twice, with repeats, delete and restore', async () => {
    const holiday = {
      type: 'Holiday',
      title: 'Kannada Rajyotsava',
      allDay: true,
      startDate: `${year.startsOn.slice(0, 4)}-11-01`,
      endDate: `${year.startsOn.slice(0, 4)}-11-01`,
      audience: { kind: 'ALL' },
    };
    const a = await send('post', '/calendar-events', holiday);
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    expect(a.body).toMatchObject({
      holidayType: 'Public holiday',
      audience: { kind: 'ALL', targets: [] },
    });
    expect((await send('post', '/calendar-events', holiday)).body.code).toBe('ACA.CAL_DUPLICATE');
    const outside = await send('post', '/calendar-events', {
      ...holiday,
      title: 'Too late',
      startDate: '2099-01-01',
      endDate: '2099-01-01',
    });
    expect(outside.body.errors[0].code).toBe('ACA.DATE_OUTSIDE_YEAR');
    const weekly = await send('post', '/calendar-events', {
      type: 'Meeting',
      title: 'Staff meeting',
      allDay: false,
      startDate: `${year.startsOn.slice(0, 4)}-11-03`,
      endDate: `${year.startsOn.slice(0, 4)}-11-03`,
      startTime: '15:30',
      endTime: '16:30',
      audience: { kind: 'CLASS', ids: [grade7.id] },
      recurrence: 'WEEKLY',
      repeatUntil: `${year.startsOn.slice(0, 4)}-11-24`,
      reminders: ['DAY_BEFORE'],
    });
    expect(weekly.status, JSON.stringify(weekly.body)).toBe(201);
    expect(weekly.body.audience.targets).toEqual([
      expect.objectContaining({ kind: 'CLASS', name: 'Grade 7' }),
    ]);
    const list = await get(
      `/calendar-events?from=${year.startsOn.slice(0, 4)}-11-01&to=${year.startsOn.slice(0, 4)}-11-30`,
    );
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    const meeting = list.body.items.find((e: { title: string }) => e.title === 'Staff meeting');
    expect(meeting.occurrences).toHaveLength(4);
    expect(list.body.counts).toMatchObject({ holidays: 1, holidayDays: 1 });
    const del = await send('delete', `/calendar-events/${a.body.id}`);
    expect(del.body.deleted).not.toBeNull();
    expect(
      (await get('/calendar-events')).body.items.some((e: { id: string }) => e.id === a.body.id),
    ).toBe(false);
    const restored = await send(
      'patch',
      `/calendar-events/${a.body.id}`,
      { restore: true },
      del.body.version,
    );
    expect(restored.status, JSON.stringify(restored.body)).toBe(200);
    expect(restored.body.deleted).toBeNull();
    const csv = `type,title,start_date,end_date,all_day\nHoliday,Christmas,${year.startsOn.slice(0, 4)}-12-25,${year.startsOn.slice(0, 4)}-12-25,Yes\nHoliday,Kannada Rajyotsava,${year.startsOn.slice(0, 4)}-11-01,,Yes\nParade,Bad type,${year.startsOn.slice(0, 4)}-12-01,,Yes\n`;
    const up = (commit: boolean) =>
      request(f.app)
        .post('/api/v1/console/calendar-events/uploads')
        .set(con)
        .set('Idempotency-Key', randomUUID())
        .field('commit', String(commit))
        .attach('file', Buffer.from(csv), 'calendar.csv');
    const check = await up(false);
    expect(check.status, JSON.stringify(check.body)).toBe(200);
    expect(check.body).toMatchObject({ accepted: 1, rejected: 2, imported: 0 });
    expect(check.body.rows.map((r: { code: string | null }) => r.code)).toEqual([
      null,
      'ACA.CAL_DUPLICATE',
      'ACA.CAL_TYPE',
    ]);
    expect((await up(true)).body.imported).toBe(1);
  });

  it('keeps subjects, the class mapping, the bell schedule, assignments and the timetable consistent', async () => {
    const math = await send('post', '/subjects', { code: 'math', name: 'Mathematics' });
    expect(math.status, JSON.stringify(math.body)).toBe(201);
    expect(math.body.code).toBe('MATH');
    expect((await send('post', '/subjects', { code: 'MAT', name: 'mathematics' })).body.code).toBe(
      'ACA.SUBJECT_NAME_TAKEN',
    );
    const eng = await send('post', '/subjects', { code: 'ENG', name: 'English' });
    const mapping = await get(`/classes/${grade7.id}/subjects`);
    const mapped = await send(
      'put',
      `/classes/${grade7.id}/subjects`,
      { subjectIds: [math.body.id, eng.body.id] },
      mapping.body.version,
    );
    expect(mapped.status, JSON.stringify(mapped.body)).toBe(200);
    const bell = await get('/periods');
    const overlap = await send(
      'put',
      '/periods',
      {
        periods: [
          { name: 'Period 1', startsAt: '09:00', endsAt: '09:40', isBreak: false },
          { name: 'Period 2', startsAt: '09:30', endsAt: '10:10', isBreak: false },
        ],
      },
      bell.body.version,
    );
    expect(overlap.body.errors[0].code).toBe('ACA.PERIOD_OVERLAP');
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
    expect(periods.body.summary).toEqual({
      teachingPeriods: 2,
      teachingMinutes: 80,
      breakMinutes: 15,
    });
    const [p1, brk] = periods.body.items as { id: string }[];
    // A saved schedule can be edited again: the kept periods are renamed and swapped in one save.
    const kept = periods.body.items as {
      id: string;
      name: string;
      startsAt: string;
      endsAt: string;
      isBreak: boolean;
    }[];
    const edited = await send(
      'put',
      '/periods',
      {
        periods: [
          { id: kept[0]!.id, name: 'Period 2', startsAt: '09:00', endsAt: '09:40', isBreak: false },
          {
            id: kept[1]!.id,
            name: 'Short break',
            startsAt: '09:40',
            endsAt: '09:55',
            isBreak: true,
          },
          { id: kept[2]!.id, name: 'Period 1', startsAt: '09:55', endsAt: '10:35', isBreak: false },
        ],
      },
      periods.body.version,
    );
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    const back = await send(
      'put',
      '/periods',
      {
        periods: [
          { id: kept[0]!.id, name: 'Period 1', startsAt: '09:00', endsAt: '09:40', isBreak: false },
          {
            id: kept[1]!.id,
            name: 'Short break',
            startsAt: '09:40',
            endsAt: '09:55',
            isBreak: true,
          },
          { id: kept[2]!.id, name: 'Period 2', startsAt: '09:55', endsAt: '10:35', isBreak: false },
        ],
      },
      edited.body.version,
    );
    expect(back.status, JSON.stringify(back.body)).toBe(200);

    const [g7a, g7b] = grade7.sections;
    const ct = await send('post', '/teacher-assignments', {
      kind: 'CLASS_TEACHER',
      teacherId: meena.id,
      sectionIds: [g7a!.id],
    });
    expect(ct.status, JSON.stringify(ct.body)).toBe(201);
    expect(
      (
        await send('post', '/teacher-assignments', {
          kind: 'CLASS_TEACHER',
          teacherId: ravi.id,
          sectionIds: [g7a!.id],
        })
      ).body.code,
    ).toBe('ACA.CLASS_TEACHER_TAKEN');
    const replaced = await send('post', '/teacher-assignments', {
      kind: 'CLASS_TEACHER',
      teacherId: ravi.id,
      sectionIds: [g7a!.id],
      replace: true,
    });
    expect(replaced.status).toBe(201);
    expect(
      replaced.body.classTeachers.find((c: { section: { id: string } }) => c.section.id === g7a!.id)
        .assignment.teacher.name,
    ).toBe('Ravi');
    const notMapped = await send('post', '/teacher-assignments', {
      kind: 'SUBJECT_TEACHER',
      teacherId: meena.id,
      subjectId: math.body.id,
      sectionIds: [grade6.sections[0]!.id],
    });
    expect(notMapped.body.code).toBe('ACA.SUBJECT_NOT_MAPPED');
    const st = await send('post', '/teacher-assignments', {
      kind: 'SUBJECT_TEACHER',
      teacherId: meena.id,
      subjectId: math.body.id,
      sectionIds: [g7a!.id, g7b!.id],
    });
    expect(st.status, JSON.stringify(st.body)).toBe(201);
    expect(st.body.subjectTeachers).toHaveLength(2);
    expect(st.body.combinedTeachers).toBe(0);

    const ttA = await get(`/timetables/${g7a!.id}`);
    expect(
      ttA.body.subjects.find((s: { name: string }) => s.name === 'Mathematics').teachers,
    ).toEqual([expect.objectContaining({ name: 'Meena' })]);
    const onBreak = await send(
      'put',
      `/timetables/${g7a!.id}`,
      { slots: [{ day: 1, periodId: brk!.id, subjectId: math.body.id, teacherId: meena.id }] },
      ttA.body.version,
    );
    expect(onBreak.body.errors[0].code).toBe('ACA.BREAK_PERIOD');
    const savedA = await send(
      'put',
      `/timetables/${g7a!.id}`,
      { slots: [{ day: 1, periodId: p1!.id, subjectId: math.body.id, teacherId: meena.id }] },
      ttA.body.version,
    );
    expect(savedA.status, JSON.stringify(savedA.body)).toBe(200);
    expect(savedA.body.slots).toHaveLength(1);
    const ttB = await get(`/timetables/${g7b!.id}`);
    const clash = await send(
      'put',
      `/timetables/${g7b!.id}`,
      { slots: [{ day: 1, periodId: p1!.id, subjectId: math.body.id, teacherId: meena.id }] },
      ttB.body.version,
    );
    expect(clash.status).toBe(409);
    expect(clash.body).toMatchObject({
      code: 'ACA.TEACHER_CLASH',
      params: { section: 'Grade 7 A' },
    });
    expect(
      (await send('put', `/timetables/${g7a!.id}`, { slots: [] }, ttA.body.version)).status,
    ).toBe(412);
    // A subject on the timetable can't be unmapped; a timetabled teacher can't be withdrawn.
    const m2 = await get(`/classes/${grade7.id}/subjects`);
    expect(
      (
        await send(
          'put',
          `/classes/${grade7.id}/subjects`,
          { subjectIds: [eng.body.id] },
          m2.body.version,
        )
      ).body.code,
    ).toBe('ACA.SUBJECT_TIMETABLED');
    const assignA = st.body.subjectTeachers.find(
      (a: { section: { id: string } }) => a.section.id === g7a!.id,
    );
    expect((await send('delete', `/teacher-assignments/${assignA.id}`)).body.code).toBe(
      'ACA.ASSIGNMENT_TIMETABLED',
    );
    const week = await get(`/timetables/clashes?teacherId=${meena.id}`);
    expect(week.body).toMatchObject({
      clashes: [],
      teacherWeek: [expect.objectContaining({ day: 1 })],
    });
  });

  it('transfers within the class, refuses a closed year and corrects it only through a checker', async () => {
    const list = await get('/enrolments');
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    const diyaEn = list.body.items.find((e: { student: { id: string } }) => e.student.id === diya);
    expect(diyaEn).toMatchObject({ class: { name: 'Grade 6' }, section: { name: 'A' } });
    const again = await send('post', '/enrolments', {
      studentId: diya,
      sectionId: grade6.sections[0]!.id,
    });
    expect(again.body.code).toBe('ACA.ALREADY_ENROLLED');
    const g6b = grade6.sections.find((s) => s.name === 'B')!;
    const across = await send('post', `/enrolments/${diyaEn.id}/transfers`, {
      sectionId: grade7.sections[0]!.id,
      effectiveOn: year.startsOn,
      reason: 'Wrong class',
    });
    expect(across.body.errors[0].code).toBe('ACA.TRANSFER_SAME_CLASS');
    const moved = await send('post', `/enrolments/${diyaEn.id}/transfers`, {
      sectionId: g6b.id,
      effectiveOn: year.startsOn,
      reason: 'Balancing sections',
    });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(moved.body.section.name).toBe('B');
    expect(moved.body.history.map((h: { kind: string }) => h.kind)).toEqual(['TRANSFERRED']);

    // A past year, closed: writes refused; a correction waits for a checker.
    const start = Number(year.startsOn.slice(0, 4)) - 1;
    const past = await send('post', '/academic-years', {
      label: `${start}-${String((start + 1) % 100).padStart(2, '0')}`,
      startsOn: `${start}-04-01`,
      endsOn: `${start + 1}-03-31`,
    });
    expect(past.status, JSON.stringify(past.body)).toBe(201);
    const old = await send('post', '/enrolments', {
      yearId: past.body.id,
      studentId: kiran,
      sectionId: grade6.sections[0]!.id,
      enrolledOn: `${start}-06-01`,
    });
    expect(old.status, JSON.stringify(old.body)).toBe(201);
    expect(
      (
        await send('post', `/academic-years/${past.body.id}/status`, {
          action: 'CLOSE',
          reason: 'Year ended and checked',
        })
      ).status,
    ).toBe(200);
    const blocked = await send('post', `/enrolments/${old.body.id}/transfers`, {
      sectionId: g6b.id,
      effectiveOn: `${start}-07-01`,
      reason: 'Late change',
    });
    expect(blocked.body).toMatchObject({
      code: 'ACA.YEAR_CLOSED',
      params: { label: past.body.label },
    });
    const open = await send('post', '/closed-year-corrections', {
      enrolmentId: moved.body.id,
      sectionId: grade6.sections[0]!.id,
      reason: 'This year is still open',
    });
    expect(open.body.code).toBe('ACA.YEAR_STILL_OPEN');
    const s = (await request(f.app).get('/api/v1/ops/settings').set(f.ops)).body.items.find(
      (x: { key: string }) => x.key === 'mkr.adminSelfApply',
    );
    const off = await request(f.app)
      .put('/api/v1/ops/settings/mkr.adminSelfApply')
      .set(f.ops)
      .set('If-Match', `"v${s.version}"`)
      .send({ value: 0, reason: 'Correction checker path' });
    try {
      const sent = await send('post', '/closed-year-corrections', {
        enrolmentId: old.body.id,
        sectionId: g6b.id,
        reason: 'Recorded in the wrong section last year',
      });
      expect(sent.status, JSON.stringify(sent.body)).toBe(202);
      expect(sent.body.enrolment.correctionPending).toBe(sent.body.approvalId);
      expect(
        (
          await send('post', '/closed-year-corrections', {
            enrolmentId: old.body.id,
            sectionId: g6b.id,
            reason: 'Asking a second time',
          })
        ).body.code,
      ).toBe('ACA.CORRECTION_PENDING');
      const checker: Principal = {
        subject: randomUUID(),
        surface: 'console',
        sessionId: randomUUID(),
        institutionId: f.school.id,
        subTasks: ['approvals.decide', 'approvals.view'],
      };
      const a = await f.h.services.approvals.detail(checker, 'console', sent.body.approvalId);
      expect(a.changes).toEqual([
        { label: `Class-section · ${past.body.label}`, from: 'Grade 6 A', to: 'Grade 6 B' },
      ]);
      await f.h.services.approvals.decide(checker, 'console', sent.body.approvalId, a.version, {
        decision: 'APPROVE',
        remarks: 'Register checked',
      });
      const after = await get(`/enrolments?yearId=${past.body.id}`);
      const k = after.body.items.find((e: { id: string }) => e.id === old.body.id);
      expect(k).toMatchObject({ section: { name: 'B' }, correctionPending: null });
      expect(after.body.year.closed).toBe(true);
    } finally {
      await request(f.app)
        .put('/api/v1/ops/settings/mkr.adminSelfApply')
        .set(f.ops)
        .set('If-Match', `"v${off.body.version}"`)
        .send({ value: 1, reason: 'Back to the default' });
    }
  });

  it('proposes the roll-over from the class order, takes amendments and commits it as a whole', async () => {
    const nextStart = Number(year.endsOn.slice(0, 4));
    expect((await get('/rollover-proposals')).body.code).toBe('ACA.NEXT_YEAR_NEEDED');
    const next = await send('post', '/academic-years', {
      label: `${nextStart}-${String((nextStart + 1) % 100).padStart(2, '0')}`,
      startsOn: `${nextStart}-04-01`,
      endsOn: `${nextStart + 1}-03-31`,
    });
    expect(next.status, JSON.stringify(next.body)).toBe(201);
    const prop = await get('/rollover-proposals');
    expect(prop.status, JSON.stringify(prop.body)).toBe(200);
    expect(prop.body).toMatchObject({
      status: 'PROPOSED',
      from: { label: year.label },
      to: { label: next.body.label },
    });
    const d = prop.body.items.find((i: { student: { id: string } }) => i.student.id === diya);
    expect(d).toMatchObject({ outcome: 'PROMOTED', from: 'Grade 6 B', to: { label: 'Grade 7 B' } });
    const amended = await send(
      'patch',
      `/rollover-proposals/${prop.body.id}/items/${kiran}`,
      { outcome: 'REPEATED', sectionId: grade6.sections[0]!.id },
      prop.body.version,
    );
    expect(amended.status, JSON.stringify(amended.body)).toBe(200);
    expect(amended.body.counts).toMatchObject({ repeated: 1 });
    const bad = await send(
      'patch',
      `/rollover-proposals/${prop.body.id}/items/${kiran}`,
      { outcome: 'REPEATED', sectionId: grade7.sections[0]!.id },
      amended.body.version,
    );
    expect(bad.body.errors[0].code).toBe('ACA.ROLLOVER_SECTION');
    const done = await send(
      'post',
      `/rollover-proposals/${prop.body.id}/commit`,
      {},
      amended.body.version,
    );
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.status).toBe('COMMITTED');
    const nextList = await get(`/enrolments?yearId=${next.body.id}`);
    expect(
      nextList.body.items.find((e: { student: { id: string } }) => e.student.id === diya),
    ).toMatchObject({ class: { name: 'Grade 7' }, outcome: 'PROMOTED' });
    expect(
      nextList.body.items.find((e: { student: { id: string } }) => e.student.id === kiran),
    ).toMatchObject({ class: { name: 'Grade 6' }, outcome: 'REPEATED' });
    // This year's records stay as they were (RNG-ACA-445).
    const thisYear = await get('/enrolments');
    expect(
      thisYear.body.items.find((e: { student: { id: string } }) => e.student.id === diya).class
        .name,
    ).toBe('Grade 6');
    expect(
      (await send('post', `/rollover-proposals/${prop.body.id}/commit`, {}, done.body.version)).body
        .code,
    ).toBe('ACA.ROLLOVER_COMMITTED');
  });
});
