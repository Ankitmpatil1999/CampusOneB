/**
 * Payment burst on a real MySQL (Phase 3.7; docs/03 §1 targets, §11.3 hot merchant row): many payers
 * pay one canteen at once through the full HTTP path (PIN, engine, ledger, outbox), then an overdraw
 * storm. Runs only with `npm run test:load` (its own throw-away database); writes the results to
 * docs/reports/load-phase-3.md. The k6 script next to it is for staging environments.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomInt, randomUUID } from 'node:crypto';
import { cpus } from 'node:os';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import { adminUrl, createTestDatabase, type TestDatabase } from '../integration/db';
import { buildHttpApp, codeOf } from '../integration/http-app';
import { binToUuid, newPublicIdPair, uuidToBin } from '../../utils/idGenerator';
import { hashSecret } from '../../utils/password';

const RUN = process.env['npm_lifecycle_event'] === 'test:load' || process.env['LOAD'] === '1';
const PASSWORD = 'CampusOne@2026';
const PIN = '4826';
const PAYERS = Number(process.env['LOAD_PAYERS'] ?? 300);
const CONCURRENCY = Number(process.env['LOAD_CONCURRENCY'] ?? 50);

const pct = (sorted: number[], p: number) =>
  sorted.length
    ? sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!
    : 0;

/** Runs `tasks` with at most `limit` in flight; returns per-task latency (ms) and result. */
async function pool<T>(tasks: (() => Promise<T>)[], limit: number) {
  const out: { ms: number; value: T }[] = new Array(tasks.length);
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const i = next++;
      const t0 = performance.now();
      const value = await tasks[i]!();
      out[i] = { ms: performance.now() - t0, value };
    }
  };
  const t0 = performance.now();
  await Promise.all(Array.from({ length: limit }, worker));
  return { results: out, seconds: (performance.now() - t0) / 1000 };
}

describe.skipIf(!adminUrl || !RUN)('payment burst (load)', () => {
  let t: TestDatabase;
  let h: Awaited<ReturnType<typeof buildHttpApp>>;
  let server: Server;
  let base = '';
  let school: { id: string; rowId: string; con: Record<string, string> };
  let teacherTypeRow = '';
  let payload = '';
  let merchantWallet = '';
  const report: string[] = [];

  async function account(first: string) {
    const email = `${first.toLowerCase()}.${randomInt(0, 1e9)}@example.in`;
    const r = await t.db
      .insertInto('platform_accounts')
      .values({
        public_id: newPublicIdPair().bin,
        mobile: `9${String(randomInt(0, 1e9)).padStart(9, '0')}`,
        email,
        first_name: first,
        last_name: 'RAO',
      })
      .executeTakeFirstOrThrow();
    await t.db
      .insertInto('account_credentials')
      .values({
        account_id: String(r.insertId),
        kind: 'PASSWORD',
        hash: await hashSecret(PASSWORD),
      })
      .execute();
    return { id: String(r.insertId), email };
  }
  async function signedIn(surface: 'ops' | 'console', email: string) {
    const b = surface === 'ops' ? '/api/v1/ops/auth' : '/api/v1/auth/console';
    const s1 = await request(h.app).post(`${b}/signin`).send({ email, password: PASSWORD });
    const r = await request(h.app)
      .post(`${b}/otp/verify`)
      .send({ challengeId: s1.body.challengeId, otp: codeOf(h.sms.sent.at(-1)) });
    const cookies = ([] as string[])
      .concat(r.headers['set-cookie'] ?? [])
      .map((c) => c.split(';')[0] ?? '');
    return { Cookie: cookies.join('; '), 'X-CSRF-Token': r.body.csrfToken as string };
  }

  /** Payers made directly in the database (the HTTP sign-up is not what is measured). */
  async function payers(n: number, paise: number) {
    const pinHash = await hashSecret(PIN);
    const out: { token: string; wallet: string }[] = [];
    for (let i = 0; i < n; i++) {
      const acc = newPublicIdPair();
      const mob = `8${String(randomInt(0, 1e9)).padStart(9, '0')}`;
      const a = await t.db
        .insertInto('platform_accounts')
        .values({
          public_id: acc.bin,
          mobile: mob,
          email: `p${i}.${randomInt(0, 1e9)}@load.example.in`,
          first_name: `PAYER${i}`,
          last_name: 'LOAD',
        })
        .executeTakeFirstOrThrow();
      await t.db
        .insertInto('account_credentials')
        .values({ account_id: String(a.insertId), kind: 'TPIN', hash: pinHash })
        .execute();
      const prof = newPublicIdPair();
      const p = await t.db
        .insertInto('member_profiles')
        .values({
          public_id: prof.bin,
          institution_id: school.rowId,
          account_id: String(a.insertId),
          user_type_id: teacherTypeRow,
          first_name: `PAYER${i}`,
          contact_mobile: mob,
          status: 'ACTIVE',
        })
        .executeTakeFirstOrThrow();
      const w = await t.db
        .selectFrom('wallets')
        .select('id')
        .where('owner_profile_id', '=', String(p.insertId))
        .where('kind', '=', 'CAMPUS')
        .executeTakeFirstOrThrow();
      await t.db.transaction().execute((trx) =>
        h.services.ledger.post(trx, {
          institutionId: school.rowId,
          type: 'ADJUSTMENT',
          channel: 'BACK_OFFICE',
          amountPaise: paise,
          idempotencyKey: randomUUID(),
          debit: { account: 'ADJUSTMENT', institutionId: school.rowId },
          credit: { walletId: String(w.id) },
          narration: 'Load test',
        }),
      );
      const token = await h.security.signer.sign({
        subject: acc.id,
        surface: 'member',
        sessionId: randomUUID(),
        institutionId: school.id,
        profileId: prof.id,
        subTasks: [],
      });
      out.push({ token: token.token, wallet: String(w.id) });
    }
    return out;
  }

  const pay = (token: string, amount: string) =>
    fetch(`${base}/api/v1/me/payments`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': randomUUID(),
      },
      body: JSON.stringify({ qrPayload: payload, amount: { amount, currency: 'INR' }, pin: PIN }),
    }).then(async (r) => ({ status: r.status, body: (await r.json()) as { code?: string } }));

  const balance = async (walletId: string) =>
    Number(
      (
        await t.db
          .selectFrom('wallet_balances')
          .select('available_paise')
          .where('wallet_id', '=', walletId)
          .executeTakeFirstOrThrow()
      ).available_paise,
    );

  beforeAll(async () => {
    t = await createTestDatabase();
    h = await buildHttpApp(t, {
      env: {
        RATE_LIMIT_GLOBAL_MAX: '1000000',
        RATE_LIMIT_SESSION_MAX: '1000000',
        RATE_LIMIT_AUTH_MAX: '1000000',
      },
    });
    server = createServer(h.app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const op = await account('ARJUN');
    const role = await t.db
      .selectFrom('roles')
      .select('id')
      .where('code', '=', 'PLATFORM_ADMIN')
      .executeTakeFirstOrThrow();
    await t.db
      .insertInto('operator_accounts')
      .values({ public_id: newPublicIdPair().bin, account_id: op.id, role_id: String(role.id) })
      .execute();
    const ops = await signedIn('ops', op.email);
    const admin = await account('LAKSHMI');
    const plans = (await request(h.app).get('/api/v1/ops/plans').set(ops)).body.items;
    const reg = await request(h.app)
      .post('/api/v1/ops/institutions')
      .set(ops)
      .set('Idempotency-Key', randomUUID())
      .send({
        name: 'Load School',
        address: 'Lake Road, Hassan',
        city: 'Hassan',
        primaryContact: {
          name: 'Lakshmi Rao',
          email: 'office@hassan.example.in',
          mobile: '9845012345',
        },
        adminEmail: admin.email,
        planId: plans.at(-1).id,
      });
    const id = reg.body.id as string;
    for (const step of ['toggles', 'year', 'feeacct']) {
      await request(h.app)
        .post(`/api/v1/ops/institutions/${id}/checklist/${step}`)
        .set(ops)
        .send({});
    }
    const v = (await request(h.app).get(`/api/v1/ops/institutions/${id}`).set(ops)).body.version;
    await request(h.app)
      .put(`/api/v1/ops/institutions/${id}/bank-arrangement`)
      .set(ops)
      .set('If-Match', `"v${v}"`)
      .send({ corporateCode: 'LOAD', poolAccountRef: 'POOLLOAD0001' });
    await request(h.app)
      .post(`/api/v1/ops/institutions/${id}/lifecycle-events`)
      .set(ops)
      .set('Idempotency-Key', randomUUID())
      .send({ action: 'ACTIVATE', reason: 'Load test institution' });
    const row = await t.db
      .selectFrom('institutions')
      .select('id')
      .where('public_id', '=', uuidToBin(id))
      .executeTakeFirstOrThrow();
    school = { id, rowId: String(row.id), con: await signedIn('console', admin.email) };
    for (const [name, category, departments] of [
      ['Teacher', 'TEACHER', ['Primary']],
      ['Merchant', 'MERCHANT', ['Canteen']],
    ] as const) {
      await request(h.app)
        .post('/api/v1/console/user-types')
        .set(school.con)
        .set('Idempotency-Key', randomUUID())
        .send({ name, category, departments });
    }
    const tt = (
      await request(h.app).get('/api/v1/console/user-types').set(school.con)
    ).body.items.find((x: { name: string }) => x.name === 'Teacher');
    teacherTypeRow = String(
      (
        await t.db
          .selectFrom('user_types')
          .select('id')
          .where('public_id', '=', uuidToBin(tt.id))
          .executeTakeFirstOrThrow()
      ).id,
    );
    const mer = await request(h.app)
      .post('/api/v1/console/merchants')
      .set(school.con)
      .set('Idempotency-Key', randomUUID())
      .send({
        displayName: 'Main Canteen',
        operatorFirstName: 'Ravi',
        subType: 'REGULAR',
        mobile: '9886100001',
      });
    const qr = await request(h.app)
      .post(`/api/v1/console/merchants/${mer.body.merchantId}/qr-codes`)
      .set(school.con)
      .set('Idempotency-Key', randomUUID())
      .send({ kind: 'PAYMENT' });
    payload = qr.body.payload;
    merchantWallet = String(
      (
        await t.db
          .selectFrom('wallets as w')
          .innerJoin('member_profiles as m', 'm.id', 'w.owner_profile_id')
          .select('w.id')
          .where('m.public_id', '=', uuidToBin(mer.body.merchantId))
          .executeTakeFirstOrThrow()
      ).id,
    );
  }, 600_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await t?.drop();
    const file = join(import.meta.dirname, '../../../docs/reports/load-phase-3.md');
    writeFileSync(
      file,
      [
        '# Phase 3 load test — payment burst',
        '',
        `Run ${new Date().toISOString()} on this workstation (${cpus().length} × ${cpus()[0]?.model ?? 'CPU'}, MySQL 8 local, one API process, Node ${process.version}). Full HTTP path: authentication, Idempotency-Key, PIN (Argon2id), the §9.11 engine, the ledger pair, notifications and the outbox. Targets (docs/03 §1): payment p95 < 700 ms server time; design point 25 payments/s into one canteen merchant.`,
        '',
        ...report,
        '',
        'The test is `CampusOne_Backend_API/tests/load/payments-burst.load.spec.ts` (`npm run test:load`; `LOAD_PAYERS`, `LOAD_CONCURRENCY`). `tests/load/payments-burst.k6.js` runs the same burst with k6 against a staging API.',
        '',
      ].join('\n'),
    );
  });

  it(`${PAYERS} payers pay one canteen, ${CONCURRENCY} at a time: every payment posts once, nothing is lost`, async () => {
    const people = await payers(PAYERS, 50_000);
    const { results, seconds } = await pool(
      people.map((p) => () => pay(p.token, '20.00')),
      CONCURRENCY,
    );
    const codes = new Map<number, number>();
    for (const r of results) codes.set(r.value.status, (codes.get(r.value.status) ?? 0) + 1);
    const ms = results.map((r) => r.ms).sort((a, b) => a - b);
    report.push(
      '## Burst into one merchant (hot row)',
      '',
      '| Payments | In flight | Took | Throughput | p50 | p95 | p99 | Max | Responses |',
      '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
      `| ${PAYERS} | ${CONCURRENCY} | ${seconds.toFixed(1)} s | ${(PAYERS / seconds).toFixed(1)} payments/s | ${pct(ms, 50).toFixed(0)} ms | ${pct(ms, 95).toFixed(0)} ms | ${pct(ms, 99).toFixed(0)} ms | ${ms.at(-1)!.toFixed(0)} ms | ${[...codes].map(([k, v]) => `${k}×${v}`).join(', ')} |`,
      '',
    );
    expect(codes.get(201)).toBe(PAYERS);
    expect(await balance(merchantWallet)).toBe(PAYERS * 2_000);
    const debits = await t.db
      .selectFrom('ledger_entries')
      .select((eb) => [eb.fn.sum<string>('amount_paise').as('d')])
      .where('direction', '=', 'D')
      .executeTakeFirstOrThrow();
    const credits = await t.db
      .selectFrom('ledger_entries')
      .select((eb) => [eb.fn.sum<string>('amount_paise').as('c')])
      .where('direction', '=', 'C')
      .executeTakeFirstOrThrow();
    expect(Number(debits.d)).toBe(Number(credits.c));
    void binToUuid;
  }, 600_000);

  it('an overdraw storm: each payer with ₹10 sends three ₹5 payments at once — exactly two pass', async () => {
    const n = Math.max(20, Math.floor(PAYERS / 6));
    const people = await payers(n, 1_000);
    const tasks = people.flatMap((p) => [0, 1, 2].map(() => () => pay(p.token, '5.00')));
    const { results, seconds } = await pool(tasks, CONCURRENCY);
    const ok = results.filter((r) => r.value.status === 201).length;
    const refused = results.filter((r) => r.value.body.code === 'PAY.INSUFFICIENT_BALANCE').length;
    const ms = results.map((r) => r.ms).sort((a, b) => a - b);
    report.push(
      '## Overdraw storm',
      '',
      '| Payers | Requests | In flight | Took | Passed | Refused (V13) | p95 |',
      '| --- | --- | --- | --- | --- | --- | --- |',
      `| ${n} | ${tasks.length} | ${CONCURRENCY} | ${seconds.toFixed(1)} s | ${ok} | ${refused} | ${pct(ms, 95).toFixed(0)} ms |`,
      '',
      'Every payer ends at ₹0.00: no wallet went below zero and no payment was lost.',
    );
    expect(ok).toBe(n * 2);
    expect(refused).toBe(n);
    for (const p of people) expect(await balance(p.wallet)).toBe(0);
  }, 600_000);
});
