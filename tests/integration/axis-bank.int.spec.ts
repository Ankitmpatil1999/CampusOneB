/**
 * Axis Bank Power E-coll on a real MySQL (client 2026-10-12, scope document v4.0; BNK-001…003): the
 * bank's token, validation and notification calls in its own format, as the earlier application
 * answered them.
 * - token: missing fields, wrong grant, wrong secret, unknown scope, address not allowed; JSON and
 *   form fields; one token for both scopes, the same token returned while valid, a new one after
 *   the tokens are revoked;
 * - calls: missing, invalid or wrong-scope token refused as {Stts_flg: "N", Err_cd: "001"};
 * - validation: invalid parameters, date, account, sender account; the account number with or
 *   without the corporate-code prefix; a repeat gets the same success; every call logged; the
 *   sender's account number kept only as its last four digits;
 * - notification: refused before a successful validation or for another amount, credits the wallet
 *   once, a repeat is "Duplicate UTR"; the /cug/bank alias works.
 */
import { randomInt, randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { adminUrl } from './db';
import { schoolFixture } from './school';

type Fixture = Awaited<ReturnType<typeof schoolFixture>>;

describe.skipIf(!adminUrl)('Axis Bank Power E-coll on real MySQL', () => {
  let f: Fixture;
  let client: { id: string; clientId: string; secret: string };
  let wallet = '';
  let va = '';

  const token = (body: Record<string, string>, base = '/api/v1/partners/axis/bank') =>
    request(f.app).post(`${base}/token`).send(body);
  const tokenFor = async (scope: string) => {
    const r = await token({
      grant_type: 'client_credentials',
      client_id: client.clientId,
      client_secret: client.secret,
      scope,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body.access_token as string;
  };
  const call = (
    endpoint: 'validate' | 'notify',
    bearer: string | null,
    body: Record<string, string>,
    base = '/api/v1/partners/axis/bank',
  ) => {
    const r = request(f.app).post(`${base}/transaction/${endpoint}`);
    if (bearer) r.set('Authorization', `Bearer ${bearer}`);
    return r.send(body);
  };
  const payload = (over: Record<string, string> = {}) => ({
    UTR: `AXIS${randomInt(0, 1e9)}`,
    Bene_acc_no: va,
    Req_type: 'Validation',
    Req_date: '2026-10-12',
    Txn_amnt: '4999.00',
    Pmode: 'NEFT',
    Sndr_acnt: '918020045671234',
    Sndr_nm: 'LAKSHMI RAO',
    Sndr_ifsc: 'UTIB0000123',
    Corp_code: va.slice(0, 4),
    Tran_id: `T${randomInt(0, 1e9)}`,
    ...over,
  });

  beforeAll(async () => {
    f = await schoolFixture('Axis');
    const created = await request(f.app)
      .post('/api/v1/ops/api-clients')
      .set(f.ops)
      .set('Idempotency-Key', randomUUID())
      .send({
        name: 'Axis Bank Power E-coll',
        partner: 'SPONSOR_BANK',
        scopes: ['va.validate', 'va.notify'],
        ipAllowlist: ['127.0.0.1', '::1'],
      });
    expect(created.status).toBe(201);
    client = created.body;
    const p = await f.payer('Meena', 0);
    wallet = p.wallet;
    va = (
      await f.t.db
        .selectFrom('virtual_accounts')
        .select('va_number')
        .where('wallet_id', '=', wallet)
        .executeTakeFirstOrThrow()
    ).va_number;
  }, 180_000);
  afterAll(async () => {
    await f?.t.drop();
  });

  it('issues tokens in the bank format and refuses as the earlier application did', async () => {
    expect((await token({ client_id: client.clientId })).body).toEqual({
      message: 'Missing required fields',
    });
    const base = {
      grant_type: 'client_credentials',
      client_id: client.clientId,
      client_secret: client.secret,
      scope: 'transaction_validation',
    };
    const refusal = (message: string) => ({ status: false, statusCode: 400, message, data: null });
    expect((await token({ ...base, grant_type: 'password' })).body).toEqual(
      refusal('INVALID_GRANT_TYPE'),
    );
    expect((await token({ ...base, client_secret: 'wrong' })).body).toEqual(
      refusal('INVALID_CLIENT'),
    );
    expect((await token({ ...base, scope: 'refunds' })).body).toEqual(refusal('INVALID_SCOPE'));

    const ok = await token(base);
    expect(ok.status).toBe(200);
    // One token for both calls (client 2026-10-12).
    expect(ok.body).toMatchObject({
      token_type: 'Bearer',
      expires_in: 900,
      scope: 'transaction_notification_posting transaction_validation',
    });
    expect(Date.parse(ok.body.expires_at)).toBeGreaterThan(Date.now());
    expect(ok.headers['cache-control']).toBe('no-store');

    // Asked again while it is valid — form fields, at the earlier application's address, the
    // other scope: the same token, with its own expiry.
    const form = await request(f.app)
      .post('/cug/bank/token')
      .type('form')
      .send({ ...base, scope: 'transaction_notification_posting' });
    expect(form.status).toBe(200);
    expect(form.body.access_token).toBe(ok.body.access_token);
    expect(form.body.expires_at).toBe(ok.body.expires_at);
    expect(form.body.expires_in).toBeLessThanOrEqual(900);
    const t = payload();
    expect((await call('validate', ok.body.access_token, t)).body.Stts_flg).toBe('S');
    expect(
      (await call('notify', ok.body.access_token, { ...t, Req_type: 'notification' })).body
        .Stts_flg,
    ).toBe('S');
    const stored = await f.t.db
      .selectFrom('api_client_tokens')
      .select('token_enc')
      .where('token_enc', 'is not', null)
      .execute();
    expect(stored).toHaveLength(1);
    expect(stored[0]!.token_enc!.toString('latin1')).not.toContain(ok.body.access_token);

    // Revoked in the back office: the next token call gives a new token, the old one is refused.
    await request(f.app)
      .post(`/api/v1/ops/api-clients/${client.id}/token-revocations`)
      .set(f.ops)
      .send({ reason: 'Key ceremony' });
    const fresh = await token(base);
    expect(fresh.body.access_token).not.toBe(ok.body.access_token);
    expect((await call('validate', ok.body.access_token, payload())).status).toBe(401);
    expect((await call('validate', fresh.body.access_token, payload())).body.Stts_flg).toBe('S');
  });

  it('refuses an address not on the allow-list, and calls without a good token', async () => {
    const other = await request(f.app)
      .post('/api/v1/ops/api-clients')
      .set(f.ops)
      .set('Idempotency-Key', randomUUID())
      .send({
        name: 'Axis Bank other site',
        partner: 'SPONSOR_BANK',
        scopes: ['va.validate'],
        ipAllowlist: ['203.0.113.10'],
      });
    const r = await token({
      grant_type: 'client_credentials',
      client_id: other.body.clientId,
      client_secret: other.body.secret,
      scope: 'transaction_validation',
    });
    expect(r.status).toBe(403);
    expect(r.body).toEqual({
      status: false,
      Stts_flg: 'N',
      Err_cd: '001',
      message: 'Authentication failed',
      error: 'Access denied: IP not whitelisted',
    });

    const refused = (error: string) => ({
      Stts_flg: 'N',
      Err_cd: '001',
      message: 'Authentication failed',
      error,
    });
    const none = await call('validate', null, payload());
    expect(none.status).toBe(401);
    expect(none.body).toEqual(refused('Missing bearer token'));
    expect((await call('validate', 'not.a.token', payload())).body).toEqual(
      refused('Invalid token'),
    );
    const narrow = await request(f.app)
      .post('/api/v1/ops/api-clients')
      .set(f.ops)
      .set('Idempotency-Key', randomUUID())
      .send({
        name: 'Axis Bank validation only',
        partner: 'SPONSOR_BANK',
        scopes: ['va.validate'],
        ipAllowlist: ['127.0.0.1', '::1'],
      });
    const validateOnly = await token({
      grant_type: 'client_credentials',
      client_id: narrow.body.clientId,
      client_secret: narrow.body.secret,
      scope: 'transaction_validation',
    });
    expect(validateOnly.body.scope).toBe('transaction_validation');
    expect(
      (
        await token({
          grant_type: 'client_credentials',
          client_id: narrow.body.clientId,
          client_secret: narrow.body.secret,
          scope: 'transaction_notification_posting',
        })
      ).body.message,
    ).toBe('INVALID_SCOPE');
    const wrong = await call(
      'notify',
      validateOnly.body.access_token,
      payload({ Req_type: 'notification' }),
    );
    expect(wrong.status).toBe(403);
    expect(wrong.body).toEqual(refused('Insufficient scope'));
  });

  it('validates and logs every call; notifies once after a successful validation', async () => {
    const v = await tokenFor('transaction_validation');
    const n = await tokenFor('transaction_notification_posting');
    const ans = (flag: string, code: string, message: string, error?: string) => ({
      Stts_flg: flag,
      Err_cd: code,
      message,
      ...(error ? { error } : {}),
    });

    expect((await call('validate', v, payload({ Req_type: 'Notify' }))).body).toEqual(
      ans('F', '003', 'Invalid request parameters'),
    );
    expect((await call('validate', v, payload({ Bene_acc_no: 'AB12' }))).body).toEqual(
      ans('F', '002', 'Invalid Van'),
    );
    expect((await call('validate', v, payload({ Req_date: '2026-02-30' }))).body).toEqual(
      ans('F', '006', 'Invalid date format'),
    );
    expect((await call('validate', v, payload({ Bene_acc_no: `${va}99` }))).body).toEqual(
      ans('F', '002', 'Incorrect Van'),
    );
    // Scope document test case 10: a sender account number that can't be one.
    expect((await call('validate', v, payload({ Sndr_acnt: '22334455' }))).body).toEqual(
      ans('F', '003', 'Invalid sender account number'),
    );
    expect((await call('validate', v, payload({ Sndr_acnt: '2 233 4 4 5 5' }))).body).toEqual(
      ans('F', '003', 'Invalid sender account number'),
    );

    const credit = payload();
    // A notification before any validation is refused.
    expect((await call('notify', n, { ...credit, Req_type: 'notification' })).body).toEqual(
      ans('F', '001', 'Authentication failed', 'Validation not completed or failed'),
    );
    expect((await call('validate', v, credit)).body).toEqual(ans('S', '000', 'Success'));
    // The bank asks again (a retry, or IMPS's second call): the same success.
    expect((await call('validate', v, credit)).body).toEqual(ans('S', '000', 'Success'));
    const logged = await f.t.db
      .selectFrom('bank_va_validations')
      .selectAll()
      .where('utr', '=', credit.UTR)
      .execute();
    expect(logged).toHaveLength(2);
    expect(logged[0]).toMatchObject({
      status_flag: 'S',
      response_code: '000',
      sender_account_last4: '1234',
      institution_id: f.school.rowId,
    });
    expect(JSON.stringify(logged)).not.toContain('918020045671234');

    expect(
      (await call('notify', n, { ...credit, Req_type: 'notification', Req_date: '12-10-2026' }))
        .body,
    ).toEqual(ans('F', '006', 'Invalid date format. Expected YYYY-MM-DD'));
    expect((await call('notify', n, { ...credit, Req_type: 'Validation' })).body).toEqual(
      ans('F', '003', 'Invalid request type', "Request type must be 'notification'"),
    );
    expect((await call('notify', n, { UTR: credit.UTR })).body).toEqual(
      ans('F', '001', 'Authentication failed', 'Missing mandatory fields'),
    );

    // Another amount than the one validated is refused.
    expect(
      (await call('notify', n, { ...credit, Req_type: 'notification', Txn_amnt: '9999.00' })).body,
    ).toEqual(ans('F', '001', 'Authentication failed', 'Validation not completed or failed'));

    const before = await f.balance(wallet);
    const posted = await call('notify', n, { ...credit, Req_type: 'notification' });
    expect(posted.status).toBe(200);
    expect(posted.body).toEqual(ans('S', '000', 'Success'));
    expect((await f.balance(wallet)) - before).toBe(499_900);
    const row = await f.t.db
      .selectFrom('bank_credits')
      .select(['status', 'mode', 'sender_account_last4', 'api_client_id'])
      .where('utr', '=', credit.UTR)
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({ status: 'PROCESSED', mode: 'NEFT', sender_account_last4: '1234' });

    // The bank sends it again: no second credit.
    expect((await call('notify', n, { ...credit, Req_type: 'Notification' })).body).toEqual(
      ans('F', '002', 'Duplicate UTR'),
    );
    expect((await f.balance(wallet)) - before).toBe(499_900);
    // Asked to validate it again after posting: a duplicate.
    expect((await call('validate', v, credit)).body).toEqual(ans('F', '002', 'Duplicate UTR'));
  });

  it('takes the account number without the corporate-code prefix', async () => {
    const v = await tokenFor('transaction_validation');
    const code = (
      await f.t.db
        .selectFrom('virtual_accounts')
        .select('corporate_code')
        .where('va_number', '=', va)
        .executeTakeFirstOrThrow()
    ).corporate_code;
    const credit = payload({ Bene_acc_no: va.slice(code.length), Corp_code: code });
    expect((await call('validate', v, credit)).body.Stts_flg).toBe('S');
    const before = await f.balance(wallet);
    expect((await call('notify', v, { ...credit, Req_type: 'notification' })).body).toEqual({
      Stts_flg: 'S',
      Err_cd: '000',
      message: 'Success',
    });
    expect((await f.balance(wallet)) - before).toBe(499_900);
    // Without the corporate code the short number isn't an account.
    expect(
      (
        await call('validate', v, {
          ...payload(),
          Bene_acc_no: va.slice(code.length),
          Corp_code: '',
        })
      ).body.Err_cd,
    ).toBe('002');
  });

  it('serves the same calls at the earlier address, with form fields', async () => {
    const v = await tokenFor('transaction_validation transaction_notification_posting');
    const credit = payload({ Txn_amnt: '100.50' });
    const valid = await request(f.app)
      .post('/cug/bank/transaction/validate')
      .set('Authorization', `Bearer ${v}`)
      .type('form')
      .send(credit);
    expect(valid.body).toEqual({ Stts_flg: 'S', Err_cd: '000', message: 'Success' });
    const before = await f.balance(wallet);
    const posted = await request(f.app)
      .post('/cug/bank/transaction/notify')
      .set('Authorization', `Bearer ${v}`)
      .type('form')
      .send({ ...credit, Req_type: 'notification' });
    expect(posted.body).toEqual({ Stts_flg: 'S', Err_cd: '000', message: 'Success' });
    expect((await f.balance(wallet)) - before).toBe(10_050);
  });

  it('keeps the earlier application’s Axis client working: imported with its secret’s bcrypt hash', async () => {
    // As the bank holds it (client 2026-10-14): a client id and a secret RingPe only knows as a hash.
    const legacyId = `AXISBANKEC_${randomInt(0, 1e8).toString(16).toUpperCase()}`;
    const legacySecret = 'legacy-axis-secret-value';
    const hash = bcrypt.hashSync(legacySecret, 4);
    const importIt = (body: object) =>
      request(f.app)
        .post('/api/v1/ops/api-clients/imports')
        .set(f.ops)
        .set('Idempotency-Key', randomUUID())
        .send(body);
    const base = {
      name: 'Axis Bank (earlier client)',
      partner: 'SPONSOR_BANK',
      clientId: legacyId,
      secretHash: hash,
      scopes: ['va.validate', 'va.notify'],
      ipAllowlist: ['127.0.0.1', '::1'],
    };
    expect((await importIt({ ...base, secretHash: 'not-a-hash' })).body.errors[0]).toMatchObject({
      field: 'secretHash',
      code: 'INT.SECRET_HASH_FORMAT',
    });
    const imported = await importIt(base);
    expect(imported.status, JSON.stringify(imported.body)).toBe(201);
    expect(imported.body).toMatchObject({ clientId: legacyId, secretKind: 'HASH' });
    expect(JSON.stringify(imported.body)).not.toContain(hash);
    expect((await importIt({ ...base, name: 'Another name' })).body.code).toBe(
      'INT.CLIENT_ID_TAKEN',
    );

    const tok = (secret: string) =>
      token({
        grant_type: 'client_credentials',
        client_id: legacyId,
        client_secret: secret,
        scope: 'transaction_validation transaction_notification_posting',
      });
    expect((await tok('wrong-secret')).body.message).toBe('INVALID_CLIENT');
    const t = await tok(legacySecret);
    expect(t.status, JSON.stringify(t.body)).toBe(200);
    const bearer = t.body.access_token as string;

    // The student's VAN (code + wallet number): validated, then the money is loaded.
    const credit = payload({ Txn_amnt: '250.00' });
    expect((await call('validate', bearer, credit)).body).toEqual({
      Stts_flg: 'S',
      Err_cd: '000',
      message: 'Success',
    });
    const before = await f.balance(wallet);
    expect((await call('notify', bearer, { ...credit, Req_type: 'notification' })).body).toEqual({
      Stts_flg: 'S',
      Err_cd: '000',
      message: 'Success',
    });
    expect((await f.balance(wallet)) - before).toBe(25_000);

    // Rotated: a RingPe secret; the hash still works during the overlap.
    const rotated = await request(f.app)
      .post(`/api/v1/ops/api-clients/${imported.body.id}/secret-rotations`)
      .set(f.ops)
      .set('Idempotency-Key', randomUUID())
      .send({ overlapHours: 24 });
    expect(rotated.status, JSON.stringify(rotated.body)).toBeLessThan(300);
    expect((await tok(legacySecret)).status).toBe(200);
    expect((await tok(rotated.body.secret)).status).toBe(200);
  });
});
