/**
 * Merchant settlement on a real MySQL (Phase 6.1; SRS 14; STL-001…013; Q14 M1–M4, M17):
 * - the run settles each successful credit to a merchant once, with the platform fee per line, the
 *   four statements and the day balances; a re-run for the same date changes nothing;
 * - approval needs a maker and a different checker; rejection frees the lines, which the next run
 *   collects once more and not again after that;
 * - the payout records the UTR once and posts the merchant's money through the ledger: the wallet
 *   falls by the gross, the payout clearing gets the net and the platform fee account the fee.
 */
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { adminUrl } from './db';
import { inr, PIN, schoolFixture, type Merchant, type Payer } from './school';
import type { Principal } from '../../utils/principal';
import { uuidToBin } from '../../utils/idGenerator';

describe.skipIf(!adminUrl)('merchant settlement on real MySQL', () => {
  let f: Awaited<ReturnType<typeof schoolFixture>>;
  let canteen: Merchant;
  let asha: Payer;
  let today: string;
  const op = (subTasks: string[]): Principal => ({
    subject: randomUUID(),
    surface: 'ops',
    sessionId: randomUUID(),
    subTasks,
  });
  const maker = op(['settle.view', 'settle.stage1']);
  const checker = op(['settle.view', 'settle.final', 'settle.reject', 'settle.payout']);
  const other = op(['settle.view', 'settle.reject']);
  const pay = async (amount: string) => {
    const r = await request(f.app)
      .post('/api/v1/me/payments')
      .set(asha.auth)
      .set('Idempotency-Key', randomUUID())
      .send({ qrPayload: canteen.qr.payload, amount: inr(amount), pin: PIN });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  };
  const plusDays = (d: string, n: number) =>
    new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
  const S = () => f.h.services.settlement;
  const settlementOn = async (date: string) =>
    (await S().list({ institutionId: f.school.id })).items.find((s) => s.date === date)!;
  const account = (kind: 'PAYOUT_CLEARING' | 'PLATFORM_FEE') =>
    f.t.db
      .selectFrom('ledger_entries as e')
      .innerJoin('ledger_accounts as a', 'a.id', 'e.account_id')
      .select((eb) => eb.fn.sum<string>('e.amount_paise').as('total'))
      .where('a.kind', '=', kind)
      .where('a.institution_id', '=', f.school.rowId)
      .where('e.direction', '=', 'C')
      .executeTakeFirst();

  beforeAll(async () => {
    f = await schoolFixture('Settlement School');
    today = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
    canteen = await f.merchant('Annapoorna Canteen');
    asha = await f.payer('Asha', 100_000);
  }, 240_000);
  afterAll(async () => {
    await f?.t.drop();
  });

  it('settles each credit once with the fee per line, four statements and the day balances', async () => {
    await pay('100.00'); // fee ₹1.00 (flat, inclusive)
    await pay('100.01'); // fee 0.5 % = ₹0.50
    await pay('250.00'); // fee ₹1.25
    const first = await S().settleInstitution(f.school.rowId, today);
    expect(first).toMatchObject({ created: true, lines: 3 });
    expect(await S().settleInstitution(f.school.rowId, today)).toMatchObject({ created: false });
    const s = await settlementOn(today);
    expect(s).toMatchObject({
      status: 'PENDING',
      lines: 3,
      merchants: 1,
      gross: inr('450.01'),
      fee: inr('2.75'),
      net: inr('447.26'),
    });
    const d = await S().detail(s.id);
    expect(d.statements.map((x) => x.fileNo)).toEqual([1, 2, 3, 4]);
    expect((await S().statement(s.id, 1)).url).toMatch(/^\/api\/v1\/files\//);
    expect(d.merchantsList).toEqual([
      expect.objectContaining({
        name: 'Annapoorna Canteen',
        gross: inr('450.01'),
        fee: inr('2.75'),
      }),
    ]);
    const days = await f.t.db
      .selectFrom('wallet_day_balances')
      .select(['wallet_id', 'closing_paise'])
      .where('institution_id', '=', f.school.rowId)
      .where('business_date', '=', today)
      .execute();
    expect(days.find((x) => x.wallet_id === canteen.wallet)?.closing_paise).toBe('45001');
  });

  it('needs a maker and a different checker, then pays out once through the ledger', async () => {
    const s = await settlementOn(today);
    const one = await S().stage1(maker, s.id, s.version, { remarks: 'Statements checked' });
    expect(one.status).toBe('APPROVAL_STAGE_1');
    await expect(
      S().final(maker, s.id, one.version, { remarks: 'Self check' }),
    ).rejects.toMatchObject({
      code: 'STL.SAME_APPROVER',
    });
    await expect(
      S().reject(maker, s.id, one.version, { remarks: 'Changed my mind' }),
    ).rejects.toMatchObject({
      code: 'STL.REJECTER_APPROVED',
    });
    const two = await S().final(checker, s.id, one.version, { remarks: 'Bank file ready' });
    expect(two.status).toBe('APPROVED');
    expect(two.payableNow).toEqual(inr('447.26'));
    await expect(
      S().reject(other, s.id, two.version, { remarks: 'Too late' }),
    ).rejects.toMatchObject({
      code: 'STL.CANNOT_REJECT',
    });
    await expect(
      S().payout(checker, s.id, { utr: 'short', amountPaise: 44_726 }),
    ).rejects.toMatchObject({
      errors: [{ field: 'utr', code: 'STL.UTR_FORMAT' }],
    });
    await expect(
      S().payout(checker, s.id, { utr: 'HDFCN52026100412345', amountPaise: 45_001 }),
    ).rejects.toMatchObject({ code: 'STL.PAYOUT_AMOUNT', params: { amount: '₹447.26' } });
    const before = await f.balance(canteen.wallet);
    const paid = await S().payout(checker, s.id, {
      utr: 'hdfcn52026100412345',
      amountPaise: 44_726,
    });
    expect(paid.payout).toMatchObject({ utr: 'HDFCN52026100412345', amount: inr('447.26') });
    expect(paid.status).toBe('APPROVED');
    expect(await f.balance(canteen.wallet)).toBe(before - 45_001);
    expect(Number((await account('PAYOUT_CLEARING'))?.total)).toBe(44_726);
    expect(Number((await account('PLATFORM_FEE'))?.total)).toBe(275);
    await expect(
      S().payout(checker, s.id, { utr: 'HDFCN52026100499999', amountPaise: 44_726 }),
    ).rejects.toMatchObject({ code: 'STL.UTR_SET' });
    // The merchant sees it on its statement.
    const mine = await request(f.app).get('/api/v1/merchant/settlements').set(canteen.auth);
    expect(mine.status, JSON.stringify(mine.body)).toBe(200);
    expect(mine.body.items[0]).toMatchObject({
      statusLabel: 'Final Approval',
      net: inr('447.26'),
      paidOut: { utr: 'HDFCN52026100412345' },
    });
  });

  it('collects a rejected settlement’s lines once more, and not again after that (Q14 M17)', async () => {
    await pay('80.00');
    const d1 = plusDays(today, 1);
    expect(await S().settleInstitution(f.school.rowId, d1)).toMatchObject({ lines: 1 });
    const s1 = await settlementOn(d1);
    const r1 = await S().reject(other, s1.id, s1.version, { remarks: 'Bank holiday file' });
    expect(r1.status).toBe('FAILED');
    const d2 = plusDays(today, 2);
    expect(await S().settleInstitution(f.school.rowId, d2)).toMatchObject({ lines: 1 });
    const s2 = await settlementOn(d2);
    expect(s2.recollected).toBe(1);
    await S().reject(other, s2.id, s2.version, { remarks: 'Rejected again' });
    const d3 = plusDays(today, 3);
    expect(await S().settleInstitution(f.school.rowId, d3)).toMatchObject({ lines: 0 });
    // A rejected date can be settled again (a failed settlement never blocks); a day with nothing
    // to settle creates no settlement.
    expect(await S().settleInstitution(f.school.rowId, d1)).toMatchObject({ created: false });
    await pay('20.00');
    expect(await S().settleInstitution(f.school.rowId, d1)).toMatchObject({
      created: true,
      lines: 1,
    });
    const lines = await f.t.db
      .selectFrom('settlement_lines')
      .select(['active'])
      .where('institution_id', '=', f.school.rowId)
      .where('reference', 'like', 'RPEP%')
      .execute();
    expect(lines.filter((l) => Number(l.active) === 1)).toHaveLength(4);
    void uuidToBin;
  });
});
