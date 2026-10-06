/**
 * Fee heads, entry fees and fee structures on a real MySQL (Phase 5.1; SRS 13.2, 13.19 CR-11;
 * FEE-001…009):
 * - the head master starts with the seven heads; names are unique;
 * - entry fees are one per year, edited with If-Match once set;
 * - a structure is priced by the one formula (whole-rupee shares, remainder on the last) and every
 *   rule refuses with nothing written; a stated total that differs is refused;
 * - submitting sends it to a checker (or applies it for an administrator); a rejection returns it to
 *   draft with the remarks; approval activates it; editing it opens a new version;
 * - a class has one structure a year; assignment previews, then raises one record per remaining
 *   instalment per student, with the head breakdown, once.
 */
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { adminUrl } from './db';
import { inr, schoolFixture, type Auth } from './school';
import type { Principal } from '../../utils/principal';

describe.skipIf(!adminUrl)('fee heads, entry fees and structures on real MySQL', () => {
  let f: Awaited<ReturnType<typeof schoolFixture>>;
  let con: Auth;
  let year: { id: string; label: string };
  let grade6: string;
  let grade7: string;
  let heads: Record<string, string>;
  const students: { id: string; rowId: string }[] = [];

  const post = (path: string, body: object, auth: Auth = con) =>
    request(f.app).post(path).set(auth).set('Idempotency-Key', randomUUID()).send(body);
  const base = () => ({
    yearId: year.id,
    name: 'Middle school 2026-27',
    classIds: [grade6],
    heads: [
      { headId: heads['Tuition']!, amount: inr('30000.00') },
      { headId: heads['Annual']!, amount: inr('5000.00') },
      { headId: heads['Transport']!, amount: inr('6000.00'), optional: true },
    ],
    instalments: [
      { label: 'Term 1', dueDate: `${year.label.slice(0, 4)}-06-15`, share: '40' },
      { label: 'Term 2', dueDate: `${year.label.slice(0, 4)}-11-15`, share: '30' },
      { label: 'Term 3', dueDate: `20${year.label.slice(5, 7)}-01-15`, share: '30' },
    ],
    lateFine: inr('100.00'),
  });
  const setSelfApply = async (value: 0 | 1) => {
    const s = (await request(f.app).get('/api/v1/ops/settings').set(f.ops)).body.items.find(
      (x: { key: string }) => x.key === 'mkr.adminSelfApply',
    );
    const r = await request(f.app)
      .put('/api/v1/ops/settings/mkr.adminSelfApply')
      .set(f.ops)
      .set('If-Match', `"v${s.version}"`)
      .send({ value, reason: 'Fees test checker path' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  };
  /** A second administrator deciding (maker ≠ checker). */
  const checker = (): Principal => ({
    subject: randomUUID(),
    surface: 'console',
    sessionId: randomUUID(),
    institutionId: f.school.id,
    subTasks: ['approvals.decide', 'approvals.view'],
  });
  const decide = async (approvalId: string, decision: 'APPROVE' | 'REJECT', remarks: string) => {
    const p = checker();
    const a = await f.h.services.approvals.detail(p, 'console', approvalId);
    return f.h.services.approvals.decide(p, 'console', approvalId, a.version, {
      decision,
      remarks,
    });
  };

  beforeAll(async () => {
    f = await schoolFixture('Fee School');
    con = f.school.con;
    for (const n of ['Asha', 'Ravi', 'Meera']) students.push(await f.student(n));
    const classes = (await request(f.app).get('/api/v1/console/classes').set(con)).body.items as {
      id: string;
      name: string;
    }[];
    grade6 = classes.find((c) => c.name === 'Grade 6')!.id;
    const g7 = await post('/api/v1/console/classes', {
      name: 'Grade 7',
      sections: [{ name: 'A' }],
    });
    grade7 = g7.body.id;
    const ef = (await request(f.app).get('/api/v1/console/entry-fees').set(con)).body.items as {
      year: { id: string; label: string; current: boolean };
    }[];
    year = ef.find((x) => x.year.current)!.year;
  }, 180_000);
  afterAll(async () => {
    await f?.t.drop();
  });

  it('keeps the head master and one entry-fee schedule per year (FEE-001/002/008/009)', async () => {
    const list = await request(f.app).get('/api/v1/console/fee-heads').set(con);
    expect(list.body.items.map((h: { name: string }) => h.name)).toEqual([
      'Tuition',
      'Annual',
      'Transport',
      'Laboratory',
      'Activity',
      'Hostel',
      'Other',
    ]);
    heads = Object.fromEntries(
      list.body.items.map((h: { id: string; name: string }) => [h.name, h.id]),
    );
    const added = await post('/api/v1/console/fee-heads', { name: 'uniform' });
    expect(added.status).toBe(201);
    expect(added.body.name).toBe('Uniform');
    expect((await post('/api/v1/console/fee-heads', { name: 'UNIFORM' })).body).toMatchObject({
      code: 'FEE.HEAD_TAKEN',
    });

    const put = (body: object, version?: number) => {
      const r = request(f.app).put(`/api/v1/console/entry-fees/${year.id}`).set(con);
      return (version ? r.set('If-Match', `"v${version}"`) : r).send(body);
    };
    const fees = {
      applicationFee: inr('500.00'),
      applicationMandatory: true,
      admissionFee: inr('10000.00'),
    };
    const first = await put(fees);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.fees).toMatchObject({ applicationFee: inr('500.00'), version: 1 });
    expect((await put(fees)).status).toBe(428);
    expect((await put({ ...fees, admissionFee: inr('12000.00') }, 2)).status).toBe(412);
    const second = await put(
      { ...fees, applicationMandatory: false, admissionFee: inr('12000.00') },
      1,
    );
    expect(second.body.fees).toMatchObject({
      applicationMandatory: false,
      admissionFee: inr('12000.00'),
      version: 2,
    });
  });

  it('prices a structure by the one formula and refuses what breaks a rule (FEE-004/005)', async () => {
    const create = (over: object) => post('/api/v1/console/fee-structures', { ...base(), ...over });
    const b = base();
    expect((await create({ total: inr('35000.01') })).body).toMatchObject({
      code: 'FEE.TOTAL_MISMATCH',
      params: { total: '₹35,000.00' },
    });
    expect(
      (
        await create({
          instalments: b.instalments.map((x, i) => ({ ...x, share: i ? '20' : '40' })),
        })
      ).body,
    ).toMatchObject({ code: 'FEE.SHARES_NOT_100', params: { total: '80' } });
    expect(
      (
        await create({
          instalments: [{ ...b.instalments[0]!, dueDate: '2030-01-01' }, ...b.instalments.slice(1)],
        })
      ).body.code,
    ).toBe('FEE.DUE_OUTSIDE_YEAR');
    expect(
      (await create({ instalments: [b.instalments[1]!, b.instalments[0]!, b.instalments[2]!] }))
        .body.code,
    ).toBe('FEE.DUE_ORDER');
    expect((await create({ lateFine: inr('20000.00') })).body).toMatchObject({
      code: 'FEE.FINE_TOO_HIGH',
      params: { max: '₹10,500.00' },
    });
    expect(
      (await create({ heads: [...b.heads, { headId: heads['Tuition']!, amount: inr('1.00') }] }))
        .body,
    ).toMatchObject({ code: 'FEE.HEAD_REPEATED', params: { name: 'Tuition' } });
    expect((await f.t.db.selectFrom('fee_structures').selectAll().execute()).length).toBe(0);

    const ok = await create({ total: inr('35000.00') });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body).toMatchObject({
      status: 'DRAFT',
      current: {
        no: 1,
        total: inr('35000.00'),
        optional: inr('6000.00'),
        lateFine: inr('100.00'),
        classes: [{ name: 'Grade 6' }],
      },
    });
    expect(
      ok.body.current.instalments.map((x: { share: string; amount: { amount: string } }) => [
        x.share,
        x.amount.amount,
      ]),
    ).toEqual([
      ['40', '14000.00'],
      ['30', '10500.00'],
      ['30', '10500.00'],
    ]);
    expect((await create({})).body.code).toBe('FEE.STRUCTURE_NAME_TAKEN');

    const patched = await request(f.app)
      .patch(`/api/v1/console/fee-structures/${ok.body.id}`)
      .set(con)
      .set('If-Match', `"v${ok.body.current.version}"`)
      .send({ ...base(), lateFine: inr('250.00') });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    expect(patched.body.current).toMatchObject({ no: 1, lateFine: inr('250.00') });
  });

  it('goes through a checker, keeps a class to one structure, and versions an edit (FEE-006, MKR-003)', async () => {
    const s = (await request(f.app).get('/api/v1/console/fee-structures').set(con)).body.items[0];
    await setSelfApply(0);
    try {
      const sent = await post(`/api/v1/console/fee-structures/${s.id}/submissions`, {
        note: 'Term fees',
      });
      expect(sent.status, JSON.stringify(sent.body)).toBe(202);
      expect(sent.body).toMatchObject({ appliedDirectly: false, structure: { status: 'PENDING' } });
      expect((await post(`/api/v1/console/fee-structures/${s.id}/submissions`, {})).body.code).toBe(
        'FEE.ALREADY_PENDING',
      );
      expect(
        (
          await request(f.app)
            .patch(`/api/v1/console/fee-structures/${s.id}`)
            .set(con)
            .set('If-Match', `"v${sent.body.structure.current.version}"`)
            .send(base())
        ).body.code,
      ).toBe('FEE.STRUCTURE_LOCKED');
      // The maker can't decide their own request; another administrator returns it.
      const own = await request(f.app)
        .post(`/api/v1/console/approvals/${sent.body.approvalId}/decision`)
        .set(con)
        .set('If-Match', '"v1"')
        .set('Idempotency-Key', randomUUID())
        .send({ decision: 'APPROVE', remarks: 'Approving my own request' });
      expect([403, 409]).toContain(own.status);
      await decide(sent.body.approvalId, 'REJECT', 'Term 1 is already over — check the shares');
      const back = (await request(f.app).get('/api/v1/console/fee-structures').set(con)).body
        .items[0];
      expect(back).toMatchObject({
        status: 'DRAFT',
        current: { returnedRemarks: 'Term 1 is already over — check the shares' },
      });
      const again = await post(`/api/v1/console/fee-structures/${s.id}/submissions`, {});
      const approved = await decide(again.body.approvalId, 'APPROVE', 'Matches the circular');
      expect(approved.status).toBe('APPROVED');
      const live = (await request(f.app).get('/api/v1/console/fee-structures').set(con)).body;
      expect(live.items[0]).toMatchObject({
        status: 'ACTIVE',
        current: { no: 1, state: 'ACTIVE' },
      });
      expect(live.kpis).toMatchObject({ approved: 1, pending: 0, classesCovered: 1, classes: 2 });
    } finally {
      await setSelfApply(1);
    }
    // A class has one structure a year.
    expect(
      (
        await post('/api/v1/console/fee-structures', {
          ...base(),
          name: 'Another for Grade 6',
          classIds: [grade6, grade7],
        })
      ).body,
    ).toMatchObject({ code: 'FEE.CLASS_TAKEN', params: { class: 'Grade 6' } });
    // Editing the approved structure opens version 2; version 1 stays the approved one.
    const cur = (await request(f.app).get('/api/v1/console/fee-structures').set(con)).body.items[0];
    const edit = await request(f.app)
      .patch(`/api/v1/console/fee-structures/${s.id}`)
      .set(con)
      .set('If-Match', `"v${cur.current.version}"`)
      .send({ ...base(), heads: [{ headId: heads['Tuition']!, amount: inr('32000.00') }] });
    expect(edit.body).toMatchObject({
      status: 'DRAFT',
      current: { no: 2, state: 'DRAFT', total: inr('32000.00') },
      active: { no: 1, state: 'ACTIVE', total: inr('35000.00') },
    });
  });

  it('assigns the approved version: preview, then one record per remaining instalment, once (FEE-007)', async () => {
    const s = (await request(f.app).get('/api/v1/console/fee-structures').set(con)).body.items[0];
    const today = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
    const raised = base().instalments.filter((x) => x.dueDate >= today).length;
    const preview = await post(`/api/v1/console/fee-structures/${s.id}/assignments`, {
      preview: true,
    });
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    expect(preview.body).toMatchObject({
      version: 1,
      totals: { students: 3, records: 3 * raised },
      perClass: [{ class: { name: 'Grade 6' }, students: 3, already: 0, toAssign: 3 }],
    });
    expect(await f.t.db.selectFrom('fee_records').selectAll().execute()).toEqual([]);

    const done = await post(`/api/v1/console/fee-structures/${s.id}/assignments`, {
      preview: false,
      optional: [{ studentId: students[0]!.id, headIds: [heads['Transport']!] }],
    });
    expect(done.status, JSON.stringify(done.body)).toBe(201);
    expect(done.body).toMatchObject({ recordsCreated: 3 * raised, studentsAssigned: 3 });
    const recs = await f.t.db
      .selectFrom('fee_records')
      .selectAll()
      .where('student_profile_id', '=', students[0]!.rowId)
      .orderBy('instalment_seq')
      .execute();
    expect(recs).toHaveLength(raised);
    if (raised) {
      // Asha takes Transport: ₹6,000 × 30 % = ₹1,800 more per remaining term.
      expect(Number(recs.at(-1)!.amount_paise)).toBe(1_050_000 + 180_000);
      expect(recs.at(-1)).toMatchObject({
        status: 'DUE',
        source: 'STRUCTURE',
        late_fine_paise: '25000',
      });
      const lines = await f.t.db
        .selectFrom('fee_record_heads')
        .select(['name', 'amount_paise'])
        .where('record_id', '=', recs.at(-1)!.id)
        .execute();
      expect(lines.map((l) => [l.name, Number(l.amount_paise)]).sort()).toEqual([
        ['Annual', 150_000],
        ['Transport', 180_000],
        ['Tuition', 900_000],
      ]);
    }
    const again = await post(`/api/v1/console/fee-structures/${s.id}/assignments`, {
      preview: false,
    });
    expect(again.body).toMatchObject({ recordsCreated: 0, studentsAssigned: 0 });
    const after = (await request(f.app).get(`/api/v1/console/fee-structures`).set(con)).body
      .items[0];
    expect(after.assigned).toEqual({ students: 3, records: 3 * raised });
  });
});
