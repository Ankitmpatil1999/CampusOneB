/**
 * Personal details on a real MySQL (IDN-015…017, IDN-020…023; SRS 6.11, 6.38.5 CR-06): address
 * with proof, bank account with the ₹1 check (test provider), nominee, income, version guards, and
 * correction requests that wait for a checker while the stored value stands.
 */
import { randomInt, randomUUID } from 'node:crypto';
import request from 'supertest';
import type { Express } from 'express';
import { adminUrl, createTestDatabase, type TestDatabase } from './db';
import { buildHttpApp, codeOf } from './http-app';

/** PANs are unique per platform: a counter keeps sign-ups in one file from colliding. */
let panSeq = randomInt(0, 5_000);
const uniquePan = () => `ABCDE${String(++panSeq % 10_000).padStart(4, '0')}F`;
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const PASSWORD = 'Ringpe@2026';

describe.skipIf(!adminUrl)('personal details on real MySQL', () => {
  let t: TestDatabase;
  let h: Awaited<ReturnType<typeof buildHttpApp>>;
  let app: Express;

  beforeAll(async () => {
    t = await createTestDatabase();
    h = await buildHttpApp(t);
    app = h.app;
  }, 120_000);
  afterAll(async () => {
    await t?.drop();
  });

  /** A signed-up member's bearer header. */
  async function member() {
    const mobile = `9${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`;
    const start = await request(app)
      .post('/api/v1/auth/member/signup/otp')
      .send({ mobile, consentVersion: '2026.10' });
    const verify = await request(app)
      .post('/api/v1/auth/member/signup/otp/verify')
      .send({ challengeId: start.body.challengeId, otp: codeOf(h.sms.sent.at(-1)) });
    const created = await request(app)
      .post('/api/v1/auth/member/signup')
      .set('Idempotency-Key', randomUUID())
      .send({
        signupToken: verify.body.signupToken,
        mobile,
        consentVersion: '2026.10',
        termsVersion: '2026.10',
        termsAccepted: true,
        pan: uniquePan(),
        firstName: 'Asha',
        lastName: 'Rao',
        gender: 'FEMALE',
        dob: '1990-04-12',
        idDocType: 'AADHAAR',
        idDocNumber: String(randomInt(0, 1_000_000)).padStart(6, '0'),
        email: `asha.${randomInt(0, 1e9)}@example.in`,
        password: PASSWORD,
        securityQuestion: 'FIRST_SCHOOL',
        securityAnswer: 'vidyaniketan',
        device: { installId: randomUUID() },
      });
    expect(created.status).toBe(201);
    return { Authorization: `Bearer ${created.body.accessToken}` };
  }

  const upload = async (auth: Record<string, string>, purpose: string) => {
    const r = await request(app)
      .post('/api/v1/files')
      .set(auth)
      .field('purpose', purpose)
      .attach('file', PDF, 'proof.pdf');
    expect(r.status).toBe(201);
    return r.body.fileId as string;
  };

  it('serves the details with masked identity and the lists to choose from (IDN-015)', async () => {
    const auth = await member();
    const r = await request(app).get('/api/v1/me/personal-details').set(auth);
    expect(r.status).toBe(200);
    expect(r.body.identity).toMatchObject({
      fullName: 'ASHA RAO',
      gender: 'FEMALE',
      dob: '1990-04-12',
    });
    expect(r.body.identity.pan).toMatch(/^••••••\d{3}F$/);
    expect(r.body.identity.idDocument.number).toMatch(/^XXXX XXXX \d{4}$/);
    expect(r.body.address).toBeNull();
    expect(r.body.options.relations.map((x: { code: string }) => x.code)).toEqual([
      'SPOUSE',
      'SON',
      'DAUGHTER',
      'MOTHER',
      'FATHER',
      'SIBLING',
      'OTHER',
    ]);
    expect(r.body.options.incomeBands).toHaveLength(5);
    expect(r.body.options.occupations.length).toBeGreaterThan(5);
  });

  it('saves the address with its proof, version-guarded (IDN-020)', async () => {
    const auth = await member();
    // The prototype's fields: house and street, city, PIN code and the proof file.
    const body = { line1: '12 MG Road', city: 'Bengaluru', pinCode: '560001' };
    const noVersion = await request(app).put('/api/v1/me/address').set(auth).send(body);
    expect(noVersion.status).toBe(428);
    const noProof = await request(app)
      .put('/api/v1/me/address')
      .set(auth)
      .set('If-Match', '"v0"')
      .send(body);
    expect(noProof.body.errors[0]).toMatchObject({
      field: 'proofFileId',
      code: 'VALIDATION.REQUIRED',
    });
    const badPin = await request(app)
      .put('/api/v1/me/address')
      .set(auth)
      .set('If-Match', '"v0"')
      .send({ ...body, pinCode: '5600' });
    expect(badPin.body.errors[0]).toMatchObject({ field: 'pinCode', code: 'VALIDATION.PIN_CODE' });
    expect(badPin.body.errors[0].message).toBe('PIN code must contain exactly 6 digits');

    // Someone else's file cannot be attached.
    const otherAuth = await member();
    const othersFile = await upload(otherAuth, 'document');
    const stolen = await request(app)
      .put('/api/v1/me/address')
      .set(auth)
      .set('If-Match', '"v0"')
      .send({ ...body, proofFileId: othersFile });
    expect(stolen.status).toBe(404);

    const proof = await upload(auth, 'document');
    const saved = await request(app)
      .put('/api/v1/me/address')
      .set(auth)
      .set('If-Match', '"v0"')
      .send({ ...body, proofFileId: proof });
    expect(saved.status).toBe(200);
    expect(saved.headers['etag']).toBe('"v1"');
    // A stale version is refused; the current one updates and keeps the proof on file.
    const stale = await request(app)
      .put('/api/v1/me/address')
      .set(auth)
      .set('If-Match', '"v0"')
      .send({ ...body, proofFileId: proof });
    expect(stale.status).toBe(412);
    const moved = await request(app)
      .put('/api/v1/me/address')
      .set(auth)
      .set('If-Match', '"v1"')
      .send({ ...body, line1: '14 MG Road' });
    expect(moved.status).toBe(200);
    const view = await request(app).get('/api/v1/me/personal-details').set(auth);
    expect(view.body.address).toMatchObject({
      line1: '14 MG Road',
      pinCode: '560001',
      proofType: null,
      version: 2,
    });
    expect(view.body.address.proofFile.fileId).toBe(proof);
    // The SRS document type may still be sent; an unknown one is refused.
    const badType = await request(app)
      .put('/api/v1/me/address')
      .set(auth)
      .set('If-Match', '"v2"')
      .send({ ...body, proofType: 'LIBRARY_CARD' });
    expect(badType.body.errors[0]).toMatchObject({ field: 'proofType', code: 'VALIDATION.FORMAT' });
  });

  it('links the bank account after the ₹1 check, stored encrypted (IDN-021)', async () => {
    const auth = await member();
    // The prototype's fields; the re-entered number (SRS) is checked only when it is sent.
    const body = { holderName: 'Asha Rao', accountNumber: '123456789012', ifsc: 'sbin0001234' };
    const put = (b: object, version: string) =>
      request(app)
        .put('/api/v1/me/bank-account')
        .set(auth)
        .set('If-Match', version)
        .set('Idempotency-Key', randomUUID())
        .send(b);
    const mismatch = await put({ ...body, confirmAccountNumber: '123456789013' }, '"v0"');
    expect(mismatch.body.errors[0]).toMatchObject({
      field: 'confirmAccountNumber',
      code: 'IDN.ACCOUNT_NUMBER_MISMATCH',
      message: "Account Number don't match",
    });
    const badIfsc = await put({ ...body, ifsc: 'SBIN1234' }, '"v0"');
    expect(badIfsc.body.errors[0].message).toBe(
      'IFSC Code is Not Valid. Please Enter a Valid IFSC Code.',
    );
    const failed = await put({ ...body, accountNumber: '123456780000' }, '"v0"');
    expect(failed.body.errors[0].code).toBe('IDN.BANK_VERIFY_FAILED');

    const linked = await put(body, '"v0"');
    expect(linked.status).toBe(200);
    expect(linked.body).toEqual({ version: 1, verified: true, testVerification: true });
    const row = await t.db
      .selectFrom('account_bank_accounts')
      .select(['acct_enc', 'acct_last4', 'ifsc', 'holder_name'])
      .executeTakeFirstOrThrow();
    expect(Buffer.from(row.acct_enc).toString('latin1')).not.toContain('123456789012');
    expect(row).toMatchObject({ acct_last4: '9012', ifsc: 'SBIN0001234', holder_name: 'ASHA RAO' });
    // A reason is optional when replacing; an unknown one is refused.
    const badReason = await put(
      { ...body, accountNumber: '998877665544', changeReason: 'BORED' },
      '"v1"',
    );
    expect(badReason.body.errors[0]).toMatchObject({ field: 'changeReason' });
    const replaced = await put({ ...body, accountNumber: '998877665544' }, '"v1"');
    expect(replaced.status).toBe(200);
    const view = await request(app).get('/api/v1/me/personal-details').set(auth);
    expect(view.body.bankAccount).toMatchObject({
      bankName: null,
      accountNumber: 'XXXXXXXX5544',
      verified: true,
      testVerification: true,
      version: 2,
    });
    expect(JSON.stringify(view.body)).not.toContain('998877665544');
  });

  it('saves the nominee and the income (IDN-022, IDN-023)', async () => {
    const auth = await member();
    const nominee = { name: 'Ravi Rao', relation: 'SPOUSE', dob: '1988-01-20', sharePct: 100 };
    const badDob = await request(app)
      .put('/api/v1/me/nominee')
      .set(auth)
      .set('If-Match', '"v0"')
      .send({ ...nominee, dob: '1988-02-30' });
    expect(badDob.body.errors[0].message).toBe('DOB Not Valid !!! Please Enter a valid DOB');
    const badShare = await request(app)
      .put('/api/v1/me/nominee')
      .set(auth)
      .set('If-Match', '"v0"')
      .send({ ...nominee, sharePct: 120 });
    expect(badShare.body.errors[0]).toMatchObject({ field: 'sharePct', code: 'VALIDATION.RANGE' });
    const guardianOnly = await request(app)
      .put('/api/v1/me/nominee')
      .set(auth)
      .set('If-Match', '"v0"')
      .send({ ...nominee, relation: 'GUARDIAN' });
    expect(guardianOnly.body.errors[0].field).toBe('relation');
    expect(
      (await request(app).put('/api/v1/me/nominee').set(auth).set('If-Match', '"v0"').send(nominee))
        .status,
    ).toBe(200);
    // The prototype asks only for name, relationship and share.
    const prototypeNominee = { name: nominee.name, relation: nominee.relation };
    expect(
      (
        await request(app)
          .put('/api/v1/me/nominee')
          .set(auth)
          .set('If-Match', '"v1"')
          .send({ ...prototypeNominee, sharePct: 50 })
      ).status,
    ).toBe(200);

    const badOccupation = await request(app)
      .put('/api/v1/me/income')
      .set(auth)
      .set('If-Match', '"v0"')
      .send({ occupation: '<script>', band: 'FROM_5L_TO_10L' });
    expect(badOccupation.body.errors[0]).toMatchObject({
      field: 'occupation',
      code: 'VALIDATION.FORMAT',
    });
    const income = await request(app)
      .put('/api/v1/me/income')
      .set(auth)
      .set('If-Match', '"v0"')
      .send({ occupation: '  Architect ', band: 'FROM_10L_TO_25L' });
    expect(income.status).toBe(200);
    const view = await request(app).get('/api/v1/me/personal-details').set(auth);
    expect(view.body.nominee).toMatchObject({
      name: 'RAVI RAO',
      relation: 'SPOUSE',
      dob: null,
      sharePct: 50,
      version: 2,
    });
    expect(view.body.income).toMatchObject({ occupation: 'Architect', band: 'FROM_10L_TO_25L' });
  });

  it('raises a correction that waits for a checker; the stored value stands (IDN-016/017, CR-06)', async () => {
    const auth = await member();
    const evidence = await upload(auth, 'evidence');
    const raise = (b: object) =>
      request(app)
        .post('/api/v1/me/pii-corrections')
        .set(auth)
        .set('Idempotency-Key', randomUUID())
        .send(b);
    const mobile = await raise({
      field: 'MOBILE',
      proposedValue: '9000000000',
      reason: 'I changed my number',
      evidenceFileId: evidence,
    });
    expect(mobile.body.errors[0].code).toBe('IDN.PII_FIELD_NOT_CORRECTABLE');
    const shortReason = await raise({
      field: 'FULL_NAME',
      proposedValue: 'Asha Kumari Rao',
      reason: 'typo',
      evidenceFileId: evidence,
    });
    expect(shortReason.body.errors[0].field).toBe('reason');

    const created = await raise({
      field: 'FULL_NAME',
      proposedValue: 'Asha Kumari Rao',
      reason: 'Middle name missed at sign-up',
      evidenceFileId: evidence,
    });
    expect(created.status).toBe(201);
    expect(created.body.status).toBe('PENDING');
    const again = await raise({
      field: 'FULL_NAME',
      proposedValue: 'Asha K Rao',
      reason: 'Middle name missed at sign-up',
      evidenceFileId: evidence,
    });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('IDN.CORRECTION_PENDING');

    const view = await request(app).get('/api/v1/me/personal-details').set(auth);
    expect(view.body.identity.fullName).toBe('ASHA RAO');
    expect(view.body.pendingCorrections).toEqual([
      { requestId: created.body.requestId, field: 'FULL_NAME' },
    ]);
    const list = await request(app).get('/api/v1/me/pii-corrections').set(auth);
    expect(list.body.items[0]).toMatchObject({
      field: 'FULL_NAME',
      current: 'ASHA RAO',
      status: 'PENDING',
    });
    // The corrected value is stored encrypted; the approval request is in the queue.
    const approval = await t.db
      .selectFrom('approval_requests')
      .select(['module', 'action', 'status'])
      .executeTakeFirstOrThrow();
    expect(approval).toEqual({ module: 'PII_CORRECTION', action: 'UPDATE', status: 'PENDING' });
    const stored = await t.db
      .selectFrom('pii_correction_requests')
      .select('proposed_enc')
      .executeTakeFirstOrThrow();
    expect(Buffer.from(stored.proposed_enc).toString('latin1')).not.toContain('KUMARI');
  });
});
