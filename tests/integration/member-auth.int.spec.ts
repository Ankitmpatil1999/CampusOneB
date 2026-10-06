/**
 * Member sign-up, sign-in, device binding, password recovery and the "me" endpoints on a real
 * MySQL, through HTTP exactly as the app calls them (IDN-001…013, 024, 029, 030, 077, 078;
 * SRS 6.2, 6.3, 6.8, 6.15; BR-01, BR-05; OI-IDN-09; Q13).
 */
import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import request from 'supertest';
import type { Express } from 'express';
import { adminUrl, createTestDatabase, type TestDatabase } from './db';
import { buildHttpApp, codeOf } from './http-app';

const PASSWORD = 'Ringpe@2026';
const CONSENT = '2026.10';
const TERMS = '2026.10';

type Harness = Awaited<ReturnType<typeof buildHttpApp>>;

const newMobile = () => `9${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`;
const newPan = () => `ABCDE${String(randomInt(0, 10_000)).padStart(4, '0')}F`;
/** Aadhaar: only the last 6 digits are asked for and kept (client Q16(e)). */
const newAadhaar = () => String(randomInt(0, 1_000_000)).padStart(6, '0');
const device = (installId = randomUUID(), model = 'Pixel 8') => ({
  installId,
  model,
  os: 'Android 15',
  appVersion: '1.0.0',
});

describe.skipIf(!adminUrl)('member sign-up, sign-in and recovery on real MySQL', () => {
  let t: TestDatabase;
  let h: Harness;
  let app: Express;

  beforeAll(async () => {
    t = await createTestDatabase();
    h = await buildHttpApp(t);
    app = h.app;
  }, 120_000);
  afterAll(async () => {
    await t?.drop();
  });

  const lastSms = () => h.sms.sent.at(-1);
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  /** Steps 1–2: consent + mobile → code → sign-up token. */
  async function signupToken(mobile: string) {
    const start = await request(app)
      .post('/api/v1/auth/member/signup/otp')
      .send({ mobile, consentVersion: CONSENT });
    expect(start.status).toBe(202);
    const verify = await request(app)
      .post('/api/v1/auth/member/signup/otp/verify')
      .send({ challengeId: start.body.challengeId, otp: codeOf(lastSms()) });
    expect(verify.status).toBe(200);
    return verify.body.signupToken as string;
  }

  const details = (mobile: string, token: string, extra: Record<string, unknown> = {}) => ({
    signupToken: token,
    mobile,
    consentVersion: CONSENT,
    termsVersion: TERMS,
    termsAccepted: true,
    pan: newPan(),
    firstName: 'Asha',
    lastName: 'Rao',
    gender: 'FEMALE',
    dob: '1990-04-12',
    idDocType: 'AADHAAR',
    idDocNumber: newAadhaar(),
    email: `asha.${randomInt(0, 1e9)}@example.in`,
    password: PASSWORD,
    securityQuestion: 'FIRST_SCHOOL',
    securityAnswer: 'Vidyaniketan',
    device: device(),
    ...extra,
  });

  /** A complete sign-up; returns the session and what was sent. */
  async function signUp(extra: Record<string, unknown> = {}) {
    const mobile = (extra['mobile'] as string | undefined) ?? newMobile();
    const body = details(mobile, await signupToken(mobile), extra);
    const res = await request(app)
      .post('/api/v1/auth/member/signup')
      .set('Idempotency-Key', randomUUID())
      .send(body);
    expect(res.status).toBe(201);
    return { mobile, body, session: res.body };
  }

  it('serves the sign-up reference data (IDN-077)', async () => {
    const res = await request(app).get('/api/v1/auth/member/signup/reference');
    expect(res.status).toBe(200);
    expect(res.body.consent).toMatchObject({
      version: CONSENT,
      title: 'Terms of use',
      draft: false,
    });
    expect(res.body.terms).toMatchObject({ version: TERMS, draft: false });
    expect(res.body.genders.map((g: { code: string }) => g.code)).toEqual(['MALE', 'FEMALE']);
    expect(res.body.securityQuestions.map((q: { code: string }) => q.code)).toContain(
      'FIRST_SCHOOL',
    );
    expect(res.body.idDocumentTypes.map((d: { code: string }) => d.code)).toEqual(
      expect.arrayContaining(['AADHAAR', 'PASSPORT', 'VOTER_ID', 'DRIVING_LICENCE']),
    );
    expect(res.body.password).toEqual({ minLength: 8, maxLength: 64 });
    expect(res.body.minAgeYears).toBe(18);
  });

  it('runs the sign-up journey end to end and stores personal data protected', async () => {
    const mobile = newMobile();

    // Step 1 refusals.
    const badMobile = await request(app)
      .post('/api/v1/auth/member/signup/otp')
      .send({ mobile: '12345', consentVersion: CONSENT });
    expect(badMobile.status).toBe(422);
    expect(badMobile.body.errors[0]).toMatchObject({ field: 'mobile', code: 'VALIDATION.MOBILE' });
    const badConsent = await request(app)
      .post('/api/v1/auth/member/signup/otp')
      .send({ mobile, consentVersion: '1999.01' });
    expect(badConsent.body.code).toBe('IDN.CONSENT_UNKNOWN');

    // Step 1: one SMS; asking again keeps the live code (RNG-IDN-010).
    const sent = h.sms.sent.length;
    const start = await request(app)
      .post('/api/v1/auth/member/signup/otp')
      .send({ mobile, consentVersion: CONSENT });
    expect(start.status).toBe(202);
    expect(start.body.sentTo).not.toContain(mobile);
    expect(start.body.testCode).toBeUndefined();
    expect(h.sms.sent.length).toBe(sent + 1);
    const again = await request(app)
      .post('/api/v1/auth/member/signup/otp')
      .send({ mobile, consentVersion: CONSENT });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ challengeId: start.body.challengeId, alreadySent: true });
    expect(h.sms.sent.length).toBe(sent + 1);

    // Resend only after the countdown (IDN-078), and only to the same mobile.
    const early = await request(app)
      .post('/api/v1/auth/otp/resend')
      .send({ challengeId: start.body.challengeId, mobile });
    expect(early.status).toBe(409);
    expect(early.body.code).toBe('AUTH.OTP_RESEND_TOO_SOON');
    expect(early.headers['retry-after']).toBeDefined();
    const otherMobile = await request(app)
      .post('/api/v1/auth/otp/resend')
      .send({ challengeId: start.body.challengeId, mobile: newMobile() });
    expect(otherMobile.body.code).toBe('AUTH.OTP_INVALID');

    // Step 2: wrong code, right code, then the code is spent.
    const code = codeOf(lastSms());
    expect(code).toMatch(/^[1-9]\d{3}$/);
    const wrong = await request(app)
      .post('/api/v1/auth/member/signup/otp/verify')
      .send({ challengeId: start.body.challengeId, otp: code === '1111' ? '2222' : '1111' });
    expect(wrong.status).toBe(400);
    expect(wrong.body.code).toBe('AUTH.OTP_INVALID');
    const verified = await request(app)
      .post('/api/v1/auth/member/signup/otp/verify')
      .send({ challengeId: start.body.challengeId, otp: code });
    expect(verified.status).toBe(200);
    expect(verified.headers['cache-control']).toBe('no-store');
    const reused = await request(app)
      .post('/api/v1/auth/member/signup/otp/verify')
      .send({ challengeId: start.body.challengeId, otp: code });
    expect(reused.body.code).toBe('AUTH.OTP_ALREADY_USED');

    const token = verified.body.signupToken as string;
    const body = details(mobile, token);

    // Steps 3–5: an Idempotency-Key is required.
    const noKey = await request(app).post('/api/v1/auth/member/signup').send(body);
    expect(noKey.status).toBe(428);
    expect(noKey.body.code).toBe('GEN.IDEMPOTENCY_KEY_REQUIRED');

    // The token belongs to this mobile only.
    const otherSession = await request(app)
      .post('/api/v1/auth/member/signup')
      .set('Idempotency-Key', randomUUID())
      .send({ ...body, mobile: newMobile() });
    expect(otherSession.status).toBe(401);
    expect(otherSession.body.code).toBe('IDN.SIGNUP_SESSION_ENDED');

    // Every field rule answers with its own 27.5 message, all at once.
    const invalid = await request(app)
      .post('/api/v1/auth/member/signup')
      .set('Idempotency-Key', randomUUID())
      .send({
        ...body,
        pan: 'ABC123',
        firstName: 'Asha1',
        dob: '2015-01-01',
        idDocNumber: '1234',
        email: 'not-an-email',
        password: 'weakpass',
        securityQuestion: 'NO_SUCH',
        securityAnswer: 'two words9',
      });
    expect(invalid.status).toBe(422);
    expect(
      invalid.body.errors.map((e: { field: string; code: string }) => `${e.field}:${e.code}`),
    ).toEqual(
      expect.arrayContaining([
        'pan:IDN.PAN_INVALID',
        'firstName:IDN.NAME_LETTERS_ONLY',
        'dob:IDN.AGE_UNDER_18',
        'idDocNumber:IDN.ID_DOC_NUMBER_INVALID',
        'email:VALIDATION.EMAIL',
        'password:VALIDATION.PASSWORD',
        'securityQuestion:IDN.SECURITY_QUESTION_INVALID',
        'securityAnswer:IDN.SECURITY_ANSWER_FORMAT',
      ]),
    );
    const noTerms = await request(app)
      .post('/api/v1/auth/member/signup')
      .set('Idempotency-Key', randomUUID())
      .send({ ...body, termsAccepted: false });
    expect(noTerms.body.code).toBe('IDN.TERMS_REQUIRED');

    // A valid request creates the account and signs in on this device.
    const key = randomUUID();
    const created = await request(app)
      .post('/api/v1/auth/member/signup')
      .set('Idempotency-Key', key)
      .send(body);
    expect(created.status).toBe(201);
    expect(created.headers['cache-control']).toBe('no-store');
    expect(created.body.account).toMatchObject({
      firstName: 'ASHA',
      lastName: 'RAO',
      preferredLang: 'en',
    });
    // A repeat with the same key replays the stored answer; nothing is created twice.
    const replay = await request(app)
      .post('/api/v1/auth/member/signup')
      .set('Idempotency-Key', key)
      .send(body);
    expect(replay.status).toBe(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body.sessionId).toBe(created.body.sessionId);

    // Stored protected: PAN and identity number encrypted, secrets hashed, consents recorded.
    const row = await t.db
      .selectFrom('platform_accounts')
      .selectAll()
      .where('mobile', '=', mobile)
      .executeTakeFirstOrThrow();
    expect(row.pan_last4).toBe(body.pan.slice(-4));
    expect(Buffer.from(row.pan_enc!).toString('latin1')).not.toContain(body.pan);
    expect(Buffer.from(row.id_doc_enc!).toString('latin1')).not.toContain(body.idDocNumber);
    const credentials = await t.db
      .selectFrom('account_credentials')
      .select(['kind', 'hash', 'question_code'])
      .where('account_id', '=', row.id)
      .execute();
    expect(credentials.map((c) => c.kind).sort()).toEqual(['PASSWORD', 'SECURITY_ANSWER']);
    for (const c of credentials) expect(c.hash).toMatch(/^\$argon2id\$/);
    const consents = await t.db
      .selectFrom('consents')
      .select(['kind', 'version'])
      .where('account_id', '=', row.id)
      .execute();
    expect(consents.map((c) => c.kind).sort()).toEqual(['DATA_PROCESSING', 'TERMS']);
    const audit = await t.db
      .selectFrom('audit_log')
      .select('action')
      .where('action', '=', 'ACCOUNT_CREATED')
      .execute();
    expect(audit.length).toBeGreaterThanOrEqual(1);

    // Nothing secret reaches the logs — as a value of its own: a 4-digit code may sit inside a random
    // correlation id ("…c7403311") without being logged.
    const logs = JSON.stringify(h.lines);
    for (const secret of [body.pan, body.idDocNumber, PASSWORD, 'vidyaniketan', code]) {
      const escaped = String(secret).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      expect(logs).not.toMatch(new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`));
    }

    // "Me" shows the account with PAN and identity number masked (IDN-013).
    const me = await request(app).get('/api/v1/me').set(bearer(created.body.accessToken));
    expect(me.status).toBe(200);
    expect(me.body.account).toMatchObject({
      mobile,
      email: body.email,
      firstName: 'ASHA',
      pan: `••••••${body.pan.slice(-4)}`,
      idDocument: { type: 'AADHAAR', number: `XXXX XXXX ${body.idDocNumber.slice(-4)}` },
      dob: '1990-04-12',
    });
    expect(JSON.stringify(me.body)).not.toContain(body.pan);

    // The mobile, e-mail and PAN are each taken now.
    const exists = await request(app)
      .post('/api/v1/auth/member/signup/otp')
      .send({ mobile, consentVersion: CONSENT });
    expect(exists.status).toBe(409);
    expect(exists.body.code).toBe('IDN.ACCOUNT_EXISTS');
    const second = newMobile();
    const taken = await request(app)
      .post('/api/v1/auth/member/signup')
      .set('Idempotency-Key', randomUUID())
      .send(details(second, await signupToken(second), { pan: body.pan, email: body.email }));
    expect(taken.status).toBe(422);
    expect(taken.body.errors.map((e: { code: string }) => e.code).sort()).toEqual([
      'IDN.EMAIL_TAKEN',
      'IDN.PAN_TAKEN',
    ]);
  });

  it('signs in on the bound device and asks for a code on a new one (IDN-006/007, BR-05)', async () => {
    const { mobile, body, session } = await signUp();

    const format = await request(app)
      .post('/api/v1/auth/member/signin')
      .send({ mobile, password: 'short', device: body.device });
    expect(format.status).toBe(400);
    expect(format.body.code).toBe('IDN.CREDENTIALS_FORMAT');
    const unknown = await request(app)
      .post('/api/v1/auth/member/signin')
      .send({ mobile: newMobile(), password: PASSWORD, device: body.device });
    expect(unknown.status).toBe(401);
    expect(unknown.body.code).toBe('IDN.MOBILE_NOT_REGISTERED');

    // Same device: signed in straight away; the earlier member session ends (one per surface).
    const again = await request(app)
      .post('/api/v1/auth/member/signin')
      .send({ mobile, password: PASSWORD, device: body.device });
    expect(again.status).toBe(200);
    expect(again.body.sessionId).not.toBe(session.sessionId);
    expect((await request(app).get('/api/v1/me').set(bearer(session.accessToken))).status).toBe(
      401,
    );
    expect((await request(app).get('/api/v1/me').set(bearer(again.body.accessToken))).status).toBe(
      200,
    );

    // The member app refreshes with the token in the body (IDN-008).
    const refreshed = await request(app)
      .post('/api/v1/auth/token/refresh')
      .send({ refreshToken: again.body.refreshToken });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.refreshToken).not.toBe(again.body.refreshToken);

    // New device: a code to the account mobile, bound to this install only.
    const phone = device(randomUUID(), 'Galaxy S24');
    const challenged = await request(app)
      .post('/api/v1/auth/member/signin')
      .send({ mobile, password: PASSWORD, device: phone });
    expect(challenged.status).toBe(202);
    const challengeId = challenged.body.deviceChallenge.challengeId as string;
    const code = codeOf(lastSms());
    const elsewhere = await request(app)
      .post('/api/v1/auth/member/device/verify')
      .send({ deviceChallengeId: challengeId, otp: code, device: device() });
    expect(elsewhere.status).toBe(400);
    expect(elsewhere.body.code).toBe('AUTH.OTP_INVALID');
    const bound = await request(app)
      .post('/api/v1/auth/member/device/verify')
      .send({ deviceChallengeId: challengeId, otp: code, device: phone });
    expect(bound.status).toBe(200);

    const devices = await request(app)
      .get('/api/v1/me/devices')
      .set(bearer(bound.body.accessToken));
    expect(devices.body.device).toMatchObject({ model: 'Galaxy S24', os: 'Android 15' });
    // The old device needs a code now.
    const old = await request(app)
      .post('/api/v1/auth/member/signin')
      .send({ mobile, password: PASSWORD, device: body.device });
    expect(old.status).toBe(202);
  });

  it('locks sign-in after repeated wrong passwords (IDN.SIGNIN_LOCKED)', async () => {
    const { mobile, body } = await signUp();
    const attempt = (password: string) =>
      request(app)
        .post('/api/v1/auth/member/signin')
        .send({ mobile, password, device: body.device });
    for (let i = 0; i < 4; i += 1) {
      const r = await attempt('Wrong@2026');
      expect(r.status).toBe(401);
      expect(r.body.code).toBe('IDN.CREDENTIALS_INVALID');
    }
    const locked = await attempt('Wrong@2026');
    expect(locked.status).toBe(429);
    expect(locked.body.code).toBe('IDN.SIGNIN_LOCKED');
    // The placeholder values travel with the problem so the app can word it in any language.
    expect(locked.body.params).toEqual({ minutes: 15 });
    expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0);
    // Even the right password waits for the lock to pass.
    expect((await attempt(PASSWORD)).body.code).toBe('IDN.SIGNIN_LOCKED');
  });

  it('recovers a forgotten password with the security answer and a code (IDN-010…012)', async () => {
    const { mobile, body, session } = await signUp();

    const unknown = await request(app)
      .post('/api/v1/auth/member/password/forgot')
      .send({ mobile: newMobile() });
    expect(unknown.status).toBe(404);
    expect(unknown.body.code).toBe('IDN.USER_NOT_REGISTERED');

    const started = await request(app).post('/api/v1/auth/member/password/forgot').send({ mobile });
    expect(started.status).toBe(202);
    expect(started.body.question).toMatchObject({ code: 'FIRST_SCHOOL' });
    const recoveryId = started.body.recoveryId as string;
    const code = codeOf(lastSms());

    const wrongAnswer = await request(app)
      .post('/api/v1/auth/member/password/forgot/verify')
      .send({ recoveryId, securityAnswer: 'Elsewhere', otp: code });
    expect(wrongAnswer.status).toBe(422);
    expect(wrongAnswer.body.errors[0].code).toBe('IDN.SECURITY_ANSWER_WRONG');
    const wrongCode = await request(app)
      .post('/api/v1/auth/member/password/forgot/verify')
      .send({ recoveryId, securityAnswer: 'vidyaniketan', otp: code === '1111' ? '2222' : '1111' });
    expect(wrongCode.body.code).toBe('AUTH.OTP_INVALID');
    // The answer is compared without case or surrounding spaces.
    const verified = await request(app)
      .post('/api/v1/auth/member/password/forgot/verify')
      .send({ recoveryId, securityAnswer: '  VidyaNiketan ', otp: code });
    expect(verified.status).toBe(200);
    const resetToken = verified.body.resetToken as string;

    const weak = await request(app)
      .post('/api/v1/auth/member/password/reset')
      .send({ resetToken, newPassword: 'weak' });
    expect(weak.status).toBe(422);
    expect(weak.body.errors[0].code).toBe('IDN.PASSWORD_FORMAT');
    const reset = await request(app)
      .post('/api/v1/auth/member/password/reset')
      .send({ resetToken, newPassword: 'Changed#2027' });
    expect(reset.status).toBe(204);

    // The token works once; every session ended; the new password signs in.
    const reuse = await request(app)
      .post('/api/v1/auth/member/password/reset')
      .send({ resetToken, newPassword: 'Another#2028' });
    expect(reuse.status).toBe(401);
    expect(reuse.body.code).toBe('IDN.RECOVERY_SESSION_ENDED');
    expect((await request(app).get('/api/v1/me').set(bearer(session.accessToken))).status).toBe(
      401,
    );
    const oldPassword = await request(app)
      .post('/api/v1/auth/member/signin')
      .send({ mobile, password: PASSWORD, device: body.device });
    expect(oldPassword.body.code).toBe('IDN.CREDENTIALS_INVALID');
    const signedIn = await request(app)
      .post('/api/v1/auth/member/signin')
      .send({ mobile, password: 'Changed#2027', device: body.device });
    expect(signedIn.status).toBe(200);
  });

  it('changes the password and the language for the signed-in member (IDN-024, IDN-030)', async () => {
    const { mobile, body, session } = await signUp();
    const auth = bearer(session.accessToken);

    const mismatch = await request(app)
      .post('/api/v1/me/password')
      .set(auth)
      .send({ currentPassword: 'Wrong@2026', newPassword: 'Changed#2027' });
    expect(mismatch.body.errors[0].code).toBe('IDN.PASSWORD_MISMATCH');
    const same = await request(app)
      .post('/api/v1/me/password')
      .set(auth)
      .send({ currentPassword: PASSWORD, newPassword: PASSWORD });
    expect(same.body.errors[0].code).toBe('IDN.PASSWORD_SAME');
    const changed = await request(app)
      .post('/api/v1/me/password')
      .set(auth)
      .send({ currentPassword: PASSWORD, newPassword: 'Changed#2027' });
    expect(changed.status).toBe(204);
    // The session that changed it keeps working.
    expect((await request(app).get('/api/v1/me').set(auth)).status).toBe(200);
    const signedIn = await request(app)
      .post('/api/v1/auth/member/signin')
      .send({ mobile, password: 'Changed#2027', device: body.device });
    expect(signedIn.status).toBe(200);

    const auth2 = bearer(signedIn.body.accessToken);
    const kannada = await request(app).put('/api/v1/me/language').set(auth2).send({ lang: 'kn' });
    expect(kannada.status).toBe(200);
    expect(kannada.body).toEqual({ preferredLang: 'kn' });
    expect((await request(app).get('/api/v1/me').set(auth2)).body.account.preferredLang).toBe('kn');
    const french = await request(app).put('/api/v1/me/language').set(auth2).send({ lang: 'fr' });
    expect(french.status).toBe(422);
    expect(french.body.code).toBe('IDN.LANGUAGE_INVALID');
  });

  it('changes the e-mail only after the code sent to the new address (IDN-018/019)', async () => {
    const { session, body } = await signUp();
    const other = await signUp();
    const auth = bearer(session.accessToken);
    const invalid = await request(app)
      .put('/api/v1/me/contact/email')
      .set(auth)
      .send({ email: 'not-an-email' });
    expect(invalid.body.errors[0].code).toBe('VALIDATION.EMAIL');
    const same = await request(app)
      .put('/api/v1/me/contact/email')
      .set(auth)
      .send({ email: body.email });
    expect(same.body.errors[0].code).toBe('IDN.EMAIL_UNCHANGED');
    const taken = await request(app)
      .put('/api/v1/me/contact/email')
      .set(auth)
      .send({ email: other.body.email });
    expect(taken.body.errors[0].code).toBe('IDN.EMAIL_TAKEN');

    const fresh = `asha.new.${randomInt(0, 1e9)}@example.in`;
    const started = await request(app)
      .put('/api/v1/me/contact/email')
      .set(auth)
      .send({ email: fresh });
    expect(started.status).toBe(202);
    const sent = h.email.sent.at(-1);
    expect(sent?.to).toBe(fresh);
    // Nothing changes until the code is confirmed.
    expect((await request(app).get('/api/v1/me').set(auth)).body.account.email).toBe(body.email);
    const wrong = await request(app)
      .post('/api/v1/me/contact/email/verify')
      .set(auth)
      .send({
        changeToken: started.body.changeToken,
        challengeId: started.body.challenge.challengeId,
        otp: codeOf(sent) === '1111' ? '2222' : '1111',
      });
    expect(wrong.body.code).toBe('AUTH.OTP_INVALID');
    const confirmed = await request(app)
      .post('/api/v1/me/contact/email/verify')
      .set(auth)
      .send({
        changeToken: started.body.changeToken,
        challengeId: started.body.challenge.challengeId,
        otp: codeOf(sent),
      });
    expect(confirmed.status).toBe(200);
    const me = await request(app).get('/api/v1/me').set(auth);
    expect(me.body.account).toMatchObject({ email: fresh, emailVerified: true });
  });

  it('signs up and signs in with a sign-in provider in test mode (IDN-004/005, CR-03)', async () => {
    const pkce = () => {
      const verifier = randomBytes(32).toString('base64url');
      return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
    };
    const testCode = (email: string, name: string) =>
      `test.${Buffer.from(JSON.stringify({ email, name })).toString('base64url')}`;
    const email = `priya.${randomInt(0, 1e9)}@example.in`;
    const phone = device();

    // Start: the state carries the provider and the PKCE challenge.
    const p1 = pkce();
    const start = await request(app)
      .post('/api/v1/auth/member/social/google/start')
      .send({ redirectUri: 'in.ringpe.app://social', codeChallenge: p1.challenge });
    expect(start.status).toBe(200);
    expect(start.body.mode).toBe('test');
    expect(start.body.authorizationUrl).toContain('state=');
    const unknown = await request(app)
      .post('/api/v1/auth/member/social/facebook/start')
      .send({ redirectUri: 'in.ringpe.app://social', codeChallenge: p1.challenge });
    expect(unknown.body.code).toBe('IDN.PROVIDER_DISABLED');

    // A wrong verifier is refused; the right one returns a sign-up ticket for a new identity.
    const wrong = await request(app)
      .post('/api/v1/auth/member/social/google/callback')
      .send({
        code: testCode(email, 'Priya Rao'),
        state: start.body.state,
        codeVerifier: pkce().verifier,
        device: phone,
      });
    expect(wrong.status).toBe(401);
    expect(wrong.body.code).toBe('IDN.SOCIAL_STATE_INVALID');
    const ticket = await request(app)
      .post('/api/v1/auth/member/social/google/callback')
      .send({
        code: testCode(email, 'Priya Rao'),
        state: start.body.state,
        codeVerifier: p1.verifier,
        device: phone,
      });
    expect(ticket.status).toBe(200);
    expect(ticket.body.prefill).toEqual({
      provider: 'google',
      email,
      firstName: 'Priya',
      lastName: 'Rao',
    });

    // The wizard still verifies the mobile; PAN and password may be left out.
    const mobile = newMobile();
    const body = details(mobile, await signupToken(mobile), {
      socialTicket: ticket.body.signupTicket,
      email,
      firstName: 'Priya',
      lastName: 'Rao',
      device: phone,
    }) as Record<string, unknown>;
    delete body['pan'];
    delete body['password'];
    const otherEmail = await request(app)
      .post('/api/v1/auth/member/signup')
      .set('Idempotency-Key', randomUUID())
      .send({ ...body, email: 'someone.else@example.in' });
    expect(otherEmail.body.code).toBe('IDN.SIGNUP_SESSION_ENDED');
    const created = await request(app)
      .post('/api/v1/auth/member/signup')
      .set('Idempotency-Key', randomUUID())
      .send(body);
    expect(created.status).toBe(201);
    const row = await t.db
      .selectFrom('platform_accounts')
      .select(['id', 'pan_enc', 'pan_last4'])
      .where('mobile', '=', mobile)
      .executeTakeFirstOrThrow();
    expect(row.pan_enc).toBeNull();
    const kinds = await t.db
      .selectFrom('account_credentials')
      .select('kind')
      .where('account_id', '=', row.id)
      .execute();
    expect(kinds.map((k) => k.kind)).toEqual(['SECURITY_ANSWER']);

    // Next time the provider signs the linked account in on its registered phone.
    const p2 = pkce();
    const again = await request(app)
      .post('/api/v1/auth/member/social/google/start')
      .send({ redirectUri: 'in.ringpe.app://social', codeChallenge: p2.challenge });
    const signedIn = await request(app)
      .post('/api/v1/auth/member/social/google/callback')
      .send({
        code: testCode(email, 'Priya Rao'),
        state: again.body.state,
        codeVerifier: p2.verifier,
        device: phone,
      });
    expect(signedIn.status).toBe(200);
    expect(signedIn.body.account).toMatchObject({ firstName: 'PRIYA', lastName: 'RAO' });
    // A new phone still needs the code sent to the account mobile.
    const p3 = pkce();
    const third = await request(app)
      .post('/api/v1/auth/member/social/google/start')
      .send({ redirectUri: 'in.ringpe.app://social', codeChallenge: p3.challenge });
    const newPhone = await request(app)
      .post('/api/v1/auth/member/social/google/callback')
      .send({
        code: testCode(email, 'Priya Rao'),
        state: third.body.state,
        codeVerifier: p3.verifier,
        device: device(),
      });
    expect(newPhone.status).toBe(202);
    expect(newPhone.body.deviceChallenge.challengeId).toBeTruthy();
  });

  it('refuses the member endpoints without a member session', async () => {
    expect((await request(app).get('/api/v1/me')).status).toBe(401);
    const consoleToken = (
      await h.security.signer.sign({
        subject: randomUUID(),
        surface: 'console',
        sessionId: randomUUID(),
        subTasks: [],
      })
    ).token;
    expect((await request(app).get('/api/v1/me').set(bearer(consoleToken))).status).toBe(403);
    expect((await request(app).get('/api/v1/me/devices').set(bearer(consoleToken))).status).toBe(
      403,
    );
  });
});

describe.skipIf(!adminUrl)('test mode shows the code in the app (client Q17)', () => {
  let t: TestDatabase;

  beforeAll(async () => {
    t = await createTestDatabase();
  }, 120_000);
  afterAll(async () => {
    await t?.drop();
  });

  it('returns testCode only when OTP_TEST_SHOW_CODE is on', async () => {
    const { app, sms } = await buildHttpApp(t, { env: { OTP_TEST_SHOW_CODE: 'true' } });
    const res = await request(app)
      .post('/api/v1/auth/member/signup/otp')
      .send({ mobile: newMobile(), consentVersion: CONSENT });
    expect(res.status).toBe(202);
    expect(res.body.testCode).toBe(codeOf(sms.sent.at(-1)));
  });
});
