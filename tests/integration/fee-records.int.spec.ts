/**
 * Fee records and collection on a real MySQL (Phase 5.2; SRS 13.3, 13.5, 13.15; FEE-010…018, job
 * tuition-autodebit):
 * - a manual record is one head (default Tuition), due today or later, for a student only;
 * - collecting goes through the payment engine (TUITION, RPTF): exactly one of many racing requests
 *   debits the wallet, and the record is PAID with its collection row in the same transaction;
 * - a short balance leaves one pending attempt (202); the job collects it after a top-up, never twice;
 * - a record past its due date turns OVERDUE and its late fine is added once;
 * - the institution's toggles are honoured: tuition off, consent required, financed records.
 */
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { adminUrl } from './db';
import { inr, schoolFixture, type Auth, type Payer } from './school';
import { newPublicIdPair, uuidToBin } from '../../utils/idGenerator';
import type { Principal } from '../../utils/principal';

describe.skipIf(!adminUrl)('fee records and collection on real MySQL', () => {
  let f: Awaited<ReturnType<typeof schoolFixture>>;
  let con: Auth;
  let year: { id: string; label: string };
  let today: string;
  let feeWallet: string;
  let asha: Payer;
  let ravi: Payer;
  let meera: Payer;

  const post = (path: string, body: object = {}, key = randomUUID()) =>
    request(f.app).post(path).set(con).set('Idempotency-Key', key).send(body);
  const raise = async (student: Payer, amount: string, label = 'Term 2') => {
    const r = await post('/api/v1/console/fee-records', {
      studentId: student.id,
      yearId: year.id,
      label,
      dueDate: today,
      amount: inr(amount),
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body as { id: string; version: number };
  };
  const collect = (recordId: string, key = randomUUID()) =>
    post(`/api/v1/console/fee-records/${recordId}/collections`, {}, key);
  const row = (recordId: string) =>
    f.t.db
      .selectFrom('fee_records')
      .selectAll()
      .where('public_id', '=', uuidToBin(recordId))
      .executeTakeFirstOrThrow();
  const runJob = () =>
    f.h.services.jobs.runNow('tuition-autodebit', { reason: 'Fee collection test run' });
  const setSelfApply = async (value: 0 | 1) => {
    const s = (await request(f.app).get('/api/v1/ops/settings').set(f.ops)).body.items.find(
      (x: { key: string }) => x.key === 'mkr.adminSelfApply',
    );
    const r = await request(f.app)
      .put('/api/v1/ops/settings/mkr.adminSelfApply')
      .set(f.ops)
      .set('If-Match', `"v${s.version}"`)
      .send({ value, reason: 'Fee record checker path' });
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

  beforeAll(async () => {
    f = await schoolFixture('Fee Collect School');
    con = f.school.con;
    today = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
    asha = await f.student('Asha', 2_000_000);
    ravi = await f.student('Ravi', 50_000);
    meera = await f.student('Meera');
    const fees = await f.merchant('Fees Office');
    feeWallet = fees.wallet;
    const inst = await request(f.app).get('/api/v1/console/institution').set(con);
    const set = await request(f.app)
      .put('/api/v1/console/institution/fee-account')
      .set(con)
      .set('If-Match', `"v${inst.body.version}"`)
      .send({ merchantId: fees.id });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    const ef = (await request(f.app).get('/api/v1/console/entry-fees').set(con)).body.items as {
      year: { id: string; label: string; current: boolean };
    }[];
    year = ef.find((x) => x.year.current)!.year;
  }, 240_000);
  afterAll(async () => {
    await f?.t.drop();
  });

  it('raises a manual record for a student only, due today or later (FEE-012/010/011)', async () => {
    const r = await raise(asha, '12500.00');
    const detail = await request(f.app).get(`/api/v1/console/fee-records/${r.id}`).set(con);
    expect(detail.status).toBe(200);
    expect(detail.headers['etag']).toBe(`"v${r.version}"`);
    expect(detail.body).toMatchObject({
      source: 'MANUAL',
      status: 'DUE',
      instalment: { seq: 1, label: 'Term 2' },
      amount: inr('12500.00'),
      outstanding: inr('12500.00'),
      student: { name: 'Asha Rao', classSection: 'Grade 6 A' },
      heads: [{ name: 'Tuition', amount: inr('12500.00') }],
      collections: [],
      pendingAttempt: null,
    });
    const past = await post('/api/v1/console/fee-records', {
      studentId: asha.id,
      yearId: year.id,
      label: 'Old term',
      dueDate: '2026-04-01',
      amount: inr('100.00'),
    });
    expect(past.status).toBe(422);
    const notStudent = await post('/api/v1/console/fee-records', {
      studentId: (await f.merchant('Stationery')).id,
      yearId: year.id,
      label: 'Term 2',
      dueDate: today,
      amount: inr('100.00'),
    });
    expect(notStudent.body.code).toBe('FEE.NOT_A_STUDENT');
    const zero = await post('/api/v1/console/fee-records', {
      studentId: asha.id,
      yearId: year.id,
      label: 'Term 2',
      dueDate: today,
      amount: inr('0.00'),
    });
    expect(zero.status).toBe(422);
    const list = await request(f.app)
      .get(`/api/v1/console/fee-records?studentId=${asha.id}&status=DUE`)
      .set(con);
    expect(list.body.items.map((x: { id: string }) => x.id)).toEqual([r.id]);
  });

  it('collects once under racing requests through the engine (FEE-016, TUITION)', async () => {
    const [r] = (
      await request(f.app).get(`/api/v1/console/fee-records?studentId=${asha.id}`).set(con)
    ).body.items as { id: string }[];
    await f.feature('tuition', false);
    expect((await collect(r!.id)).body.code).toBe('FEE.TUITION_OFF');
    await f.feature('tuition', true);

    const before = await f.balance(asha.wallet);
    const feeBefore = await f.balance(feeWallet);
    const key = randomUUID();
    const all = await Promise.all([
      collect(r!.id, key),
      ...Array.from({ length: 5 }, () => collect(r!.id)),
    ]);
    const ok = all.filter((x) => x.status === 201);
    expect(ok, JSON.stringify(all.map((x) => [x.status, x.body.code]))).toHaveLength(1);
    for (const x of all.filter((y) => y.status !== 201))
      expect(x.body.code).toBe('FEE.RECORD_PAID');
    expect(ok[0]!.body).toMatchObject({
      collected: true,
      receipt: { amount: inr('12500.00') },
      record: { status: 'PAID', paid: inr('12500.00'), outstanding: inr('0.00') },
    });
    expect(ok[0]!.body.receipt.reference).toMatch(/^RPTF/);
    expect(await f.balance(asha.wallet)).toBe(before - 1_250_000);
    expect(await f.balance(feeWallet)).toBe(feeBefore + 1_250_000);
    const rows = await f.t.db
      .selectFrom('fee_collections')
      .selectAll()
      .where('record_id', '=', (await row(r!.id)).id)
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source: 'CONSOLE',
      status: 'COLLECTED',
      amount_paise: '1250000',
    });
    // The same key again never debits a second time.
    const replay = await collect(r!.id, key);
    expect([201, 409]).toContain(replay.status);
    expect(await f.balance(asha.wallet)).toBe(before - 1_250_000);
  });

  it('collects a waiting fee as soon as a bank credit reaches the wallet (Q14 M9)', async () => {
    const neha = await f.student('Neha', 20_000);
    const r = await raise(neha, '600.00', 'Term 2');
    expect((await collect(r.id)).status).toBe(202);
    const inst = await f.t.db
      .selectFrom('institutions')
      .select('corporate_code')
      .where('id', '=', f.school.rowId)
      .executeTakeFirstOrThrow();
    const va = await f.t.db
      .selectFrom('virtual_accounts')
      .select('va_number')
      .where('wallet_id', '=', neha.wallet)
      .executeTakeFirstOrThrow();
    const out = await f.h.services.bankCredits.notify(
      {
        requestId: randomUUID(),
        corporateCode: inst.corporate_code!,
        vaNumber: va.va_number,
        amount: '500.00',
        utr: `UTR${Date.now()}`,
        bankTxnId: `BT${Date.now()}`,
        mode: 'UPI',
      },
      null,
    );
    expect(out.code).toBe('000');
    // ₹200 + ₹500 credited − ₹600 collected at once, without waiting for the job.
    expect((await row(r.id)).status).toBe('PAID');
    expect(await f.balance(neha.wallet)).toBe(10_000);
    const attempt = await f.t.db
      .selectFrom('fee_collection_attempts')
      .select('status')
      .where('record_id', '=', (await row(r.id)).id)
      .executeTakeFirstOrThrow();
    expect(attempt.status).toBe('SUCCEEDED');
  });

  it('keeps one pending attempt on a short balance and the job collects it after a top-up', async () => {
    const r = await raise(ravi, '1000.00');
    const first = await collect(r.id);
    expect(first.status, JSON.stringify(first.body)).toBe(202);
    expect(first.body).toMatchObject({
      collected: false,
      pendingAttempt: { tries: 1, reasonCode: 'PAY.INSUFFICIENT_BALANCE' },
      record: { status: 'DUE' },
    });
    const second = await collect(r.id);
    expect(second.body.pendingAttempt).toMatchObject({
      id: first.body.pendingAttempt.id,
      tries: 2,
    });
    const queue = await request(f.app).get('/api/v1/console/fee-collection-attempts').set(con);
    expect(queue.body.items).toEqual([
      expect.objectContaining({
        id: first.body.pendingAttempt.id,
        status: 'PENDING',
        outstanding: inr('1000.00'),
        record: { id: r.id, label: 'Term 2' },
      }),
    ]);
    expect(await f.balance(ravi.wallet)).toBe(50_000);

    // Still short: the run tries once more and leaves it waiting.
    await runJob();
    expect((await row(r.id)).status).toBe('DUE');
    await f.credit(ravi.wallet, 100_000);
    const run = await runJob();
    expect(run.status).toBe('SUCCESS');
    expect((await row(r.id)).status).toBe('PAID');
    expect(await f.balance(ravi.wallet)).toBe(50_000);
    // A re-run collects nothing more.
    await runJob();
    expect(await f.balance(ravi.wallet)).toBe(50_000);
    const attempt = await f.t.db
      .selectFrom('fee_collection_attempts')
      .select(['status', 'closed_at'])
      .where('public_id', '=', uuidToBin(first.body.pendingAttempt.id))
      .executeTakeFirstOrThrow();
    expect(attempt.status).toBe('SUCCEEDED');
    expect(attempt.closed_at).not.toBeNull();
    const rows = await f.t.db
      .selectFrom('fee_collections')
      .select(['source'])
      .where('record_id', '=', (await row(r.id)).id)
      .execute();
    expect(rows).toEqual([{ source: 'JOB' }]);
  });

  it('turns a record overdue past its due date and adds the late fine once', async () => {
    const r = await raise(meera, '2000.00');
    await f.t.db
      .updateTable('fee_records')
      .set({ due_date: '2026-04-15', late_fine_paise: 15_000 })
      .where('public_id', '=', uuidToBin(r.id))
      .execute();
    expect((await collect(r.id)).status).toBe(202);
    await runJob();
    const overdue = await request(f.app).get(`/api/v1/console/fee-records/${r.id}`).set(con);
    expect(overdue.body).toMatchObject({
      status: 'OVERDUE',
      fine: inr('150.00'),
      outstanding: inr('2150.00'),
    });
    await f.credit(meera.wallet, 300_000);
    await runJob();
    await runJob();
    expect(await f.balance(meera.wallet)).toBe(300_000 - 215_000);
    const done = await request(f.app).get(`/api/v1/console/fee-records/${r.id}`).set(con);
    expect(done.body).toMatchObject({
      status: 'PAID',
      paid: inr('2150.00'),
      outstanding: inr('0.00'),
      // The collection keeps the fee and the fine apart (fee income and fine income).
      collections: [{ amount: inr('2000.00'), fine: inr('150.00'), source: 'JOB' }],
    });
  });

  it('honours consent and financing, and reports by class and section (FEE-017)', async () => {
    const r = await raise(asha, '500.00', 'Activity');
    await f.feature('feeConsent', true);
    try {
      expect((await collect(r.id)).body.code).toBe('FEE.CONSENT_REQUIRED');
      const p = await f.profileRow(asha.id);
      await f.t.db
        .insertInto('fee_consents')
        .values({
          public_id: uuidToBin(randomUUID()),
          institution_id: f.school.rowId,
          student_profile_id: String(p.id),
          account_id: String(p.account_id),
          text_version: '2026.10',
          agreed_at: new Date(),
          valid_until: new Date(Date.now() + 86_400_000),
        })
        .execute();
      await f.t.db
        .updateTable('fee_records')
        .set({ financed: 1 })
        .where('public_id', '=', uuidToBin(r.id))
        .execute();
      expect((await collect(r.id)).body.code).toBe('FEE.FINANCED');
      await f.t.db
        .updateTable('fee_records')
        .set({ financed: 0 })
        .where('public_id', '=', uuidToBin(r.id))
        .execute();
      expect((await collect(r.id)).status).toBe(201);
    } finally {
      await f.feature('feeConsent', false);
    }
    const report = await request(f.app).get('/api/v1/console/fee-collections/report').set(con);
    expect(report.status).toBe(200);
    expect(report.body.rows).toEqual([
      expect.objectContaining({
        classSection: 'Grade 6 A',
        students: 4,
        records: 5,
        billed: inr('16750.00'),
        collected: inr('16750.00'),
        outstanding: inr('0.00'),
      }),
    ]);
  });

  it('changes an unpaid record through a checker, or at once for an administrator (FEE-013)', async () => {
    const paid = (
      await request(f.app)
        .get(`/api/v1/console/fee-records?studentId=${asha.id}&status=PAID`)
        .set(con)
    ).body.items[0] as { id: string };
    const change = (id: string, body: object) =>
      post(`/api/v1/console/fee-records/${id}/change-requests`, body);
    expect(
      (await change(paid.id, { amount: inr('1.00'), reason: 'Scholarship granted' })).body.code,
    ).toBe('FEE.RECORD_PAID');

    const r = await raise(ravi, '800.00', 'Term 3');
    expect((await change(r.id, { dueDate: '2026-04-01', reason: 'Late admission' })).status).toBe(
      422,
    );
    // The administrator's own change applies directly (ADR-0015).
    const direct = await change(r.id, { amount: inr('900.00'), reason: 'Transport added' });
    expect(direct.status, JSON.stringify(direct.body)).toBe(202);
    expect(direct.body).toMatchObject({
      appliedDirectly: true,
      record: { amount: inr('900.00'), heads: [{ name: 'Tuition', amount: inr('900.00') }] },
    });

    await setSelfApply(0);
    try {
      const later = `${Number(year.label.slice(0, 4)) + 1}-02-15`;
      const sent = await change(r.id, { dueDate: later, reason: 'Family asked for more time' });
      expect(sent.body).toMatchObject({ appliedDirectly: false, record: { dueDate: today } });
      expect(
        (await change(r.id, { amount: inr('1.00'), reason: 'Another change' })).body.code,
      ).toBe('FEE.CHANGE_PENDING');
      const p = checker();
      const a = await f.h.services.approvals.detail(p, 'console', sent.body.approvalId);
      expect(a.changes).toEqual([{ label: 'Due date', from: today, to: later }]);
      await f.h.services.approvals.decide(p, 'console', sent.body.approvalId, a.version, {
        decision: 'APPROVE',
        remarks: 'Extension agreed with the family',
      });
      const after = await request(f.app).get(`/api/v1/console/fee-records/${r.id}`).set(con);
      expect(after.body).toMatchObject({ dueDate: later, amount: inr('900.00'), status: 'DUE' });
    } finally {
      await setSelfApply(1);
    }
  });

  it('runs the auto-debit for its own institution only (GOV-007)', async () => {
    const run = await post('/api/v1/console/jobs/tuition-autodebit/runs', {
      reason: 'Parents topped up this morning',
    });
    expect(run.status, JSON.stringify(run.body)).toBe(202);
    expect(run.body).toMatchObject({ job: { id: 'tuition-autodebit' }, runStatus: 'SUCCESS' });
    const logged = await f.t.db
      .selectFrom('job_runs')
      .select(['scope_institution_id', 'trigger_kind'])
      .where('public_id', '=', uuidToBin(run.body.runId))
      .executeTakeFirstOrThrow();
    expect(logged).toEqual({ scope_institution_id: f.school.rowId, trigger_kind: 'MANUAL' });
    expect(
      (await post('/api/v1/console/jobs/coupon-expiry/runs', { reason: 'Not ours to run' })).status,
    ).toBe(404);
  });

  it('checks a fee sheet row by row, then creates the accepted rows once (FEE-014/015)', async () => {
    const adm = async (s: Payer) =>
      (
        await f.t.db
          .selectFrom('member_profiles')
          .select('admission_no')
          .where('id', '=', s.rowId)
          .executeTakeFirstOrThrow()
      ).admission_no!;
    const template = await request(f.app)
      .get('/api/v1/console/fee-records/uploads/template')
      .set(con);
    expect(template.status).toBe(200);
    const header = template.text.trimStart().split(/\r?\n/)[0]!;
    const csv = [
      header,
      `Asha Rao,${await adm(asha)},Grade 6,A,"3,000.00",3,50.00,,No,,,`,
      `Ravi Rao,${await adm(ravi)},Grade 6,A,1000.01,2,0,${today},Yes,${today},CHQ-1234,Paid at the office`,
      'Ghost Student,ADM/NOPE,Grade 6,A,100,1,,,,,,',
      `Meera Rao,${await adm(meera)},,A,0,1,,,,,,`,
    ].join('\n');
    const send = () =>
      request(f.app)
        .post('/api/v1/console/fee-records/uploads')
        .set(con)
        .set('Idempotency-Key', randomUUID())
        .attach('file', Buffer.from(csv), { filename: 'fees.csv', contentType: 'text/csv' });
    const up = await send();
    expect(up.status, JSON.stringify(up.body)).toBe(201);
    expect(up.body).toMatchObject({ total: 4, accepted: 2, rejected: 2, recordsPlanned: 5 });
    expect(up.body.rows[0]).toMatchObject({
      accepted: true,
      instalments: [inr('1000.00'), inr('1000.00'), inr('1000.00')],
      dueDefaulted: true,
    });
    expect(up.body.rows[1]).toMatchObject({
      accepted: true,
      paid: true,
      instalments: [inr('500.00'), inr('500.01')],
    });
    expect(up.body.rows[2].errors).toEqual([
      { column: 'Admission number', message: 'No student with this admission number' },
    ]);
    expect(up.body.rows[3].errors.map((e: { column: string }) => e.column)).toEqual([
      'Grade',
      'Total',
    ]);
    expect(
      await f.t.db
        .selectFrom('fee_records')
        .select('id')
        .where('upload_id', 'is not', null)
        .execute(),
    ).toEqual([]);

    const commit = (mode?: 'ALL') =>
      post(`/api/v1/console/fee-records/uploads/${up.body.id}/commit`, mode ? { mode } : {});
    expect((await commit('ALL')).body).toMatchObject({ code: 'UPL.HAS_REJECTED' });
    const done = await commit();
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body).toEqual({ created: 5, skipped: 2 });
    expect((await commit()).body.code).toBe('UPL.ALREADY_COMMITTED');

    const made = await f.t.db
      .selectFrom('fee_records')
      .select(['id', 'label', 'amount_paise', 'status', 'late_fine_paise', 'paid_reference'])
      .where('upload_id', 'is not', null)
      .orderBy('id')
      .execute();
    expect(made.map((m) => [m.label, Number(m.amount_paise), m.status])).toEqual([
      ['Instalment 1', 100_000, 'DUE'],
      ['Instalment 2', 100_000, 'DUE'],
      ['Instalment 3', 100_000, 'DUE'],
      ['Instalment 1', 50_000, 'PAID'],
      ['Instalment 2', 50_001, 'PAID'],
    ]);
    expect(made[0]!.late_fine_paise).toBe('5000');
    expect(made[3]!.paid_reference).toBe('CHQ-1234');
    // Paid history moves no money.
    expect(
      await f.t.db
        .selectFrom('fee_collections')
        .select('id')
        .where(
          'record_id',
          'in',
          made.map((m) => m.id),
        )
        .execute(),
    ).toEqual([]);

    // The same sheet again the same day: the accepted rows are now repeats.
    const again = await send();
    expect(again.body.rows[0].errors).toEqual([
      {
        column: 'Admission number',
        message: 'Already uploaded today with the same total and instalments',
      },
    ]);
    const list = await request(f.app).get('/api/v1/console/fee-records/uploads').set(con);
    expect(list.body.items.map((u: { status: string }) => u.status)).toEqual([
      'VALIDATED',
      'COMMITTED',
    ]);
  });

  it('lets the accountant find a student and raise a record without the member directory (FEE-043)', async () => {
    // A staff member with the Accountant role only (client 2026-10-15).
    const a = await f.account('LATHA');
    const type = await f.t.db
      .selectFrom('user_types')
      .select('id')
      .where('public_id', '=', uuidToBin(f.teacherTypeId))
      .executeTakeFirstOrThrow();
    const prof = await f.t.db
      .insertInto('member_profiles')
      .values({
        public_id: newPublicIdPair().bin,
        institution_id: f.school.rowId,
        account_id: a.id,
        user_type_id: String(type.id),
        first_name: 'LATHA',
        last_name: null,
        employee_no: null,
        admission_no: null,
      })
      .executeTakeFirstOrThrow();
    const role = await f.t.db
      .selectFrom('roles')
      .select('id')
      .where('code', '=', 'ACCOUNTANT')
      .executeTakeFirstOrThrow();
    await f.t.db
      .insertInto('profile_roles')
      .values({
        institution_id: f.school.rowId,
        profile_id: String(prof.insertId),
        role_id: String(role.id),
      })
      .execute();
    const acc = await f.signedIn('console', a.email);

    expect((await request(f.app).get('/api/v1/console/members').set(acc)).status).toBe(403);
    const found = await request(f.app).get('/api/v1/console/fee-records/students?q=ravi').set(acc);
    expect(found.status, JSON.stringify(found.body)).toBe(200);
    expect(found.body.items).toEqual([
      { id: ravi.id, name: 'Ravi Rao', admissionNo: expect.any(String), grade: expect.anything() },
    ]);
    expect(Object.keys(found.body.items[0]).sort()).toEqual(['admissionNo', 'grade', 'id', 'name']);
    const all = await request(f.app).get('/api/v1/console/fee-records/students').set(acc);
    expect(all.body.items.map((s: { id: string }) => s.id)).toEqual(
      expect.arrayContaining([asha.id, ravi.id, meera.id]),
    );
    const made = await request(f.app)
      .post('/api/v1/console/fee-records')
      .set(acc)
      .set('Idempotency-Key', randomUUID())
      .send({
        studentId: ravi.id,
        yearId: year.id,
        label: 'Accounts term',
        dueDate: today,
        amount: inr('10.00'),
      });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
  });
});
