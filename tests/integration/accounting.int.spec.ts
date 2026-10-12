/**
 * Accounting vouchers and the platform fee rule per plan on a real MySQL (Phase 6.4; SRS 13.13,
 * 14.7; FEE-034…037, STL-009; RC-36; Q14 M15; OQ-04/06 example contracts):
 * - the institution maps a posting to its ledgers and turns transfers on; the job writes one voucher
 *   per mapped posting and the (test) package takes it; a re-run writes nothing twice;
 * - a refused voucher keeps its reason and waits for the next try; an officer can retry it;
 * - a plan's fee rule is versioned and effective-dated, and the settlement run applies the version
 *   in force on its date.
 */
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { adminUrl } from './db';
import { inr, PIN, schoolFixture, type Merchant, type Payer } from './school';
import type { Principal } from '../../utils/principal';

describe.skipIf(!adminUrl)('accounting vouchers and plan fee rules on real MySQL', () => {
  let f: Awaited<ReturnType<typeof schoolFixture>>;
  let canteen: Merchant;
  let asha: Payer;
  const op = (): Principal => ({
    subject: randomUUID(),
    surface: 'ops',
    sessionId: randomUUID(),
    subTasks: ['recon.resolve'],
  });
  const pay = async (amount: string) => {
    const r = await request(f.app)
      .post('/api/v1/me/payments')
      .set(asha.auth)
      .set('Idempotency-Key', randomUUID())
      .send({ qrPayload: canteen.qr.payload, amount: inr(amount), pin: PIN });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.receipt.reference as string;
  };
  const refund = async (reference: string, paise: number) => {
    const R = f.h.services.refunds;
    const req = await R.requestRefund(op(), {
      transactionRef: reference,
      amountPaise: paise,
      reason: 'Item not served',
    });
    return R.decideRefund(op(), req.id, req.version, { decision: 'PROCESS', remarks: 'Confirmed' });
  };
  const runJob = async () => {
    const items: { status: string; note: string | null }[] = [];
    await f.h.services.accounting.run({
      item: (i) => items.push(i),
      scope: { institutionId: f.school.rowId },
    });
    return items;
  };
  const vouchers = (q = '') =>
    request(f.app).get(`/api/v1/console/accounting/vouchers${q}`).set(f.school.con);
  const map = (version: number, body: object) =>
    request(f.app)
      .put('/api/v1/console/accounting/mappings')
      .set(f.school.con)
      .set('If-Match', `"v${version}"`)
      .send(body);

  beforeAll(async () => {
    f = await schoolFixture('Accounting School');
    canteen = await f.merchant('Annapoorna Canteen');
    asha = await f.payer('Asha', 100_000);
  }, 240_000);
  afterAll(async () => {
    await f?.t.drop();
  });

  it('writes one voucher per mapped posting and the package takes it', async () => {
    const empty = await request(f.app).get('/api/v1/console/accounting/mappings').set(f.school.con);
    expect(empty.body).toMatchObject({ mode: 'test', company: null, enabled: false, version: 0 });
    const none = await map(0, { companyName: 'Tunga Valley Trust', enabled: true, mappings: [] });
    expect(none.body.errors[0].code).toBe('ACC.MAPPING_NEEDED');
    const same = await map(0, {
      companyName: 'Tunga Valley Trust',
      enabled: true,
      mappings: [{ event: 'REFUND', debitLedger: 'Sales', creditLedger: 'Sales' }],
    });
    expect(same.body.errors[0].code).toBe('ACC.LEDGER');
    const on = await map(0, {
      companyName: 'Tunga Valley Trust',
      enabled: true,
      mappings: [
        { event: 'REFUND', debitLedger: 'Canteen Sales', creditLedger: 'Student Wallets' },
      ],
    });
    expect(on.status, JSON.stringify(on.body)).toBe(200);
    expect(on.body).toMatchObject({ enabled: true, version: 1 });

    const done = await refund(await pay('50.00'), 2_000);
    const first = await runJob();
    expect(first[0]).toMatchObject({ status: 'SUCCESS' });
    const list = await vouchers();
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(list.body.counts).toEqual({ pending: 0, transferred: 1, failed: 0 });
    expect(list.body.items[0]).toMatchObject({
      reference: done.refundReference,
      event: 'REFUND',
      amount: inr('20.00'),
      company: 'Tunga Valley Trust',
      debitLedger: 'Canteen Sales',
      creditLedger: 'Student Wallets',
      status: 'TRANSFERRED',
      externalRef: expect.stringMatching(/^TEST-/),
    });
    // The payment itself is not mapped; a re-run writes nothing twice.
    await runJob();
    expect((await vouchers()).body.items).toHaveLength(1);
    const retryDone = await request(f.app)
      .post(`/api/v1/console/accounting/vouchers/${list.body.items[0].id}/retries`)
      .set(f.school.con)
      .set('Idempotency-Key', randomUUID());
    expect(retryDone.body.code).toBe('ACC.NOT_FAILED');
  });

  it('keeps a refused voucher with its reason, retries it later and by hand', async () => {
    const current = await request(f.app)
      .get('/api/v1/console/accounting/mappings')
      .set(f.school.con);
    const changed = await map(current.body.version, {
      companyName: 'Tunga Valley Trust',
      enabled: true,
      mappings: [
        { event: 'REFUND', debitLedger: 'TEST-FAIL Sales', creditLedger: 'Student Wallets' },
      ],
    });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    await refund(await pay('30.00'), 1_000);
    const items = await runJob();
    expect(items[0]).toMatchObject({ status: 'FAILED' });
    const failed = (await vouchers('?status=FAILED')).body.items[0];
    expect(failed).toMatchObject({
      status: 'FAILED',
      statusLabel: 'Failed',
      attempts: 1,
      lastError: expect.stringContaining('Ledger not found'),
    });
    expect(failed.nextAttemptAt).not.toBeNull();
    // Not due yet: the next run leaves it.
    await runJob();
    expect((await vouchers('?status=FAILED')).body.items[0].attempts).toBe(1);
    const retry = await request(f.app)
      .post(`/api/v1/console/accounting/vouchers/${failed.id}/retries`)
      .set(f.school.con)
      .set('Idempotency-Key', randomUUID());
    expect(retry.status, JSON.stringify(retry.body)).toBe(202);
    expect(retry.body).toMatchObject({ status: 'FAILED', attempts: 2 });
    // The officer corrects the ledger name: the next try uses it and succeeds.
    const now = await request(f.app).get('/api/v1/console/accounting/mappings').set(f.school.con);
    const fixed = await map(now.body.version, {
      companyName: 'Tunga Valley Trust',
      enabled: true,
      mappings: [{ event: 'REFUND', debitLedger: 'Sales', creditLedger: 'Student Wallets' }],
    });
    expect(fixed.status, JSON.stringify(fixed.body)).toBe(200);
    const again = await request(f.app)
      .post(`/api/v1/console/accounting/vouchers/${failed.id}/retries`)
      .set(f.school.con)
      .set('Idempotency-Key', randomUUID());
    expect(again.body).toMatchObject({ status: 'TRANSFERRED', attempts: 3, debitLedger: 'Sales' });
  });

  it('applies the plan’s fee rule version in force on the settlement date (STL-009)', async () => {
    const rules = await request(f.app).get('/api/v1/ops/platform-fee-rules').set(f.ops);
    expect(rules.status, JSON.stringify(rules.body)).toBe(200);
    const plan = rules.body.plans[0];
    const today = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
    const tomorrow = new Date(Date.now() + 330 * 60_000 + 86_400_000).toISOString().slice(0, 10);
    const body = {
      flatFee: inr('2.00'),
      threshold: inr('100.00'),
      boundary: 'EXCLUSIVE',
      basisPoints: 100,
      appliesTo: ['PAYMENT', 'EVENT'],
      effectiveFrom: today,
      remarks: 'Pilot pricing for this plan',
    };
    const put = (b: object, v: number) =>
      request(f.app)
        .put(`/api/v1/ops/platform-fee-rules/${plan.id}`)
        .set(f.ops)
        .set('If-Match', `"v${v}"`)
        .send(b);
    expect((await put(body, plan.version)).body.errors[0].code).toBe('STL.RULE_EFFECTIVE');
    const saved = await put({ ...body, effectiveFrom: tomorrow }, plan.version);
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.versions[0]).toMatchObject({
      version: plan.version + 1,
      effectiveFrom: tomorrow,
      boundary: 'EXCLUSIVE',
      flatFee: inr('2.00'),
    });
    expect((await put({ ...body, effectiveFrom: tomorrow }, plan.version)).status).toBe(412);

    // A ₹100.00 payment: the default rule charges ₹1.00 flat; tomorrow's charges 1 % = ₹1.00 —
    // and ₹99.00 shows the difference: ₹1.00 today, ₹2.00 tomorrow.
    const S = f.h.services.settlement;
    expect(await S.rulesFor(f.school.rowId, today)).toMatchObject({ flatPaise: 100 });
    expect(await S.rulesFor(f.school.rowId, tomorrow)).toMatchObject({
      flatPaise: 200,
      boundary: 'EXCLUSIVE',
      basisPoints: 100,
    });
    await pay('99.00');
    await S.settleInstitution(f.school.rowId, tomorrow);
    const s = (await S.list({ institutionId: f.school.id })).items.find(
      (x) => x.date === tomorrow,
    )!;
    const d = await S.detail(s.id);
    const line = d.linesList.find((l) => l.amount.amount === '99.00')!;
    expect(line.fee).toEqual(inr('2.00'));
  });
});
