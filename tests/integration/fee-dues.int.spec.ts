/**
 * Members' dues and fee financing on a real MySQL (Phase 5.3; SRS 13.5, 13.11–13.12; FEE-019…027,
 * FEE-038, FEE-042):
 * - the member sees the year's fees, the next due and the consent text; another student's fee is a
 *   404;
 * - accepting the consent keeps the exact text and tries the due once (pending on a short balance);
 *   a stale template is refused;
 * - paying now needs the PIN and posts through the engine; the receipt is a PDF;
 * - financing: the family asks (while allowed) or the institution registers; one live registration
 *   per student; the partner's signed webhook approves (records financed, never debited), rejects, or
 *   pays (records paid without a posting), once per event id.
 */
import { createHmac, randomUUID } from 'node:crypto';
import request from 'supertest';
import { adminUrl } from './db';
import { inr, PIN, schoolFixture, type Auth, type Payer } from './school';
import { uuidToBin } from '../../utils/idGenerator';

describe.skipIf(!adminUrl)('members’ dues and fee financing on real MySQL', () => {
  let f: Awaited<ReturnType<typeof schoolFixture>>;
  let con: Auth;
  let year: { id: string };
  let today: string;
  let asha: Payer;
  let ravi: Payer;
  let meera: Payer;

  const post = (path: string, body: object = {}, auth: Auth = con) =>
    request(f.app).post(path).set(auth).set('Idempotency-Key', randomUUID()).send(body);
  const raise = async (s: Payer, amount: string, label: string) => {
    const r = await post('/api/v1/console/fee-records', {
      studentId: s.id,
      yearId: year.id,
      label,
      dueDate: today,
      amount: inr(amount),
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body as { id: string };
  };
  const setting = async (key: string, value: number) => {
    const s = (await request(f.app).get('/api/v1/ops/settings').set(f.ops)).body.items.find(
      (x: { key: string }) => x.key === key,
    );
    const r = await request(f.app)
      .put(`/api/v1/ops/settings/${key}`)
      .set(f.ops)
      .set('If-Match', `"v${s.version}"`)
      .send({ value, reason: 'Fee dues test' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  };

  beforeAll(async () => {
    f = await schoolFixture('Fee Dues School');
    con = f.school.con;
    today = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
    asha = await f.student('Asha', 5_000);
    ravi = await f.student('Ravi');
    meera = await f.student('Meera');
    await f.feature('tuition', true);
    const fees = await f.merchant('Fees Office');
    const inst = await request(f.app).get('/api/v1/console/institution').set(con);
    const set = await request(f.app)
      .put('/api/v1/console/institution/fee-account')
      .set(con)
      .set('If-Match', `"v${inst.body.version}"`)
      .send({ merchantId: fees.id });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    const ef = (await request(f.app).get('/api/v1/console/entry-fees').set(con)).body.items as {
      year: { id: string; current: boolean };
    }[];
    year = ef.find((x) => x.year.current)!.year;
  }, 240_000);
  afterAll(async () => {
    await f?.t.drop();
  });

  it('shows the year’s fees with consent, collects on consent, and pays with the PIN (FEE-019…023)', async () => {
    const r = await raise(asha, '100.00', 'Term 2');
    await f.feature('feeConsent', true);
    try {
      const dues = await request(f.app).get('/api/v1/me/fees').set(asha.auth);
      expect(dues.status, JSON.stringify(dues.body)).toBe(200);
      expect(dues.body).toMatchObject({
        student: { name: 'Asha Rao', classSection: 'Grade 6 A' },
        summary: { annual: inr('100.00'), paid: inr('0.00'), outstanding: inr('100.00') },
        heads: [{ name: 'Tuition', amount: inr('100.00') }],
        next: { id: r.id, amountDue: inr('100.00'), status: 'DUE', pending: null },
        consent: { required: true, valid: false },
        financing: { status: 'NOT_REGISTERED' },
        wallet: { balance: inr('50.00') },
      });
      const tpl = dues.body.consent.template as { version: string; text: string };
      expect(tpl.text).toMatch(/authorise .* to collect the school fees of Asha Rao/);

      expect(
        (
          await post(
            '/api/v1/me/fee-consents',
            { templateVersion: '2000.01', accept: true },
            asha.auth,
          )
        ).body.code,
      ).toBe('FEE.CONSENT_TEMPLATE_STALE');
      const consent = await post(
        '/api/v1/me/fee-consents',
        { templateVersion: tpl.version, accept: true },
        asha.auth,
      );
      expect(consent.status, JSON.stringify(consent.body)).toBe(201);
      // ₹50 for a ₹100 fee: kept pending for a top-up.
      expect(consent.body.collection).toMatchObject({
        recordId: r.id,
        collected: false,
        pendingAttempt: { tries: 1, reasonCode: 'PAY.INSUFFICIENT_BALANCE' },
      });
      const kept = await f.t.db
        .selectFrom('fee_consents')
        .select(['accepted_text', 'text_version'])
        .where('institution_id', '=', f.school.rowId)
        .executeTakeFirstOrThrow();
      expect(kept).toEqual({ accepted_text: tpl.text, text_version: tpl.version });
      const after = (await request(f.app).get('/api/v1/me/fees').set(asha.auth)).body;
      expect(after.consent.valid).toBe(true);
      expect(after.next.pending).toMatchObject({ tries: 1 });
    } finally {
      await f.feature('feeConsent', false);
    }

    await f.credit(asha.wallet, 10_000);
    const pay = (pin: string) => post(`/api/v1/me/fees/${r.id}/payments`, { pin }, asha.auth);
    expect((await pay('0000')).status).toBeGreaterThanOrEqual(400);
    expect(await f.balance(asha.wallet)).toBe(15_000);
    const paid = await pay(PIN);
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);
    expect(paid.body).toMatchObject({
      collected: true,
      receipt: { amount: inr('100.00') },
      record: {
        status: 'PAID',
        amountDue: inr('0.00'),
        settlement: 'COLLECTED',
        collection: 'WALLET',
      },
    });
    expect(await f.balance(asha.wallet)).toBe(5_000);
    const pdf = await request(f.app)
      .get(`/api/v1/me/fees/${r.id}/receipt.pdf`)
      .set(asha.auth)
      .buffer(true)
      .parse((res, done) => {
        const parts: Buffer[] = [];
        res.on('data', (c: Buffer) => parts.push(c));
        res.on('end', () => done(null, Buffer.concat(parts)));
      });
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toMatch(/application\/pdf/);
    expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');

    // Another student's fee is not Asha's to see, pay or print.
    const other = await raise(ravi, '10.00', 'Term 2');
    expect((await request(f.app).get(`/api/v1/me/fees/${other.id}`).set(asha.auth)).status).toBe(
      404,
    );
    expect((await pay(PIN)).body.code).toBe('FEE.RECORD_PAID');
    expect((await request(f.app).get(`/api/v1/me/fees?for=${ravi.id}`).set(asha.auth)).status).toBe(
      404,
    );
  });

  // FINANCING-OFF (client 2026-10-22): the fee financing partner is commented out in the whole application; uncomment to bring it back.
  it.skip('registers for financing once; the partner approves, rejects or pays on its signed webhook (FEE-024…027, FEE-038, FEE-042)', async () => {
    const term3 = await raise(ravi, '2000.00', 'Term 3');
    const before = await request(f.app).get('/api/v1/me/financing').set(ravi.auth);
    expect(before.body).toMatchObject({ status: 'NOT_REGISTERED', canRegister: true });
    const asked = await post('/api/v1/me/financing', {}, ravi.auth);
    expect(asked.status, JSON.stringify(asked.body)).toBe(201);
    expect(asked.body).toMatchObject({ status: 'PENDING', canRegister: false });
    expect(asked.body.records).toHaveLength(2);
    expect((await post('/api/v1/me/financing', {}, ravi.auth)).body).toMatchObject({
      code: 'FEE.FINANCING_EXISTS',
      params: { student: 'Ravi Rao', status: 'Pending' },
    });
    const listed = await request(f.app).get('/api/v1/console/financing-applications').set(con);
    expect(listed.body.items).toEqual([
      expect.objectContaining({ status: 'PENDING', requestedBy: 'MEMBER', total: inr('2010.00') }),
    ]);
    const partnerRef = listed.body.items[0].partnerRef as string;

    // While the family may not ask, the school registers (SRS 13.12).
    await setting('fee.financing.memberRegisters', 0);
    try {
      expect((await post('/api/v1/me/financing', {}, meera.auth)).body.code).toBe(
        'FEE.FINANCING_BY_SCHOOL',
      );
      expect(
        (await post('/api/v1/console/financing-applications', { studentProfileId: meera.id })).body
          .code,
      ).toBe('FEE.FINANCING_NOT_ELIGIBLE');
    } finally {
      await setting('fee.financing.memberRegisters', 1);
    }

    // The partner: a signed client with the financing scopes.
    const client = (
      await post(
        '/api/v1/ops/api-clients',
        {
          name: 'Example Finance',
          partner: 'FINANCING',
          scopes: ['fee.webhook', 'fee.read'],
          ipAllowlist: ['127.0.0.1', '::1'],
        },
        f.ops,
      )
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
    const fees = await signed('get', `/api/v1/partners/financing/students/${partnerRef}/fees`);
    expect(fees.status, JSON.stringify(fees.body)).toBe(200);
    expect(fees.body).toMatchObject({
      status: 'PENDING',
      student: { name: 'Ravi Rao', classSection: 'Grade 6 A' },
    });
    expect(Object.keys(fees.body.student).sort()).toEqual(['admissionNo', 'classSection', 'name']);

    // A short-balance attempt waiting on Ravi's record ends when the partner approves.
    await post(`/api/v1/console/fee-records/${term3.id}/collections`);
    const approve = { eventId: randomUUID(), partnerRef, event: 'APPROVED' };
    const ok = await signed('post', '/api/v1/partners/financing/webhooks', approve);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toEqual({ partnerRef, status: 'SUCCESS', recordsPaid: 0 });
    // The same event again answers the same; a different event can't decide twice.
    expect((await signed('post', '/api/v1/partners/financing/webhooks', approve)).body).toEqual(
      ok.body,
    );
    expect(
      (
        await signed('post', '/api/v1/partners/financing/webhooks', {
          ...approve,
          eventId: randomUUID(),
          event: 'REJECTED',
        })
      ).body.code,
    ).toBe('FEE.FINANCING_DECIDED');
    const financed = await f.t.db
      .selectFrom('fee_records')
      .select(['financed', 'status'])
      .where('student_profile_id', '=', ravi.rowId)
      .execute();
    expect(financed.every((x) => Number(x.financed) === 1)).toBe(true);
    expect(
      await f.t.db
        .selectFrom('fee_collection_attempts')
        .select('status')
        .where('institution_id', '=', f.school.rowId)
        .where('status', '=', 'PENDING')
        .execute(),
    ).toEqual([]);
    expect((await post(`/api/v1/console/fee-records/${term3.id}/collections`)).body.code).toBe(
      'FEE.FINANCED',
    );

    // The partner pays the school: the records are paid, no money moves in CampusOne.
    const paid = await signed('post', '/api/v1/partners/financing/webhooks', {
      eventId: 'PAY-0001',
      partnerRef,
      event: 'PAID',
      paidOn: today,
    });
    expect(paid.body).toMatchObject({ status: 'SUCCESS', recordsPaid: 2 });
    const rec = await f.t.db
      .selectFrom('fee_records')
      .select(['status', 'paid_reference'])
      .where('public_id', '=', uuidToBin(term3.id))
      .executeTakeFirstOrThrow();
    expect(rec).toEqual({ status: 'PAID', paid_reference: 'FIN-PAY-0001' });
    expect(await f.balance(ravi.wallet)).toBe(0);
    const mine = (await request(f.app).get('/api/v1/me/financing').set(ravi.auth)).body;
    expect(mine).toMatchObject({
      status: 'SUCCESS',
      records: [{ status: 'PAID' }, { status: 'PAID' }],
    });

    // A wrong signature is refused.
    const bad = await request(f.app)
      .post('/api/v1/partners/financing/webhooks')
      .set('Authorization', `Bearer ${tok.body.access_token as string}`)
      .set('X-CampusOne-Timestamp', String(Math.floor(Date.now() / 1000)))
      .set('X-CampusOne-Signature', `v1=${'0'.repeat(64)}`)
      .send({ ...approve, eventId: randomUUID() });
    expect(bad.status).toBe(401);
  });
});
