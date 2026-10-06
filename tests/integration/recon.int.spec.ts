/**
 * Reconciliation on a real MySQL (Phase 6.2; SRS 15; REC-001…019, PAY-025; RC-19; Q14 M3):
 * - a statement is taken whole or not at all; a file or a row seen before is refused; each row is
 *   matched to the bank credit, and differences — and the platform's credits missing from the
 *   statement — become mismatches, closed when a later statement has them;
 * - a refund is processed once, through the ledger, by an officer other than the requester, and is
 *   deducted in the merchant's next settlement;
 * - a chargeback is raised once, disputed, then reversed through the ledger;
 * - the pool equals what is held for the wallets; the console reports read the same money.
 */
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { adminUrl } from './db';
import { inr, PIN, schoolFixture, type Merchant, type Payer } from './school';
import type { Principal } from '../../utils/principal';
import { newPublicIdPair } from '../../utils/idGenerator';

describe.skipIf(!adminUrl)('reconciliation on real MySQL', () => {
  let f: Awaited<ReturnType<typeof schoolFixture>>;
  let canteen: Merchant;
  let asha: Payer;
  let today: string;
  /** A Reconciliation Officer's back-office session (the platform admin has no recon tasks). */
  let officer: Record<string, string>;
  const op = (subTasks: string[]): Principal => ({
    subject: randomUUID(),
    surface: 'ops',
    sessionId: randomUUID(),
    subTasks,
  });
  const maker = op(['recon.resolve', 'recon.chargeback']);
  const checker = op(['recon.resolve', 'recon.chargeback']);
  const R = () => f.h.services.refunds;
  const stamp = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const credits: { utr: string; bankTxnId: string; reference: string }[] = [];
  const bankCredit = async (amount: string) => {
    const inst = await f.t.db
      .selectFrom('institutions')
      .select('corporate_code')
      .where('id', '=', f.school.rowId)
      .executeTakeFirstOrThrow();
    const va = await f.t.db
      .selectFrom('virtual_accounts')
      .select('va_number')
      .where('wallet_id', '=', asha.wallet)
      .executeTakeFirstOrThrow();
    const s = stamp();
    const c = { utr: `UTR${s}`, bankTxnId: `BT${s}` };
    const out = await f.h.services.bankCredits.notify(
      {
        requestId: randomUUID(),
        corporateCode: inst.corporate_code!,
        vaNumber: va.va_number,
        amount,
        utr: c.utr,
        bankTxnId: c.bankTxnId,
        mode: 'UPI',
      },
      null,
    );
    expect(out.code).toBe('000');
    const t = await f.t.db
      .selectFrom('bank_credits as b')
      .innerJoin('ledger_transactions as t', 't.id', 'b.ledger_txn_id')
      .select('t.reference')
      .where('b.utr', '=', c.utr)
      .executeTakeFirstOrThrow();
    const full = { ...c, reference: t.reference, va: va.va_number };
    credits.push(full);
    return full;
  };
  const upload = (type: string, csv: string, name = 'statement.csv') =>
    request(f.app)
      .post('/api/v1/ops/recon/statement-uploads')
      .set(officer)
      .set('Idempotency-Key', randomUUID())
      .field('type', type)
      .attach('file', Buffer.from(csv, 'utf8'), name);
  const vaRow = (c: { utr: string; bankTxnId: string }, va: string, amount: string) =>
    `${today},${c.utr},${c.bankTxnId},${va},"${amount}",UPI,Asha`;
  const HEADER = 'Date,UTR,Bank Txn ID,VA Number,Amount,Mode,Sender';

  beforeAll(async () => {
    f = await schoolFixture('Reconciliation School');
    today = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
    canteen = await f.merchant('Annapoorna Canteen');
    asha = await f.payer('Asha', 100_000);
    const acct = await f.account('MEERA');
    const role = await f.t.db
      .selectFrom('roles')
      .select('id')
      .where('code', '=', 'RECON_OFFICER')
      .executeTakeFirstOrThrow();
    await f.t.db
      .insertInto('operator_accounts')
      .values({ public_id: newPublicIdPair().bin, account_id: acct.id, role_id: String(role.id) })
      .execute();
    officer = await f.signedIn('ops', acct.email);
  }, 240_000);
  afterAll(async () => {
    await f?.t.drop();
  });

  it('takes a statement whole or not at all and turns differences into mismatches', async () => {
    const a = await bankCredit('500.00');
    const b = await bankCredit('300.00');
    const c = await bankCredit('200.00');
    const va = (a as { va: string }).va;
    const unknown = { utr: `UTR${stamp()}X`, bankTxnId: `BT${stamp()}X` };
    const good = [
      HEADER,
      vaRow(a, va, '500.00'),
      vaRow(unknown, va, '75.00'),
      vaRow(c, va, '1,250.00'),
    ].join('\n');

    // One bad row rejects the whole file; nothing is stored.
    const bad = await upload('VA_CREDITS', `${good}\n${today},UTR${stamp()},BT1,${va},,UPI,Asha`);
    expect(bad.status, JSON.stringify(bad.body)).toBe(422);
    expect(bad.body.code).toBe('REC.FILE_REJECTED');
    expect(bad.body.errors).toEqual([
      expect.objectContaining({ field: 'rows.4', code: 'REC.ROW_NULL' }),
    ]);
    expect(await f.t.db.selectFrom('recon_statement_rows').select('id').execute()).toHaveLength(0);

    const ok = await upload('VA_CREDITS', good, 'va-1.csv');
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body).toMatchObject({ rows: 3, matched: 1, mismatchedRows: 2, mismatches: 3 });
    const list = await request(f.app)
      .get('/api/v1/ops/recon/mismatches?status=OPEN&type=VA_CREDITS')
      .set(officer);
    expect(list.status).toBe(200);
    const kinds = list.body.items.map((x: { kind: string }) => x.kind).sort();
    expect(kinds).toEqual(['AMOUNT', 'MISSING_IN_STATEMENT', 'MISSING_ON_PLATFORM']);
    const amount = list.body.items.find((x: { kind: string }) => x.kind === 'AMOUNT');
    expect(amount).toMatchObject({
      statement: { amount: inr('1250.00'), rowNo: 3 },
      platform: { type: 'bank_credit', amount: inr('200.00') },
    });
    expect(
      list.body.items.find((x: { kind: string }) => x.kind === 'MISSING_IN_STATEMENT').platform
        .reference,
    ).toBe(b.utr);

    // The same file again, and a row from an earlier statement, are refused.
    const again = await upload('VA_CREDITS', good, 'copy.csv');
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('REC.FILE_DUPLICATE');
    const seen = await upload(
      'VA_CREDITS',
      [HEADER, vaRow(a, va, '500.00'), vaRow(b, va, '300.00')].join('\n'),
    );
    expect(seen.status).toBe(422);
    expect(seen.body.errors).toEqual([
      expect.objectContaining({ field: 'rows.1', code: 'REC.ROW_SEEN' }),
    ]);

    // A later statement with the missing credit closes that mismatch.
    const later = await upload(
      'VA_CREDITS',
      [HEADER, vaRow(b, va, '300.00')].join('\n'),
      'va-2.csv',
    );
    expect(later.status, JSON.stringify(later.body)).toBe(201);
    expect(later.body).toMatchObject({ rows: 1, matched: 1, mismatches: 0 });
    const open = await request(f.app).get('/api/v1/ops/recon/mismatches?status=OPEN').set(officer);
    expect(open.body.items.map((x: { kind: string }) => x.kind).sort()).toEqual([
      'AMOUNT',
      'MISSING_ON_PLATFORM',
    ]);

    // Resolution: explained, with remarks; a second resolution is refused.
    const res = await request(f.app)
      .post(`/api/v1/ops/recon/mismatches/${amount.id}/resolution`)
      .set(officer)
      .set('Idempotency-Key', randomUUID())
      .set('If-Match', `"v${amount.version}"`)
      .send({ action: 'EXPLAINED', remarks: 'Bank typed the amount wrong; corrected file asked' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ status: 'RESOLVED', resolution: 'EXPLAINED' });
    const twice = await request(f.app)
      .post(`/api/v1/ops/recon/mismatches/${amount.id}/resolution`)
      .set(officer)
      .set('Idempotency-Key', randomUUID())
      .set('If-Match', `"v${res.body.version}"`)
      .send({ action: 'ADJUSTED', remarks: 'Again' });
    expect(twice.status).toBe(409);
    expect(twice.body.code).toBe('REC.TRANSITION_INVALID');
  });

  it('refunds once through the ledger, decided by another officer, and nets it in the next settlement', async () => {
    const paid = await request(f.app)
      .post('/api/v1/me/payments')
      .set(asha.auth)
      .set('Idempotency-Key', randomUUID())
      .send({ qrPayload: canteen.qr.payload, amount: inr('250.00'), pin: PIN });
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);
    const ref = paid.body.receipt.reference as string;
    const before = { asha: await f.balance(asha.wallet), canteen: await f.balance(canteen.wallet) };

    await expect(
      R().requestRefund(maker, { transactionRef: ref, amountPaise: 30_000, reason: 'Too much' }),
    ).rejects.toMatchObject({ code: 'REC.AMOUNT_ABOVE', params: { amount: '₹250.00' } });
    const req = await R().requestRefund(maker, {
      transactionRef: ref.toLowerCase(),
      amountPaise: 10_000,
      reason: 'Charged for an item not served',
    });
    expect(req).toMatchObject({ status: 'REQUESTED', amount: inr('100.00'), source: 'MANUAL' });
    await expect(
      R().requestRefund(maker, { transactionRef: ref, reason: 'Duplicate request' }),
    ).rejects.toMatchObject({ code: 'REC.REFUND_EXISTS' });
    await expect(
      R().decideRefund(maker, req.id, req.version, { decision: 'PROCESS', remarks: 'Checked' }),
    ).rejects.toMatchObject({ code: 'REC.SAME_OFFICER' });
    const done = await R().decideRefund(checker, req.id, req.version, {
      decision: 'PROCESS',
      remarks: 'Counter confirmed',
    });
    expect(done.status).toBe('PROCESSED');
    expect(done.refundReference).toMatch(/^RPER/);
    expect(await f.balance(asha.wallet)).toBe(before.asha + 10_000);
    expect(await f.balance(canteen.wallet)).toBe(before.canteen - 10_000);
    const txn = await f.t.db
      .selectFrom('ledger_transactions as t')
      .innerJoin('ledger_transactions as o', 'o.id', 't.reversal_of_txn_id')
      .select(['t.type', 'o.reference'])
      .where('t.reference', '=', done.refundReference!)
      .executeTakeFirstOrThrow();
    expect(txn).toEqual({ type: 'REFUND', reference: ref });
    const told = await f.t.db
      .selectFrom('notifications')
      .select('title_key')
      .where('account_id', '=', asha.accountId)
      .where('title_key', '=', 'NTF.REFUND_PROCESSED')
      .execute();
    expect(told).toHaveLength(1);
    await expect(
      R().decideRefund(checker, req.id, done.version, { decision: 'REJECT', remarks: 'Late' }),
    ).rejects.toMatchObject({ code: 'REC.TRANSITION_INVALID' });

    // Q14 M3: the refund is an adjustment in the merchant's settlement.
    await f.h.services.settlement.settleInstitution(f.school.rowId, today);
    const s = (await f.h.services.settlement.list({ institutionId: f.school.id })).items.find(
      (x) => x.date === today,
    )!;
    expect(s).toMatchObject({
      gross: inr('250.00'),
      fee: inr('1.25'),
      adjustments: inr('100.00'),
      net: inr('148.75'),
    });
    // The detail sums signed lines per merchant (a refund line is −1).
    const d = await f.h.services.settlement.detail(s.id);
    expect(d.merchantsList).toEqual([
      expect.objectContaining({ adjustments: inr('100.00'), net: inr('148.75') }),
    ]);
    expect(d.payableNow).toEqual(inr('0.00'));
    expect(d.linesList.filter((l) => l.adjustment)).toHaveLength(1);
  });

  it('raises a chargeback once, disputes it, then reverses it through the ledger', async () => {
    const credit = await bankCredit('400.00');
    const raise = (key = randomUUID()) =>
      request(f.app)
        .post('/api/v1/ops/recon/chargebacks')
        .set(officer)
        .set('Idempotency-Key', key)
        .send({ transactionRef: credit.reference, reasonCode: 'U010' });
    const r = await raise();
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ status: 'RAISED', amount: inr('400.00'), reasonCode: 'U010' });
    expect((await raise()).body.code).toBe('REC.CHARGEBACK_EXISTS');
    await expect(
      R().requestRefund(maker, { transactionRef: credit.reference, reason: 'Back to bank' }),
    ).rejects.toMatchObject({ code: 'REC.NOT_REFUNDABLE' });
    const dispute = await request(f.app)
      .post(`/api/v1/ops/recon/chargebacks/${r.body.id}/decision`)
      .set(officer)
      .set('Idempotency-Key', randomUUID())
      .set('If-Match', `"v${r.body.version}"`)
      .send({ decision: 'DISPUTE', remarks: 'Credit evidence sent to the bank' });
    expect(dispute.status, JSON.stringify(dispute.body)).toBe(200);
    expect(dispute.body.status).toBe('DISPUTED');
    const before = await f.balance(asha.wallet);
    const done = await request(f.app)
      .post(`/api/v1/ops/recon/chargebacks/${r.body.id}/completion`)
      .set(officer)
      .set('Idempotency-Key', randomUUID())
      .set('If-Match', `"v${dispute.body.version}"`)
      .send({ outcome: 'REVERSED', remarks: 'Dispute lost' });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body).toMatchObject({ status: 'COMPLETED', outcome: 'REVERSED' });
    expect(done.body.reversalReference).toMatch(/^RPCB/);
    expect(await f.balance(asha.wallet)).toBe(before - 40_000);
  });

  it('shows a pool equal to what is held, and the console reports read the same money', async () => {
    const con = f.school.con;
    const pool = await request(f.app).get('/api/v1/console/recon/pool-balance').set(con);
    expect(pool.status, JSON.stringify(pool.body)).toBe(200);
    // Bank credits ₹500 + ₹300 + ₹200 + ₹400, less the ₹400 chargeback.
    expect(pool.body).toMatchObject({
      received: { ...inr('1400.00'), negative: false },
      chargebacks: { ...inr('400.00'), negative: false },
      poolExpected: { ...inr('1000.00'), negative: false },
      difference: { ...inr('0.00'), negative: false },
      bankReported: null,
    });
    expect(pool.body.wallets).toEqual(pool.body.walletsPerLedger);

    const txns = await request(f.app).get('/api/v1/console/recon/transactions').set(con);
    expect(txns.status, JSON.stringify(txns.body)).toBe(200);
    expect(txns.body.tiles.success.count).toBeGreaterThanOrEqual(1);
    expect(txns.body.items[0]).toMatchObject({
      description: 'Payment',
      payee: 'Annapoorna Canteen',
      statusLabel: 'Success',
    });
    const csv = await request(f.app).get('/api/v1/console/recon/transactions?format=csv').set(con);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.text).toContain('Annapoorna Canteen');

    const mis = await request(f.app).get('/api/v1/console/recon/mis').set(con);
    expect(mis.status, JSON.stringify(mis.body)).toBe(200);
    expect(mis.body.counts).toMatchObject({ matched: 1, mismatched: 0 });
    expect(mis.body.items[0]).toMatchObject({ settled: true, match: 'MATCHED' });

    const st = await request(f.app)
      .get(`/api/v1/console/recon/merchant-statement?merchantId=${canteen.id}`)
      .set(con);
    expect(st.status, JSON.stringify(st.body)).toBe(200);
    expect(st.body.totals).toMatchObject({
      collections: inr('250.00'),
      fees: inr('1.25'),
      adjustments: inr('100.00'),
    });
    expect(st.body.items.map((x: { type: string }) => x.type)).toEqual(['REFUND', 'PAYMENT']);

    const rep = await request(f.app).get('/api/v1/console/merchants/reports').set(con);
    expect(rep.status, JSON.stringify(rep.body)).toBe(200);
    expect(rep.body.items[0]).toMatchObject({
      merchant: { name: 'Annapoorna Canteen' },
      amount: inr('250.00'),
      settled: inr('250.00'),
      unsettled: inr('0.00'),
    });

    const ops = await request(f.app)
      .get(`/api/v1/ops/recon/mis?institutionId=${f.school.id}`)
      .set(officer);
    expect(ops.status, JSON.stringify(ops.body)).toBe(200);
    expect(ops.body.items[0]).toMatchObject({
      bankCredits: { count: 4, amount: inr('1400.00') },
      refunds: { count: 1, amount: inr('100.00') },
      chargebacks: { count: 1, amount: inr('400.00') },
    });
    void credits;
  });
});
