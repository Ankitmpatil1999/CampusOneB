/**
 * Allowances on a real MySQL (Phase 4.3; SRS 10; ALW-001…005, job allowance-cycle):
 * - issuing checks the dates, the amount, the feature and the students; one allowance per student
 *   at a time, so an overlapping grant is a duplicate and the next month can be issued ahead;
 * - the 00:05 job credits on the start date from the institution's allowance funding account, once,
 *   and expires on the expiry date, returning the unspent balance — the ledger stays balanced;
 * - a student pays a merchant's allowance QR through the payment engine (PIN, RPAW reference), within
 *   the daily limits, also when two payments race; refusals carry the allowance wording;
 * - limits change and a not-yet-credited grant is cancelled with If-Match; another school sees none.
 */
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { sql } from 'kysely';
import { adminUrl } from './db';
import { inr, PIN, schoolFixture, type Auth, type Merchant } from './school';
import { istBusinessDate } from '../../utils/format';

/** The 1st of the month after `months` months from today (IST), and the day before the next 1st. */
const period = (months: number) => {
  const [y, m] = istBusinessDate(new Date()).split('-').map(Number) as [number, number];
  const start = new Date(Date.UTC(y, m - 1 + months, 1));
  const next = new Date(Date.UTC(y, m + months, 1));
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return { start: iso(start), expiry: iso(new Date(next.getTime() - 86_400_000)), next: iso(next) };
};

describe.skipIf(!adminUrl)('allowances on real MySQL', () => {
  let f: Awaited<ReturnType<typeof schoolFixture>>;
  let con: Auth;
  const nov = period(1);
  const dec = period(2);

  const issue = (body: object) =>
    request(f.app)
      .post('/api/v1/console/allowances')
      .set(con)
      .set('Idempotency-Key', randomUUID())
      .send(body);
  const list = (query = '') => request(f.app).get(`/api/v1/console/allowances${query}`).set(con);
  const patch = (id: string, version: number, body: object) =>
    request(f.app)
      .patch(`/api/v1/console/allowances/${id}`)
      .set(con)
      .set('If-Match', `"v${version}"`)
      .send(body);
  const run = (periodKey: string) =>
    f.h.services.allowances.runCycle({ periodKey, item: () => undefined });
  const balance = async (walletId: string) => f.balance(walletId);
  const status = async (walletId: string) =>
    (
      await f.t.db
        .selectFrom('wallets')
        .select('status')
        .where('id', '=', walletId)
        .executeTakeFirstOrThrow()
    ).status;
  const allowanceQr = async (m: Merchant) => {
    const r = await request(f.app)
      .post(`/api/v1/console/merchants/${m.id}/qr-codes`)
      .set(con)
      .set('Idempotency-Key', randomUUID())
      .send({ kind: 'ALLOWANCE' });
    expect(r.status).toBe(201);
    return r.body.payload as string;
  };
  const pay = (who: { auth: Auth }, payload: string, amount: string) =>
    request(f.app)
      .post('/api/v1/me/payments')
      .set(who.auth)
      .set('Idempotency-Key', randomUUID())
      .send({ qrPayload: payload, amount: inr(amount), pin: PIN });

  beforeAll(async () => {
    f = await schoolFixture('Allowance School');
    con = f.school.con;
  }, 180_000);
  afterAll(async () => {
    await f?.t.drop();
  });

  it('checks dates, amount, feature and students, and keeps one allowance per student (ALW-003)', async () => {
    const [asha, ravi] = [await f.student('Asha'), await f.student('Ravi')];
    const teacher = await f.payer('Meena', 0);
    const body = {
      studentIds: [asha.id, ravi.id],
      name: 'November pocket money',
      amount: inr('500.00'),
      startDate: nov.start,
      expiryDate: nov.expiry,
      dailyLimits: { count: 2, amount: inr('200.00') },
    };

    await f.feature('allowances', false);
    expect((await issue(body)).body.code).toBe('ALW.FEATURE_OFF');
    await f.feature('allowances', true);

    const bad = await issue({
      ...body,
      startDate: `${nov.start.slice(0, 8)}15`,
      expiryDate: `${nov.start.slice(0, 8)}10`,
      amount: inr('999999999.00'),
    });
    expect(bad.status).toBe(422);
    expect(
      bad.body.errors.map((e: { field: string; code: string }) => `${e.field}:${e.code}`),
    ).toEqual([
      'startDate:ALW.START_NOT_FIRST',
      'expiryDate:ALW.EXPIRY_BEFORE_START',
      'amount:ALW.AMOUNT_RANGE',
    ]);
    const past = await issue({ ...body, startDate: '2026-01-01', expiryDate: '2026-01-31' });
    expect(past.body.errors[0].code).toBe('ALW.START_NOT_FUTURE');

    const unknown = randomUUID();
    const r = await issue({ ...body, studentIds: [asha.id, ravi.id, teacher.id, unknown] });
    expect(r.status).toBe(201);
    expect(r.body.created.map((c: { name: string }) => c.name).sort()).toEqual([
      'Asha Rao',
      'Ravi Rao',
    ]);
    expect(r.body.refused).toEqual([
      { studentId: teacher.id, code: 'ALW.NOT_STUDENT' },
      { studentId: unknown, code: 'GEN.NOT_FOUND' },
    ]);

    // Overlapping: a duplicate. The next month (renewal) can be issued ahead.
    const again = await issue({ ...body, studentIds: [asha.id] });
    expect(again.body).toMatchObject({
      created: [],
      duplicates: [{ studentId: asha.id, name: 'Asha Rao' }],
    });
    const next = await issue({
      ...body,
      studentIds: [asha.id],
      startDate: dec.start,
      expiryDate: dec.expiry,
    });
    expect(next.body.created).toHaveLength(1);

    const l = await list();
    expect(l.status).toBe(200);
    expect(l.body.kpis).toMatchObject({ active: 0, scheduled: 3 });
    expect(l.body.defaults).toEqual({ dailyCount: 3, dailyAmount: inr('200.00') });
    const mine = l.body.items.find(
      (x: { student: { id: string }; startDate: string }) =>
        x.student.id === asha.id && x.startDate === nov.start,
    );
    expect(mine).toMatchObject({
      name: 'November pocket money',
      amount: inr('500.00'),
      state: 'SCHEDULED',
      status: 'ACTIVE',
      balance: null,
      dailyLimits: { count: 2, amount: inr('200.00') },
      student: { name: 'Asha Rao', grade: 'Grade 6 A' },
    });
    expect((await list('?state=SCHEDULED&q=Ravi')).body.items).toHaveLength(1);
  });

  it('cancels only a grant not yet credited and changes limits with If-Match (ALW-004)', async () => {
    const ravi = await f.student('Kiran');
    await f.feature('allowances', true);
    const created = (
      await issue({
        studentIds: [ravi.id],
        amount: inr('300.00'),
        startDate: nov.start,
        expiryDate: nov.expiry,
      })
    ).body.created[0].grantId as string;
    const g = (await list()).body.items.find((x: { id: string }) => x.id === created);
    expect((await patch(created, g.version + 1, { dailyLimits: null })).status).toBe(412);
    const limited = await patch(created, g.version, {
      dailyLimits: { count: 1, amount: inr('50.00') },
    });
    expect(limited.status).toBe(200);
    expect(limited.body.dailyLimits).toEqual({ count: 1, amount: inr('50.00') });
    expect(limited.headers['etag']).toBe(`"v${g.version + 1}"`);
    const cancelled = await patch(created, g.version + 1, {
      status: 'INACTIVE',
      reason: 'Left the school',
    });
    expect(cancelled.body).toMatchObject({
      state: 'CANCELLED',
      status: 'INACTIVE',
      cancelReason: 'Left the school',
    });
    expect((await patch(created, g.version + 2, { status: 'INACTIVE' })).body.code).toBe(
      'ALW.TRANSITION_INVALID',
    );
    // A cancelled grant frees the period for a new one.
    const again = await issue({
      studentIds: [ravi.id],
      amount: inr('100.00'),
      startDate: nov.start,
      expiryDate: nov.expiry,
    });
    expect(again.body.created).toHaveLength(1);
  });

  it('credits on the start date once, pays merchants within the limits, and expires the rest (job, ALW-001)', async () => {
    await f.feature('allowances', true);
    const s = await f.student('Divya', 10_000);
    const other = await f.student('Mohan');
    const canteen = await f.merchant('Allowance Canteen');
    const qr = await allowanceQr(canteen);
    const created = (
      await issue({
        studentIds: [s.id, other.id],
        amount: inr('500.00'),
        startDate: nov.start,
        expiryDate: nov.expiry,
        dailyLimits: { count: 2, amount: inr('200.00') },
      })
    ).body.created as { studentId: string; grantId: string }[];
    expect(created).toHaveLength(2);

    // Before the credit the allowance wallet is inactive (RC-02).
    const early = await pay(s, qr, '10.00');
    expect(early.body).toMatchObject({ code: 'ALW.WALLET_INACTIVE', check: 'G5' });

    const first = await run(nov.start);
    expect(first.credited).toBeGreaterThanOrEqual(2);
    expect(await balance(s.allowanceWallet)).toBe(50_000);
    expect(await status(s.allowanceWallet)).toBe('ACTIVE');
    expect((await run(nov.start)).credited).toBe(0);
    expect(await balance(s.allowanceWallet)).toBe(50_000);

    const resolved = await request(f.app)
      .post('/api/v1/me/payments/resolve')
      .set(s.auth)
      .send({ qrPayload: qr });
    expect(resolved.body).toMatchObject({
      kind: 'ALLOWANCE',
      instruments: ['ALLOWANCE'],
      maxAmount: null,
    });

    const paid = await pay(s, qr, '120.00');
    expect(paid.status).toBe(201);
    expect(paid.body.receipt.reference).toMatch(/^RPAW/);
    expect(await balance(s.allowanceWallet)).toBe(38_000);
    expect(await balance(s.wallet)).toBe(10_000); // the campus wallet is untouched
    expect(await balance(canteen.wallet)).toBe(12_000);

    // Today's amount (₹120 spent + ₹100 > ₹200), then the count (2 a day).
    expect((await pay(s, qr, '100.00')).body).toMatchObject({
      code: 'ALW.DAILY_AMOUNT',
      check: 'G6',
      params: { limit: '₹200.00' },
    });
    expect((await pay(s, qr, '80.00')).status).toBe(201);
    expect((await pay(s, qr, '1.00')).body).toMatchObject({ code: 'ALW.DAILY_COUNT', check: 'G6' });
    expect((await pay(s, qr, '1.00')).status).toBe(409);

    const mine = await request(f.app).get('/api/v1/me/allowance').set(s.auth);
    expect(mine.status).toBe(200);
    expect(mine.body).toMatchObject({
      wallet: { status: 'ACTIVE', balance: inr('300.00') },
      grant: { state: 'ACTIVE', amount: inr('500.00'), startDate: nov.start },
      limits: { count: 2, amount: inr('200.00') },
      today: { count: 2, spent: inr('200.00'), countLeft: 0, amountLeft: inr('0.00') },
      periodSpent: inr('200.00'),
    });
    expect(mine.body.merchants.map((m: { name: string }) => m.name)).toContain('Allowance Canteen');
    expect(mine.body.history.map((h: { kind: string }) => h.kind)).toEqual([
      'PAYMENT',
      'PAYMENT',
      'CREDIT',
    ]);
    expect(mine.body.history[0]).toMatchObject({ title: 'Allowance Canteen', direction: 'OUT' });

    // A merchant that stops accepting allowances refuses (V6).
    await f.t.db
      .updateTable('merchants')
      .set({ accepts_allowance: 0 })
      .where('profile_id', '=', canteen.rowId)
      .execute();
    const off = await pay(other, qr, '10.00');
    expect(off.body).toMatchObject({ code: 'ALW.MERCHANT_NOT_ACCEPTING', check: 'V6' });
    await f.t.db
      .updateTable('merchants')
      .set({ accepts_allowance: 1 })
      .where('profile_id', '=', canteen.rowId)
      .execute();
    // More than the balance (no daily limit reached yet for Mohan).
    expect((await pay(other, qr, '150.00')).status).toBe(201);
    expect((await pay(other, qr, '60.00')).body.code).toBe('ALW.DAILY_AMOUNT');

    // Expiry: the unspent balance returns to the institution; the grant ends; once only.
    const done = await run(nov.expiry);
    expect(done.expired).toBeGreaterThanOrEqual(2);
    expect(await balance(s.allowanceWallet)).toBe(0);
    const g = await f.t.db
      .selectFrom('allowance_grants')
      .select(['status', 'ended_reason', 'expired_paise'])
      .where('profile_id', '=', s.rowId)
      .executeTakeFirstOrThrow();
    expect(g).toMatchObject({
      status: 'INACTIVE',
      ended_reason: 'EXPIRED',
      expired_paise: '30000',
    });
    expect((await run(nov.expiry)).expired).toBe(0);
    expect((await pay(s, qr, '1.00')).status).toBe(409);

    // The funding account nets to what was spent: credited − returned = paid out.
    const funding = await f.t.db
      .selectFrom('ledger_entries as e')
      .innerJoin('ledger_accounts as a', 'a.id', 'e.account_id')
      .select([
        sql<string>`SUM(CASE WHEN e.direction = 'D' THEN e.amount_paise ELSE 0 END)`.as('d'),
        sql<string>`SUM(CASE WHEN e.direction = 'C' THEN e.amount_paise ELSE 0 END)`.as('c'),
      ])
      .where('a.kind', '=', 'ALLOWANCE_FUNDING')
      .where('a.institution_id', '=', f.school.rowId)
      .executeTakeFirstOrThrow();
    const spent = await f.t.db
      .selectFrom('payment_attempts')
      .select(sql<string>`SUM(amount_paise)`.as('p'))
      .where('instrument', '=', 'ALLOWANCE')
      .where('status', '=', 'SUCCESS')
      .where('institution_id', '=', f.school.rowId)
      .executeTakeFirstOrThrow();
    expect(Number(funding.d) - Number(funding.c)).toBe(Number(spent.p));

    const rep = await request(f.app)
      .get(`/api/v1/console/allowances/reports?to=${istBusinessDate(new Date())}`)
      .set(con);
    expect(rep.status).toBe(200);
    expect(rep.body.kpis.spent).toEqual(inr('350.00'));
    expect(rep.body.byMerchant[0]).toEqual({ merchant: 'Allowance Canteen', spent: inr('350.00') });
    expect(
      rep.body.perStudent.find(
        (x: { student: { name: string } }) => x.student.name === 'Divya Rao',
      ),
    ).toMatchObject({
      issued: inr('500.00'),
      spent: inr('200.00'),
      expired: inr('300.00'),
    });
  });

  it('keeps the daily count when two payments race (G6 under the wallet lock)', async () => {
    await f.feature('allowances', true);
    const s = await f.student('Gita');
    const m = await f.merchant('Race Kiosk');
    const qr = await allowanceQr(m);
    await issue({
      studentIds: [s.id],
      amount: inr('500.00'),
      startDate: dec.start,
      expiryDate: dec.expiry,
      dailyLimits: { count: 1, amount: inr('500.00') },
    });
    await run(dec.start);
    const results = await Promise.all([pay(s, qr, '20.00'), pay(s, qr, '30.00')]);
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    const loser = results.find((r) => r.status !== 201)!;
    expect(['ALW.DAILY_COUNT', 'PAY.PENDING_GUARD']).toContain(loser.body.code);
    const left = await balance(s.allowanceWallet);
    expect([48_000, 47_000]).toContain(left);
  });

  it('shows the school the job runs that touched it (GOV-004 run by an operator, GOV-006)', async () => {
    await f.feature('allowances', true);
    const s = await f.student('Pooja');
    await issue({
      studentIds: [s.id],
      amount: inr('200.00'),
      startDate: dec.start,
      expiryDate: dec.expiry,
    });
    // A manual run can't be for a future day, so the grant is made due today.
    const today = istBusinessDate(new Date());
    await f.t.db
      .updateTable('allowance_grants')
      .set({ start_date: today })
      .where('institution_id', '=', f.school.rowId)
      .where('start_date', '=', dec.start)
      .execute();
    const run = await request(f.app)
      .post('/api/v1/ops/jobs/allowance-cycle/runs')
      .set(f.ops)
      .set('Idempotency-Key', randomUUID())
      .send({ period: today, reason: 'Credit for the GOV-006 test' });
    expect(run.status, JSON.stringify(run.body)).toBe(202);
    const runs = await request(f.app).get('/api/v1/console/job-runs').set(con);
    expect(runs.status).toBe(200);
    expect(runs.body.items[0]).toMatchObject({
      job: { id: 'allowance-cycle', name: 'Allowance credit and expiry' },
      periodKey: today,
      trigger: 'MANUAL',
      status: 'SUCCESS',
    });
    expect(runs.body.items[0].note).toMatch(/credited/);
    expect(
      (await request(f.app).get('/api/v1/console/job-runs?jobId=coupon-expiry').set(con)).body
        .items,
    ).toEqual([]);
  });

  it("refuses another school's grants (tenant isolation)", async () => {
    await f.feature('allowances', true);
    const s = await f.student('Nisha');
    const id = (
      await issue({
        studentIds: [s.id],
        amount: inr('100.00'),
        startDate: nov.start,
        expiryDate: nov.expiry,
      })
    ).body.created[0].grantId as string;
    const other = await schoolFixture('Other Allowance School');
    try {
      const r = await request(other.app)
        .patch(`/api/v1/console/allowances/${id}`)
        .set(other.school.con)
        .set('If-Match', '"v1"')
        .send({ status: 'INACTIVE' });
      expect(r.status).toBe(404);
      expect(
        (await request(other.app).get('/api/v1/console/allowances').set(other.school.con)).body
          .items,
      ).toEqual([]);
    } finally {
      await other.t.drop();
    }
  }, 180_000);
});
