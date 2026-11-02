/**
 * The testers' Postman collection for adding money to a wallet (CampusOne_Axis_Bank_Test.postman_
 * collection.json, client 2026-10-22) on a real MySQL: its three requests, played as Postman plays
 * them — the variables filled in, its pre-request and test scripts run — credit the wallet whose
 * account number the app shows; the next run is another transfer; a repeat of the credit is refused.
 * It keeps the collection in step with the bank calls (BNK-001…003).
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import request from 'supertest';
import { adminUrl } from './db';
import { schoolFixture, type Payer } from './school';

interface Item {
  name: string;
  event?: { listen: 'prerequest' | 'test'; script: { exec: string[] } }[];
  request: {
    method: string;
    header: { key: string; value: string }[];
    body: { raw: string };
    url: { path: string[] };
  };
}
const collection = JSON.parse(
  readFileSync(
    new URL('../../CampusOne_Axis_Bank_Test.postman_collection.json', import.meta.url),
    'utf8',
  ),
) as { variable: { key: string; value: string }[]; item: Item[] };

describe.skipIf(!adminUrl)('the Postman collection that adds money to a wallet', () => {
  let f: Awaited<ReturnType<typeof schoolFixture>>;
  let meena: Payer;
  const vars: Record<string, string> = {};
  const fill = (s: string) => s.replace(/\{\{(\w+)\}\}/g, (_, k: string) => vars[k] ?? '');

  /** What Postman gives a script: the collection's variables, the response, tests. */
  const pmOf = (res?: { status: number; body: unknown }) => {
    const passed: string[] = [];
    const pm = {
      collectionVariables: {
        get: (k: string) => vars[k],
        set: (k: string, v: unknown) => {
          vars[k] = String(v);
        },
      },
      response: res && {
        code: res.status,
        json: () => res.body,
        to: { have: { status: (n: number) => expect(res.status).toBe(n) } },
      },
      expect: (v: unknown, message?: string) => ({
        to: {
          eql: (x: unknown) => expect(v, message).toEqual(x),
          be: { a: (type: string) => expect(typeof v, message).toBe(type) },
        },
      }),
      test: (name: string, fn: () => void) => {
        fn();
        passed.push(name);
      },
    };
    return { pm, passed };
  };
  const run = (
    item: Item,
    listen: 'prerequest' | 'test',
    res?: { status: number; body: unknown },
  ) => {
    const code = item.event?.find((e) => e.listen === listen)?.script.exec.join('\n');
    if (!code) return [];
    const { pm, passed } = pmOf(res);
    const quiet = { log: () => undefined, warn: () => undefined };
    new Function('pm', 'console', code)(pm, quiet);
    return passed;
  };
  /** Sends one of the collection's requests (by its number), as Postman would. */
  const send = async (n: number) => {
    const item = collection.item[n - 1]!;
    run(item, 'prerequest');
    let r = request(f.app).post(`/${item.request.url.path.join('/')}`);
    for (const h of item.request.header) r = r.set(h.key, fill(h.value));
    const res = await r.send(JSON.parse(fill(item.request.body.raw)) as object);
    return { res, passed: run(item, 'test', { status: res.status, body: res.body }) };
  };
  const balance = async () =>
    Number(
      (
        await f.t.db
          .selectFrom('wallet_balances')
          .select('available_paise')
          .where('wallet_id', '=', meena.wallet)
          .executeTakeFirstOrThrow()
      ).available_paise,
    );

  beforeAll(async () => {
    f = await schoolFixture('Postman');
    // The back office's test client: both scopes, this computer's address.
    const created = await request(f.app)
      .post('/api/v1/ops/api-clients')
      .set(f.ops)
      .set('Idempotency-Key', randomUUID())
      .send({
        name: 'Axis Bank test',
        partner: 'SPONSOR_BANK',
        scopes: ['va.validate', 'va.notify'],
        ipAllowlist: ['127.0.0.1', '::1'],
      });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    meena = await f.payer('Meena', 0);
    // The account number the app shows under Wallet → Add money (WAL-003).
    const wallets = await request(f.app).get('/api/v1/me/wallets').set(meena.auth);
    const w = wallets.body.wallets.find((x: { kind: string }) => x.kind === 'CAMPUS');
    const va = await request(f.app)
      .get(`/api/v1/me/wallets/${w.id}/virtual-account`)
      .set(meena.auth);
    expect(va.status, JSON.stringify(va.body)).toBe(200);
    for (const v of collection.variable) vars[v.key] = v.value;
    Object.assign(vars, {
      clientId: created.body.clientId,
      clientSecret: created.body.secret,
      accountNumber: va.body.vaNumber,
    });
  }, 180_000);
  afterAll(async () => {
    await f?.t.drop();
  });

  it('loads ₹500 into the wallet with requests 1, 2 and 3, and again as a new transfer', async () => {
    expect(collection.item.map((i) => i.name)).toEqual([
      "1. Get the bank's token",
      '2. Check the account (validate)',
      '3. Credit the wallet (notify)',
    ]);
    const before = await balance();
    expect((await send(1)).passed).toEqual(['Token given']);
    expect(vars['accessToken']).toBeTruthy();
    const checked = await send(2);
    expect(checked.passed, JSON.stringify(checked.res.body)).toEqual(['Account accepted']);
    expect(vars['utr']).toMatch(/^RPTEST\d+$/);
    expect(vars['reqDate']).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const credited = await send(3);
    expect(credited.passed, JSON.stringify(credited.res.body)).toEqual(['Wallet credited']);
    expect(await balance()).toBe(before + 50_000);

    // Request 3 again: the same UTR is never credited twice.
    await expect(send(3)).rejects.toThrow();
    expect(await balance()).toBe(before + 50_000);

    // 2 and 3 again: a new transfer.
    const firstUtr = vars['utr'];
    await new Promise((r) => setTimeout(r, 5));
    expect((await send(2)).passed).toEqual(['Account accepted']);
    expect(vars['utr']).not.toBe(firstUtr);
    expect((await send(3)).passed).toEqual(['Wallet credited']);
    expect(await balance()).toBe(before + 100_000);
  });
});
