/**
 * Admissions on a real MySQL (Phase 5.4–5.5; SRS 7.8, 19; CR-14; INS-027…029, ADM-001…030):
 * - a link opens the landing; generating again retires the old link;
 * - the public form: a draft saved section by section, documents and references, the checks at
 *   submission (age band, documents), the application fee through the gateway's test mode (a bad
 *   signature fails and can be retried), the status lookup showing progress only;
 * - resume by a one-time code to the mobile on the application, the same answer when nothing matches;
 * - the counsellor's mid-term application: transfer certificate or undertaking and a reference,
 *   the fee in cash, approval creating the member, wallets, guardian and enrolment once, rejection;
 * - the admission fee by payment link, the receipt, and the existing-students import.
 */
import { createHmac, randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import request from 'supertest';
import { adminUrl } from './db';
import { buildHttpApp, codeOf } from './http-app';
import type { GatewayPayment, PaymentGateway } from '../../integrations/payment-gateway.provider';
import type { SchoolGatewayFactory } from '../../services/payment-gateways.service';
import { aadhaar, inr, schoolFixture, type Auth } from './school';
import { PERSON_CARDS } from '../../schemas/admissions.schema';
import { newPublicIdPair, uuidToBin } from '../../utils/idGenerator';
import { pngOf } from '../png';

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const TOKEN = 'X-Admission-Token';

describe.skipIf(!adminUrl)('admissions on real MySQL', () => {
  let f: Awaited<ReturnType<typeof schoolFixture>>;
  let con: Auth;
  let link: { id: string; url: string; token: string };
  let currentYear: { id: string; label: string };
  let nextYear: { id: string; rowId: string; label: string };
  let grade6: { id: string; sectionId: string };
  let today: string;
  /** The school's pick-up stop (client 2026-10-12: the family may opt for transport). */
  let stop: { id: string; name: string };

  const post = (path: string, body: object = {}, headers: Record<string, string> = con) =>
    request(f.app).post(path).set(headers).set('Idempotency-Key', randomUUID()).send(body);
  const pub = (
    method: 'get' | 'post' | 'patch' | 'delete',
    path: string,
    token: string,
    body?: object,
  ) => {
    const r = request(f.app)[method](path).set(TOKEN, token).set('Idempotency-Key', randomUUID());
    return body ? r.send(body) : r;
  };
  const attach = (path: string, token: string | null, type: string, auth?: Auth) => {
    let r = request(f.app).post(path).set('Idempotency-Key', randomUUID());
    if (token) r = r.set(TOKEN, token);
    if (auth) r = r.set(auth);
    return r.field('documentType', type).attach('file', PDF, `${type.toLowerCase()}.pdf`);
  };
  /** The application fee paid online in the gateway's test mode: the declared draft is submitted. */
  const payOnline = async (id: string, token: string) => {
    const base = `/api/v1/public/admissions/applications/${id}/fee-payments`;
    const o = await pub('post', base, token, {});
    expect(o.status, JSON.stringify(o.body)).toBe(201);
    const v = await pub('post', `${base}/${o.body.paymentId}/verify`, token, {
      gatewayPaymentId: o.body.gatewayOrder.test.paymentId,
      signature: o.body.gatewayOrder.test.signature,
    });
    expect(v.status, JSON.stringify(v.body)).toBe(200);
    return v.body as { applicationStatus: string };
  };
  /** `tc`: the transfer certificate, which a regular admission above LKG needs (2026-10-15). */
  const completeDraft = async (id: string, token: string, mobile: string, tc = true) => {
    const base = `/api/v1/public/admissions/applications/${id}`;
    for (const [section, data] of [
      [
        'addresses',
        {
          residential: {
            line1: 'No. 12, 4th Cross',
            // Required (client 2026-10-13).
            line2: 'Vinoba Nagar',
            city: 'Shivamogga',
            state: 'Karnataka',
            pin: '577205',
          },
          sameAsResidential: true,
        },
      ],
      [
        'parents',
        {
          // The father's and the mother's Aadhaar and PAN, not only the primary contact's (client
          // 2026-10-13).
          father: {
            name: 'Rakesh Shetty',
            mobile,
            email: 'rakesh@example.in',
            aadhaar: aadhaar(),
            pan: 'ABCPS1234F',
          },
          // The mother's name and mobile, and the children question, are required (client 2026-10-12).
          mother: {
            name: 'Pallavi Shetty',
            mobile: mobile.replace(/^9/, '8'),
            aadhaar: aadhaar(),
            pan: 'ABCPS5678K',
          },
          primary: 'FATHER',
          children: 'MORE',
        },
      ],
    ] as const) {
      const r = await pub('patch', base, token, { section, data });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    }
    // With both sides of the father's and the mother's Aadhaar and PAN cards (client 2026-10-13).
    for (const t of [
      'BIRTH',
      'ADDRESS',
      'REPORT',
      ...(tc ? ['TC'] : []),
      ...PERSON_CARDS.father,
      ...PERSON_CARDS.mother,
    ]) {
      const r = await attach(`${base}/documents`, token, t);
      expect(r.status, JSON.stringify(r.body)).toBe(201);
    }
  };

  beforeAll(async () => {
    f = await schoolFixture('Admission School');
    con = f.school.con;
    // The school sends SMS and e-mail (the family's notices go through the channels it has on).
    await f.t.db
      .insertInto('notification_channel_settings')
      .values(
        (['SMS', 'EMAIL'] as const).map((channel) => ({
          institution_id: f.school.rowId,
          channel,
          enabled: 1,
        })),
      )
      .onDuplicateKeyUpdate({ enabled: 1 })
      .execute();
    await f.student('Seed'); // the Student and Parent types and Grade 6 A
    today = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
    const classes = (await request(f.app).get('/api/v1/console/classes').set(con)).body.items as {
      id: string;
      name: string;
      sections: { id: string }[];
    }[];
    const g = classes.find((c) => c.name === 'Grade 6')!;
    grade6 = { id: g.id, sectionId: g.sections[0]!.id };
    const ef = (await request(f.app).get('/api/v1/console/entry-fees').set(con)).body.items as {
      year: { id: string; label: string; current: boolean };
    }[];
    currentYear = ef.find((x) => x.year.current)!.year;
    const put = await request(f.app)
      .put(`/api/v1/console/entry-fees/${currentYear.id}`)
      .set(con)
      .send({
        applicationFee: inr('500.00'),
        applicationMandatory: true,
        admissionFee: inr('10000.00'),
      });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    // Next year: admissions open, not started.
    const start = Number(currentYear.label.slice(0, 4)) + 1;
    const yPub = randomUUID();
    const ins = await f.t.db
      .insertInto('academic_years')
      .values({
        public_id: uuidToBin(yPub),
        institution_id: f.school.rowId,
        label: `${start}-${String((start + 1) % 100).padStart(2, '0')}`,
        starts_on: `${start}-04-01`,
        ends_on: `${start + 1}-03-31`,
        status: 'OPEN',
        is_current: 0,
        created_at: new Date(),
        updated_at: new Date(),
      })
      .executeTakeFirstOrThrow();
    nextYear = {
      id: yPub,
      rowId: String(ins.insertId),
      label: `${start}-${String((start + 1) % 100).padStart(2, '0')}`,
    };
    await f.t.db
      .insertInto('entry_fees')
      .values({
        institution_id: f.school.rowId,
        year_id: nextYear.rowId,
        application_fee_paise: 50_000,
        application_mandatory: 1,
        admission_fee_paise: 1_000_000,
      })
      .execute();
  }, 240_000);
  afterAll(async () => {
    await f?.t.drop();
  });

  it('opens the landing by link and retires an old link (INS-027/028, ADM-001)', async () => {
    const first = await post('/api/v1/console/admission-links', {});
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const second = await post('/api/v1/console/admission-links', {});
    const tokenOf = (url: string) => url.split('/').at(-1)!;
    link = { id: second.body.id, url: second.body.url, token: tokenOf(second.body.url) };
    expect(second.body.qrSvg).toMatch(/^<svg/);
    expect(
      (await request(f.app).get(`/api/v1/public/admissions/${tokenOf(first.body.url)}`)).body.code,
    ).toBe('ADM.LINK_INVALID');
    const listed = await request(f.app).get('/api/v1/console/admission-links').set(con);
    expect(listed.body.current.id).toBe(link.id);
    expect(listed.body.history).toEqual([
      expect.objectContaining({ status: 'REPLACED', url: null }),
    ]);
    // The school's active pick-up stops are offered to a family opting for transport.
    const at = new Date();
    const stopRow = (name: string, active: number) => {
      const pid = newPublicIdPair();
      return {
        id: pid.id,
        row: {
          public_id: pid.bin,
          institution_id: f.school.rowId,
          name,
          landmark: active ? 'Near the bus shelter' : null,
          active,
          created_at: at,
          updated_at: at,
        },
      };
    };
    const open = stopRow('Gopala Circle', 1);
    const closed = stopRow('Old Market', 0);
    await f.t.db.insertInto('transport_stops').values([open.row, closed.row]).execute();
    stop = { id: open.id, name: 'Gopala Circle' };
    const land = await request(f.app).get(`/api/v1/public/admissions/${link.token}`);
    expect(land.status, JSON.stringify(land.body)).toBe(200);
    expect(land.body.transportStops).toEqual([
      { id: open.id, name: 'Gopala Circle', landmark: 'Near the bus shelter' },
    ]);
    expect(land.body.years.map((y: { label: string; kind: string }) => [y.label, y.kind])).toEqual([
      [nextYear.label, 'REGULAR'],
      [currentYear.label, 'MID_TERM'],
    ]);
    expect(land.body.classes).toEqual(
      expect.arrayContaining([{ id: grade6.id, name: 'Grade 6', ageBand: { min: 11, max: 15 } }]),
    );
    // Only what a family needs, and the school's logo (client 2026-10-15).
    expect(Object.keys(land.body.institution).sort()).toEqual([
      'city',
      'logoUrl',
      'name',
      'shortName',
    ]);
  });

  it('takes a public application to submission, payment and status (ADM-004…012)', async () => {
    const diya = {
      firstName: 'Diya',
      lastName: 'Shetty',
      gender: 'FEMALE',
      dob: `${Number(nextYear.label.slice(0, 4)) - 11}-02-14`,
    };
    // The student's Aadhaar is checked: twelve digits, not starting with 0 or 1 (client 2026-10-12).
    const wrong = await post(
      `/api/v1/public/admissions/${link.token}/applications`,
      {
        class: { yearId: nextYear.id, classId: grade6.id },
        student: { ...diya, aadhaar: '123456789012' },
      },
      {},
    );
    expect(wrong.status).toBe(422);
    expect(wrong.body.errors).toEqual([
      expect.objectContaining({ field: 'student.aadhaar', code: 'ADM.ID_INVALID' }),
    ]);
    const diyaAadhaar = aadhaar();
    const created = await post(
      `/api/v1/public/admissions/${link.token}/applications`,
      {
        class: { yearId: nextYear.id, classId: grade6.id },
        // Typed in groups of four; the PAN in lower case.
        student: {
          ...diya,
          aadhaar: diyaAadhaar.replace(/(\d{4})(?=\d)/g, '$1 '),
          pan: 'bxsps4821k',
        },
      },
      {},
    );
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const app = created.body.application;
    const token = created.body.resumeToken as string;
    expect(app).toMatchObject({ status: 'DRAFT', midTerm: false, student: { firstName: 'Diya' } });
    // The identity number is no longer asked for (client 2026-10-12).
    expect(app.student).not.toHaveProperty('idNumber');
    // The numbers come back masked only; the full ones never leave the server.
    expect(app.student).toMatchObject({
      aadhaar: `XXXX XXXX ${diyaAadhaar.slice(-4)}`,
      pan: '••••••821K',
    });
    expect(JSON.stringify(created.body)).not.toContain(diyaAadhaar);
    expect(JSON.stringify(created.body)).not.toContain('BXSPS4821K');
    // The same Aadhaar under other names is the same child.
    const sameAadhaar = await post(
      `/api/v1/public/admissions/${link.token}/applications`,
      {
        class: { yearId: nextYear.id, classId: grade6.id },
        student: { ...diya, firstName: 'Riya', lastName: 'Kamath', aadhaar: diyaAadhaar },
      },
      {},
    );
    expect(sameAadhaar.body.code).toBe('ADM.DUPLICATE');
    expect(app.applicationNo).toMatch(/^[A-Z0-9]{2,5}\/\d{4}\/000001$/);
    // The same child twice for the same year is refused: the same names and birth date, whatever
    // the case of the letters.
    const sameChild = (lastName: string) =>
      post(
        `/api/v1/public/admissions/${link.token}/applications`,
        {
          class: { yearId: nextYear.id, classId: grade6.id },
          student: { firstName: 'DIYA', lastName, gender: 'FEMALE', dob: app.student.dob },
        },
        {},
      );
    expect((await sameChild('shetty')).body.code).toBe('ADM.DUPLICATE');
    // A twin or a namesake with another surname is not the same child.
    const twin = await sameChild('Shenoy');
    expect(twin.status, JSON.stringify(twin.body)).toBe(201);
    // The student's Aadhaar is optional (client 2026-10-12): it can be cleared, and the
    // application goes on to be submitted without it.
    const cleared = await pub('patch', `/api/v1/public/admissions/applications/${app.id}`, token, {
      section: 'student',
      data: { ...diya, aadhaar: null },
    });
    expect(cleared.status, JSON.stringify(cleared.body)).toBe(200);
    expect(cleared.body.student.aadhaar).toBeNull();
    expect(cleared.body.student.pan).toBe('••••••821K');
    // Without the token the draft can't be read; with it, it can.
    expect(
      (await request(f.app).get(`/api/v1/public/admissions/applications/${app.id}`)).status,
    ).toBe(404);
    expect(
      (await pub('get', `/api/v1/public/admissions/applications/${app.id}`, token)).status,
    ).toBe(200);
    // Submitting early names what is missing.
    const early = await pub(
      'post',
      `/api/v1/public/admissions/applications/${app.id}/submission`,
      token,
      { declarationAccepted: true, registrationConsent: true },
    );
    expect(early.status).toBe(422);
    expect(early.body.errors.map((e: { field: string }) => e.field)).toEqual(
      expect.arrayContaining([
        'addresses.residential',
        'parents.primary',
        'parents.father.aadhaar',
        'parents.father.pan',
        'parents.mother.aadhaar',
        'parents.mother.pan',
        'documents.FATHER_AADHAAR_FRONT',
        'documents.MOTHER_PAN_BACK',
        'documents.BIRTH',
      ]),
    );
    expect(early.body.errors.map((e: { field: string }) => e.field)).not.toContain(
      'student.aadhaar',
    );
    // The mother's details and the children question are required (client 2026-10-12).
    const noMother = await pub('patch', `/api/v1/public/admissions/applications/${app.id}`, token, {
      section: 'parents',
      data: { father: { name: 'Rakesh Shetty', mobile: '9876501234' }, primary: 'FATHER' },
    });
    expect(noMother.status).toBe(422);
    expect(noMother.body.errors.map((e: { field: string }) => e.field)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/mother$/),
        expect.stringMatching(/children$/),
      ]),
    );
    await completeDraft(app.id, token, '9876501234');
    // School transport, with a pick-up stop from the school's list (client 2026-10-12).
    const parents = {
      father: { name: 'Rakesh Shetty', mobile: '9876501234', email: 'rakesh@example.in' },
      mother: { name: 'Pallavi Shetty', mobile: '8876501234' },
      primary: 'FATHER',
      children: 'MORE',
    };
    const base = `/api/v1/public/admissions/applications/${app.id}`;
    const badStop = await pub('patch', base, token, {
      section: 'parents',
      data: { ...parents, transport: true, transportStopId: randomUUID() },
    });
    expect(badStop.status).toBe(422);
    expect(badStop.body.errors).toEqual([
      expect.objectContaining({
        field: 'parents.transportStopId',
        code: 'ADM.TRANSPORT_STOP_INVALID',
      }),
    ]);
    const bus = await pub('patch', base, token, {
      section: 'parents',
      data: { ...parents, transport: true, transportStopId: stop.id },
    });
    expect(bus.status, JSON.stringify(bus.body)).toBe(200);
    expect(bus.body.parents).toMatchObject({ transport: true, transportStop: stop });
    expect(bus.body.parents).not.toHaveProperty('transportStopId');
    // The primary contact stayed the same: their Aadhaar and PAN are kept.
    expect(bus.body.primaryContact.pan).toBe('••••••234F');
    // The admission fee comes with the submitted form or after it, never before (client 2026-10-09).
    const early2 = await pub(
      'post',
      `/api/v1/public/admissions/applications/${app.id}/fee-payments`,
      token,
      { feeType: 'ADMISSION' },
    );
    expect(early2.status).toBe(409);
    expect(early2.body.code).toBe('ADM.ADMISSION_FEE_NOT_YET');
    // The primary contact's numbers, masked too, and each person's; none in the stored section.
    const filled = await pub('get', `/api/v1/public/admissions/applications/${app.id}`, token);
    expect(filled.body.primaryContact).toMatchObject({
      aadhaar: expect.stringMatching(/^XXXX XXXX \d{4}$/),
      pan: '••••••234F',
    });
    expect(filled.body.identityNumbers).toEqual({
      father: { aadhaar: expect.stringMatching(/^XXXX XXXX \d{4}$/), pan: '••••••234F' },
      mother: { aadhaar: expect.stringMatching(/^XXXX XXXX \d{4}$/), pan: '••••••678K' },
      guardian: { aadhaar: null, pan: null },
      localGuardian: { aadhaar: null, pan: null },
    });
    expect(filled.body.parents.father).not.toHaveProperty('aadhaar');
    expect(filled.body.parents.mother).not.toHaveProperty('pan');
    // The family's consent to register their RingPe account is required (client 2026-10-12).
    const noConsent = await pub(
      'post',
      `/api/v1/public/admissions/applications/${app.id}/submission`,
      token,
      { declarationAccepted: true },
    );
    expect(noConsent.status).toBe(422);
    expect(noConsent.body.errors).toEqual([
      expect.objectContaining({ field: 'registrationConsent', code: 'ADM.CONSENT_REQUIRED' }),
    ]);
    const sub = await pub(
      'post',
      `/api/v1/public/admissions/applications/${app.id}/submission`,
      token,
      { declarationAccepted: true, registrationConsent: true },
    );
    expect(sub.status, JSON.stringify(sub.body)).toBe(200);
    // The application fee is paid online to submit (client 2026-10-13).
    expect(sub.body).toMatchObject({
      status: 'DRAFT',
      feeDue: { amount: '500.00', mandatory: true },
    });

    // The gateway's test mode: a bad signature fails; a new order succeeds.
    const order = await pub(
      'post',
      `/api/v1/public/admissions/applications/${app.id}/fee-payments`,
      token,
      {},
    );
    expect(order.status, JSON.stringify(order.body)).toBe(201);
    expect(order.body).toMatchObject({
      feeType: 'APPLICATION',
      amount: inr('500.00'),
      gatewayOrder: { mode: 'test' },
    });
    const bad = await pub(
      'post',
      `/api/v1/public/admissions/applications/${app.id}/fee-payments/${order.body.paymentId}/verify`,
      token,
      {
        gatewayPaymentId: order.body.gatewayOrder.test.paymentId,
        signature: '0'.repeat(64),
      },
    );
    expect(bad.status).toBe(402);
    expect(bad.body.code).toBe('ADM.PAYMENT_NOT_VERIFIED');
    const again = await pub(
      'post',
      `/api/v1/public/admissions/applications/${app.id}/fee-payments`,
      token,
      {},
    );
    // A receipt number already taken (a desk receipt typed in the same form) is skipped, so the
    // gateway's payment is always recorded.
    const payRow = await f.t.db
      .selectFrom('admission_payments')
      .select(['id', 'institution_id', 'application_id'])
      .where('public_id', '=', uuidToBin(again.body.paymentId))
      .executeTakeFirstOrThrow();
    const receiptBase = `${String(app.applicationNo).split('/')[0]}/R/${new Date(Date.now() + 330 * 60_000).getUTCFullYear()}/`;
    const planted = `${receiptBase}${String(payRow.id).padStart(6, '0')}`;
    await f.t.db
      .insertInto('admission_payments')
      .values({
        public_id: newPublicIdPair().bin,
        institution_id: payRow.institution_id,
        application_id: payRow.application_id,
        fee_type: 'ADMISSION',
        amount_paise: 100,
        status: 'PAID',
        mode: 'CASH',
        receipt_no: planted,
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
    const ok = await pub(
      'post',
      `/api/v1/public/admissions/applications/${app.id}/fee-payments/${again.body.paymentId}/verify`,
      token,
      again.body.gatewayOrder.test.paymentId
        ? {
            gatewayPaymentId: again.body.gatewayOrder.test.paymentId,
            signature: again.body.gatewayOrder.test.signature,
          }
        : {},
    );
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ status: 'PAID', applicationStatus: 'SUBMITTED' });
    // The payment gateway's transaction ID is shown to the family (client 2026-10-16).
    const txn = again.body.gatewayOrder.test.paymentId as string;
    expect(ok.body.transactionId).toBe(txn);
    expect(ok.body.receiptNo).toMatch(/\/R\/\d{4}\/\d{6}$/);
    expect(ok.body.receiptNo).toBe(
      `${receiptBase}${String(Number(payRow.id) + 1).padStart(6, '0')}`,
    );
    await f.t.db.deleteFrom('admission_payments').where('receipt_no', '=', planted).execute();
    // Paying the application fee submitted it: the family is told by SMS and e-mail (logged).
    const received = f.h.sms.sent.findLast((m) => m.to.endsWith('9876501234'));
    expect(received?.purpose).toBe('admission.submitted');
    expect(received?.text).toContain(`we have received application ${app.applicationNo}`);
    expect(f.h.email.sent.findLast((m) => m.to === 'rakesh@example.in')?.purpose).toBe(
      'admission.submitted',
    );

    const status = await post(
      '/api/v1/public/admissions/status',
      { applicationNo: app.applicationNo, mobile: '9876501234' },
      {},
    );
    expect(status.status, JSON.stringify(status.body)).toBe(200);
    expect(status.body).toMatchObject({
      status: 'SUBMITTED',
      name: 'D••• S•••••',
      fees: { application: { status: 'PAID', transactionId: txn } },
    });
    expect(JSON.stringify(status.body)).not.toMatch(/Rakesh|657410|Shivamogga/);
    expect(
      (
        await post(
          '/api/v1/public/admissions/status',
          { applicationNo: app.applicationNo, mobile: '9876500000' },
          {},
        )
      ).body.code,
    ).toBe('ADM.STATUS_NOT_FOUND');

    // A child too young for the class is refused at submission (BR-50).
    const young = await post(
      `/api/v1/public/admissions/${link.token}/applications`,
      {
        class: { yearId: nextYear.id, classId: grade6.id },
        student: {
          firstName: 'Ira',
          lastName: 'Rao',
          gender: 'FEMALE',
          dob: `${Number(nextYear.label.slice(0, 4)) - 8}-01-01`,
          aadhaar: aadhaar(),
        },
      },
      {},
    );
    await completeDraft(young.body.application.id, young.body.resumeToken, '9876501299');
    const refused = await pub(
      'post',
      `/api/v1/public/admissions/applications/${young.body.application.id}/submission`,
      young.body.resumeToken,
      { declarationAccepted: true, registrationConsent: true },
    );
    expect(refused.body).toMatchObject({
      code: 'ADM.AGE_TOO_LOW',
      params: { n: 11, standard: 'Grade 6' },
    });
  });

  it('pays through Razorpay: checkout key, the payment checked with the gateway, and its webhook (client 2026-10-09)', async () => {
    // A gateway answering like Razorpay (live mode), without the network.
    const KEY_SECRET = 'rzp-key-secret';
    const HOOK_SECRET = 'rzp-hook-secret';
    const sign = (o: string, p: string) =>
      createHmac('sha256', KEY_SECRET).update(`${o}|${p}`).digest('hex');
    const held = new Map<string, GatewayPayment>();
    let n = 0;
    const gateway: PaymentGateway = {
      mode: 'live',
      async createOrder({ amountPaise }) {
        n += 1;
        return { orderId: `order_FAKE${n}`, amountPaise, checkout: { keyId: 'rzp_test_FAKE' } };
      },
      verify: ({ orderId, paymentId, signature }) => signature === sign(orderId, paymentId),
      async fetchPayment(id) {
        const p = held.get(id);
        if (!p) throw new Error('unknown payment');
        return p;
      },
      async capturePayment(id) {
        const p = { ...held.get(id)!, status: 'captured' };
        held.set(id, p);
        return p;
      },
      verifyWebhook: (raw, sig) =>
        sig === createHmac('sha256', HOOK_SECRET).update(raw).digest('hex'),
    };
    const live = await buildHttpApp(f.t, { overrides: { gateway }, security: f.h.security });
    const livePub = (path: string, token: string, body: object) =>
      request(live.app)
        .post(path)
        .set(TOKEN, token)
        .set('Idempotency-Key', randomUUID())
        .send(body);
    const draft = async (first: string, mobile: string) => {
      const c = await post(
        `/api/v1/public/admissions/${link.token}/applications`,
        {
          class: { yearId: nextYear.id, classId: grade6.id },
          student: {
            firstName: first,
            lastName: 'Rao',
            gender: 'FEMALE',
            dob: `${Number(nextYear.label.slice(0, 4)) - 11}-05-20`,
            aadhaar: aadhaar(),
          },
        },
        {},
      );
      expect(c.status, JSON.stringify(c.body)).toBe(201);
      const id = c.body.application.id as string;
      const token = c.body.resumeToken as string;
      await completeDraft(id, token, mobile);
      const sub = await pub(
        'post',
        `/api/v1/public/admissions/applications/${id}/submission`,
        token,
        { declarationAccepted: true, registrationConsent: true },
      );
      expect(sub.status, JSON.stringify(sub.body)).toBe(200);
      return { id, token, base: `/api/v1/public/admissions/applications/${id}/fee-payments` };
    };

    // 1. The order carries the public key for Razorpay Checkout (never the secret).
    const a = await draft('Ira', '9876501301');
    const order = await livePub(a.base, a.token, {});
    expect(order.status, JSON.stringify(order.body)).toBe(201);
    expect(order.body.gatewayOrder).toMatchObject({
      orderId: 'order_FAKE1',
      mode: 'live',
      checkout: { keyId: 'rzp_test_FAKE' },
    });
    expect(order.body.gatewayOrder.checkout.name).toBeTruthy();
    expect(JSON.stringify(order.body)).not.toContain(KEY_SECRET);

    // 2. A correctly signed payment for a smaller amount is refused after the gateway check.
    held.set('pay_LOW', {
      id: 'pay_LOW',
      orderId: 'order_FAKE1',
      amountPaise: 100,
      status: 'captured',
      method: 'upi',
    });
    const low = await livePub(`${a.base}/${order.body.paymentId}/verify`, a.token, {
      gatewayPaymentId: 'pay_LOW',
      signature: sign('order_FAKE1', 'pay_LOW'),
    });
    expect(low.status).toBe(402);
    const failed = await f.t.db
      .selectFrom('admission_payments')
      .select(['status', 'failure_reason'])
      .where('gateway_order_id', '=', 'order_FAKE1')
      .executeTakeFirstOrThrow();
    expect(failed).toEqual({
      status: 'FAILED',
      failure_reason: 'The amount paid differs from the fee',
    });

    // 3. The right amount, only authorised: captured, then the fee is paid.
    const again = await livePub(a.base, a.token, {});
    held.set('pay_OK', {
      id: 'pay_OK',
      orderId: 'order_FAKE2',
      amountPaise: 50000,
      status: 'authorized',
      method: 'card',
    });
    const ok = await livePub(`${a.base}/${again.body.paymentId}/verify`, a.token, {
      gatewayPaymentId: 'pay_OK',
      signature: sign('order_FAKE2', 'pay_OK'),
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ status: 'PAID', applicationStatus: 'SUBMITTED' });
    expect(held.get('pay_OK')!.status).toBe('captured');

    // 4. The family closed the page: the signed webhook marks the fee paid, once.
    const b = await draft('Tara', '9876501302');
    const bOrder = await livePub(b.base, b.token, {});
    const event = JSON.stringify({
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: 'pay_HOOK',
            order_id: bOrder.body.gatewayOrder.orderId,
            amount: 50000,
            status: 'captured',
          },
        },
      },
    });
    const hook = (body: string, sig: string, id = 'evt_1') =>
      request(live.app)
        .post('/api/v1/partners/gateway/webhooks')
        .set('Content-Type', 'application/json')
        .set('X-Razorpay-Signature', sig)
        .set('X-Razorpay-Event-Id', id)
        .send(body);
    const good = createHmac('sha256', HOOK_SECRET).update(event).digest('hex');
    expect((await hook(event, '0'.repeat(64))).status).toBe(401);
    const first = await hook(event, good);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body).toEqual({ ok: true, outcome: 'PAID' });
    expect((await hook(event, good)).body).toEqual({ ok: true, duplicate: true });
    const paid = await f.t.db
      .selectFrom('admission_payments')
      .select(['status', 'gateway_payment_id'])
      .where('gateway_order_id', '=', bOrder.body.gatewayOrder.orderId)
      .executeTakeFirstOrThrow();
    expect(paid).toEqual({ status: 'PAID', gateway_payment_id: 'pay_HOOK' });
    const other = JSON.stringify({ event: 'refund.created', payload: {} });
    const ignored = await hook(
      other,
      createHmac('sha256', HOOK_SECRET).update(other).digest('hex'),
      'evt_2',
    );
    expect(ignored.body).toEqual({ ok: true, outcome: 'IGNORED' });
  });

  it('pays both fees in one live order: checked against the order total, and settled by webhook', async () => {
    // Before the school adds its own gateway (next test): RingPe's own gateway takes the order.
    const hmac = (secret: string, data: string) =>
      createHmac('sha256', secret).update(data).digest('hex');
    const held = new Map<string, GatewayPayment>();
    let n = 0;
    const gateway: PaymentGateway = {
      mode: 'live',
      createOrder: async ({ amountPaise }) => ({
        orderId: `order_BOTH${++n}`,
        amountPaise,
        checkout: { keyId: 'rzp_test_BOTH' },
      }),
      verify: ({ orderId, paymentId, signature }) =>
        signature === hmac('both-secret', `${orderId}|${paymentId}`),
      fetchPayment: async (id) => held.get(id)!,
      verifyWebhook: (raw, sig) => sig === hmac('both-hook', raw.toString()),
    };
    const live = await buildHttpApp(f.t, { overrides: { gateway }, security: f.h.security });
    const send = (path: string, token: string, body: object) =>
      request(live.app)
        .post(path)
        .set(TOKEN, token)
        .set('Idempotency-Key', randomUUID())
        .send(body);
    const both = async (first: string, mobile: string) => {
      const c = await post(
        `/api/v1/public/admissions/${link.token}/applications`,
        {
          class: { yearId: nextYear.id, classId: grade6.id },
          student: {
            firstName: first,
            lastName: 'Rao',
            gender: 'FEMALE',
            dob: `${Number(nextYear.label.slice(0, 4)) - 11}-05-14`,
            aadhaar: aadhaar(),
          },
        },
        {},
      );
      expect(c.status, JSON.stringify(c.body)).toBe(201);
      const id = c.body.application.id as string;
      const token = c.body.resumeToken as string;
      await completeDraft(id, token, mobile);
      const sub = await pub(
        'post',
        `/api/v1/public/admissions/applications/${id}/submission`,
        token,
        { declarationAccepted: true, registrationConsent: true },
      );
      expect(sub.status, JSON.stringify(sub.body)).toBe(200);
      const base = `/api/v1/public/admissions/applications/${id}/fee-payments`;
      const order = await send(base, token, { withAdmission: true });
      expect(order.status, JSON.stringify(order.body)).toBe(201);
      expect(order.body.gatewayOrder.amount).toEqual(inr('10500.00'));
      return {
        token,
        base,
        paymentId: order.body.paymentId as string,
        orderId: order.body.gatewayOrder.orderId as string,
      };
    };
    const feesOn = (orderId: string) =>
      f.t.db
        .selectFrom('admission_payments')
        .select(['fee_type', 'status'])
        .where('gateway_order_id', '=', orderId)
        .orderBy('fee_type')
        .execute();
    const bothPaid = [
      { fee_type: 'APPLICATION', status: 'PAID' },
      { fee_type: 'ADMISSION', status: 'PAID' },
    ];

    // The gateway holds one payment for the order's total (₹500 + ₹10,000): both fees are paid.
    const a = await both('Mira', '9876501304');
    held.set('pay_BOTH', {
      id: 'pay_BOTH',
      orderId: a.orderId,
      amountPaise: 1_050_000,
      status: 'captured',
      method: 'upi',
    });
    const ok = await send(`${a.base}/${a.paymentId}/verify`, a.token, {
      gatewayPaymentId: 'pay_BOTH',
      signature: hmac('both-secret', `${a.orderId}|pay_BOTH`),
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.receipts.map((r: { feeType: string }) => r.feeType)).toEqual([
      'APPLICATION',
      'ADMISSION',
    ]);
    expect(await feesOn(a.orderId)).toEqual(bothPaid);

    // The family closed the page: the webhook for the order's total settles both fees.
    const b = await both('Nila', '9876501305');
    const event = JSON.stringify({
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: 'pay_BOTH_HOOK',
            order_id: b.orderId,
            amount: 1_050_000,
            status: 'captured',
          },
        },
      },
    });
    const hook = await request(live.app)
      .post('/api/v1/partners/gateway/webhooks')
      .set('Content-Type', 'application/json')
      .set('X-Razorpay-Signature', hmac('both-hook', event))
      .set('X-Razorpay-Event-Id', 'evt_both_1')
      .send(event);
    expect(hook.body).toEqual({ ok: true, outcome: 'PAID' });
    expect(await feesOn(b.orderId)).toEqual(bothPaid);
  });

  it("takes the fee with the school's own default gateway; only that gateway's webhook settles it (client 2026-10-09)", async () => {
    const held = new Map<string, GatewayPayment>();
    let n = 0;
    const hmac = (secret: string, data: string) =>
      createHmac('sha256', secret).update(data).digest('hex');
    // RingPe's own gateway (live) and the school's, each answering like Razorpay.
    const platform: PaymentGateway = {
      mode: 'live',
      createOrder: async ({ amountPaise }) => ({
        orderId: `order_PLATFORM${++n}`,
        amountPaise,
        checkout: { keyId: 'rzp_test_PLATFORM' },
      }),
      verify: ({ orderId, paymentId, signature }) =>
        signature === hmac('platform-secret', `${orderId}|${paymentId}`),
      fetchPayment: async (id) => held.get(id)!,
      verifyWebhook: (raw, sig) => sig === hmac('platform-hook', raw.toString()),
    };
    const school: SchoolGatewayFactory = (keys) => ({
      mode: 'live',
      createOrder: async ({ amountPaise }) => ({
        orderId: `order_SCHOOL${++n}`,
        amountPaise,
        checkout: { keyId: keys.keyId },
      }),
      verify: ({ orderId, paymentId, signature }) =>
        signature === hmac(keys.keySecret, `${orderId}|${paymentId}`),
      fetchPayment: async (id) => held.get(id)!,
      verifyWebhook: (raw, sig) =>
        !!keys.webhookSecret && sig === hmac(keys.webhookSecret, raw.toString()),
      checkCredentials: async () => ({ ok: true, note: 'Accepted' }),
    });
    const live = await buildHttpApp(f.t, {
      overrides: { gateway: platform, schoolGateway: school },
      security: f.h.security,
    });
    const added = await request(live.app)
      .post('/api/v1/console/payment-gateways')
      .set(con)
      .set('Idempotency-Key', randomUUID())
      .send({
        label: 'Admissions account',
        keyId: 'rzp_test_SCHOOLKEY1',
        keySecret: 'school-key-secret',
        webhookSecret: 'school-hook-secret',
      });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    expect(added.body).toMatchObject({ isDefault: true, lastCheck: { ok: true } });

    const c = await post(
      `/api/v1/public/admissions/${link.token}/applications`,
      {
        class: { yearId: nextYear.id, classId: grade6.id },
        student: {
          firstName: 'Usha',
          lastName: 'Rao',
          gender: 'FEMALE',
          dob: `${Number(nextYear.label.slice(0, 4)) - 11}-07-01`,
          aadhaar: aadhaar(),
        },
      },
      {},
    );
    const id = c.body.application.id as string;
    const token = c.body.resumeToken as string;
    await completeDraft(id, token, '9876501303');
    await pub('post', `/api/v1/public/admissions/applications/${id}/submission`, token, {
      declarationAccepted: true,
      registrationConsent: true,
    });
    const order = await request(live.app)
      .post(`/api/v1/public/admissions/applications/${id}/fee-payments`)
      .set(TOKEN, token)
      .set('Idempotency-Key', randomUUID())
      .send({});
    expect(order.body.gatewayOrder).toMatchObject({ checkout: { keyId: 'rzp_test_SCHOOLKEY1' } });
    const orderId = order.body.gatewayOrder.orderId as string;
    expect(orderId).toMatch(/^order_SCHOOL/);
    const row = await f.t.db
      .selectFrom('admission_payments as p')
      .innerJoin('institution_payment_gateways as g', 'g.id', 'p.gateway_id')
      .select(['g.label'])
      .where('p.gateway_order_id', '=', orderId)
      .executeTakeFirstOrThrow();
    expect(row.label).toBe('Admissions account');

    // Signed with RingPe's key instead of the school's: refused.
    held.set('pay_S1', {
      id: 'pay_S1',
      orderId,
      amountPaise: 50000,
      status: 'captured',
      method: 'upi',
    });
    const wrongKey = await request(live.app)
      .post(
        `/api/v1/public/admissions/applications/${id}/fee-payments/${order.body.paymentId}/verify`,
      )
      .set(TOKEN, token)
      .send({
        gatewayPaymentId: 'pay_S1',
        signature: hmac('platform-secret', `${orderId}|pay_S1`),
      });
    expect(wrongKey.status).toBe(402);

    // The webhook: RingPe's own address doesn't settle the school's order; the school's does.
    const again = await request(live.app)
      .post(`/api/v1/public/admissions/applications/${id}/fee-payments`)
      .set(TOKEN, token)
      .set('Idempotency-Key', randomUUID())
      .send({});
    const orderId2 = again.body.gatewayOrder.orderId as string;
    const event = JSON.stringify({
      event: 'payment.captured',
      payload: {
        payment: {
          entity: { id: 'pay_S2', order_id: orderId2, amount: 50000, status: 'captured' },
        },
      },
    });
    const viaPlatform = await request(live.app)
      .post('/api/v1/partners/gateway/webhooks')
      .set('Content-Type', 'application/json')
      .set('X-Razorpay-Signature', hmac('platform-hook', event))
      .set('X-Razorpay-Event-Id', 'evt_school_1')
      .send(event);
    expect(viaPlatform.body).toEqual({ ok: true, outcome: 'UNKNOWN_ORDER' });
    const hookPath = `/api/v1/partners/gateway/webhooks/${added.body.id}`;
    const forged = await request(live.app)
      .post(hookPath)
      .set('Content-Type', 'application/json')
      .set('X-Razorpay-Signature', hmac('platform-hook', event))
      .set('X-Razorpay-Event-Id', 'evt_school_2')
      .send(event);
    expect(forged.status).toBe(401);
    const viaSchool = await request(live.app)
      .post(hookPath)
      .set('Content-Type', 'application/json')
      .set('X-Razorpay-Signature', hmac('school-hook-secret', event))
      .set('X-Razorpay-Event-Id', 'evt_school_2')
      .send(event);
    expect(viaSchool.body).toEqual({ ok: true, outcome: 'PAID' });
  });

  it('resumes by a one-time code to the mobile on the application (ADM-002/003)', async () => {
    const ask = await post(
      `/api/v1/public/admissions/${link.token}/resume`,
      { mobile: '9876501234' },
      {},
    );
    expect(ask.status, JSON.stringify(ask.body)).toBe(202);
    const code = codeOf(f.h.sms.sent.findLast((m) => m.to.endsWith('9876501234')));
    const verified = await post(
      `/api/v1/public/admissions/${link.token}/resume/verify`,
      {
        challengeId: ask.body.challengeId,
        requestToken: ask.body.requestToken,
        otp: code,
      },
      {},
    );
    expect(verified.status, JSON.stringify(verified.body)).toBe(200);
    expect(verified.body.applications).toEqual([
      expect.objectContaining({
        status: 'SUBMITTED',
        name: 'D••• S•••••',
        classApplied: 'Grade 6',
      }),
    ]);
    // Nobody with this mobile: the same answer shape, and no code works.
    const none = await post(
      `/api/v1/public/admissions/${link.token}/resume`,
      { mobile: '9876500001' },
      {},
    );
    expect(none.status).toBe(202);
    expect(Object.keys(none.body).sort()).toEqual(['challengeId', 'requestToken', 'sentTo']);
    // The token reveals neither the mobile nor whether anything matched.
    const payload = (t: string) => Buffer.from(t.split('.')[1] ?? '', 'base64url').toString('utf8');
    expect(payload(ask.body.requestToken)).not.toContain('9876501234');
    expect(none.body.requestToken.length).toBe(ask.body.requestToken.length);
    expect(
      (
        await post(
          `/api/v1/public/admissions/${link.token}/resume/verify`,
          {
            challengeId: none.body.challengeId,
            requestToken: none.body.requestToken,
            otp: '123456',
          },
          {},
        )
      ).status,
    ).toBe(400);
  });

  it('lets a family submit a mid-term application online with an undertaking for the transfer certificate (client 2026-10-13)', async () => {
    const plus = (d: string, n: number) => {
      const x = new Date(`${d}T00:00:00Z`);
      x.setUTCDate(x.getUTCDate() + n);
      return x.toISOString().slice(0, 10);
    };
    const c = await post(
      `/api/v1/public/admissions/${link.token}/applications`,
      {
        class: {
          yearId: currentYear.id,
          classId: grade6.id,
          joiningDate: today,
          midTermReason: 'Moved to Shivamogga',
        },
        student: {
          firstName: 'Anvi',
          lastName: 'Kulkarni',
          gender: 'FEMALE',
          dob: `${Number(currentYear.label.slice(0, 4)) - 12}-08-01`,
        },
      },
      {},
    );
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    expect(c.body.application.midTerm).toBe(true);
    const id = c.body.application.id as string;
    const token = c.body.resumeToken as string;
    await completeDraft(id, token, '9876501901', false);
    const base = `/api/v1/public/admissions/applications/${id}`;
    const submit = () =>
      pub('post', `${base}/submission`, token, {
        declarationAccepted: true,
        registrationConsent: true,
      });
    // Before: nothing on the certificate, and the family had no way to give an undertaking.
    expect((await submit()).body.code).toBe('ADM.TC_OR_UNDERTAKING_REQUIRED');
    const previous = (tc: object) =>
      pub('patch', base, token, {
        section: 'previous',
        data: { school: 'Vidya Mandir', lastClass: 'Grade 6', board: 'STATE', tc },
      });
    // At most 60 days after joining.
    const late = await previous({ mode: 'UNDERTAKING', dueDate: plus(today, 61) });
    expect(late.status).toBe(422);
    expect(late.body.errors).toContainEqual(
      expect.objectContaining({ field: 'previous.tc.dueDate', code: 'ADM.TC_DUE_DATE' }),
    );
    expect((await previous({ mode: 'UNDERTAKING' })).status).toBe(422);
    const due = plus(today, 30);
    const saved = await previous({ mode: 'UNDERTAKING', dueDate: due });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.tc).toMatchObject({ mode: 'UNDERTAKING', dueDate: due });
    // The certificate isn't asked for any more; a reference still is.
    expect((await submit()).body.code).toBe('ADM.REFERENCES_REQUIRED');
    // School transport or the hostel, not both (client 2026-10-13).
    const both = await pub('patch', base, token, {
      section: 'parents',
      data: {
        father: { name: 'Rakesh Kulkarni', mobile: '9876501901' },
        mother: { name: 'Pallavi Kulkarni', mobile: '8876501901' },
        primary: 'FATHER',
        children: 'MORE',
        transport: true,
        hostel: true,
        localGuardian: {
          name: 'Suma Rao',
          relation: 'Aunt',
          mobile: '9876501902',
          address: 'Vinoba Nagar, Shivamogga',
        },
      },
    });
    expect(both.status).toBe(422);
    expect(both.body.errors).toContainEqual(
      expect.objectContaining({ field: 'parents.hostel', code: 'ADM.TRANSPORT_OR_HOSTEL' }),
    );
    // The PDF copy is for a submitted application only.
    expect((await pub('get', `${base}/form.pdf`, token)).body.code).toBe('ADM.FORM_NOT_SUBMITTED');
    const ref = await pub('post', `${base}/references`, token, {
      name: 'Sunita Rao',
      relation: 'Class teacher',
      mobile: '9845009977',
    });
    expect(ref.status, JSON.stringify(ref.body)).toBe(201);
    // A picture attached is drawn in the PDF; any other file is listed by its name (2026-10-14).
    const photo = await request(f.app)
      .post(`${base}/documents`)
      .set(TOKEN, token)
      .set('Idempotency-Key', randomUUID())
      .field('documentType', 'PHOTO')
      .attach(
        'file',
        pngOf({
          width: 2,
          height: 2,
          type: 2,
          rows: [
            [9, 9, 9, 200, 200, 200],
            [1, 2, 3, 4, 5, 6],
          ],
        }),
        { filename: 'photo.png', contentType: 'image/png' },
      );
    expect(photo.status, JSON.stringify(photo.body)).toBe(201);
    // "Pay later" is no longer honoured for the family: the application fee is paid online to
    // submit (client 2026-10-13).
    const sub = await pub('post', `${base}/submission`, token, {
      declarationAccepted: true,
      registrationConsent: true,
      payLater: true,
    });
    expect(sub.status, JSON.stringify(sub.body)).toBe(200);
    expect(sub.body).toMatchObject({ status: 'DRAFT', feeDue: { mandatory: true } });
    expect((await payOnline(id, token)).applicationStatus).toBe('SUBMITTED');
    // The school sees the undertaking and its date.
    const seen = await request(f.app).get(`/api/v1/console/applications/${id}`).set(con);
    expect(seen.body.tc).toMatchObject({ mode: 'UNDERTAKING', dueDate: due });

    // The family downloads the submitted form as a PDF (client 2026-10-13).
    const pdf = await pub('get', `${base}/form.pdf`, token)
      .buffer(true)
      .parse((res, done) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => done(null, Buffer.concat(chunks)));
      });
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.headers['content-disposition']).toMatch(
      /^attachment; filename="Application-.+\.pdf"$/,
    );
    const text = (pdf.body as Buffer).toString('latin1');
    expect(text.startsWith('%PDF')).toBe(true);
    for (const words of [
      seen.body.applicationNo as string,
      'Anvi Kulkarni',
      'Previous schooling',
      'Vidya Mandir',
      'Undertaking',
      'Sunita Rao',
      'Declaration',
      'photo.png',
      'birth.pdf',
    ]) {
      expect(text, words).toContain(words);
    }
    // The photo drawn (2 × 2 pixels, never enlarged); the PDFs by their names only.
    expect(text.match(/\/Subtype \/Image/g)).toHaveLength(1);
    expect(text).toMatch(/q 2 0 0 2 210 [\d.]+ cm \/Im0 Do Q/);
    // Without the family's token, nothing.
    expect((await request(f.app).get(`${base}/form.pdf`)).status).toBe(404);
  });

  it('takes mobiles with a country code, removes an attachment and opens one (client 2026-10-13)', async () => {
    const c = await post(
      `/api/v1/public/admissions/${link.token}/applications`,
      {
        class: { yearId: nextYear.id, classId: grade6.id },
        student: {
          firstName: 'Tara',
          lastName: 'Menon',
          gender: 'FEMALE',
          dob: `${Number(nextYear.label.slice(0, 4)) - 11}-06-10`,
        },
      },
      {},
    );
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    const id = c.body.application.id as string;
    const token = c.body.resumeToken as string;
    await completeDraft(id, token, '9876507001');
    const base = `/api/v1/public/admissions/applications/${id}`;
    const parents = (mother: string, father = '9876507001') =>
      pub('patch', base, token, {
        section: 'parents',
        data: {
          father: { name: 'Ravi Menon', mobile: father, email: 'ravi@example.in' },
          mother: { name: 'Anu Menon', mobile: mother },
          primary: 'FATHER',
          children: 'SINGLE',
        },
      });
    const short = await parents('+97150');
    expect(short.status).toBe(422);
    expect(short.body.errors).toEqual([
      // Relative to the section, as every section's field errors are.
      expect.objectContaining({ field: 'mother.mobile', code: 'ADM.MOBILE_INTL_INVALID' }),
    ]);
    // Another country: kept with its code; India's "+91" is dropped.
    const ok = await parents('+971501234567', '+91 98765 07001');
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.parents.mother.mobile).toBe('+971501234567');
    expect(ok.body.parents.father.mobile).toBe('9876507001');
    const ref = await pub('post', `${base}/references`, token, {
      name: 'Sara Thomas',
      relation: 'Neighbour',
      mobile: '+447700900123',
    });
    expect(ref.status, JSON.stringify(ref.body)).toBe(201);
    expect(ref.body.references[0].mobile).toBe('+447700900123');

    // An attachment opened by a short-lived link, then removed; a required one is asked again.
    const opened = await pub('get', `${base}/documents/BIRTH`, token);
    expect(opened.status, JSON.stringify(opened.body)).toBe(200);
    expect(opened.body).toMatchObject({ name: 'birth.pdf', mimeType: 'application/pdf' });
    expect(opened.body.url).toMatch(/^\/api\/v1\/files\/[0-9a-f-]+\/content\?exp=\d+&sig=/);
    expect((await request(f.app).get(`${base}/documents/BIRTH`)).status).toBe(404);
    const removed = await pub('delete', `${base}/documents/BIRTH`, token);
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    expect(removed.body.documents.map((d: { type: string }) => d.type)).not.toContain('BIRTH');
    expect((await pub('delete', `${base}/documents/BIRTH`, token)).status).toBe(404);
    const sub = await pub('post', `${base}/submission`, token, {
      declarationAccepted: true,
      registrationConsent: true,
    });
    expect(sub.status).toBe(422);
    expect(sub.body.errors).toEqual([
      expect.objectContaining({ field: 'documents.BIRTH', code: 'VALIDATION.REQUIRED' }),
    ]);
  });

  it('takes a counsellor’s mid-term application through cash, approval and the admission fee (ADM-015…024)', async () => {
    // Created and submitted at once: only with the family's consent (client 2026-10-12).
    const unconsented = await post('/api/v1/console/applications', {
      class: { yearId: currentYear.id, classId: grade6.id, joiningDate: today },
      submit: true,
    });
    expect(unconsented.status).toBe(422);
    expect(unconsented.body.errors).toContainEqual(
      expect.objectContaining({ field: 'registrationConsent', code: 'ADM.CONSENT_REQUIRED' }),
    );
    const created = await post('/api/v1/console/applications', {
      class: {
        yearId: currentYear.id,
        classId: grade6.id,
        joiningDate: today,
        midTermReason: 'Family moved to Udupi',
      },
      student: {
        firstName: 'Kiran',
        lastName: 'Bhat',
        gender: 'MALE',
        dob: `${Number(currentYear.label.slice(0, 4)) - 12}-08-01`,
        aadhaar: aadhaar(),
      },
      addresses: {
        residential: {
          line1: 'Temple Road',
          line2: 'Car Street',
          city: 'Udupi',
          state: 'Karnataka',
          pin: '576101',
        },
        sameAsResidential: true,
      },
      parents: {
        father: {
          name: 'Mohan Bhat',
          mobile: '9845001122',
          email: 'mohan@example.in',
          aadhaar: aadhaar(),
          pan: 'ABCPB1122K',
        },
        mother: {
          name: 'Sunita Bhat',
          mobile: '9845001133',
          aadhaar: aadhaar(),
          pan: 'ABCPB3344L',
        },
        primary: 'FATHER',
        children: 'SINGLE',
      },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body.id as string;
    expect(created.body).toMatchObject({ source: 'COUNSELLOR', midTerm: true, status: 'DRAFT' });
    for (const t of [
      'BIRTH',
      'ADDRESS',
      'REPORT',
      ...PERSON_CARDS.father,
      ...PERSON_CARDS.mother,
    ]) {
      expect(
        (await attach(`/api/v1/console/applications/${id}/documents`, null, t, con)).status,
      ).toBe(201);
    }
    // The counsellor's form is the public one (client 2026-10-15): its lists and rules (ADM-035),
    // and an attachment removed from the draft and attached again (ADM-036).
    const form = await request(f.app).get('/api/v1/console/applications/form').set(con);
    expect(form.status, JSON.stringify(form.body)).toBe(200);
    expect(form.body).toMatchObject({
      preselectedYearId: null,
      years: expect.arrayContaining([expect.objectContaining({ id: currentYear.id })]),
      classes: expect.arrayContaining([expect.objectContaining({ id: grade6.id })]),
      rules: { references: { midTermMin: 1 } },
    });
    expect(form.body.transportStops).toEqual(expect.any(Array));
    const docUrl = `/api/v1/console/applications/${id}/documents/BIRTH`;
    const removed = await request(f.app).delete(docUrl).set(con);
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    expect(removed.body.documents.map((d: { type: string }) => d.type)).not.toContain('BIRTH');
    expect((await request(f.app).delete(docUrl).set(con)).status).toBe(404);
    expect(
      (
        await request(f.app)
          .delete(`${docUrl.slice(0, -5)}NOPE`)
          .set(con)
      ).status,
    ).toBe(422);
    expect(
      (await attach(`/api/v1/console/applications/${id}/documents`, null, 'BIRTH', con)).status,
    ).toBe(201);
    const submit = () =>
      post(`/api/v1/console/applications/${id}/submission`, {
        declarationAccepted: true,
        registrationConsent: true,
      });
    expect((await submit()).body.code).toBe('ADM.TC_OR_UNDERTAKING_REQUIRED');
    const due = `${Number(today.slice(0, 4)) + 1}-01-15`;
    expect(
      (
        await request(f.app)
          .put(`/api/v1/console/applications/${id}/transfer-certificate`)
          .set(con)
          .send({ mode: 'UNDERTAKING', dueDate: due })
      ).status,
    ).toBe(200);
    expect((await submit()).body.code).toBe('ADM.REFERENCES_REQUIRED');
    expect(
      (
        await post(`/api/v1/console/applications/${id}/references`, {
          name: 'Sunita Rao',
          relation: 'Class teacher',
          mobile: '9845009988',
        })
      ).status,
    ).toBe(201);
    const declared = await submit();
    expect(declared.body).toMatchObject({ status: 'DRAFT', feeDue: { amount: '500.00' } });
    const cashApp = await post(`/api/v1/console/applications/${id}/admission-fee/cash`, {
      feeType: 'APPLICATION',
      receivedAt: today,
      paidBy: 'Mohan Bhat',
    });
    expect(cashApp.status, JSON.stringify(cashApp.body)).toBe(201);
    expect(cashApp.body.application.status).toBe('SUBMITTED');

    // Approval: the student, the parent and the enrolment, once.
    const detail = await request(f.app).get(`/api/v1/console/applications/${id}`).set(con);
    expect(detail.body.documents[0].url).toMatch(/^\/api\/v1\/files\//);
    const types = (await request(f.app).get('/api/v1/console/user-types').set(con)).body.items as {
      id: string;
      name: string;
    }[];
    const studentType = types.find((t) => t.name === 'Student')!.id;
    const approve = (version: number, admissionNo: string) =>
      request(f.app)
        .post(`/api/v1/console/applications/${id}/approval`)
        .set(con)
        .set('If-Match', `"v${version}"`)
        .set('Idempotency-Key', randomUUID())
        .send({ userTypeId: studentType, sectionId: grade6.sectionId, admissionNo });
    expect((await approve(detail.body.version - 1, 'ADM/2026/0042')).status).toBe(412);
    // The admission number and section wait for Accounts to confirm both fees (client 2026-10-09).
    expect(detail.body).toMatchObject({
      paymentStatus: 'PENDING',
      admissionFeeDue: inr('10000.00'),
    });
    expect((await approve(detail.body.version, 'ADM/2026/0042')).body.code).toBe(
      'ADM.FEES_NOT_CONFIRMED',
    );

    // The admission fee before approval, by payment link; then nothing more to collect.
    const link2 = await post(`/api/v1/console/applications/${id}/admission-fee/online`);
    expect(link2.status, JSON.stringify(link2.body)).toBe(201);
    const payToken = new URL(link2.body.paymentLink).searchParams.get('token')!;
    const summary = await pub('get', `/api/v1/public/admissions/applications/${id}`, payToken);
    expect(Object.keys(summary.body)).not.toContain('parents');
    expect(
      (
        await pub('patch', `/api/v1/public/admissions/applications/${id}`, payToken, {
          section: 'previous',
          data: {},
        })
      ).status,
    ).toBe(404);
    const order = await pub(
      'post',
      `/api/v1/public/admissions/applications/${id}/fee-payments`,
      payToken,
      {},
    );
    expect(order.body).toMatchObject({ feeType: 'ADMISSION', amount: inr('10000.00') });
    const paid = await pub(
      'post',
      `/api/v1/public/admissions/applications/${id}/fee-payments/${order.body.paymentId}/verify`,
      payToken,
      {
        gatewayPaymentId: order.body.gatewayOrder.test.paymentId,
        signature: order.body.gatewayOrder.test.signature,
      },
    );
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    // The gateway's transaction ID on the application, for Accounts (client 2026-10-16); a cash
    // payment has none.
    const admTxn = order.body.gatewayOrder.test.paymentId as string;
    expect(paid.body.transactionId).toBe(admTxn);
    expect(
      (
        await post(`/api/v1/console/applications/${id}/admission-fee/cash`, {
          receivedAt: today,
          paidBy: 'Mohan Bhat',
        })
      ).body.code,
    ).toBe('ADM.FEE_ALREADY_PAID');

    // Accounts confirms each receipt, once; paid is not enough to approve.
    const confirm = (paymentId: string) =>
      post(`/api/v1/console/admission-payments/${paymentId}/confirmation`);
    const afterPaid = await request(f.app).get(`/api/v1/console/applications/${id}`).set(con);
    expect(afterPaid.body).toMatchObject({ paymentStatus: 'PAID', admissionFeeDue: null });
    expect((await approve(afterPaid.body.version, 'ADM/2026/0042')).body.code).toBe(
      'ADM.FEES_NOT_CONFIRMED',
    );
    const c1 = await confirm(cashApp.body.receipt.paymentId);
    expect(c1.status, JSON.stringify(c1.body)).toBe(200);
    expect(c1.body.application.paymentStatus).toBe('PAID');
    expect((await confirm(cashApp.body.receipt.paymentId)).body.code).toBe(
      'ADM.FEE_ALREADY_CONFIRMED',
    );
    expect((await approve(c1.body.application.version, 'ADM/2026/0042')).body.code).toBe(
      'ADM.FEES_NOT_CONFIRMED',
    );
    const c2 = await confirm(order.body.paymentId);
    expect(c2.status, JSON.stringify(c2.body)).toBe(200);
    expect(c2.body.application.paymentStatus).toBe('CONFIRMED');
    expect(
      c2.body.application.fees.map((x: { confirmedAt: string | null }) => !!x.confirmedAt),
    ).toEqual([true, true]);
    const fees = await request(f.app)
      .get(`/api/v1/console/admission-fees?yearId=${currentYear.id}`)
      .set(con);
    expect(
      fees.body.items.filter((x: { applicationId: string }) => x.applicationId === id),
    ).toEqual([
      expect.objectContaining({
        feeType: 'APPLICATION',
        status: 'PAID',
        mode: 'CASH',
        transactionId: null,
      }),
      expect.objectContaining({
        feeType: 'ADMISSION',
        status: 'PAID',
        mode: 'ONLINE',
        transactionId: admTxn,
      }),
    ]);
    expect(
      c2.body.application.fees.find((x: { feeType: string }) => x.feeType === 'ADMISSION')
        .transactionId,
    ).toBe(admTxn);
    const version = c2.body.application.version as number;

    // A school without a Parent user type (a new one has only Staff): refused before anything is
    // written, with what to add — not a validation error on a field the form does not show.
    const parentTypes = await f.t.db
      .selectFrom('user_types')
      .select('id')
      .where('category', '=', 'PARENT')
      .where('status', '=', 'ACTIVE')
      .execute();
    const setParentTypes = (status: 'ACTIVE' | 'INACTIVE') =>
      f.t.db
        .updateTable('user_types')
        .set({ status })
        .where(
          'id',
          'in',
          parentTypes.map((t) => t.id),
        )
        .execute();
    await setParentTypes('INACTIVE');
    const noParentType = await approve(version, 'ADM/2026/0042');
    await setParentTypes('ACTIVE');
    expect(noParentType.status).toBe(409);
    expect(noParentType.body.code).toBe('ADM.PARENT_TYPE_MISSING');
    const ok = await approve(version, 'ADM/2026/0042');
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.application).toMatchObject({
      status: 'APPROVED',
      admissionNo: 'ADM/2026/0042',
      section: { name: 'A' },
    });
    const member = await f.t.db
      .selectFrom('member_profiles')
      .select(['id', 'first_name', 'admission_no'])
      .where('public_id', '=', uuidToBin(ok.body.memberId))
      .executeTakeFirstOrThrow();
    expect(member).toMatchObject({ admission_no: 'ADM/2026/0042' });
    // Fee collection details (client 2026-10-19): the application and admission fees in their own
    // columns, counted in the student's total.
    const fc = await request(f.app)
      .get(`/api/v1/console/fee-collection?yearId=${currentYear.id}&q=Kiran`)
      .set(con);
    expect(fc.status, JSON.stringify(fc.body)).toBe(200);
    const kiranRow = fc.body.students.find((x: { id: string }) => x.id === ok.body.memberId);
    expect(kiranRow).toMatchObject({
      applicationFee: { amount: inr('500.00'), collected: inr('500.00'), status: 'PAID' },
      admissionFee: {
        amount: inr('10000.00'),
        collected: inr('10000.00'),
        status: 'PAID',
        mode: 'ONLINE',
      },
      total: { collected: inr('10500.00') },
    });
    expect(fc.body.cards.admissionFee.collected).toEqual(inr('10000.00'));
    expect(
      await f.t.db
        .selectFrom('wallets')
        .select('kind')
        .where('owner_profile_id', '=', String(member.id))
        .execute(),
    ).toEqual(expect.arrayContaining([{ kind: 'CAMPUS' }]));
    expect(
      await f.t.db
        .selectFrom('enrolments')
        .select('id')
        .where('student_profile_id', '=', String(member.id))
        .execute(),
    ).toHaveLength(1);
    expect((await approve(ok.body.application.version, 'ADM/2026/0043')).body).toMatchObject({
      code: 'ADM.ALREADY_DECIDED',
      params: { status: 'Approved' },
    });

    const receipt = await request(f.app)
      .get(`/api/v1/console/admission-receipts/${order.body.paymentId}`)
      .set(con)
      .buffer(true)
      .parse((res, done) => {
        const parts: Buffer[] = [];
        res.on('data', (c: Buffer) => parts.push(c));
        res.on('end', () => done(null, Buffer.concat(parts)));
      });
    expect(receipt.status).toBe(200);
    expect((receipt.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    // The receipt names the gateway's transaction ID (client 2026-10-16).
    const receiptText = (receipt.body as Buffer).toString('latin1');
    expect(receiptText).toContain('Transaction ID');
    expect(receiptText).toContain(order.body.gatewayOrder.test.paymentId as string);
  });

  it('rejects with a reason, lists by status, and imports existing students (ADM-013/019/020)', async () => {
    const list = await request(f.app).get('/api/v1/console/applications?status=SUBMITTED').set(con);
    expect(list.status).toBe(200);
    const target = list.body.items[0] as { id: string };
    const d = await request(f.app).get(`/api/v1/console/applications/${target.id}`).set(con);
    const rej = await request(f.app)
      .post(`/api/v1/console/applications/${target.id}/rejection`)
      .set(con)
      .set('If-Match', `"v${d.body.version}"`)
      .set('Idempotency-Key', randomUUID())
      .send({ reasonCode: 'SEATS_FULL', remarks: 'Grade 6 is full for next year' });
    expect(rej.status, JSON.stringify(rej.body)).toBe(200);
    expect(rej.body).toMatchObject({ status: 'REJECTED', rejection: { reasonCode: 'SEATS_FULL' } });
    // The family is told, without the school's remarks.
    const told = f.h.sms.sent.findLast((m) => m.purpose === 'admission.rejected');
    expect(told?.text).toContain(`application ${d.body.applicationNo}`);
    expect(told?.text).toContain('was not approved');
    expect(told?.text).not.toContain('Grade 6 is full');
    // The approval in the mid-term journey was told too.
    expect(f.h.sms.sent.findLast((m) => m.purpose === 'admission.approved')?.text).toContain(
      'is approved, admission number',
    );
    expect(
      (
        await post(`/api/v1/console/applications/${target.id}/admission-fee/cash`, {
          receivedAt: today,
          paidBy: 'Someone Else',
        })
      ).body.code,
    ).toBe('ADM.REJECTED_NO_PAYMENT');
    const counts = (await request(f.app).get('/api/v1/console/applications').set(con)).body.counts;
    expect(counts).toMatchObject({ APPROVED: 1, REJECTED: 1 });

    const tpl = await request(f.app).get('/api/v1/console/applications/imports/template').set(con);
    const header = tpl.text.trimStart().split(/\r?\n/)[0]!;
    const csv = [
      header,
      'Neha,Kamath,Female,2014-03-03,Grade 6,A,ADM/OLD/0001,,Suresh Kamath,9845055501,Father',
      'Bad,Row,Unknown,2014-03-03,Grade 9,Z,,,X,123,Uncle',
    ].join('\n');
    const imp = await request(f.app)
      .post('/api/v1/console/applications/imports')
      .set(con)
      .set('Idempotency-Key', randomUUID())
      .attach('file', Buffer.from(csv), { filename: 'old.csv', contentType: 'text/csv' });
    expect(imp.status, JSON.stringify(imp.body)).toBe(201);
    expect(imp.body).toMatchObject({ total: 2, imported: 1, rejected: 1 });
    expect(imp.body.rows[1].errors.map((e: { column: string }) => e.column)).toEqual(
      expect.arrayContaining([
        'Gender',
        'Section',
        'Admission number',
        'Parent mobile',
        'Parent relation',
      ]),
    );
  });

  it('pays the admission fee with the application fee in one order when the family chooses it', async () => {
    const created = await post(
      `/api/v1/public/admissions/${link.token}/applications`,
      {
        class: { yearId: nextYear.id, classId: grade6.id },
        student: {
          firstName: 'Neha',
          lastName: 'Kamath',
          gender: 'FEMALE',
          dob: `${Number(nextYear.label.slice(0, 4)) - 11}-03-21`,
          aadhaar: aadhaar(),
        },
      },
      {},
    );
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const app = created.body.application;
    const token = created.body.resumeToken as string;
    await completeDraft(app.id, token, '9876509876');
    const base = `/api/v1/public/admissions/applications/${app.id}`;
    const sub = await pub('post', `${base}/submission`, token, {
      declarationAccepted: true,
      registrationConsent: true,
    });
    expect(sub.status, JSON.stringify(sub.body)).toBe(200);
    // Ticked on the form (client 2026-10-09): one order for both fees, ₹500 + ₹10,000.
    const order = await pub('post', `${base}/fee-payments`, token, { withAdmission: true });
    expect(order.status, JSON.stringify(order.body)).toBe(201);
    expect(order.body).toMatchObject({
      feeType: 'APPLICATION',
      includes: ['APPLICATION', 'ADMISSION'],
      amount: inr('10500.00'),
      gatewayOrder: { amount: inr('10500.00') },
    });
    const paid = await pub('post', `${base}/fee-payments/${order.body.paymentId}/verify`, token, {
      gatewayPaymentId: order.body.gatewayOrder.test.paymentId,
      signature: order.body.gatewayOrder.test.signature,
    });
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    expect(paid.body).toMatchObject({ status: 'PAID', applicationStatus: 'SUBMITTED' });
    expect(paid.body.receipts.map((r: { feeType: string }) => r.feeType)).toEqual([
      'APPLICATION',
      'ADMISSION',
    ]);
    // Two fees, each with its receipt, each for Accounts to confirm.
    const rows = await f.t.db
      .selectFrom('admission_payments as p')
      .innerJoin('admission_applications as a', 'a.id', 'p.application_id')
      .select(['p.fee_type', 'p.status', 'p.amount_paise', 'p.receipt_no', 'p.gateway_order_id'])
      .where('a.public_id', '=', uuidToBin(app.id))
      .orderBy('p.fee_type')
      .execute();
    expect(rows.map((r) => [r.fee_type, r.status, Number(r.amount_paise)])).toEqual([
      ['APPLICATION', 'PAID', 50_000],
      ['ADMISSION', 'PAID', 1_000_000],
    ]);
    expect(rows[0]!.gateway_order_id).toBe(rows[1]!.gateway_order_id);
    expect(rows[0]!.receipt_no).not.toBe(rows[1]!.receipt_no);
    const detail = await request(f.app).get(`/api/v1/console/applications/${app.id}`).set(con);
    expect(detail.body).toMatchObject({ paymentStatus: 'PAID', admissionFeeDue: null });
  });

  it('keeps each person’s numbers and cards, asks a guardian who is the contact and a hostel student’s local guardian for theirs; the application fee is never left for later by the family, and the desk can still take the fees in cash (client 2026-10-13)', async () => {
    const created = await post(
      `/api/v1/public/admissions/${link.token}/applications`,
      {
        class: { yearId: nextYear.id, classId: grade6.id },
        student: {
          firstName: 'Ira',
          lastName: 'Bhat',
          gender: 'FEMALE',
          dob: `${Number(nextYear.label.slice(0, 4)) - 11}-04-02`,
          aadhaar: aadhaar(),
        },
      },
      {},
    );
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const app = created.body.application;
    const token = created.body.resumeToken as string;
    await completeDraft(app.id, token, '9876504321');
    // Another primary contact: each person's Aadhaar, PAN and cards stay theirs; the new contact's
    // e-mail is asked for (client 2026-10-12, 2026-10-13).
    const parents = (extra: object) =>
      pub('patch', `/api/v1/public/admissions/applications/${app.id}`, token, {
        section: 'parents',
        data: {
          father: { name: 'Suresh Bhat', mobile: '9876504321' },
          mother: { name: 'Latha Bhat', mobile: '8876504321' },
          primary: 'MOTHER',
          children: 'MORE',
          ...extra,
        },
      });
    const noEmail = await parents({});
    expect(noEmail.status).toBe(422);
    expect(noEmail.body.errors).toEqual([
      expect.objectContaining({ field: 'parents.mother.email', code: 'VALIDATION.REQUIRED' }),
    ]);
    const mother = { name: 'Latha Bhat', mobile: '8876504321', email: 'latha@example.in' };
    expect((await parents({ mother })).status).toBe(200);
    const read = () => pub('get', `/api/v1/public/admissions/applications/${app.id}`, token);
    const types = (b: { documents: { type: string }[] }) => b.documents.map((d) => d.type);
    const before = (await read()).body;
    expect(before.primaryContact).toMatchObject({
      relation: 'MOTHER',
      email: 'latha@example.in',
      aadhaar: expect.stringMatching(/^XXXX XXXX \d{4}$/),
      pan: '••••••678K',
    });
    expect(before.identityNumbers.father.pan).toBe('••••••234F');
    expect(types(before)).toEqual(
      expect.arrayContaining([...PERSON_CARDS.father, ...PERSON_CARDS.mother]),
    );
    const submit = (body: object) =>
      pub('post', `/api/v1/public/admissions/applications/${app.id}/submission`, token, {
        declarationAccepted: true,
        registrationConsent: true,
        ...body,
      });
    const missing = async () =>
      ((await submit({})).body.errors as { field: string }[]).map((e) => e.field);
    const cardsOf = (h: keyof typeof PERSON_CARDS) => PERSON_CARDS[h].map((t) => `documents.${t}`);
    const attachAll = async (h: keyof typeof PERSON_CARDS) => {
      for (const t of PERSON_CARDS[h]) {
        const r = await attach(
          `/api/v1/public/admissions/applications/${app.id}/documents`,
          token,
          t,
        );
        expect(r.status, JSON.stringify(r.body)).toBe(201);
      }
    };
    // A guardian who is the primary contact gives theirs too.
    const guardian = {
      name: 'Ravi Rao',
      relation: 'Uncle',
      mobile: '9876509090',
      email: 'ravi@example.in',
    };
    expect((await parents({ mother, guardian, primary: 'GUARDIAN' })).status).toBe(200);
    expect(await missing()).toEqual([
      'parents.guardian.aadhaar',
      'parents.guardian.pan',
      ...cardsOf('guardian'),
    ]);
    await attachAll('guardian');
    // Taken off the form, the guardian's cards go with them.
    expect((await parents({ mother })).status).toBe(200);
    expect(types((await read()).body)).not.toContain('GUARDIAN_AADHAAR_FRONT');
    // A hostel student: the local guardian's Aadhaar, PAN and cards are required too.
    const local = {
      name: 'Ravi Rao',
      relation: 'Uncle',
      mobile: '9876509090',
      address: 'Gandhi Bazaar, Shivamogga',
    };
    expect((await parents({ mother, hostel: true, localGuardian: local })).status).toBe(200);
    expect(await missing()).toEqual([
      'parents.localGuardian.aadhaar',
      'parents.localGuardian.pan',
      ...cardsOf('localGuardian'),
    ]);
    const withIds = { ...local, aadhaar: aadhaar(), pan: 'RAVPR1234K' };
    expect((await parents({ mother, hostel: true, localGuardian: withIds })).status).toBe(200);
    await attachAll('localGuardian');
    const local2 = (await read()).body;
    expect(local2.identityNumbers.localGuardian.pan).toBe('••••••234K');
    expect(local2.parents.localGuardian).not.toHaveProperty('aadhaar');
    // "Pay later" isn't honoured for the family any more (client 2026-10-13): the application
    // waits for its fee.
    const sub = await submit({ payLater: true });
    expect(sub.status, JSON.stringify(sub.body)).toBe(200);
    expect(sub.body).toMatchObject({
      status: 'DRAFT',
      feeDue: { amount: '500.00', mandatory: true },
    });
    const detail = () => request(f.app).get(`/api/v1/console/applications/${app.id}`).set(con);
    expect((await detail()).body).toMatchObject({
      status: 'DRAFT',
      admissionFeeDue: inr('10000.00'),
      fees: [expect.objectContaining({ feeType: 'APPLICATION', status: 'PENDING' })],
    });
    // The application fee still due: the admission fee can't be paid online on its own (client
    // 2026-10-12) — not by the family, nor by a payment link from the desk.
    const alone = await pub(
      'post',
      `/api/v1/public/admissions/applications/${app.id}/fee-payments`,
      token,
      { feeType: 'ADMISSION' },
    );
    expect(alone.status).toBe(409);
    expect(alone.body.code).toBe('ADM.APPLICATION_FEE_FIRST');
    const payLink = await post(`/api/v1/console/applications/${app.id}/admission-fee/online`);
    expect(payLink.body.code).toBe('ADM.APPLICATION_FEE_FIRST');
    // The family paid at the school's desk instead: Accounts records both fees in cash, each with
    // its receipt — the application fee submits the declared form.
    for (const feeType of ['APPLICATION', 'ADMISSION']) {
      const cash = await post(`/api/v1/console/applications/${app.id}/admission-fee/cash`, {
        feeType,
        receivedAt: today,
        paidBy: 'Suresh Bhat',
      });
      expect(cash.status, JSON.stringify(cash.body)).toBe(201);
      expect(cash.body.receipt.receiptNo).toMatch(/\/R\/\d{4}\/\d{6}$/);
    }
    const after = (await detail()).body;
    expect(after).toMatchObject({ status: 'SUBMITTED', paymentStatus: 'PAID' });
    expect(after.fees.map((x: { mode: string }) => x.mode)).toEqual(['CASH', 'CASH']);
  });

  // 2026-10-14: "Mobile Number, Aadhar Number, PAN should never be same for Father, Mother and
  // Guardian. Exclude Local Guardian." — "Add Occupation and Annual Income Field for Father and
  // Mother."
  it('keeps the father’s, the mother’s and the guardian’s mobile, Aadhaar and PAN their own, and takes the parents’ annual income (client 2026-10-14)', async () => {
    const created = await post(
      `/api/v1/public/admissions/${link.token}/applications`,
      {
        class: { yearId: nextYear.id, classId: grade6.id },
        student: {
          firstName: 'Nila',
          lastName: 'Rao',
          gender: 'FEMALE',
          dob: `${Number(nextYear.label.slice(0, 4)) - 11}-05-09`,
          aadhaar: aadhaar(),
        },
      },
      {},
    );
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const app = created.body.application;
    const token = created.body.resumeToken as string;
    await completeDraft(app.id, token, '9876505551');
    const parents = (data: object) =>
      pub('patch', `/api/v1/public/admissions/applications/${app.id}`, token, {
        section: 'parents',
        data: { primary: 'FATHER', children: 'SINGLE', ...data },
      });
    const father = { name: 'Vinay Rao', mobile: '9876505551', email: 'vinay@example.in' };
    const mother = { name: 'Kavya Rao', mobile: '9876505552' };
    const refused = async (data: object) => {
      const r = await parents(data);
      expect(r.status, JSON.stringify(r.body)).toBe(422);
      return r.body.errors as { field: string; code: string; params?: object }[];
    };
    // The mother's mobile is the father's — written with +91 and spaces, it is the same number.
    expect(await refused({ father, mother: { ...mother, mobile: '+91 98765 05551' } })).toEqual([
      expect.objectContaining({
        field: 'parents.mother.mobile',
        code: 'ADM.SAME_MOBILE',
        params: { person: 'father' },
      }),
    ]);
    // A guardian's too.
    const guardian = { name: 'Mohan Rao', relation: 'Uncle', mobile: mother.mobile };
    expect(await refused({ father, mother, guardian })).toEqual([
      expect.objectContaining({
        field: 'parents.guardian.mobile',
        code: 'ADM.SAME_MOBILE',
        params: { person: 'mother' },
      }),
    ]);
    // The same Aadhaar number and PAN sent for both parents.
    const shared = { aadhaar: aadhaar(), pan: 'ABCPR1111A' };
    expect(
      await refused({ father: { ...father, ...shared }, mother: { ...mother, ...shared } }),
    ).toEqual([
      expect.objectContaining({ field: 'parents.mother.aadhaar', code: 'ADM.SAME_AADHAAR' }),
      expect.objectContaining({ field: 'parents.mother.pan', code: 'ADM.SAME_PAN' }),
    ]);
    // Stored for the father, then sent for the mother: the stored number counts.
    const saved = await parents({ father: { ...father, ...shared }, mother });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(await refused({ father, mother: { ...mother, aadhaar: shared.aadhaar } })).toEqual([
      expect.objectContaining({
        field: 'parents.mother.aadhaar',
        code: 'ADM.SAME_AADHAAR',
        params: { person: 'father' },
      }),
    ]);
    // The local guardian may share a parent's mobile, Aadhaar and PAN.
    const lg = await parents({
      father,
      mother,
      hostel: true,
      localGuardian: {
        name: 'Mohan Rao',
        relation: 'Uncle',
        mobile: father.mobile,
        address: 'Vinoba Nagar, Shivamogga',
        ...shared,
      },
    });
    expect(lg.status, JSON.stringify(lg.body)).toBe(200);
    // The annual income: whole rupees, as a number (relative to the section, as schema errors are).
    for (const bad of [-1, 12.5, '600000']) {
      expect(await refused({ father: { ...father, annualIncome: bad }, mother })).toEqual([
        expect.objectContaining({
          field: 'father.annualIncome',
          code: 'ADM.INCOME_INVALID',
        }),
      ]);
    }
    const income = await parents({
      father: { ...father, occupation: 'Engineer', annualIncome: 850000 },
      mother: { ...mother, occupation: 'Teacher', annualIncome: 0 },
    });
    expect(income.status, JSON.stringify(income.body)).toBe(200);
    expect(income.body.parents.father).toMatchObject({
      occupation: 'Engineer',
      annualIncome: 850000,
    });
    expect(income.body.parents.mother).toMatchObject({ occupation: 'Teacher', annualIncome: 0 });
    // A draft saved before the rule, with the parents sharing a mobile, can't be submitted.
    await f.t.db
      .updateTable('admission_applications')
      .set({
        data: sql`JSON_SET(data, '$.parents.mother.mobile', ${father.mobile})`,
      })
      .where('public_id', '=', uuidToBin(app.id))
      .execute();
    const sub = await pub(
      'post',
      `/api/v1/public/admissions/applications/${app.id}/submission`,
      token,
      {
        declarationAccepted: true,
        registrationConsent: true,
      },
    );
    expect(sub.status, JSON.stringify(sub.body)).toBe(422);
    expect(sub.body.errors).toContainEqual(
      expect.objectContaining({ field: 'parents.mother.mobile', code: 'ADM.SAME_MOBILE' }),
    );
  });

  // 2026-10-15: "I have uploaded the logo for Sri Ram Global School, but it is not reflecting any
  // where."
  it('shows the school’s logo from a stable address: the console session, the admission pages, the branding (INS-043)', async () => {
    const session = () => request(f.app).get('/api/v1/console/session').set(con);
    const landing = () => request(f.app).get(`/api/v1/public/admissions/${link.token}`);
    expect((await session()).body.institution.logoUrl).toBeNull();
    expect((await landing()).body.institution.logoUrl).toBeNull();
    const png = pngOf({
      width: 2,
      height: 2,
      type: 2,
      rows: [
        [1, 2, 3, 4, 5, 6],
        [7, 8, 9, 10, 11, 12],
      ],
    });
    const up = await request(f.app)
      .post('/api/v1/files')
      .set(con)
      .set('X-RingPe-Surface', 'console')
      .field('purpose', 'logo')
      .attach('file', png, { filename: 'logo.png', contentType: 'image/png' });
    expect(up.status, JSON.stringify(up.body)).toBe(201);
    const set = await request(f.app)
      .put('/api/v1/console/institution/logo')
      .set(con)
      .set('Idempotency-Key', randomUUID())
      .send({ fileId: up.body.fileId });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    // The same address everywhere; it changes only with the logo.
    const url = (await session()).body.institution.logoUrl as string;
    expect(url).toMatch(/^\/api\/v1\/public\/institutions\/[0-9a-f-]{36}\/logo\?v=[0-9a-f]{12}$/);
    expect((await landing()).body.institution.logoUrl).toBe(url);
    // Public, cached, the picture itself.
    const img = await request(f.app)
      .get(url)
      .buffer(true)
      .parse((res, done) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => done(null, Buffer.concat(chunks)));
      });
    expect(img.status).toBe(200);
    expect(img.headers['content-type']).toBe('image/png');
    expect(img.headers['cache-control']).toBe('public, max-age=86400');
    expect((img.body as Buffer).equals(png)).toBe(true);
    expect((await request(f.app).get(url.replace(/[0-9a-f]{8}-/, '00000000-'))).status).toBe(404);
    expect((await request(f.app).get('/api/v1/public/institutions/not-a-uuid/logo')).status).toBe(
      404,
    );
  });

  // 2026-10-15: "Transfer certificate upload is mandatory for regular admission."
  it('asks a regular admission above LKG for the transfer certificate before it is submitted', async () => {
    const created = await post(
      `/api/v1/public/admissions/${link.token}/applications`,
      {
        class: { yearId: nextYear.id, classId: grade6.id },
        student: {
          firstName: 'Tara',
          lastName: 'Rao',
          gender: 'FEMALE',
          dob: `${Number(nextYear.label.slice(0, 4)) - 11}-04-12`,
          aadhaar: aadhaar(),
        },
      },
      {},
    );
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body.application.id as string;
    const token = created.body.resumeToken as string;
    await completeDraft(id, token, '9876506661', false);
    const submit = () =>
      pub('post', `/api/v1/public/admissions/applications/${id}/submission`, token, {
        declarationAccepted: true,
        registrationConsent: true,
      });
    const refused = await submit();
    expect(refused.status, JSON.stringify(refused.body)).toBe(422);
    expect(refused.body.errors).toContainEqual(
      expect.objectContaining({ field: 'documents.TC', code: 'VALIDATION.REQUIRED' }),
    );
    expect(
      (await attach(`/api/v1/public/admissions/applications/${id}/documents`, token, 'TC')).status,
    ).toBe(201);
    const sub = await submit();
    expect(sub.status, JSON.stringify(sub.body)).toBe(200);
  });
});
