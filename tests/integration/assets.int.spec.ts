/**
 * Asset groups, assets and vendor payments on a real MySQL (Phase 4.2; SRS 7.6, 7.7, 9.11 P4/P5/P8,
 * 12.6; INS-020…026, PAY-015, MER-013):
 * - groups and assets are created once per name, edited with If-Match and deactivated;
 * - a vendor's groups are set: inactive and unknown groups are skipped, an inactive group is not
 *   de-linked; a regular merchant has no groups;
 * - a vendor is paid only against an approved asset and an invoice, the invoice once — also when two
 *   payments race; the vendor lists its assets and the console its paid invoices.
 */
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { adminUrl } from './db';
import { inr, PIN, schoolFixture, type Auth, type Merchant } from './school';

describe.skipIf(!adminUrl)('assets and vendor payments on real MySQL', () => {
  let f: Awaited<ReturnType<typeof schoolFixture>>;
  let con: Auth;

  const post = (path: string, body: object) =>
    request(f.app).post(path).set(con).set('Idempotency-Key', randomUUID()).send(body);
  const patch = (path: string, version: number, body: object) =>
    request(f.app).patch(path).set(con).set('If-Match', `"v${version}"`).send(body);
  const link = (merchantId: string, groupIds: string[]) =>
    request(f.app)
      .put(`/api/v1/console/merchants/${merchantId}/asset-groups`)
      .set(con)
      .send({ groupIds });
  const payVendor = (
    who: { auth: Auth },
    m: Merchant,
    amount: string,
    vendor?: { assetId: string; invoiceNo: string },
  ) =>
    request(f.app)
      .post('/api/v1/me/payments')
      .set(who.auth)
      .set('Idempotency-Key', randomUUID())
      .send({
        qrPayload: m.qr.payload,
        amount: inr(amount),
        pin: PIN,
        ...(vendor ? { vendor } : {}),
      });

  async function group(name: string) {
    const r = await post('/api/v1/console/asset-groups', { name, description: `${name} items` });
    expect(r.status).toBe(201);
    return r.body.groupId as string;
  }
  async function asset(groupId: string, name: string) {
    const r = await post('/api/v1/console/assets', { groupId, name, type: 'PHYSICAL' });
    expect(r.status).toBe(201);
    return r.body.assetId as string;
  }

  beforeAll(async () => {
    f = await schoolFixture('Asset School');
    con = f.school.con;
  }, 180_000);
  afterAll(async () => {
    await f?.t.drop();
  });

  it('creates groups and assets once per name and edits them with If-Match (INS-020…025)', async () => {
    const g = await group('Lab Equipment');
    const dup = await post('/api/v1/console/asset-groups', { name: 'Lab Equipment' });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('INS.ASSET_GROUP_TAKEN');

    const a = await asset(g, 'Microscope');
    const dupAsset = await post('/api/v1/console/assets', {
      groupId: g,
      name: 'Microscope',
      type: 'PHYSICAL',
    });
    expect(dupAsset.body.code).toBe('INS.ASSET_TAKEN');
    const badType = await post('/api/v1/console/assets', { groupId: g, name: 'X', type: 'CAR' });
    expect(badType.status).toBe(422);
    const unknownGroup = await post('/api/v1/console/assets', {
      groupId: randomUUID(),
      name: 'Beaker',
      type: 'PHYSICAL',
    });
    expect(unknownGroup.status).toBe(404);

    const groups = await request(f.app).get('/api/v1/console/asset-groups').set(con);
    expect(groups.status).toBe(200);
    const row = groups.body.items.find((x: { id: string }) => x.id === g);
    expect(row).toMatchObject({ name: 'Lab Equipment', status: 'ACTIVE', assets: 1, vendors: 0 });

    const list = await request(f.app).get(`/api/v1/console/assets?groupId=${g}`).set(con);
    expect(list.body.items).toEqual([
      expect.objectContaining({ id: a, name: 'Microscope', type: 'PHYSICAL', status: 'ACTIVE' }),
    ]);
    const version = list.body.items[0].version as number;
    expect((await patch(`/api/v1/console/assets/${a}`, version + 1, { name: 'M' })).status).toBe(
      412,
    );
    const noMatch = await request(f.app)
      .patch(`/api/v1/console/assets/${a}`)
      .set(con)
      .send({ name: 'M' });
    expect(noMatch.status).toBe(428);
    const renamed = await patch(`/api/v1/console/assets/${a}`, version, {
      name: 'Compound Microscope',
      type: 'OTHER',
    });
    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({ name: 'Compound Microscope', type: 'OTHER' });
    expect(renamed.headers['etag']).toBe(`"v${version + 1}"`);

    const off = await patch(`/api/v1/console/asset-groups/${g}`, row.version, {
      status: 'INACTIVE',
    });
    expect(off.body.status).toBe('INACTIVE');
    const inactive = await request(f.app)
      .get('/api/v1/console/asset-groups?status=INACTIVE')
      .set(con);
    expect(inactive.body.items.map((x: { id: string }) => x.id)).toContain(g);
  });

  it('sets a vendor’s groups: skips inactive and unknown groups, keeps an inactive link (INS-026)', async () => {
    const v = await f.merchant('Stationery Vendor', { subType: 'VENDOR' });
    const regular = await f.merchant('Juice Corner');
    const books = await group('Books');
    const sports = await group('Sports Goods');
    const old = await group('Old Stock');
    const oldGroup = (
      await request(f.app).get('/api/v1/console/asset-groups').set(con)
    ).body.items.find((x: { id: string }) => x.id === old);
    await patch(`/api/v1/console/asset-groups/${old}`, oldGroup.version, { status: 'INACTIVE' });

    expect((await link(regular.id, [books])).body.code).toBe('MER.NOT_VENDOR');
    expect((await link(randomUUID(), [books])).status).toBe(404);

    const unknown = randomUUID();
    const set = await link(v.id, [books, sports, old, unknown]);
    expect(set.status).toBe(200);
    expect(set.body.linked.map((x: { id: string }) => x.id).sort()).toEqual([books, sports].sort());
    expect(set.body.skipped).toEqual(
      expect.arrayContaining([
        { groupId: old, reason: 'INACTIVE' },
        { groupId: unknown, reason: 'UNKNOWN' },
      ]),
    );

    // Sports is deactivated while linked: removing every group keeps it (27.2), Books goes.
    const sportsRow = (
      await request(f.app).get('/api/v1/console/asset-groups').set(con)
    ).body.items.find((x: { id: string }) => x.id === sports);
    expect(sportsRow.vendors).toBe(1);
    await patch(`/api/v1/console/asset-groups/${sports}`, sportsRow.version, {
      status: 'INACTIVE',
    });
    const cleared = await link(v.id, []);
    expect(cleared.body.linked).toEqual([
      expect.objectContaining({ id: sports, status: 'INACTIVE' }),
    ]);
    expect(cleared.body.skipped).toEqual([{ groupId: sports, reason: 'INACTIVE' }]);
  });

  it('pays a vendor only against an approved asset, each invoice once (PAY-002 P4/P5/P8, PAY-015, MER-013)', async () => {
    const v = await f.merchant('Uniform Vendor', { subType: 'VENDOR' });
    const g = await group('Uniforms');
    const shirt = await asset(g, 'School Shirt');
    const tie = await asset(g, 'School Tie');
    const other = await asset(await group('Furniture'), 'Desk');
    await link(v.id, [g]);
    const p = await f.payer('Meena', 100_000);

    const resolved = await request(f.app)
      .post('/api/v1/me/payments/resolve')
      .set(p.auth)
      .send({ qrPayload: v.qr.payload });
    expect(resolved.body.vendor).toEqual({ assetRequired: true, invoiceRequired: true });
    expect(resolved.body.stages).toContain('vendor');

    const mine = await request(f.app).get('/api/v1/merchant/assets').set(v.auth);
    expect(mine.status).toBe(200);
    expect(mine.body.items.map((x: { name: string }) => x.name)).toEqual([
      'School Shirt',
      'School Tie',
    ]);

    const none = await payVendor(p, v, '250.00');
    expect(none.status).toBe(422);
    expect(none.body).toMatchObject({ code: 'PAY.VENDOR_ASSET_REQUIRED', check: 'P8' });
    const notLinked = await payVendor(p, v, '250.00', { assetId: other, invoiceNo: 'INV1' });
    expect(notLinked.body).toMatchObject({ code: 'PAY.VENDOR_ASSET_REQUIRED', check: 'P4' });
    const bogus = await payVendor(p, v, '250.00', { assetId: 'not-an-asset', invoiceNo: 'INV1' });
    expect(bogus.body.check).toBe('P4');

    const paid = await payVendor(p, v, '250.00', { assetId: shirt, invoiceNo: 'inv1001' });
    expect(paid.status).toBe(201);
    expect(await f.balance(v.wallet)).toBe(25_000);
    const again = await payVendor(p, v, '250.00', { assetId: tie, invoiceNo: 'INV1001' });
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({
      code: 'PAY.INVOICE_ALREADY_PAID',
      check: 'P5',
      params: { invoiceNo: 'INV1001' },
    });

    // The tie is deactivated: no longer approved (P4), and gone from the vendor's list.
    const tieRow = (
      await request(f.app).get(`/api/v1/console/assets?groupId=${g}`).set(con)
    ).body.items.find((x: { id: string }) => x.id === tie);
    await patch(`/api/v1/console/assets/${tie}`, tieRow.version, { status: 'INACTIVE' });
    expect(
      (await payVendor(p, v, '40.00', { assetId: tie, invoiceNo: 'INV1002' })).body.check,
    ).toBe('P4');
    expect(
      (await request(f.app).get('/api/v1/merchant/assets').set(v.auth)).body.items.map(
        (x: { name: string }) => x.name,
      ),
    ).toEqual(['School Shirt']);

    const invoices = await request(f.app)
      .get(`/api/v1/console/vendor-invoices?merchantId=${v.id}`)
      .set(con);
    expect(invoices.status).toBe(200);
    expect(invoices.body.items).toEqual([
      expect.objectContaining({
        reference: paid.body.receipt.reference,
        invoiceNo: 'INV1001',
        asset: { id: shirt, name: 'School Shirt' },
        amount: inr('250.00'),
        payer: 'Meena',
        merchant: { id: v.id, name: 'Uniform Vendor' },
      }),
    ]);
  });

  it('pays an invoice once when two payments race (P5 under the vendor lock)', async () => {
    const v = await f.merchant('Transport Vendor', { subType: 'VENDOR' });
    const g = await group('Transport');
    const bus = await asset(g, 'Bus Pass');
    await link(v.id, [g]);
    const [a, b] = await Promise.all([f.payer('Ramesh', 50_000), f.payer('Sunita', 50_000)]);
    const results = await Promise.all([
      payVendor(a, v, '300.00', { assetId: bus, invoiceNo: 'TR77' }),
      payVendor(b, v, '300.00', { assetId: bus, invoiceNo: 'TR77' }),
    ]);
    const ok = results.filter((r) => r.status === 201);
    expect(ok).toHaveLength(1);
    const loser = results.find((r) => r.status !== 201)!;
    expect(loser.body).toMatchObject({ code: 'PAY.INVOICE_ALREADY_PAID', check: 'P5' });
    expect(await f.balance(v.wallet)).toBe(30_000);
    expect((await f.balance(a.wallet)) + (await f.balance(b.wallet))).toBe(70_000);
  });

  it('refuses another school’s groups, assets and vendors (tenant isolation)', async () => {
    const g = await group('Canteen Supplies');
    const other = await schoolFixture('Other Asset School');
    try {
      const ocon = other.school.con;
      expect(
        (
          await request(other.app)
            .patch(`/api/v1/console/asset-groups/${g}`)
            .set(ocon)
            .set('If-Match', '"v1"')
            .send({ name: 'Taken over' })
        ).status,
      ).toBe(404);
      const assets = await request(other.app).get(`/api/v1/console/assets?groupId=${g}`).set(ocon);
      expect(assets.body.items).toEqual([]);
    } finally {
      await other.t.drop();
    }
  }, 180_000);
});
