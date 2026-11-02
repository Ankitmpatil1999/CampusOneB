/**
 * A plain-HTTP test server on the LAN (client 2026-10-06): browsers keep `__Host-` Secure cookies
 * only over HTTPS or on localhost, so with COOKIE_SECURE=false the console session lives in plain
 * cookies (no prefix, no Secure) and still works end to end: sign-in, session, CSRF-checked change.
 * Its own file, because the cookie mode is set per API process.
 */
import { randomInt } from 'node:crypto';
import request from 'supertest';
import { adminUrl, createTestDatabase, insertInstitution, type TestDatabase } from './db';
import { buildHttpApp, codeOf } from './http-app';
import { newPublicIdPair } from '../../utils/idGenerator';
import { hashSecret } from '../../utils/password';
import { useSecureCookies } from '../../utils/cookies';

const PASSWORD = 'Tvps@2026';

describe.skipIf(!adminUrl)('console sessions on a plain-HTTP LAN server', () => {
  let t: TestDatabase;

  beforeAll(async () => {
    t = await createTestDatabase();
  }, 120_000);
  afterAll(async () => {
    useSecureCookies(true);
    await t?.drop();
  });

  async function admin() {
    const inst = await insertInstitution(t.db);
    await t.db
      .updateTable('institutions')
      .set({ status: 'ACTIVE' })
      .where('id', '=', inst.id)
      .execute();
    const email = `lan.${randomInt(0, 1e9)}@school.example.in`;
    const acc = await t.db
      .insertInto('platform_accounts')
      .values({
        public_id: newPublicIdPair().bin,
        mobile: `9${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`,
        email,
        first_name: 'PRAKASH',
        last_name: 'SHETTY',
      })
      .executeTakeFirstOrThrow();
    await t.db
      .insertInto('account_credentials')
      .values({
        account_id: String(acc.insertId),
        kind: 'PASSWORD',
        hash: await hashSecret(PASSWORD),
      })
      .execute();
    const type = await t.db
      .insertInto('user_types')
      .values({
        public_id: newPublicIdPair().bin,
        institution_id: inst.id,
        name: 'Staff',
        category: 'STAFF',
      })
      .executeTakeFirstOrThrow();
    const p = await t.db
      .insertInto('member_profiles')
      .values({
        public_id: newPublicIdPair().bin,
        institution_id: inst.id,
        account_id: String(acc.insertId),
        user_type_id: String(type.insertId),
        first_name: 'PRAKASH',
      })
      .executeTakeFirstOrThrow();
    const role = await t.db
      .selectFrom('roles')
      .select('id')
      .where('code', '=', 'INSTITUTION_ADMIN')
      .executeTakeFirstOrThrow();
    await t.db
      .insertInto('profile_roles')
      .values({ institution_id: inst.id, profile_id: String(p.insertId), role_id: String(role.id) })
      .execute();
    return email;
  }

  it('signs in with plain cookies, keeps the session and checks CSRF', async () => {
    const h = await buildHttpApp(t, { env: { COOKIE_SECURE: 'false' } });
    const email = await admin();
    const step1 = await request(h.app)
      .post('/api/v1/auth/console/signin')
      .send({ email, password: PASSWORD });
    expect(step1.status).toBe(202);
    const verified = await request(h.app)
      .post('/api/v1/auth/console/otp/verify')
      .send({ challengeId: step1.body.challengeId, otp: codeOf(h.sms.sent.at(-1)) });
    expect(verified.status).toBe(200);
    const raw = ([] as string[]).concat(verified.headers['set-cookie'] ?? []);
    // No `__Host-` prefix and no Secure flag: a browser on http://192.168.x.x keeps them.
    expect(raw.map((c) => c.split('=')[0])).toEqual([
      'rp_console_at',
      'rp_console_rt',
      'rp_console_csrf',
    ]);
    for (const c of raw) {
      expect(c).not.toMatch(/;\s*Secure/i);
      expect(c).toMatch(/SameSite=Strict/i);
    }
    expect(raw.filter((c) => /HttpOnly/i.test(c))).toHaveLength(2);
    const cookies = raw.map((c) => c.split(';')[0]!);

    const session = await request(h.app).get('/api/v1/console/session').set('Cookie', cookies);
    expect(session.status).toBe(200);
    expect(session.body.roles[0].code).toBe('INSTITUTION_ADMIN');

    // A change still needs the CSRF token from the (plain) CSRF cookie.
    const csrf = cookies.find((c) => c.startsWith('rp_console_csrf='))!.split('=')[1]!;
    const lang = (header?: string) => {
      const r = request(h.app)
        .put('/api/v1/me/language')
        .set('Cookie', cookies)
        .set('X-CampusOne-Surface', 'console');
      return (header ? r.set('X-CSRF-Token', header) : r).send({ lang: 'kn' });
    };
    expect((await lang()).status).toBe(403);
    expect((await lang(csrf)).status).toBe(200);
  });
});
