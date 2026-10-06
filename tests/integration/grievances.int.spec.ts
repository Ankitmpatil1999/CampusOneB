/**
 * Grievances on a real MySQL (Phase 6.3; SRS 16; GRV-001…014; RC-20; Q14 M16):
 * - a member raises one live ticket per transaction, only on a movement of their own wallet;
 *   feedback and fraud reports get their own numbers;
 * - the console works the queue: a comment on every change, RC-20 moves only, Closed read-only, the
 *   member told of each applied update;
 * - a refund resolution needs Priority 1 and a checker; the approval posts the ledger refund;
 * - calls are logged; the support desk's look-ups need a reason and are recorded.
 */
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { adminUrl } from './db';
import { inr, PIN, schoolFixture, type Merchant, type Payer } from './school';
import type { Principal } from '../../utils/principal';
import { newPublicIdPair } from '../../utils/idGenerator';

describe.skipIf(!adminUrl)('grievances on real MySQL', () => {
  let f: Awaited<ReturnType<typeof schoolFixture>>;
  let canteen: Merchant;
  let asha: Payer;
  let ravi: Payer;
  let paymentRef: string;
  let ticketId: string;
  let ticketNo: string;
  let feedbackId: string;
  let support: Record<string, string>;
  const checker = (): Principal => ({
    subject: randomUUID(),
    surface: 'console',
    sessionId: randomUUID(),
    institutionId: f.school.id,
    subTasks: ['approvals.decide', 'approvals.view'],
  });
  const send = (
    method: 'post' | 'patch',
    path: string,
    auth: object,
    body: object,
    ver?: number,
  ) => {
    const r = request(f.app)
      [method](path)
      .set(auth as Record<string, string>)
      .set('Idempotency-Key', randomUUID());
    return (ver === undefined ? r : r.set('If-Match', `"v${ver}"`)).send(body);
  };
  const ticket = (id: string) =>
    request(f.app).get(`/api/v1/console/tickets/${id}`).set(f.school.con);
  const update = async (id: string, body: object) => {
    const t = await ticket(id);
    return send('patch', `/api/v1/console/tickets/${id}`, f.school.con, body, t.body.version);
  };

  beforeAll(async () => {
    f = await schoolFixture('Grievance School');
    canteen = await f.merchant('Annapoorna Canteen');
    asha = await f.payer('Asha', 100_000);
    ravi = await f.payer('Ravi', 50_000);
    const paid = await send('post', '/api/v1/me/payments', asha.auth, {
      qrPayload: canteen.qr.payload,
      amount: inr('120.00'),
      pin: PIN,
    });
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);
    paymentRef = paid.body.receipt.reference;
    const acct = await f.account('SUNITA');
    const role = await f.t.db
      .selectFrom('roles')
      .select('id')
      .where('code', '=', 'SUPPORT_OFFICER')
      .executeTakeFirstOrThrow();
    await f.t.db
      .insertInto('operator_accounts')
      .values({ public_id: newPublicIdPair().bin, account_id: acct.id, role_id: String(role.id) })
      .execute();
    support = await f.signedIn('ops', acct.email);
  }, 240_000);
  afterAll(async () => {
    await f?.t.drop();
  });

  it('raises one live ticket per transaction, only on the member’s own movement', async () => {
    const raise = (auth: object, body: object) => send('post', '/api/v1/me/tickets', auth, body);
    const body = {
      transactionRef: paymentRef.toLowerCase(),
      category: 'WRONG_AMOUNT',
      issue: 'Charged ₹120 for a ₹60 meal at the canteen today.',
    };
    const r = await raise(asha.auth, body);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({
      ticketNo: expect.stringMatching(/^TKT-\d{6}$/),
      status: 'OPEN',
      priority: 2,
      categoryLabel: 'Wrong amount',
      transaction: { reference: paymentRef, amount: inr('120.00') },
      history: [expect.objectContaining({ status: 'OPEN', by: 'You' })],
    });
    ticketId = r.body.id;
    ticketNo = r.body.ticketNo;
    // The console sees the transaction as it stands, with both parties (and no attachment here).
    const seen = await ticket(ticketId);
    expect(seen.body.transaction.now).toMatchObject({ status: 'SUCCESS', statusLabel: 'Success' });
    expect(seen.body.transaction.now.payer).toMatch(/asha/i);
    expect(seen.body.transaction.now.payee).toMatch(/annapoorna/i);
    expect(seen.body.attachment).toBeNull();
    expect((await raise(asha.auth, body)).body.code).toBe('GRV.TICKET_OPEN_EXISTS');
    const other = await raise(ravi.auth, body);
    expect(other.status).toBe(403);
    expect(other.body.code).toBe('GRV.NOT_A_PARTY');
    const short = await raise(asha.auth, { ...body, issue: 'Too short' });
    expect(short.body.errors).toEqual([
      expect.objectContaining({ field: 'issue', code: 'GRV.ISSUE_FORMAT' }),
    ]);
    const markup = await raise(asha.auth, { ...body, issue: '<script>alert(1)</script> pay me' });
    expect(markup.status).toBe(422);
    expect((await raise(asha.auth, { ...body, category: 'NOPE' })).body.errors[0].code).toBe(
      'GRV.CATEGORY',
    );

    const fb = await send('post', '/api/v1/me/feedback', asha.auth, {
      kind: 'SUGGESTION',
      text: 'Please add a fruit counter to the canteen.',
    });
    expect(fb.status, JSON.stringify(fb.body)).toBe(201);
    expect(fb.body.feedbackNo).toMatch(/^FBK-\d{6}$/);
    feedbackId = fb.body.id;
    const fr = await send('post', '/api/v1/me/fraud-reports', asha.auth, {
      category: 'OTP_PIN_ASKED',
      details: 'Someone called claiming to be the school office and asked for my PIN.',
      happenedOn: '2026-10-01',
    });
    expect(fr.status, JSON.stringify(fr.body)).toBe(201);
    expect(fr.body.reportNo).toMatch(/^FRD-\d{6}$/);

    const mine = await request(f.app).get('/api/v1/me/tickets').set(asha.auth);
    expect(mine.body.counts).toEqual({ all: 3, open: 3, closed: 0 });
    expect((await request(f.app).get(`/api/v1/me/tickets/${ticketId}`).set(ravi.auth)).status).toBe(
      404,
    );
  });

  it('works the queue: a comment on every change, RC-20 moves only, Closed read-only, the member told', async () => {
    const list = await request(f.app).get('/api/v1/console/tickets').set(f.school.con);
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(list.body.tiles).toMatchObject({ total: 3, open: { count: 3, share: 100 } });
    const d = await ticket(ticketId);
    expect(d.body).toMatchObject({
      refundable: true,
      member: { name: 'Asha', mobile: expect.stringMatching(/^•+ \d{4}$/) },
    });
    expect(d.body.member.transactions.total).toBeGreaterThanOrEqual(2);

    const noVersion = await send('patch', `/api/v1/console/tickets/${feedbackId}`, f.school.con, {
      status: 'ESCALATED_INTERNAL',
      priority: 2,
      comment: 'Passed to the canteen committee',
    });
    expect(noVersion.status).toBe(428);
    const esc = await update(feedbackId, {
      status: 'ESCALATED_INTERNAL',
      priority: 2,
      reasonCode: 'OPERATIONS',
      comment: 'Passed to the canteen committee',
    });
    expect(esc.status, JSON.stringify(esc.body)).toBe(200);
    expect(esc.body).toMatchObject({
      code: 'GRV.UPDATED',
      ticket: { status: 'ESCALATED_INTERNAL' },
    });
    expect(
      (await update(feedbackId, { status: 'OPEN', priority: 2, comment: 'Back to open' })).body
        .code,
    ).toBe('GRV.TRANSITION_INVALID');
    expect(
      (await update(feedbackId, { status: 'CLOSED', priority: 2, comment: 'Done with this' })).body
        .errors[0].code,
    ).toBe('GRV.REASON_REQUIRED');
    const closed = await update(feedbackId, {
      status: 'CLOSED',
      priority: 2,
      reasonCode: 'SUGGESTION_ACCEPTED',
      comment: 'Fruit counter opens next month',
    });
    expect(closed.body.ticket.status).toBe('CLOSED');
    expect(
      (await update(feedbackId, { status: 'CLOSED', priority: 3, comment: 'Change priority' })).body
        .code,
    ).toBe('GRV.CLOSED_READ_ONLY');
    const told = await f.t.db
      .selectFrom('notifications')
      .select('title_key')
      .where('account_id', '=', asha.accountId)
      .where('title_key', '=', 'NTF.TICKET_UPDATED')
      .execute();
    expect(told).toHaveLength(2);
  });

  it('resolves with a refund only through a checker, which posts the ledger refund (Q14 M16)', async () => {
    const refund = { amount: inr('60.00') };
    expect(
      (
        await update(ticketId, {
          status: 'RESOLVED',
          priority: 2,
          reasonCode: 'REFUNDED',
          comment: 'Overcharged by ₹60; refunding',
          refund,
        })
      ).body.errors[0].code,
    ).toBe('GRV.REFUND_PRIORITY');
    const sent = await update(ticketId, {
      status: 'RESOLVED',
      priority: 1,
      reasonCode: 'REFUNDED',
      comment: 'Overcharged by ₹60; refunding',
      refund,
    });
    expect(sent.status, JSON.stringify(sent.body)).toBe(202);
    expect(sent.body).toMatchObject({
      code: 'GRV.SENT_FOR_APPROVAL',
      appliedDirectly: false,
      ticket: { status: 'OPEN', awaitingApproval: sent.body.approvalId },
    });
    expect(
      (await update(ticketId, { status: 'ESCALATED_VENDOR', priority: 2, comment: 'Meanwhile' }))
        .body.code,
    ).toBe('GRV.UPDATE_PENDING');
    const before = { asha: await f.balance(asha.wallet), canteen: await f.balance(canteen.wallet) };
    const p = checker();
    const a = await f.h.services.approvals.detail(p, 'console', sent.body.approvalId);
    expect(a.changes).toEqual(
      expect.arrayContaining([
        { label: 'Status', from: 'Open', to: 'Resolved' },
        { label: 'Refund', from: '—', to: '₹60.00' },
      ]),
    );
    await f.h.services.approvals.decide(p, 'console', sent.body.approvalId, a.version, {
      decision: 'APPROVE',
      remarks: 'Canteen confirmed the overcharge',
    });
    const after = await ticket(ticketId);
    expect(after.body).toMatchObject({ status: 'RESOLVED', priority: 1, awaitingApproval: null });
    expect(after.body.history[0]).toMatchObject({ status: 'RESOLVED', approved: true });
    expect(await f.balance(asha.wallet)).toBe(before.asha + 6_000);
    expect(await f.balance(canteen.wallet)).toBe(before.canteen - 6_000);
    const r = await f.t.db
      .selectFrom('refunds')
      .select(['status', 'source', 'amount_paise', 'refund_reference'])
      .where('original_reference', '=', paymentRef)
      .executeTakeFirstOrThrow();
    expect(r).toMatchObject({ status: 'PROCESSED', source: 'GRIEVANCE', amount_paise: '6000' });
    expect(r.refund_reference).toMatch(/^RPER/);

    // The member is satisfied and closes it; a new ticket on the same payment is possible again.
    const close = await send('post', `/api/v1/me/tickets/${ticketId}/closure`, asha.auth, {});
    expect(close.status, JSON.stringify(close.body)).toBe(200);
    expect(close.body.status).toBe('CLOSED');
    const again = await send('post', '/api/v1/me/tickets', asha.auth, {
      transactionRef: paymentRef,
      category: 'OTHER',
      issue: 'The refund shows but my receipt still says 120.',
    });
    expect(again.status, JSON.stringify(again.body)).toBe(201);
  });

  it('logs calls and records the support desk’s look-ups with their reason', async () => {
    const call = await send('post', '/api/v1/console/call-logs', f.school.con, {
      ticketId,
      direction: 'INBOUND',
      caller: 'Parent — Asha',
      minutes: 3,
      summary: 'Asked when the refund reaches the wallet',
    });
    expect(call.status, JSON.stringify(call.body)).toBe(201);
    expect(call.body).toMatchObject({ source: 'CONSOLE', ticket: { ticketNo } });
    const general = await send('post', '/api/v1/console/call-logs', f.school.con, {
      direction: 'OUTBOUND',
      caller: 'Canteen manager',
      minutes: 2,
      summary: 'Reminded about the price list',
    });
    expect(general.status).toBe(201);
    const calls = await request(f.app)
      .get(`/api/v1/console/call-logs?ticketId=${ticketId}`)
      .set(f.school.con);
    expect(calls.body.items).toHaveLength(1);

    const noReason = await request(f.app)
      .get(`/api/v1/ops/support/tickets?ticketNo=${ticketNo}`)
      .set(support);
    expect(noReason.body.errors[0].code).toBe('GRV.LOOKUP_REASON');
    const found = await request(f.app)
      .get(
        `/api/v1/ops/support/tickets?ticketNo=${ticketNo}&reason=Parent%20called%20the%20helpline`,
      )
      .set(support);
    expect(found.status, JSON.stringify(found.body)).toBe(200);
    expect(found.body.items).toEqual([
      expect.objectContaining({
        ticketNo,
        institution: expect.objectContaining({ id: f.school.id }),
      }),
    ]);
    const byMobile = await request(f.app)
      .get(`/api/v1/ops/support/tickets?mobile=${asha.mobile}&reason=Caller%20gave%20her%20mobile`)
      .set(support);
    expect(byMobile.body.items.length).toBeGreaterThanOrEqual(3);
    const txns = await request(f.app)
      .get(
        `/api/v1/ops/support/members/${f.school.id}/${asha.id}/transactions?reason=Checking%20the%20refund`,
      )
      .set(support);
    expect(txns.status, JSON.stringify(txns.body)).toBe(200);
    expect(txns.body.items.map((x: { type: string }) => x.type)).toContain('REFUND');
    const logged = await f.t.db
      .selectFrom('audit_log')
      .select(['action', 'reason'])
      .where('action', 'in', ['SUPPORT_TICKET_LOOKUP', 'SUPPORT_MEMBER_LOOKUP'])
      .where('institution_id', '=', f.school.rowId)
      .execute();
    expect(logged.map((l) => l.reason)).toEqual(expect.arrayContaining(['Checking the refund']));
    const desk = await send('post', '/api/v1/ops/support/call-logs', support, {
      institutionId: f.school.id,
      ticketId,
      direction: 'INBOUND',
      caller: 'Asha',
      minutes: 4,
      summary: 'Confirmed the refund reached the wallet',
    });
    expect(desk.status, JSON.stringify(desk.body)).toBe(201);
    expect(desk.body.source).toBe('SUPPORT');
  });
});
