/**
 * The canteen point of sale on a real MySQL (Phase 4.6; SRS 12.8–12.10, 9.10, 6.34; IDN-042,
 * MER-001…012, MER-014…022):
 * - the first operator tag needs only the paired terminal; then operators sign in with their tag; one
 *   active tag per mobile; a re-issue stops the old tag at once;
 * - the outlet appears on first use; categories and items are unique per outlet; the server prices
 *   every order line with its GST and numbers the orders;
 * - a card tap against the order's one-time request pays it once through the engine (P3), from the
 *   campus wallet; a short balance leaves the order open with the reason; a coupon can cover it;
 * - offline captures are signed by the terminal and posted once; refusals never overdraw; re-sent
 *   captures are acknowledged; the console sees the counter's day;
 * - a POS partner bound to the school creates a QR for a counter's order, which a member pays once.
 */
import { createHmac, randomUUID } from 'node:crypto';
import request from 'supertest';
import { adminUrl } from './db';
import { inr, PIN, schoolFixture, type Auth, type Merchant } from './school';
import { istBusinessDate } from '../../utils/format';
import { captureMessage } from '../../services/pos.service';

const addDays = (date: string, n: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

describe.skipIf(!adminUrl)('canteen point of sale on real MySQL', () => {
  let f: Awaited<ReturnType<typeof schoolFixture>>;
  let con: Auth;
  let canteen: Merchant;
  let counter: Awaited<ReturnType<typeof f.terminal>>;
  let ramesh: string;
  const today = istBusinessDate(new Date());

  const post = (path: string, body: object = {}, auth: Auth = counter.auth) =>
    request(f.app).post(path).set(auth).set('Idempotency-Key', randomUUID()).send(body);
  const signIn = (operatorTag: string) =>
    post('/api/v1/terminal/pos/operators/signin', { operatorTag });
  const menu = async () =>
    (await request(f.app).get('/api/v1/terminal/pos/menu').set(counter.auth)).body;
  const itemId = async (name: string) =>
    (
      (await menu()).categories.flatMap(
        (c: { items: { id: string; name: string }[] }) => c.items,
      ) as {
        id: string;
        name: string;
      }[]
    ).find((i) => i.name === name)!.id;
  const order = (lines: { itemId: string; qty: number }[], type = 'DINE_IN') =>
    post('/api/v1/terminal/pos/orders', { type, lines });

  beforeAll(async () => {
    f = await schoolFixture('POS School');
    con = f.school.con;
    canteen = await f.merchant('Annapoorna Canteen');
    counter = await f.terminal('POS', { merchantId: canteen.id });
  }, 180_000);
  afterAll(async () => {
    await f?.t.drop();
  });

  it('registers the first tag on the paired terminal, signs operators in and re-issues tags (IDN-042, MER-011/021/022)', async () => {
    const first = await menu();
    expect(first.outlet).toMatchObject({
      name: 'Annapoorna Canteen',
      merchant: 'Annapoorna Canteen',
    });
    expect(first.operator).toBeNull();
    // The terminal's own identity card (ATT-001).
    const cfg = await request(f.app).get('/api/v1/terminal/reader/config').set(counter.auth);
    expect(cfg.body).toMatchObject({
      terminal: { id: counter.id, purpose: 'POS', location: 'Main block' },
      merchant: 'Annapoorna Canteen',
      institution: { status: 'ACTIVE' },
    });
    expect(cfg.body.institution.name).toMatch(/^POS School/);
    expect(cfg.body.terminal.fingerprint).toMatch(/^[0-9A-F-]{9}$/);
    expect((await post('/api/v1/terminal/pos/categories', { name: 'Meals' })).body.code).toBe(
      'TRM.OPERATOR_REQUIRED',
    );

    const tag = await post('/api/v1/terminal/pos/operator-tags', {
      operatorName: 'Ramesh Poojary',
      operatorMobile: '9901234567',
    });
    expect(tag.status, JSON.stringify(tag.body)).toBe(201);
    expect(tag.body.tag).toMatchObject({ operatorName: 'Ramesh Poojary', status: 'ACTIVE' });
    expect(tag.body.tagToken).toMatch(/^OT[A-Z2-9]{20}$/);
    ramesh = tag.body.tagToken;
    // Once a tag exists, an operator registers the next ones.
    expect(
      (
        await post('/api/v1/terminal/pos/operator-tags', {
          operatorName: 'Shanthi Naik',
          operatorMobile: '9741188220',
        })
      ).body.code,
    ).toBe('TRM.OPERATOR_REQUIRED');

    expect((await signIn('OTWRONGTOKEN')).body.code).toBe('TRM.OPERATOR_INVALID');
    const ok = await signIn(ramesh);
    expect(ok.status).toBe(200);
    expect(ok.body.operator).toMatchObject({ name: 'Ramesh Poojary', mobile: '••••••4567' });

    expect(
      (
        await post('/api/v1/terminal/pos/operator-tags', {
          operatorName: 'Ramesh P',
          operatorMobile: '9901234567',
        })
      ).body,
    ).toMatchObject({ code: 'MER.TAG_ACTIVE_EXISTS', params: { name: 'Ramesh Poojary' } });
    const shanthi = await post('/api/v1/terminal/pos/operator-tags', {
      operatorName: 'Shanthi Naik',
      operatorMobile: '9741188220',
    });
    expect(shanthi.status).toBe(201);

    // Re-issue Ramesh's tag: the old one stops at once; he stays signed in on the new one.
    const re = await post(`/api/v1/terminal/pos/operator-tags/${tag.body.tag.id}/reissue`, {
      reason: 'Tag damaged near the dishwasher',
    });
    expect(re.status, JSON.stringify(re.body)).toBe(201);
    expect(re.body.tag).toMatchObject({
      reissueCount: 1,
      reissueReason: 'Tag damaged near the dishwasher',
    });
    expect((await signIn(ramesh)).body.code).toBe('TRM.OPERATOR_INVALID');
    expect(
      (
        await post(`/api/v1/terminal/pos/operator-tags/${tag.body.tag.id}/reissue`, {
          reason: 'Lost',
        })
      ).body.code,
    ).toBe('MER.TAG_NOT_ACTIVE');
    ramesh = re.body.tagToken;
    expect((await signIn(ramesh)).status).toBe(200);
    const tags = await request(f.app).get('/api/v1/terminal/pos/operator-tags').set(counter.auth);
    expect(tags.body.items.map((x: { status: string }) => x.status)).toEqual([
      'ACTIVE',
      'ACTIVE',
      'INACTIVE',
    ]);
    expect(tags.body.items.find((x: { signedInNow: boolean }) => x.signedInNow).operatorName).toBe(
      'Ramesh Poojary',
    );
    // Signing out ends the operator's session; the terminal stays paired.
    expect((await post('/api/v1/terminal/pos/operators/signout')).status).toBe(204);
    expect((await menu()).operator).toBeNull();
    expect((await signIn(ramesh)).status).toBe(200);
  });

  it('keeps the menu unique per outlet and prices every order on the server with GST (MER-001…007, MER-020)', async () => {
    const meals = await post('/api/v1/terminal/pos/categories', { name: 'Meals' });
    expect(meals.status).toBe(201);
    expect((await post('/api/v1/terminal/pos/categories', { name: 'meals' })).body).toMatchObject({
      code: 'MER.CATEGORY_TAKEN',
    });
    const drinks = (await post('/api/v1/terminal/pos/categories', { name: 'Drinks' })).body;
    const item = (body: object) => post('/api/v1/terminal/pos/items', body);
    const thali = await item({ categoryId: meals.body.id, name: 'Veg thali', price: inr('60.00') });
    expect(thali.status, JSON.stringify(thali.body)).toBe(201);
    expect(thali.body).toMatchObject({ gstRate: 5, available: true, price: inr('60.00') });
    expect(
      (
        await item({
          categoryId: drinks.id,
          name: 'Filter coffee',
          price: inr('15.00'),
          gstRate: 5,
        })
      ).status,
    ).toBe(201);
    expect(
      (await item({ categoryId: meals.body.id, name: 'veg THALI', price: inr('70.00') })).body,
    ).toMatchObject({ code: 'MER.ITEM_TAKEN', params: { name: 'veg THALI' } });
    expect(
      (
        await item({
          categoryId: meals.body.id,
          name: 'Curd rice',
          price: inr('30.00'),
          gstRate: 7,
        })
      ).body.errors[0],
    ).toMatchObject({ field: 'gstRate' });
    expect(
      (await item({ categoryId: randomUUID(), name: 'Curd rice', price: inr('30.00') })).body.code,
    ).toBe('MER.CATEGORY_UNKNOWN');
    expect(
      (await item({ categoryId: meals.body.id, name: 'Curd rice', price: inr('0.50') })).body
        .errors[0],
    ).toMatchObject({ field: 'price', code: 'VALIDATION.AMOUNT' });

    // Outlet details with If-Match.
    const m = await menu();
    const put = (version: number, body: object) =>
      request(f.app)
        .put('/api/v1/terminal/pos/outlet')
        .set(counter.auth)
        .set('If-Match', `"v${version}"`)
        .send(body);
    const outlet = {
      name: 'Annapoorna Canteen',
      opensAt: '07:30',
      closesAt: '17:00',
      gstin: '29ABCDE1234F1Z5',
    };
    expect((await put(m.outlet.version, { ...outlet, closesAt: '07:00' })).body.code).toBe(
      'MER.OUTLET_HOURS',
    );
    expect((await put(m.outlet.version, { ...outlet, gstin: '29ABC' })).body.errors[0].field).toBe(
      'gstin',
    );
    const saved = await put(m.outlet.version, outlet);
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({
      opensAt: '07:30',
      closesAt: '17:00',
      gstin: '29ABCDE1234F1Z5',
    });
    expect((await put(m.outlet.version, outlet)).status).toBe(412);

    // An order: the terminal sends items and quantities only.
    const [thaliId, coffeeId] = [await itemId('Veg thali'), await itemId('Filter coffee')];
    const o1 = await order([
      { itemId: thaliId, qty: 2 },
      { itemId: coffeeId, qty: 1 },
    ]);
    expect(o1.status, JSON.stringify(o1.body)).toBe(201);
    const mmdd = `${today.slice(5, 7)}${today.slice(8, 10)}`;
    expect(o1.body).toMatchObject({
      number: `ORD-${mmdd}-001`,
      status: 'CREATED',
      payment: 'PENDING',
      subtotal: inr('135.00'),
      tax: inr('6.75'),
      cgst: inr('3.37'),
      sgst: inr('3.38'),
      total: inr('141.75'),
      operator: 'Ramesh Poojary',
    });
    expect(o1.body.lines[0]).toMatchObject({
      name: 'Veg thali',
      qty: 2,
      net: inr('120.00'),
      tax: inr('6.00'),
    });

    // An item marked not available can't be ordered; an unknown one is refused.
    const coffee = (await menu()).categories[1].items[0];
    const off = await request(f.app)
      .patch(`/api/v1/terminal/pos/items/${coffee.id}`)
      .set(counter.auth)
      .set('If-Match', `"v${coffee.version}"`)
      .send({ available: false });
    expect(off.body.available).toBe(false);
    expect((await order([{ itemId: coffeeId, qty: 1 }])).body).toMatchObject({
      code: 'MER.ITEM_UNAVAILABLE',
      params: { name: 'Filter coffee' },
    });
    expect((await order([{ itemId: randomUUID(), qty: 1 }])).body.code).toBe('MER.ITEM_UNKNOWN');

    const o2 = await order([{ itemId: thaliId, qty: 1 }], 'TAKEAWAY');
    expect(o2.body.number).toBe(`ORD-${mmdd}-002`);
    const cancel = () => post(`/api/v1/terminal/pos/orders/${o2.body.id}/cancellation`, {});
    expect((await cancel()).body.status).toBe('CANCELLED');
    expect((await cancel()).body.code).toBe('MER.ORDER_PAID');

    const day = await request(f.app).get('/api/v1/terminal/pos/orders').set(counter.auth);
    expect(day.body.summary).toMatchObject({
      orders: 2,
      unpaid: { count: 1, amount: inr('141.75') },
      collected: inr('0.00'),
    });
    expect(day.body.items[0].number).toBe(`ORD-${mmdd}-002`);
  });

  it('collects an order by card tap once through the payment engine (MER-017/018/008, P3)', async () => {
    const thaliId = await itemId('Veg thali');
    const asha = await f.student('Asha', 50_000);
    const card = await f.card(asha.rowId);
    const o = (await order([{ itemId: thaliId, qty: 1 }])).body; // ₹63.00
    const req = await post(`/api/v1/terminal/pos/orders/${o.id}/payment-requests`, {
      instrument: 'WALLET',
    });
    expect(req.status).toBe(201);
    expect(req.body).toMatchObject({ amount: inr('63.00'), ttlSeconds: 120 });
    const collect = (body: object) => post(`/api/v1/terminal/pos/orders/${o.id}/collections`, body);
    expect(
      (
        await collect({
          instrument: 'WALLET',
          cardToken: card,
          requestId: req.body.requestId,
          nonce: 'x',
        })
      ).body.code,
    ).toBe('PAY.NONCE_REPLAY');

    const before = [await f.balance(asha.wallet), await f.balance(canteen.wallet)];
    // Two taps race with the same nonce: one pays, the other is refused; money moves once.
    const both = await Promise.all(
      [1, 2].map(() =>
        collect({
          instrument: 'WALLET',
          cardToken: card,
          requestId: req.body.requestId,
          nonce: req.body.nonce,
        }),
      ),
    );
    const paid = both.find((r) => r.status === 201)!;
    expect(paid, JSON.stringify(both.map((r) => r.body))).toBeDefined();
    expect(both.filter((r) => r.status === 201)).toHaveLength(1);
    expect(paid.body.order).toMatchObject({
      status: 'PAID',
      payment: 'SUCCESS',
      instrument: 'WALLET',
    });
    expect(paid.body.receipt).toMatchObject({ amount: inr('63.00'), payer: { name: 'Asha Rao' } });
    expect(paid.body.receipt.reference).toMatch(/^RPEP/);
    expect(await f.balance(asha.wallet)).toBe(before[0]! - 6_300);
    expect(await f.balance(canteen.wallet)).toBe(before[1]! + 6_300);
    const attempt = await f.t.db
      .selectFrom('payment_attempts')
      .select(['channel', 'status'])
      .where('reference', '=', paid.body.receipt.reference)
      .executeTakeFirstOrThrow();
    expect(attempt).toMatchObject({ channel: 'NFC', status: 'SUCCESS' });
    expect(
      (await post(`/api/v1/terminal/pos/orders/${o.id}/payment-requests`, { instrument: 'WALLET' }))
        .body.code,
    ).toBe('MER.ORDER_PAID');

    // A short balance: refused at V13, the order stays open with the reason; nothing moves.
    const ravi = await f.student('Ravi', 1_000);
    const raviCard = await f.card(ravi.rowId);
    const o2 = (await order([{ itemId: thaliId, qty: 1 }])).body;
    const r2 = (
      await post(`/api/v1/terminal/pos/orders/${o2.id}/payment-requests`, { instrument: 'WALLET' })
    ).body;
    const short = await post(`/api/v1/terminal/pos/orders/${o2.id}/collections`, {
      instrument: 'WALLET',
      cardToken: raviCard,
      requestId: r2.requestId,
      nonce: r2.nonce,
    });
    // The counter is told the balance is short, never the holder's balance (RNG-GOV-007).
    expect(short.body).toMatchObject({ check: 'V13', code: 'PAY.CARD_BALANCE_SHORT' });
    expect(JSON.stringify(short.body)).not.toMatch(/₹|shortfall|"params"/);
    expect(await f.balance(ravi.wallet)).toBe(1_000);
    const day = (await request(f.app).get('/api/v1/terminal/pos/orders').set(counter.auth)).body;
    expect(day.items.find((x: { id: string }) => x.id === o2.id)).toMatchObject({
      status: 'CREATED',
      payment: 'FAILED',
      lastFailureCode: short.body.code,
    });
    // A new request replaces the old one; cancelling it leaves the order unpaid.
    const r3 = (
      await post(`/api/v1/terminal/pos/orders/${o2.id}/payment-requests`, { instrument: 'WALLET' })
    ).body;
    const cancel = await post(`/api/v1/terminal/pos/payment-requests/${r3.requestId}/cancellation`);
    expect(cancel.body).toEqual({ requestId: r3.requestId, status: 'CANCELLED' });
    expect(
      (await post(`/api/v1/terminal/pos/payment-requests/${r3.requestId}/cancellation`)).body.code,
    ).toBe('PAY.REQUEST_NOT_PENDING');
  });

  it("covers an order with the holder's coupon (MER-008 COUPON)", async () => {
    const thaliId = await itemId('Veg thali');
    await f.feature('coupons', true);
    const tomorrow = addDays(today, 1);
    const type = await post(
      '/api/v1/console/coupon-types',
      {
        name: 'Canteen meal',
        kind: 'OTHER',
        holdMax: 5,
        redeemMax: 1,
        window: { start: '00:00', end: '23:59' },
      },
      con,
    );
    expect(type.status, JSON.stringify(type.body)).toBe(201);
    const meera = await f.student('Meera');
    const issued = await post(
      '/api/v1/console/coupon-issuances',
      { typeIds: [type.body.id], from: tomorrow, to: tomorrow, studentIds: [meera.id] },
      con,
    );
    expect(issued.body.created).toBe(1);
    await f.t.db
      .updateTable('coupons')
      .set({ valid_on: today })
      .where('profile_id', '=', meera.rowId)
      .execute();
    const card = await f.card(meera.rowId);
    const o = (await order([{ itemId: thaliId, qty: 1 }])).body;
    const covered = await post(`/api/v1/terminal/pos/orders/${o.id}/collections`, {
      instrument: 'COUPON',
      cardToken: card,
    });
    expect(covered.status, JSON.stringify(covered.body)).toBe(201);
    expect(covered.body).toMatchObject({
      order: { status: 'PAID', instrument: 'COUPON', payer: { name: 'Meera Rao' } },
      coupon: { type: 'Canteen meal' },
      receipt: null,
    });
    // The coupon is used: another order finds none.
    const o2 = (await order([{ itemId: thaliId, qty: 1 }])).body;
    expect(
      (
        await post(`/api/v1/terminal/pos/orders/${o2.id}/collections`, {
          instrument: 'COUPON',
          cardToken: card,
        })
      ).body.code,
    ).toBe('CPN.NONE_ACTIVE');
  });

  it('posts signed offline captures once and never overdraws (MER-009/010, MER-012)', async () => {
    const thaliId = await itemId('Veg thali');
    const kiran = await f.student('Kiran', 30_000);
    const kiranCard = await f.card(kiran.rowId);
    const poor = await f.student('Pooja', 500);
    const poorCard = await f.card(poor.rowId);
    const online = (await order([{ itemId: thaliId, qty: 1 }])).body; // ₹63.00, created before going offline
    const now = new Date().toISOString();
    const sign = (c: {
      captureKey: string;
      cardToken: string;
      amountPaise: number;
      orderId?: string;
      capturedAt: string;
    }) => createHmac('sha256', counter.credential).update(captureMessage(c)).digest('hex');
    const capture = (o: {
      key: string;
      card: string;
      paise: number;
      orderId?: string;
      lines?: { itemId: string; qty: number }[];
      at?: string;
      badSignature?: boolean;
    }) => {
      const at = o.at ?? now;
      const signature = o.badSignature
        ? '0'.repeat(64)
        : sign({
            captureKey: o.key,
            cardToken: o.card,
            amountPaise: o.paise,
            orderId: o.orderId,
            capturedAt: at,
          });
      return {
        captureKey: o.key,
        ...(o.orderId ? { orderId: o.orderId } : { order: { type: 'TAKEAWAY', lines: o.lines } }),
        cardToken: o.card,
        instrument: 'WALLET',
        amount: inr((o.paise / 100).toFixed(2)),
        capturedAt: at,
        signature,
      };
    };
    const keys = Array.from({ length: 6 }, () => `OFF-${randomUUID()}`);
    const batchId = randomUUID();
    const kiranBefore = await f.balance(kiran.wallet);
    const body = {
      batchId,
      captures: [
        capture({ key: keys[0]!, card: kiranCard, paise: 6_300, orderId: online.id }),
        capture({
          key: keys[1]!,
          card: kiranCard,
          paise: 12_600,
          lines: [{ itemId: thaliId, qty: 2 }],
        }),
        capture({
          key: keys[2]!,
          card: poorCard,
          paise: 6_300,
          lines: [{ itemId: thaliId, qty: 1 }],
        }),
        capture({
          key: keys[3]!,
          card: kiranCard,
          paise: 6_300,
          lines: [{ itemId: thaliId, qty: 1 }],
          badSignature: true,
        }),
        capture({
          key: keys[4]!,
          card: kiranCard,
          paise: 6_300,
          lines: [{ itemId: thaliId, qty: 1 }],
          at: new Date(Date.now() - 4 * 86_400_000).toISOString(),
        }),
        capture({
          key: keys[5]!,
          card: kiranCard,
          paise: 5_000,
          lines: [{ itemId: thaliId, qty: 1 }],
        }),
      ],
    };
    const sent = await post('/api/v1/terminal/pos/offline-batches', body);
    expect(sent.status, JSON.stringify(sent.body)).toBe(201);
    const outcomes = sent.body.captures.map((c: { outcome: string; code: string | null }) => [
      c.outcome,
      c.code,
    ]);
    expect(outcomes.slice(0, 2)).toEqual([
      ['ACCEPTED', null],
      ['ACCEPTED', null],
    ]);
    expect(outcomes[2][0]).toBe('REFUSED'); // Pooja can't afford it (Q14 M8)
    expect(outcomes.slice(3)).toEqual([
      ['REFUSED', 'MER.CAPTURE_SIGNATURE'],
      ['REFUSED', 'MER.CAPTURE_TOO_OLD'],
      ['REFUSED', 'MER.CAPTURE_AMOUNT_MISMATCH'],
    ]);
    expect(sent.body.summary).toEqual({ accepted: 2, refused: 4, replayed: 0 });
    expect(sent.body.captures[0].order.id).toBe(online.id);
    expect(sent.body.captures[1].reference).toMatch(/^RPEP/);
    expect(await f.balance(kiran.wallet)).toBe(kiranBefore - 18_900);
    expect(await f.balance(poor.wallet)).toBe(500);

    // The same batch again, and a new batch carrying the same captures: acknowledged, not posted.
    const again = await post('/api/v1/terminal/pos/offline-batches', body);
    expect(again.status).toBe(200);
    expect(again.body.summary).toEqual(sent.body.summary);
    const resend = await post('/api/v1/terminal/pos/offline-batches', {
      batchId: randomUUID(),
      captures: body.captures.slice(0, 2),
    });
    expect(resend.body.summary).toEqual({ accepted: 0, refused: 0, replayed: 2 });
    expect(resend.body.captures[0]).toMatchObject({ outcome: 'ACCEPTED', replayed: true });
    expect(await f.balance(kiran.wallet)).toBe(kiranBefore - 18_900);
    const read = await request(f.app)
      .get(`/api/v1/terminal/pos/offline-batches/${batchId}`)
      .set(counter.auth);
    expect(read.body.captures).toHaveLength(6);

    const day = (await request(f.app).get('/api/v1/terminal/pos/orders').set(counter.auth)).body;
    expect(day.items.find((x: { id: string }) => x.id === online.id).status).toBe('PAID');
    expect(day.items.filter((x: { offline: boolean }) => x.offline)).toHaveLength(2); // Kiran's and Pooja's
    expect(day.summary.offline).toEqual({ accepted: 2, refused: 4 });

    const consoleView = await request(f.app).get('/api/v1/console/pos-terminals').set(con);
    expect(consoleView.status).toBe(200);
    expect(consoleView.body.items[0]).toMatchObject({
      id: counter.id,
      merchant: 'Annapoorna Canteen',
      outlet: 'Annapoorna Canteen',
      operator: 'Ramesh Poojary',
      today: { offlineAccepted: 2, offlineRefused: 4 },
    });
    expect(consoleView.body.items[0].lastSyncAt).not.toBeNull();
  });

  it("lets a POS partner bound to the school create a counter's QR that a member pays once (MER-014…016)", async () => {
    const thaliId = await itemId('Veg thali');
    const base = {
      name: 'Example POS vendor',
      partner: 'POS_VENDOR',
      scopes: ['pos.qr-create', 'pos.qr-status', 'pos.offline-sync'],
      ipAllowlist: ['127.0.0.1', '::1'],
    };
    expect((await post('/api/v1/ops/api-clients', base, f.ops)).body.errors[0].field).toBe(
      'institutionId',
    );
    const client = (
      await post('/api/v1/ops/api-clients', { ...base, institutionId: f.school.id }, f.ops)
    ).body;
    const tok = await request(f.app).post('/api/v1/partners/oauth/token').send({
      grant_type: 'client_credentials',
      client_id: client.clientId,
      client_secret: client.secret,
    });
    expect(tok.status, JSON.stringify(tok.body)).toBe(200);
    const signed = (method: 'post' | 'get', path: string, body?: object) => {
      const raw = body ? JSON.stringify(body) : '';
      const ts = Math.floor(Date.now() / 1000);
      const sig = createHmac('sha256', client.secret).update(`${ts}.${raw}`).digest('hex');
      const r = request(f.app)
        [method](path)
        .set('Authorization', `Bearer ${tok.body.access_token as string}`)
        .set('X-CampusOne-Timestamp', String(ts))
        .set('X-CampusOne-Signature', `v1=${sig}`);
      return body ? r.set('Content-Type', 'application/json').send(raw) : r;
    };

    const o = (await order([{ itemId: thaliId, qty: 1 }])).body;
    const created = await signed('post', '/api/v1/partners/pos/payment-requests', {
      requestId: randomUUID(),
      terminalRef: counter.id,
      amount: inr('63.00'),
      orderRef: o.id,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    expect(created.body).toMatchObject({ amount: inr('63.00'), ttlSeconds: 120 });
    expect(
      (
        await signed('post', '/api/v1/partners/pos/payment-requests', {
          requestId: randomUUID(),
          terminalRef: counter.id,
          amount: inr('60.00'),
          orderRef: o.id,
        })
      ).body.code,
    ).toBe('MER.CAPTURE_AMOUNT_MISMATCH');
    const reader = await f.terminal('BALANCE_CHECK');
    expect(
      (
        await signed('post', '/api/v1/partners/pos/payment-requests', {
          requestId: randomUUID(),
          terminalRef: reader.id,
          amount: inr('10.00'),
        })
      ).body.code,
    ).toBe('MER.POS_TERMINAL_UNKNOWN');

    // A member pays it from the app (channel POS QR); the order is paid in the same transaction.
    const payer = await f.payer('Suma', 20_000);
    const pay = await request(f.app)
      .post('/api/v1/me/payments')
      .set(payer.auth)
      .set('Idempotency-Key', randomUUID())
      .send({ qrPayload: created.body.qrPayload, pin: PIN });
    expect(pay.status, JSON.stringify(pay.body)).toBe(201);
    expect(pay.body.receipt.channel).toBe('POS_QR');
    const status = await signed(
      'get',
      `/api/v1/partners/pos/payment-requests/${created.body.requestId}`,
    );
    expect(status.body).toMatchObject({
      status: 'SUCCESS',
      receiptRef: pay.body.receipt.reference,
      order: { id: o.id, status: 'PAID' },
    });
    const again = await request(f.app)
      .post('/api/v1/me/payments')
      .set(payer.auth)
      .set('Idempotency-Key', randomUUID())
      .send({ qrPayload: created.body.qrPayload, pin: PIN });
    expect(again.status).toBe(409);
    expect(await f.balance(payer.wallet)).toBe(20_000 - 6_300);

    // The partner uploads an offline capture of its counter (the signed call covers it).
    const nisha = await f.student('Nisha', 10_000);
    const nishaCard = await f.card(nisha.rowId);
    const o2 = (await order([{ itemId: thaliId, qty: 1 }])).body;
    const upload = {
      requestId: randomUUID(),
      terminalRef: counter.id,
      batchId: randomUUID(),
      captures: [
        {
          captureKey: `PTN-${randomUUID()}`,
          orderId: o2.id,
          cardToken: nishaCard,
          instrument: 'WALLET',
          amount: inr('63.00'),
          capturedAt: new Date().toISOString(),
        },
      ],
    };
    const synced = await signed('post', '/api/v1/partners/pos/offline-captures', upload);
    expect(synced.status, JSON.stringify(synced.body)).toBe(200);
    expect(synced.body.summary).toEqual({ accepted: 1, refused: 0, replayed: 0 });
    // The same call again returns the first answer; nothing is posted twice.
    const twice = await signed('post', '/api/v1/partners/pos/offline-captures', upload);
    expect(twice.body.summary).toEqual({ accepted: 1, refused: 0, replayed: 0 });
    expect(await f.balance(nisha.wallet)).toBe(10_000 - 6_300);
  });
  it("keeps one counter's outlet out of another's (RNG-MER-071, RNG-GOV-006)", async () => {
    const thaliId = await itemId('Veg thali');
    const o = (await order([{ itemId: thaliId, qty: 1 }])).body;
    const juice = await f.merchant('Juice Bar');
    const other = await f.terminal('POS', { merchantId: juice.id });
    const as = (path: string, body: object = {}) => post(path, body, other.auth);
    const tag = await as('/api/v1/terminal/pos/operator-tags', {
      operatorName: 'Ganesh Acharya',
      operatorMobile: '9632045571',
    });
    expect(tag.status).toBe(201);
    expect(
      (await as('/api/v1/terminal/pos/operators/signin', { operatorTag: ramesh })).body.code,
    ).toBe('TRM.OPERATOR_INVALID');
    expect(
      (await as('/api/v1/terminal/pos/operators/signin', { operatorTag: tag.body.tagToken }))
        .status,
    ).toBe(200);
    const theirs = await request(f.app).get('/api/v1/terminal/pos/menu').set(other.auth);
    expect(theirs.body.outlet.name).toBe('Juice Bar');
    expect(theirs.body.categories).toEqual([]);
    expect(
      (
        await as('/api/v1/terminal/pos/orders', {
          type: 'DINE_IN',
          lines: [{ itemId: thaliId, qty: 1 }],
        })
      ).body.code,
    ).toBe('MER.ITEM_UNKNOWN');
    expect((await as(`/api/v1/terminal/pos/orders/${o.id}/cancellation`)).status).toBe(404);
    expect(
      (await as(`/api/v1/terminal/pos/orders/${o.id}/payment-requests`, { instrument: 'WALLET' }))
        .status,
    ).toBe(404);
    const day = await request(f.app).get('/api/v1/terminal/pos/orders').set(other.auth);
    expect(day.body.items).toEqual([]);
    const tags = (await request(f.app).get('/api/v1/terminal/pos/operator-tags').set(counter.auth))
      .body.items as { id: string }[];
    expect(
      (
        await as(`/api/v1/terminal/pos/operator-tags/${tags[0]!.id}/reissue`, {
          reason: 'Not mine',
        })
      ).status,
    ).toBe(404);
    // A newly paired device starts without the previous operator (6.34).
    expect(
      (await request(f.app).get('/api/v1/terminal/pos/menu').set(other.auth)).body.operator,
    ).not.toBeNull();
    const code = await post(`/api/v1/console/readers/${other.id}/pairing-codes`, {}, con);
    expect(
      (
        await request(f.app)
          .post('/api/v1/terminal/pairing')
          .send({ pairingCode: code.body.code, deviceFingerprint: `device-${randomUUID()}` })
      ).status,
    ).toBe(201);
    expect(
      (await request(f.app).get('/api/v1/terminal/pos/menu').set(other.auth)).body.operator,
    ).toBeNull();
    // A terminal of another purpose can't use the point of sale.
    const gate = await f.terminal('BALANCE_CHECK');
    expect((await request(f.app).get('/api/v1/terminal/pos/menu').set(gate.auth)).body.code).toBe(
      'TRM.WRONG_PURPOSE',
    );
  });
});
