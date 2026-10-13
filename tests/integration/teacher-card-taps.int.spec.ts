/**
 * The teacher's own card reader on the web (client 2026-10-13; ATT-028), on a real MySQL:
 * - DAILY: a student of the class teacher's section taps → Present by card (method NFC, the teacher as
 *   the actor), shown in the register; again → ALREADY; a recorded Absent becomes Present with
 *   old → new kept; a member not in the class, an unknown card, a second tap too soon, a teacher who
 *   isn't a class teacher are refused;
 * - PERIOD: a student of the teacher's running period → Present or Late, counted for the period;
 *   again → ALREADY; another teacher's period and a period not running now are refused.
 */
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { adminUrl } from './db';
import { schoolFixture, type Auth, type Payer } from './school';
import { newPublicIdPair, uuidToBin } from '../../utils/idGenerator';

const IST = { timeZone: 'Asia/Kolkata' } as const;
const today = () => new Intl.DateTimeFormat('en-CA', IST).format(new Date());
const istMinutes = () => {
  const [h, m] = new Intl.DateTimeFormat('en-GB', {
    ...IST,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
    .format(new Date())
    .split(':')
    .map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};
const hhmm = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}:00`;

describe.skipIf(!adminUrl)("the teacher's card reader on the web (ATT-028)", () => {
  let f: Awaited<ReturnType<typeof schoolFixture>>;
  let con: Record<string, string>;
  let ravi: Payer; // class teacher of 6 A
  let meena: Payer; // subject teacher (periods only)
  let asha: { id: string; rowId: string };
  let bala: { id: string; rowId: string };
  let section6A = '';
  let scienceId = '';
  let grade6 = '';
  const cards: Record<string, string> = {};
  const post = (path: string, auth: Auth, body: object = {}) =>
    request(f.app).post(`/api/v1${path}`).set(auth).set('Idempotency-Key', randomUUID()).send(body);
  const put = (path: string, auth: Auth, body: object) =>
    request(f.app).put(`/api/v1${path}`).set(auth).send(body);
  const get = (path: string, auth: Auth) => request(f.app).get(`/api/v1${path}`).set(auth);
  const tap = (auth: Auth, body: object) => post('/teacher/attendance/card-taps', auth, body);
  /** Lets the next tap of a card through the double-tap guard. */
  const wait = (profileRowId: string) =>
    f.t.db
      .updateTable('cards')
      .set({ last_tap_at: new Date(Date.now() - 5 * 60_000) })
      .where('profile_id', '=', profileRowId)
      .execute();

  /** A period of 6 A today, taught by Meena, from `start` to `end` (minutes since midnight, IST). */
  async function period(name: string, start: number, end: number) {
    const inst = String(f.school.rowId);
    const pid = newPublicIdPair();
    const p = await f.t.db
      .insertInto('periods')
      .values({
        public_id: pid.bin,
        institution_id: inst,
        name,
        starts_at: hhmm(start),
        ends_at: hhmm(end),
        is_break: 0,
      })
      .executeTakeFirstOrThrow();
    const sec = await f.t.db
      .selectFrom('sections')
      .select('id')
      .where('public_id', '=', uuidToBin(section6A))
      .executeTakeFirstOrThrow();
    const sub = await f.t.db
      .selectFrom('subjects')
      .select('id')
      .where('institution_id', '=', inst)
      .executeTakeFirstOrThrow();
    const year = await f.t.db
      .selectFrom('academic_years')
      .select('id')
      .where('institution_id', '=', inst)
      .where('is_current', '=', 1)
      .executeTakeFirstOrThrow();
    const wd = new Date(`${today()}T00:00:00Z`).getUTCDay();
    await f.t.db
      .insertInto('timetable_slots')
      .values({
        institution_id: inst,
        year_id: String(year.id),
        section_id: String(sec.id),
        day: wd === 0 ? 7 : wd,
        period_id: String(p.insertId),
        subject_id: String(sub.id),
        teacher_profile_id: meena.rowId,
        updated_at: new Date(),
      })
      .execute();
    return `${section6A}.${pid.id}`;
  }

  beforeAll(async () => {
    f = await schoolFixture('Card Register School');
    con = f.school.con;
    ravi = await f.payer('Ravi', 0);
    meena = await f.payer('Meena', 0);
    asha = await f.student('Asha');
    bala = await f.student('Bala');
    const classes = (await get('/console/classes', con)).body.items as {
      id: string;
      name: string;
      sections: { id: string }[];
    }[];
    const g6 = classes.find((c) => c.name === 'Grade 6')!;
    grade6 = g6.id;
    section6A = g6.sections[0]!.id;
    expect(
      (
        await post('/console/teacher-assignments', con, {
          kind: 'CLASS_TEACHER',
          teacherId: ravi.id,
          sectionIds: [section6A],
        })
      ).status,
    ).toBe(201);
    const sci = await post('/console/subjects', con, { code: 'SCI', name: 'Science' });
    expect(sci.status).toBe(201);
    scienceId = sci.body.id as string;
    cards['asha'] = await f.card(asha.rowId);
    cards['bala'] = await f.card(bala.rowId);
    cards['meena'] = await f.card(meena.rowId);
  }, 240_000);
  afterAll(async () => {
    await f?.t.drop();
  });

  it('marks the class teacher’s daily register by card', async () => {
    const first = await tap(ravi.auth, {
      cardToken: cards['asha'],
      mode: 'DAILY',
      classSectionId: section6A,
    });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body).toMatchObject({
      result: 'MARKED',
      status: 'PRESENT',
      student: { id: asha.id, name: expect.stringMatching(/Asha/) },
    });
    // Too soon, then already recorded.
    expect((await tap(ravi.auth, { cardToken: cards['asha'], mode: 'DAILY' })).body.code).toBe(
      'ATT.DOUBLE_TAP',
    );
    await wait(asha.rowId);
    expect((await tap(ravi.auth, { cardToken: cards['asha'], mode: 'DAILY' })).body).toMatchObject({
      result: 'ALREADY',
      status: 'PRESENT',
    });

    // The register shows it as a card tap.
    const reg = await get('/teacher/attendance/register', ravi.auth);
    const row = reg.body.items.find((x: { student: { id: string } }) => x.student.id === asha.id);
    expect(row).toMatchObject({ status: 'PRESENT', method: 'NFC' });

    // A recorded Absent becomes Present; old → new is kept.
    expect(
      (
        await put('/teacher/attendance/register', ravi.auth, {
          classSectionId: section6A,
          date: today(),
          entries: [{ studentId: bala.id, status: 'ABSENT' }],
        })
      ).status,
    ).toBe(200);
    const back = await tap(ravi.auth, { cardToken: cards['bala'], mode: 'DAILY' });
    expect(back.body).toMatchObject({ result: 'MARKED', status: 'PRESENT' });
    const events = await f.t.db
      .selectFrom('attendance_events as e')
      .innerJoin('attendance_days as d', 'd.id', 'e.day_id')
      .select(['e.action', 'e.old_status', 'e.new_status', 'e.actor', 'd.method'])
      .where('d.profile_id', '=', bala.rowId)
      .orderBy('e.id')
      .execute();
    expect(events.at(-1)).toMatchObject({
      action: 'CHECK-IN',
      old_status: 'ABSENT',
      new_status: 'PRESENT',
      method: 'NFC',
    });
    expect(events.at(-1)!.actor).not.toBeNull();

    // Refusals: not in the class, an unknown card, not a class teacher.
    expect((await tap(ravi.auth, { cardToken: cards['meena'], mode: 'DAILY' })).body.code).toBe(
      'ATT.NOT_IN_CLASS',
    );
    expect((await tap(ravi.auth, { cardToken: 'NFCNOSUCHCARD01', mode: 'DAILY' })).body.code).toBe(
      'ATT.CARD_NOT_ACTIVE',
    );
    await wait(asha.rowId);
    expect((await tap(meena.auth, { cardToken: cards['asha'], mode: 'DAILY' })).body.code).toBe(
      'ATT.NO_CLASSES',
    );
  });

  it('lets a subject teacher of the class record the day for a student who missed the gate', async () => {
    const chitra = await f.student('Chitra');
    const chitraCard = await f.card(chitra.rowId);
    // Not assigned to 6 A yet.
    expect(
      (await tap(meena.auth, { cardToken: chitraCard, mode: 'DAILY', classSectionId: section6A }))
        .body.code,
    ).toBe('ACA.NOT_ASSIGNED');
    const mapping = await get(`/console/classes/${grade6}/subjects`, con);
    expect(
      (
        await request(f.app)
          .put(`/api/v1/console/classes/${grade6}/subjects`)
          .set(con)
          .set('If-Match', `"v${mapping.body.version}"`)
          .send({ subjectIds: [scienceId] })
      ).status,
    ).toBe(200);
    expect(
      (
        await post('/console/teacher-assignments', con, {
          kind: 'SUBJECT_TEACHER',
          teacherId: meena.id,
          subjectId: scienceId,
          sectionIds: [section6A],
        })
      ).status,
    ).toBe(201);
    await wait(chitra.rowId);
    const r = await tap(meena.auth, {
      cardToken: chitraCard,
      mode: 'DAILY',
      classSectionId: section6A,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({
      result: 'MARKED',
      status: 'PRESENT',
      student: { id: chitra.id },
    });
    const day = await f.t.db
      .selectFrom('attendance_days')
      .select(['status', 'method', 'terminal_id'])
      .where('profile_id', '=', chitra.rowId)
      .executeTakeFirstOrThrow();
    expect(day).toMatchObject({ status: 'PRESENT', method: 'NFC', terminal_id: null });
    // Any time of the day, not only during a period; a student marked at the gate stays as is.
    await wait(asha.rowId);
    expect(
      (
        await tap(meena.auth, {
          cardToken: cards['asha'],
          mode: 'DAILY',
          classSectionId: section6A,
        })
      ).body,
    ).toMatchObject({ result: 'ALREADY', status: 'PRESENT' });
  });

  it('records a running period by card, and refuses other periods', async () => {
    const now = istMinutes();
    const start = Math.max(0, now - 5);
    const running = await period('Period C', start, Math.min(23 * 60 + 59, now + 30));
    await wait(asha.rowId);
    const first = await tap(meena.auth, {
      cardToken: cards['asha'],
      mode: 'PERIOD',
      slotId: running,
    });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body).toMatchObject({
      result: 'MARKED',
      status: now > start ? 'LATE' : 'PRESENT',
      student: { id: asha.id },
    });
    await wait(asha.rowId);
    expect(
      (await tap(meena.auth, { cardToken: cards['asha'], mode: 'PERIOD', slotId: running })).body
        .result,
    ).toBe('ALREADY');
    const mine = await get('/teacher/attendance/periods', meena.auth);
    expect(mine.body.items.find((x: { slotId: string }) => x.slotId === running).captured).toBe(1);
    const stored = await f.t.db
      .selectFrom('period_attendance')
      .select(['method', 'terminal_id', 'marked_by'])
      .where('profile_id', '=', asha.rowId)
      .executeTakeFirstOrThrow();
    expect(stored).toMatchObject({ method: 'NFC', terminal_id: null });
    expect(stored.marked_by).not.toBeNull();

    // Another teacher's period; a period that isn't running now.
    await wait(bala.rowId);
    expect(
      (await tap(ravi.auth, { cardToken: cards['bala'], mode: 'PERIOD', slotId: running })).body
        .code,
    ).toBe('ATT.NOT_YOUR_PERIOD');
    const later =
      now < 20 * 60
        ? await period('Period L', now + 60, now + 90)
        : await period('Period E', now - 180, now - 120);
    await wait(bala.rowId);
    expect(
      (await tap(meena.auth, { cardToken: cards['bala'], mode: 'PERIOD', slotId: later })).body
        .code,
    ).toBe('ATT.OUTSIDE_PERIOD');
  });
});
