/**
 * Tenant isolation (golden rule: the institution comes from the session, another tenant's ids
 * answer 404): school B's administrator calls every console route that takes a record id with the
 * ids of school A's records — members, staff, classes, sections, the academic year, user types,
 * institution fields, uploads, approvals, invoices and plan-change requests. Every call answers 404
 * and school A's records are unchanged. The list of routes comes from the OpenAPI document, so a
 * new console route with an id must be added here.
 */
import { randomInt, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import type { Express } from 'express';
import { parse } from 'yaml';
import { adminUrl, createTestDatabase, type TestDatabase } from './db';
import { buildHttpApp, codeOf } from './http-app';
import { binToUuid, newPublicIdPair, uuidToBin } from '../../utils/idGenerator';
import { hashSecret } from '../../utils/password';

const PASSWORD = 'Ringpe@2026';
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const mobile = () => `9${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`;

const doc = parse(
  readFileSync(join(import.meta.dirname, '..', '..', 'config', 'openapi.yaml'), 'utf8'),
) as { paths: Record<string, Record<string, { operationId: string }>> };

/**
 * Console routes with a record id in the path (the template download is not a record, and GOV-007's
 * job id names a scheduled job, not a tenant's record: an institution runs it for itself).
 */
const ROUTES = Object.entries(doc.paths)
  .filter(([p]) => p.startsWith('/api/v1/console/') && /\{\w+Id\}/.test(p))
  .flatMap(([path, ops]) =>
    Object.entries(ops)
      .filter(([m]) => ['get', 'post', 'put', 'patch', 'delete'].includes(m))
      .map(([method, op]) => ({ method: method as 'get', path, id: op.operationId })),
  )
  // A job id (GOV-007) and a report id (RPT-003/004) name catalogue entries, not a school's records;
  // their rows come only from the session's institution.
  .filter((r) => !['GOV-007', 'RPT-003', 'RPT-004'].includes(r.id ?? ''));

describe.skipIf(!adminUrl)(
  'tenant isolation on real MySQL (every console route with an id)',
  () => {
    let t: TestDatabase;
    let h: Awaited<ReturnType<typeof buildHttpApp>>;
    let app: Express;
    let ops: Record<string, string>;
    let a: { id: string; con: Record<string, string> };
    let b: { id: string; con: Record<string, string> };
    const ids: Record<string, string> = {};
    let evidenceB = '';

    async function account(first: string, mob = mobile()) {
      const email = `${first.toLowerCase()}.${randomInt(0, 1e9)}@example.in`;
      const r = await t.db
        .insertInto('platform_accounts')
        .values({
          public_id: newPublicIdPair().bin,
          mobile: mob,
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
      return { id: String(r.insertId), email, mobile: mob };
    }

    async function signedIn(surface: 'ops' | 'console', email: string) {
      const base = surface === 'ops' ? '/api/v1/ops/auth' : '/api/v1/auth/console';
      const step1 = await request(app).post(`${base}/signin`).send({ email, password: PASSWORD });
      expect(step1.status).toBe(202);
      const r = await request(app)
        .post(`${base}/otp/verify`)
        .send({ challengeId: step1.body.challengeId, otp: codeOf(h.sms.sent.at(-1)) });
      expect(r.status).toBe(200);
      const cookies = ([] as string[])
        .concat(r.headers['set-cookie'] ?? [])
        .map((c) => c.split(';')[0] ?? '');
      return { Cookie: cookies.join('; '), 'X-CSRF-Token': r.body.csrfToken as string };
    }

    async function school() {
      const admin = await account('LAKSHMI');
      const plans = (await request(app).get('/api/v1/ops/plans').set(ops)).body.items;
      const tag = randomInt(0, 1e9);
      const r = await request(app)
        .post('/api/v1/ops/institutions')
        .set(ops)
        .set('Idempotency-Key', randomUUID())
        .send({
          name: `Isolation School ${tag}`,
          address: `Main Road ${tag}, Sagar`,
          city: 'Sagar',
          primaryContact: {
            name: 'Lakshmi Rao',
            email: `office.${tag}@sagar.example.in`,
            mobile: '9845012345',
          },
          adminEmail: admin.email,
          planId: plans[0].id,
        });
      expect(r.status).toBe(201);
      const id = r.body.id as string;
      const version = (await request(app).get(`/api/v1/ops/institutions/${id}`).set(ops)).body
        .version;
      await request(app)
        .put(`/api/v1/ops/institutions/${id}/bank-arrangement`)
        .set(ops)
        .set('If-Match', `"v${version}"`)
        .send({
          corporateCode: `I${String(randomInt(0, 999)).padStart(3, '0')}`,
          poolAccountRef: 'POOLISO0001',
        });
      for (const step of ['toggles', 'year', 'feeacct']) {
        await request(app)
          .post(`/api/v1/ops/institutions/${id}/checklist/${step}`)
          .set(ops)
          .send({});
      }
      const live = await request(app)
        .post(`/api/v1/ops/institutions/${id}/lifecycle-events`)
        .set(ops)
        .set('Idempotency-Key', randomUUID())
        .send({ action: 'ACTIVATE', reason: 'Onboarding complete for the test' });
      expect(live.status).toBe(200);
      return { id, con: await signedIn('console', admin.email) };
    }

    const post = (con: Record<string, string>, url: string, body: object) =>
      request(app).post(url).set(con).set('Idempotency-Key', randomUUID()).send(body);

    beforeAll(async () => {
      t = await createTestDatabase();
      h = await buildHttpApp(t);
      app = h.app;
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
      ops = await signedIn('ops', op.email);
      a = await school();
      b = await school();

      // School A's records.
      const ut = await post(a.con, '/api/v1/console/user-types', {
        name: 'Teacher',
        category: 'TEACHER',
        departments: ['Primary'],
      });
      expect(ut.status).toBe(201);
      const types = (await request(app).get('/api/v1/console/user-types').set(a.con)).body.items;
      const teacher = types.find((x: { name: string }) => x.name === 'Teacher');
      ids['userTypeId'] = teacher.id;
      const m = await post(a.con, '/api/v1/console/members', {
        userTypeId: teacher.id,
        firstName: 'Kavya',
        mobile: mobile(),
      });
      expect(m.status).toBe(201);
      ids['memberId'] = m.body.id;
      const staffAcc = await account('GEETHA');
      const staff = await post(a.con, '/api/v1/console/staff', {
        userTypeId: teacher.id,
        departmentId: teacher.departments[0].id,
        firstName: 'Geetha',
        gender: 'FEMALE',
        dateOfBirth: '1988-01-05',
        mobile: staffAcc.mobile,
        email: staffAcc.email,
        joinedOn: '2026-06-01',
      });
      expect(staff.status).toBe(201);
      ids['profileId'] = staff.body.id;
      const cls = await post(a.con, '/api/v1/console/classes', {
        name: 'Grade 6',
        sections: [{ name: 'A' }],
      });
      expect(cls.status).toBe(201);
      ids['classId'] = cls.body.id;
      ids['sectionId'] = cls.body.sections[0].id;
      ids['yearId'] = (
        await request(app).get('/api/v1/console/academic-years').set(a.con)
      ).body.items[0].id;
      const field = await post(a.con, '/api/v1/console/custom-fields', {
        entity: 'MEMBER',
        label: 'House',
        type: 'TEXT',
        required: false,
        unique: false,
        listColumn: true,
        filter: false,
        active: true,
        noIdDocAck: true,
      });
      expect(field.status).toBe(201);
      ids['fieldId'] = field.body.id;
      const tpl = await request(app)
        .get('/api/v1/console/members/uploads/templates/members')
        .set(a.con)
        .buffer(true)
        .parse((res, done) => {
          let text = '';
          res.on('data', (c: Buffer) => (text += c.toString('utf8')));
          res.on('end', () => done(null, text));
        });
      const header = String(tpl.body).replace(String.fromCharCode(0xfeff), '').split('\r\n')[0]!;
      const row = header
        .split(',')
        .map((c) => (c === 'First name' ? 'Isha' : ''))
        .join(',');
      const up = await request(app)
        .post('/api/v1/console/members/uploads')
        .set(a.con)
        .set('Idempotency-Key', randomUUID())
        .field('kind', 'MEMBERS')
        .attach('file', Buffer.from(`${header}\r\n${row}\r\n`), {
          filename: 'members.csv',
          contentType: 'text/csv',
        });
      expect(up.status).toBe(201);
      ids['uploadId'] = up.body.id;
      const sub = (await request(app).get('/api/v1/console/subscription').set(a.con)).body;
      ids['invoiceId'] = sub.invoices[0].id;
      const plans = (await request(app).get('/api/v1/ops/plans').set(ops)).body.items;
      const other = plans.find((p: { id: string }) => p.id !== sub.plan?.id) ?? plans[0];
      const req = await post(a.con, '/api/v1/console/subscription/plan-change-requests', {
        planId: other.id,
        timing: 'RENEWAL',
        note: 'For the isolation test',
      });
      expect(req.status).toBe(201);
      ids['requestId'] = req.body.id;
      // A merchant of school A with its payment QR (PAY-016…024, 029, 031).
      await post(a.con, '/api/v1/console/user-types', {
        name: 'Merchant',
        category: 'MERCHANT',
        departments: ['Canteen'],
      });
      const mer = await post(a.con, '/api/v1/console/merchants', {
        displayName: 'Isolation Canteen',
        operatorFirstName: 'Ravi',
        subType: 'REGULAR',
        mobile: '9886934756',
      });
      expect(mer.status).toBe(201);
      ids['merchantId'] = mer.body.merchantId;
      const qr = await post(a.con, `/api/v1/console/merchants/${ids['merchantId']}/qr-codes`, {
        kind: 'PAYMENT',
      });
      expect(qr.status).toBe(201);
      ids['qrId'] = qr.body.id;
      // An asset group and an asset of school A (INS-020…026).
      const group = await post(a.con, '/api/v1/console/asset-groups', { name: 'Isolation Kit' });
      expect(group.status).toBe(201);
      ids['groupId'] = group.body.groupId;
      const asset = await post(a.con, '/api/v1/console/assets', {
        groupId: ids['groupId'],
        name: 'Isolation Item',
        type: 'PHYSICAL',
      });
      expect(asset.status).toBe(201);
      ids['assetId'] = asset.body.assetId;
      // A reader and a campus card of school A (INS-030…034, ATT-005…007).
      const reader = await post(a.con, '/api/v1/console/readers', {
        name: 'Isolation kiosk',
        purpose: 'BALANCE_CHECK',
      });
      expect(reader.status).toBe(201);
      ids['readerId'] = reader.body.readerId;
      // A payment gateway of school A (INS-038…041; client 2026-10-09).
      const gateway = await post(a.con, '/api/v1/console/payment-gateways', {
        label: 'Isolation fees',
        keyId: 'rzp_test_ISOLATION1',
        keySecret: 'isolation-secret',
      });
      expect(gateway.status).toBe(201);
      ids['gatewayId'] = gateway.body.id;
      const aMember = await t.db
        .selectFrom('member_profiles')
        .select(['id', 'institution_id'])
        .where('public_id', '=', uuidToBin(ids['memberId']!))
        .executeTakeFirstOrThrow();
      const card = newPublicIdPair();
      await t.db
        .insertInto('cards')
        .values({
          public_id: card.bin,
          institution_id: String(aMember.institution_id),
          profile_id: String(aMember.id),
          token: `NFC${String(randomInt(0, 1e9)).padStart(13, '0')}`,
          status: 'ACTIVE',
          issue_reason: 'NEW_REGISTRATION',
        })
        .execute();
      ids['cardId'] = card.id;
      // An allowance grant of school A (ALW-004).
      const allowanceWallet = await t.db
        .selectFrom('wallets')
        .select('id')
        .where('owner_profile_id', '=', String(aMember.id))
        .where('kind', '=', 'ALLOWANCE')
        .executeTakeFirstOrThrow();
      const grant = newPublicIdPair();
      await t.db
        .insertInto('allowance_grants')
        .values({
          public_id: grant.bin,
          institution_id: String(aMember.institution_id),
          profile_id: String(aMember.id),
          wallet_id: String(allowanceWallet.id),
          amount_paise: 10_000,
          start_date: '2099-01-01',
          expiry_date: '2099-01-31',
        })
        .execute();
      ids['grantId'] = grant.id;
      // A coupon type of school A (CPN-005): the four meal types appear on the first read.
      const couponTypes = await request(app).get('/api/v1/console/coupon-types').set(a.con);
      expect(couponTypes.status).toBe(200);
      ids['typeId'] = couponTypes.body.items[0].id;
      // An event and an entry pass of school A (FEE-030/031, PAY-028).
      const merchantRow = await t.db
        .selectFrom('member_profiles')
        .select('id')
        .where('public_id', '=', uuidToBin(ids['merchantId']!))
        .executeTakeFirstOrThrow();
      const isoEvent = newPublicIdPair();
      await t.db
        .insertInto('events')
        .values({
          public_id: isoEvent.bin,
          institution_id: String(aMember.institution_id),
          title: 'Isolation Fair',
          start_date: '2099-01-01',
          end_date: '2099-01-02',
          total_paise: 10_000,
          merchant_profile_id: String(merchantRow.id),
          audience_class_ids: null,
        })
        .execute();
      ids['eventId'] = isoEvent.id;
      const anyAccount = await t.db
        .selectFrom('platform_accounts')
        .select('id')
        .executeTakeFirstOrThrow();
      const dev = await t.db
        .insertInto('devices')
        .values({
          public_id: newPublicIdPair().bin,
          account_id: String(anyAccount.id),
          install_id_hash: Buffer.alloc(32, 7),
        })
        .executeTakeFirstOrThrow();
      const pass = newPublicIdPair();
      await t.db
        .insertInto('entry_passes')
        .values({
          public_id: pass.bin,
          institution_id: String(aMember.institution_id),
          pass_type: 'FEST-ENTRY',
          purpose: 'Isolation',
          description: 'Isolation pass',
          holder_profile_id: String(aMember.id),
          device_id: String(dev.insertId),
          valid_on: '2099-01-01',
        })
        .execute();
      ids['passId'] = pass.id;
      // A fee structure and a fee record of school A (FEE-005…007, FEE-011/013/016).
      const yearA = await t.db
        .selectFrom('academic_years')
        .select('id')
        .where('public_id', '=', uuidToBin(ids['yearId']!))
        .executeTakeFirstOrThrow();
      const structure = newPublicIdPair();
      await t.db
        .insertInto('fee_structures')
        .values({
          public_id: structure.bin,
          institution_id: String(aMember.institution_id),
          year_id: String(yearA.id),
          name: 'Isolation fees',
        })
        .execute();
      ids['structureId'] = structure.id;
      const record = newPublicIdPair();
      await t.db
        .insertInto('fee_records')
        .values({
          public_id: record.bin,
          institution_id: String(aMember.institution_id),
          year_id: String(yearA.id),
          student_profile_id: String(aMember.id),
          source: 'MANUAL',
          instalment_seq: 1,
          label: 'Term 1',
          due_date: '2099-01-01',
          amount_paise: 10_000,
          created_at: new Date(),
          updated_at: new Date(),
        })
        .execute();
      ids['recordId'] = record.id;
      // An admission link, application, reference and paid fee of school A (INS-029, ADM-014…028).
      const adLink = newPublicIdPair();
      await t.db
        .insertInto('admission_links')
        .values({
          public_id: adLink.bin,
          institution_id: String(aMember.institution_id),
          token: 'A'.repeat(43),
          created_at: new Date(),
        })
        .execute();
      ids['linkId'] = adLink.id;
      const adApp = newPublicIdPair();
      const adIns = await t.db
        .insertInto('admission_applications')
        .values({
          public_id: adApp.bin,
          institution_id: String(aMember.institution_id),
          application_no: 'ISO/2026/000001',
          source: 'COUNSELLOR',
          status: 'SUBMITTED',
          year_id: String(yearA.id),
          data: '{}',
          created_at: new Date(),
          updated_at: new Date(),
        })
        .executeTakeFirstOrThrow();
      ids['applicationId'] = adApp.id;
      const adRef = newPublicIdPair();
      await t.db
        .insertInto('admission_references')
        .values({
          public_id: adRef.bin,
          application_id: String(adIns.insertId),
          name: 'Isolation Referee',
          mobile: '9845000001',
          created_at: new Date(),
        })
        .execute();
      ids['referenceId'] = adRef.id;
      const adPay = newPublicIdPair();
      await t.db
        .insertInto('admission_payments')
        .values({
          public_id: adPay.bin,
          institution_id: String(aMember.institution_id),
          application_id: String(adIns.insertId),
          fee_type: 'APPLICATION',
          amount_paise: 50_000,
          status: 'PAID',
          mode: 'CASH',
          receipt_no: 'ISO/R/2026/000001',
          paid_at: new Date(),
          created_at: new Date(),
          updated_at: new Date(),
        })
        .execute();
      ids['receiptId'] = adPay.id;
      // A settlement of school A (STL-011, STL-014).
      const stl = newPublicIdPair();
      await t.db
        .insertInto('settlements')
        .values({
          public_id: stl.bin,
          institution_id: String(aMember.institution_id),
          settlement_no: 'STL-ISO-1',
          settlement_date: '2099-01-01',
          window_to: new Date('2099-01-01T18:00:00Z'),
          files: JSON.stringify([
            { fileNo: 1, kind: 'transactions', name: 'x.csv', fileId: stl.id },
          ]),
          created_at: new Date(),
          updated_at: new Date(),
        })
        .execute();
      ids['settlementId'] = stl.id;
      // A ticket of school A (GRV-007, GRV-008, call logs).
      const tkt = newPublicIdPair();
      await t.db
        .insertInto('tickets')
        .values({
          public_id: tkt.bin,
          institution_id: String(aMember.institution_id),
          ticket_no: 'TKT-ISO001',
          kind: 'FEEDBACK',
          profile_id: String(aMember.id),
          category: 'FEEDBACK',
          issue: 'Isolation feedback text',
          channel: 'APP',
          created_at: new Date(),
          updated_at: new Date(),
        })
        .execute();
      ids['ticketId'] = tkt.id;
      // An accounting voucher of school A (FEE-035).
      const vch = newPublicIdPair();
      await t.db
        .insertInto('accounting_vouchers')
        .values({
          public_id: vch.bin,
          institution_id: String(aMember.institution_id),
          ledger_txn_id: '999999999',
          reference: 'RPER-ISO-VOUCHER',
          event: 'REFUND',
          voucher_date: '2099-01-01',
          amount_paise: 100,
          company_name: 'Isolation Trust',
          debit_ledger: 'Sales',
          credit_ledger: 'Wallets',
          status: 'FAILED',
          created_at: new Date(),
          updated_at: new Date(),
        })
        .execute();
      ids['voucherId'] = vch.id;
      // The academic structure of school A (ACA-017, ACA-023…033).
      const subj = await post(a.con, '/api/v1/console/subjects', {
        code: 'ISO',
        name: 'Isolation',
      });
      expect(subj.status, JSON.stringify(subj.body)).toBe(201);
      ids['subjectId'] = subj.body.id;
      const ctA = await post(a.con, '/api/v1/console/teacher-assignments', {
        kind: 'CLASS_TEACHER',
        teacherId: ids['memberId'],
        sectionIds: [ids['sectionId']],
      });
      expect(ctA.status, JSON.stringify(ctA.body)).toBe(201);
      ids['assignmentId'] = ctA.body.classTeachers[0].assignment.id;
      ids['classSectionId'] = ids['sectionId']!;
      const sectionA = await t.db
        .selectFrom('sections')
        .select(['id', 'class_id'])
        .where('public_id', '=', uuidToBin(ids['sectionId']!))
        .executeTakeFirstOrThrow();
      const enr = await t.db
        .insertInto('enrolments')
        .values({
          institution_id: String(aMember.institution_id),
          student_profile_id: String(aMember.id),
          year_id: String(yearA.id),
          section_id: String(sectionA.id),
        })
        .executeTakeFirstOrThrow();
      ids['enrolmentId'] = binToUuid(
        (
          await t.db
            .selectFrom('enrolments')
            .select('public_id')
            .where('id', '=', String(enr.insertId))
            .executeTakeFirstOrThrow()
        ).public_id,
      );
      const ro = newPublicIdPair();
      const roIns = await t.db
        .insertInto('rollovers')
        .values({
          public_id: ro.bin,
          institution_id: String(aMember.institution_id),
          from_year_id: String(yearA.id),
          to_year_id: String(yearA.id),
          created_at: new Date(),
        })
        .executeTakeFirstOrThrow();
      await t.db
        .insertInto('rollover_items')
        .values({
          rollover_id: String(roIns.insertId),
          student_profile_id: String(aMember.id),
          from_section_id: String(sectionA.id),
          outcome: 'LEFT',
        })
        .execute();
      ids['proposalId'] = ro.id;
      // An exam of school A (ACA-036, ACA-040).
      const subjectA = await t.db
        .selectFrom('subjects')
        .select('id')
        .where('public_id', '=', uuidToBin(ids['subjectId']!))
        .executeTakeFirstOrThrow();
      const exName = newPublicIdPair();
      const exNameIns = await t.db
        .insertInto('exam_names')
        .values({
          public_id: exName.bin,
          institution_id: String(aMember.institution_id),
          name: 'Isolation Test',
          created_at: new Date(),
        })
        .executeTakeFirstOrThrow();
      const exam = newPublicIdPair();
      await t.db
        .insertInto('exams')
        .values({
          public_id: exam.bin,
          institution_id: String(aMember.institution_id),
          year_id: String(yearA.id),
          exam_name_id: String(exNameIns.insertId),
          class_id: String(sectionA.class_id),
          section_id: String(sectionA.id),
          subject_id: String(subjectA.id),
          max_marks: 50,
          pass_marks: 18,
          created_at: new Date(),
          updated_at: new Date(),
        })
        .execute();
      ids['examId'] = exam.id;
      // A staff leave request of school A (ACA-043, ACA-076).
      const leave = newPublicIdPair();
      await t.db
        .insertInto('staff_leaves')
        .values({
          public_id: leave.bin,
          institution_id: String(aMember.institution_id),
          year_id: String(yearA.id),
          profile_id: String(aMember.id),
          leave_type: 'CASUAL',
          from_date: '2099-01-05',
          to_date: '2099-01-05',
          days: 1,
          reason: 'Isolation test',
          created_at: new Date(),
        })
        .execute();
      ids['leaveId'] = leave.id;
      // A visitor of school A (ATT-017).
      const visitor = newPublicIdPair();
      await t.db
        .insertInto('visitors')
        .values({
          public_id: visitor.bin,
          institution_id: String(aMember.institution_id),
          name: 'Isolation Visitor',
          mobile_enc: Buffer.from('x'),
          mobile_last4: '0000',
          purpose: 'Isolation test',
          checked_in_at: new Date(),
        })
        .execute();
      ids['visitorId'] = visitor.id;
      // Transport records of school A (TRN-003…025).
      const instA = String(aMember.institution_id);
      const now = new Date();
      const mk = async (table: string, values: Record<string, unknown>) => {
        const pub = newPublicIdPair();
        const r = await t.db
          .insertInto(table as never)
          .values({ public_id: pub.bin, institution_id: instA, ...values } as never)
          .executeTakeFirstOrThrow();
        return { pub: pub.id, row: String(r.insertId) };
      };
      const stopA = await mk('transport_stops', {
        name: 'Iso Stop',
        created_at: now,
        updated_at: now,
      });
      const routeA = await mk('transport_routes', {
        code: 'ISO',
        name: 'Iso Route',
        created_at: now,
        updated_at: now,
      });
      const vehicleA = await mk('transport_vehicles', {
        name: 'Iso Bus',
        registration: 'ISO-1',
        capacity: 10,
        created_at: now,
        updated_at: now,
      });
      const crewA = await mk('transport_crew', {
        profile_id: String(aMember.id),
        role: 'ATTENDANT',
        employee_ref: 'ISO-1',
        created_at: now,
        updated_at: now,
      });
      const sessionA = await mk('transport_sessions', {
        name: 'Iso Session',
        direction: 'DROP',
        start_time: '15:00:00',
        days: 'MON',
        created_at: now,
        updated_at: now,
      });
      const allocationA = await mk('transport_allocations', {
        year_id: String(yearA.id),
        profile_id: String(aMember.id),
        route_id: routeA.row,
        stop_id: stopA.row,
        effective_from: '2099-01-01',
        effective_to: '2099-01-02',
        created_at: now,
      });
      const tripA = await mk('transport_trips', {
        assignment_id: '1',
        route_id: routeA.row,
        session_id: sessionA.row,
        vehicle_id: vehicleA.row,
        driver_crew_id: crewA.row,
        trip_date: '2099-01-01',
        direction: 'DROP',
        planned_start: '15:00:00',
        created_at: now,
      });
      ids['stopId'] = stopA.pub;
      ids['routeId'] = routeA.pub;
      ids['vehicleId'] = vehicleA.pub;
      ids['crewId'] = crewA.pub;
      ids['sessionId'] = sessionA.pub;
      ids['allocationId'] = allocationA.pub;
      ids['tripId'] = tripA.pub;
      // An announcement of school A (COM-003…006).
      const annA = await mk('announcements', {
        seq: 1,
        source: 'CONSOLE',
        title: 'Isolation notice',
        body: 'Only for school A members.',
        category_code: 'GEN',
        channels: 'IN_APP',
        targets: JSON.stringify({ groups: ['ALL'] }),
        send_at: now,
        created_at: now,
        updated_at: now,
      });
      ids['announcementId'] = annA.pub;
      // A conversation between two members of school A (COM-019…021).
      const [lowA, highA] = [String(aMember.id), String(merchantRow.id)].sort(
        (x, y) => Number(x) - Number(y),
      );
      const convA = await mk('conversations', {
        profile_low: lowA,
        profile_high: highA,
        started_by: lowA,
        created_at: now,
      });
      ids['conversationId'] = convA.pub;
      ids['studentId'] = ids['memberId']!;
      // A pending approval: the administrator's suspension waits when self-apply is off.
      const s = (await request(app).get('/api/v1/ops/settings').set(ops)).body.items.find(
        (x: { key: string }) => x.key === 'mkr.adminSelfApply',
      );
      const off = await request(app)
        .put('/api/v1/ops/settings/mkr.adminSelfApply')
        .set(ops)
        .set('If-Match', `"v${s.version}"`)
        .send({ value: 0, reason: 'Isolation test' });
      const queued = await post(
        a.con,
        `/api/v1/console/members/${ids['memberId']}/status-changes`,
        {
          to: 'SUSPENDED',
          reason: 'Pending an enquiry',
        },
      );
      expect(queued.status).toBe(202);
      ids['approvalId'] = queued.body.approvalId;
      await request(app)
        .put('/api/v1/ops/settings/mkr.adminSelfApply')
        .set(ops)
        .set('If-Match', `"v${off.body.version}"`)
        .send({ value: 1, reason: 'Back to the default' });
      // School B's own evidence file, so the correction body is valid.
      const ev = await request(app)
        .post('/api/v1/files')
        .set(b.con)
        .set('X-RingPe-Surface', 'console')
        .field('purpose', 'evidence')
        .attach('file', PDF, 'certificate.pdf');
      expect(ev.status).toBe(201);
      evidenceB = ev.body.fileId;
    }, 240_000);
    afterAll(async () => {
      await t?.drop();
    });

    /** A valid body per operation, so a refusal can only come from the record lookup. */
    const bodyOf = (opId: string): object => {
      const today = new Date().toISOString().slice(0, 10);
      return (
        (
          {
            'MKR-003': { decision: 'APPROVE', remarks: 'Not my school' },
            'IDN-054': { to: 'INACTIVE', reason: 'Testing isolation' },
            'IDN-055': { reason: 'Testing isolation' },
            'IDN-086': { reason: 'Testing isolation' },
            'IDN-057': {
              field: 'FULL_NAME',
              proposedValue: 'Some Name',
              reason: 'Testing isolation here',
              evidenceFileId: evidenceB,
            },
            'IDN-046': { email: 'someone@example.in' },
            'ACA-003': { action: 'CLOSE', reason: 'Testing isolation' },
            'ACA-011': { name: 'Grade 9', order: 1, sections: [{ name: 'A' }] },
            'ACA-012': { name: 'Z' },
            'ACA-013': { name: 'Z' },
            'INS-016': { addDepartments: ['Secondary'] },
            'INS-019': { label: 'Colour', noIdDocAck: true },
            'IDN-051': { mode: 'ACCEPTED' },
            'SAS-039': { utr: 'UTR1234567890', paidOn: today },
            'IDN-061': { roleIds: [] },
            'IDN-038': { reason: 'Testing isolation' },
            'IDN-056': { enabled: false, reason: 'Testing isolation' },
            'PAY-018': { displayName: 'Another Name' },
            'PAY-019': { to: 'INACTIVE', reason: 'Testing isolation' },
            'PAY-020': { dynamicQr: true, nfc: false },
            'PAY-022': { kind: 'COUPON' },
            'PAY-023': { status: 'INACTIVE', reason: 'Testing isolation' },
            'INS-032': { name: 'Another name' },
            'INS-034': { enabled: false, reason: 'Testing isolation' },
            'ATT-006': { action: 'BLOCK', reason: 'Testing isolation' },
            'ATT-007': { reasonCode: 'LOST' },
            'INS-022': { name: 'Another group' },
            'INS-025': { name: 'Another item' },
            'INS-026': { groupIds: [] },
            'ALW-004': { status: 'INACTIVE' },
            'CPN-005': { active: false },
            'FEE-030': { title: 'Taken over' },
            'PAY-028': { reason: 'Testing isolation' },
            'FEE-005': {
              yearId: ids['yearId'],
              name: 'Taken over',
              classIds: [ids['classId']],
              heads: [{ headId: randomUUID(), amount: { amount: '100.00', currency: 'INR' } }],
              instalments: [{ label: 'Term 1', dueDate: today, share: '100' }],
              lateFine: { amount: '0.00', currency: 'INR' },
            },
            'FEE-007': { preview: true },
            'FEE-009': {
              applicationFee: { amount: '0.00', currency: 'INR' },
              applicationMandatory: false,
              admissionFee: { amount: '0.00', currency: 'INR' },
            },
            'FEE-013': { amount: { amount: '1.00', currency: 'INR' }, reason: 'Testing isolation' },
            'INS-029': { emails: ['someone@example.in'] },
            'ADM-016': { section: 'previous', data: {} },
            'ADM-017': { mode: 'UNDERTAKING', dueDate: '2099-01-01' },
            'ADM-018': {
              userTypeId: ids['userTypeId'],
              sectionId: ids['sectionId'],
              admissionNo: 'ISO-1',
            },
            'ADM-019': { reasonCode: 'OTHER', remarks: 'Testing isolation' },
            'ADM-022': { receivedAt: today, paidBy: 'Some One' },
            'ADM-026': { name: 'Ref Person', mobile: '9845000002' },
            'ADM-030': { declarationAccepted: true },
            'ACA-036': { date: today },
            'ACA-043': { decision: 'APPROVED' },
            'TRN-004': { stops: [] },
            'TRN-022': { endDate: '2099-01-01', reason: 'Testing isolation' },
            'TRN-025': { remarks: 'Testing isolation' },
            'COM-004': { withdrawn: true, reason: 'Testing isolation' },
            'COM-006': { channels: [] },
            'COM-020': { text: 'Testing isolation' },
            'COM-021': { archived: true },
          } as Record<string, object>
        )[opId] ?? {}
      );
    };

    it('knows a record of school A for every console route with an id', () => {
      const params = new Set(
        ROUTES.flatMap((r) => [...r.path.matchAll(/\{(\w+Id)\}/g)].map((m) => m[1]!)),
      );
      expect([...params].filter((p) => !ids[p]).sort()).toEqual([]);
      expect(ROUTES.length).toBeGreaterThan(20);
    });

    it("answers 404 to school B for every one of school A's records", async () => {
      const leaks: string[] = [];
      for (const r of ROUTES) {
        const url = r.path
          .replace('/api/v1', '')
          .replace(/\{(\w+)\}/g, (_m, n: string) => ids[n] ?? randomUUID());
        const res = await request(app)
          [r.method](`/api/v1${url}`)
          .set(b.con)
          .set('Idempotency-Key', randomUUID())
          .set('If-Match', '"v1"')
          .send(bodyOf(r.id));
        if (res.status !== 404)
          leaks.push(
            `${r.id} ${r.method.toUpperCase()} ${r.path} → ${res.status} ${res.body?.code ?? ''}${res.body?.errors ? ` ${JSON.stringify(res.body.errors)}` : ''}`,
          );
      }
      expect(leaks).toEqual([]);
    }, 120_000);

    it("leaves school A's records as they were and keeps them out of school B's lists", async () => {
      const m = await request(app).get(`/api/v1/console/members/${ids['memberId']}`).set(a.con);
      expect(m.body).toMatchObject({ status: 'ACTIVE', contact: { email: null } });
      const approval = await request(app)
        .get(`/api/v1/console/approvals/${ids['approvalId']}`)
        .set(a.con);
      expect(approval.body.status).toBe('PENDING');
      const members = await request(app).get('/api/v1/console/members?kind=ALL').set(b.con);
      expect(members.body.items.map((x: { id: string }) => x.id)).not.toContain(ids['memberId']);
      const search = await request(app).get('/api/v1/console/search?q=Kavya').set(b.con);
      expect(search.body.members).toEqual([]);
      const audit = await request(app)
        .get(`/api/v1/console/audit-events?entityId=${ids['memberId']}`)
        .set(b.con);
      expect(audit.body.items).toEqual([]);
      const file = await request(app)
        .get(`/api/v1/files/${evidenceB}/url`)
        .set(a.con)
        .set('X-RingPe-Surface', 'console');
      expect(file.status).toBe(404);
      const row = await t.db
        .selectFrom('member_profiles')
        .select('status')
        .where('public_id', '=', uuidToBin(ids['memberId']!))
        .executeTakeFirstOrThrow();
      expect(row.status).toBe('ACTIVE');
    });
  },
);
