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

  it('assigns on approval and when a student joins, and shows the collection by head (FEE-007, FEE-044/045)', async () => {
    const s = (await request(f.app).get('/api/v1/console/fee-structures').set(con)).body.items[0];
    const today = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
    const raised = base().instalments.filter((x) => x.dueDate >= today).length;
    const rs = (paise: number) => inr((paise / 100).toFixed(2));
    const recordsOf = (rowId: string) =>
      f.t.db
        .selectFrom('fee_records')
        .selectAll()
        .where('student_profile_id', '=', rowId)
        .orderBy('instalment_seq')
        .execute();
    // Approved: every active Grade 6 student was assigned at once, with the mandatory heads
    // (client 2026-10-16). One record per instalment still to come.
    for (const st of students) expect(await recordsOf(st.rowId)).toHaveLength(raised);
    const recs = await recordsOf(students[0]!.rowId);
    if (raised) {
      // Term 3 (30 %): Tuition ₹9,000 + Annual ₹1,500; the optional Transport is not taken.
      expect(Number(recs.at(-1)!.amount_paise)).toBe(1_050_000);
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
        ['Tuition', 900_000],
      ]);
    }
    // Nothing is left for the Assign button, and it raises nothing twice.
    const preview = await post(`/api/v1/console/fee-structures/${s.id}/assignments`, {
      preview: true,
    });
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    expect(preview.body).toMatchObject({
      version: 1,
      totals: { students: 0, records: 0 },
      perClass: [{ class: { name: 'Grade 6' }, students: 3, already: 3, toAssign: 0 }],
    });
    const again = await post(`/api/v1/console/fee-structures/${s.id}/assignments`, {
      preview: false,
    });
    expect(again.body).toMatchObject({ recordsCreated: 0, studentsAssigned: 0 });

    // A student who joins Grade 6 after the approval is assigned on joining.
    const kiran = await f.student('Kiran', 5_000_000);
    const kiranRecs = await recordsOf(kiran.rowId);
    expect(kiranRecs).toHaveLength(raised);
    const after = (await request(f.app).get(`/api/v1/console/fee-structures`).set(con)).body
      .items[0];
    expect(after.assigned).toEqual({ students: 4, records: 4 * raised });

    // Kiran's first instalment is collected from the wallet into the fee account.
    if (raised) {
      const office = await f.merchant('Fees Office');
      const inst = await request(f.app).get('/api/v1/console/institution').set(con);
      const set = await request(f.app)
        .put('/api/v1/console/institution/fee-account')
        .set(con)
        .set('If-Match', `"v${inst.body.version}"`)
        .send({ merchantId: office.id });
      expect(set.status, JSON.stringify(set.body)).toBe(200);
      await f.feature('tuition', true);
      const list = (
        await request(f.app).get(`/api/v1/console/fee-records?studentId=${kiran.id}`).set(con)
      ).body.items as { id: string; instalment: { seq: number } }[];
      const first = list.find((x) => x.instalment.seq === kiranRecs[0]!.instalment_seq)!;
      const paid = await post(`/api/v1/console/fee-records/${first.id}/collections`, {});
      expect(paid.status, JSON.stringify(paid.body)).toBe(201);
    }

    // Fee collection details of the structure: its heads, its students by head, the cards.
    const fc = (query: string) =>
      request(f.app).get(`/api/v1/console/fee-collection${query}`).set(con);
    const view = await fc(`?structureId=${s.id}`);
    expect(view.status, JSON.stringify(view.body)).toBe(200);
    expect(view.body.structure).toMatchObject({ id: s.id, version: 1 });
    expect(view.body.year).toEqual({ id: year.id, label: year.label });
    expect(view.body.heads.map((h: { name: string }) => h.name)).toEqual([
      'Tuition',
      'Annual',
      'Transport',
    ]);
    expect(view.body).toMatchObject({ page: 1, pageSize: 15, total: 4 });
    expect(view.body.students).toHaveLength(4);
    const k = view.body.students.find((x: { id: string }) => x.id === kiran.id);
    const billed = kiranRecs.reduce((a, r) => a + Number(r.amount_paise), 0);
    expect(k.heads[2]).toBeNull(); // Transport not taken
    // Onboarded at the console: no application, so no application or admission fee.
    expect(k).toMatchObject({ applicationFee: null, admissionFee: null });
    if (raised) {
      const firstLines = await f.t.db
        .selectFrom('fee_record_heads')
        .select(['name', 'amount_paise'])
        .where('record_id', '=', kiranRecs[0]!.id)
        .execute();
      const tuition1 = Number(firstLines.find((l) => l.name === 'Tuition')!.amount_paise);
      const collected = Number(kiranRecs[0]!.amount_paise);
      expect(k.total).toEqual({
        amount: rs(billed),
        collected: rs(collected),
        pending: rs(billed - collected),
      });
      expect(k.heads[0]).toMatchObject({ collected: rs(tuition1) });
      // Another student has collected nothing yet.
      const asha = view.body.students.find((x: { id: string }) => x.id === students[0]!.id);
      expect(asha.total.collected).toEqual(inr('0.00'));
      // The cards: each head's collection and the total, over every student kept.
      expect(view.body.cards.heads[0]).toEqual({
        headId: view.body.heads[0].id,
        collected: rs(tuition1),
      });
      expect(view.body.cards.total.collected).toEqual(rs(collected));
      expect(view.body.cards.admissionFee.collected).toEqual(inr('0.00'));

      // The year without a structure (the current year by default): the year's heads, every
      // student enrolled, the same figures.
      const yearView = await fc('');
      expect(yearView.status, JSON.stringify(yearView.body)).toBe(200);
      expect(yearView.body.structure).toBeNull();
      const names = yearView.body.heads.map((h: { name: string }) => h.name) as string[];
      expect(names).toEqual(expect.arrayContaining(['Tuition', 'Annual', 'Transport']));
      expect(names.indexOf('Tuition')).toBeLessThan(names.indexOf('Annual'));
      expect(yearView.body.total).toBe(4);
      expect(yearView.body.cards.total.collected).toEqual(rs(collected));
      // By class, by section, by name; a page at a time, the cards over all of them.
      expect((await fc(`?classId=${grade6}`)).body.total).toBe(4);
      const none = await fc(`?classId=${grade7}`);
      expect(none.body).toMatchObject({ total: 0, students: [] });
      expect(none.body.cards.total.collected).toEqual(inr('0.00'));
      expect((await fc(`?sectionId=${randomUUID()}`)).body.total).toBe(0);
      const byName = await fc('?q=kiran');
      expect(byName.body.students.map((x: { id: string }) => x.id)).toEqual([kiran.id]);
      const page2 = await fc(`?structureId=${s.id}&pageSize=3&page=2`);
      expect(page2.body).toMatchObject({ page: 2, pageSize: 3, total: 4 });
      expect(page2.body.students).toHaveLength(1);
      expect(page2.body.cards.total.collected).toEqual(rs(collected));

      // A head's instalments for the student, in the structure and in the year.
      for (const query of [`?structureId=${s.id}`, '']) {
        const one = await request(f.app)
          .get(`/api/v1/console/fee-collection/students/${kiran.id}${query}`)
          .set(con);
        expect(one.status, JSON.stringify(one.body)).toBe(200);
        const tuition = one.body.heads.find((h: { name: string }) => h.name === 'Tuition');
        expect(tuition.instalments).toHaveLength(raised);
        expect(tuition.instalments[0]).toMatchObject({
          status: 'PAID',
          collected: rs(tuition1),
          pending: inr('0.00'),
        });
        if (raised > 1) {
          expect(tuition.instalments[1]).toMatchObject({ status: 'DUE', collected: inr('0.00') });
        }
      }
    }
    // An unknown student, an unknown year: not found.
    expect(
      (
        await request(f.app)
          .get(`/api/v1/console/fee-collection/students/${randomUUID()}?structureId=${s.id}`)
          .set(con)
      ).status,
    ).toBe(404);
    expect((await fc(`?yearId=${randomUUID()}`)).status).toBe(404);
  });
});
