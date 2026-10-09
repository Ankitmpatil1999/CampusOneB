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
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { adminUrl } from './db';
import { codeOf } from './http-app';
import { inr, schoolFixture, type Auth } from './school';
import { newPublicIdPair, uuidToBin } from '../../utils/idGenerator';

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
  const completeDraft = async (id: string, token: string, mobile: string) => {
    const base = `/api/v1/public/admissions/applications/${id}`;
    for (const [section, data] of [
      [
        'addresses',
        {
          residential: {
            line1: 'No. 12, 4th Cross',
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
          father: { name: 'Rakesh Shetty', mobile, email: 'rakesh@example.in' },
          mother: { name: 'Pallavi Shetty' },
          primary: 'FATHER',
        },
      ],
    ] as const) {
      const r = await pub('patch', base, token, { section, data });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    }
    for (const t of ['BIRTH', 'ADDRESS', 'REPORT']) {
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
    const land = await request(f.app).get(`/api/v1/public/admissions/${link.token}`);
    expect(land.status, JSON.stringify(land.body)).toBe(200);
    expect(land.body.years.map((y: { label: string; kind: string }) => [y.label, y.kind])).toEqual([
      [nextYear.label, 'REGULAR'],
      [currentYear.label, 'MID_TERM'],
    ]);
    expect(land.body.classes).toEqual(
      expect.arrayContaining([{ id: grade6.id, name: 'Grade 6', ageBand: { min: 11, max: 15 } }]),
    );
    expect(Object.keys(land.body.institution).sort()).toEqual(['city', 'name', 'shortName']);
  });

  it('takes a public application to submission, payment and status (ADM-004…012)', async () => {
    const created = await post(
      `/api/v1/public/admissions/${link.token}/applications`,
      {
        class: { yearId: nextYear.id, classId: grade6.id },
        student: {
          firstName: 'Diya',
          lastName: 'Shetty',
          gender: 'FEMALE',
          dob: `${Number(nextYear.label.slice(0, 4)) - 11}-02-14`,
          idNumber: '657410',
        },
      },
      {},
    );
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const app = created.body.application;
    const token = created.body.resumeToken as string;
    expect(app).toMatchObject({ status: 'DRAFT', midTerm: false, student: { idNumber: '••7410' } });
    expect(app.applicationNo).toMatch(/^[A-Z0-9]{2,5}\/\d{4}\/000001$/);
    // The same child twice for the same year is refused.
    expect(
      (
        await post(
          `/api/v1/public/admissions/${link.token}/applications`,
          {
            class: { yearId: nextYear.id, classId: grade6.id },
            student: {
              firstName: 'Diya',
              lastName: 'S',
              gender: 'FEMALE',
              dob: app.student.dob,
              idNumber: '657410',
            },
          },
          {},
        )
      ).body.code,
    ).toBe('ADM.DUPLICATE');
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
      { declarationAccepted: true },
    );
    expect(early.status).toBe(422);
    expect(early.body.errors.map((e: { field: string }) => e.field)).toEqual(
      expect.arrayContaining(['addresses.residential', 'parents.primary', 'documents.BIRTH']),
    );
    await completeDraft(app.id, token, '9876501234');
    const sub = await pub(
      'post',
      `/api/v1/public/admissions/applications/${app.id}/submission`,
      token,
      { declarationAccepted: true },
    );
    expect(sub.status, JSON.stringify(sub.body)).toBe(200);
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
      fees: { application: { status: 'PAID' } },
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
        },
      },
      {},
    );
    await completeDraft(young.body.application.id, young.body.resumeToken, '9876501299');
    const refused = await pub(
      'post',
      `/api/v1/public/admissions/applications/${young.body.application.id}/submission`,
      young.body.resumeToken,
      { declarationAccepted: true },
    );
    expect(refused.body).toMatchObject({
      code: 'ADM.AGE_TOO_LOW',
      params: { n: 11, standard: 'Grade 6' },
    });
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

  it('takes a counsellor’s mid-term application through cash, approval and the admission fee (ADM-015…024)', async () => {
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
      },
      addresses: {
        residential: { line1: 'Temple Road', city: 'Udupi', state: 'Karnataka', pin: '576101' },
        sameAsResidential: true,
      },
      parents: { father: { name: 'Mohan Bhat', mobile: '9845001122' }, primary: 'FATHER' },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body.id as string;
    expect(created.body).toMatchObject({ source: 'COUNSELLOR', midTerm: true, status: 'DRAFT' });
    for (const t of ['BIRTH', 'ADDRESS', 'REPORT']) {
      expect(
        (await attach(`/api/v1/console/applications/${id}/documents`, null, t, con)).status,
      ).toBe(201);
    }
    const submit = () =>
      post(`/api/v1/console/applications/${id}/submission`, { declarationAccepted: true });
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
    const noParentType = await approve(detail.body.version, 'ADM/2026/0042');
    await setParentTypes('ACTIVE');
    expect(noParentType.status).toBe(409);
    expect(noParentType.body.code).toBe('ADM.PARENT_TYPE_MISSING');
    const ok = await approve(detail.body.version, 'ADM/2026/0042');
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

    // The admission fee by payment link, then nothing more to collect.
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
    expect(
      (
        await post(`/api/v1/console/applications/${id}/admission-fee/cash`, {
          receivedAt: today,
          paidBy: 'Mohan Bhat',
        })
      ).body.code,
    ).toBe('ADM.FEE_ALREADY_PAID');
    const fees = await request(f.app)
      .get(`/api/v1/console/admission-fees?yearId=${currentYear.id}`)
      .set(con);
    expect(
      fees.body.items.filter((x: { applicationId: string }) => x.applicationId === id),
    ).toEqual([
      expect.objectContaining({ feeType: 'APPLICATION', status: 'PAID', mode: 'CASH' }),
      expect.objectContaining({ feeType: 'ADMISSION', status: 'PAID', mode: 'ONLINE' }),
    ]);
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
});
