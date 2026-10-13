/**
 * The principal, merchants and vendor merchants on the web (client 2026-10-13) on a real MySQL: the
 * school gives each the matching console role (Principal, Merchant, Vendor merchant — a role meant for
 * another kind of profile is refused); each signs in to the console with the app account's e-mail and
 * password and a code, and works on the same routes as in the app. Without the grant, the routes stay
 * shut.
 */
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { adminUrl } from './db';
import { inr, mobile, schoolFixture, type Auth } from './school';

describe.skipIf(!adminUrl)('the principal, merchants and vendor merchants on the web', () => {
  let f: Awaited<ReturnType<typeof schoolFixture>>;
  let con: Auth;
  let roles: Record<string, string>;
  let principalId = '';
  let canteen: Awaited<ReturnType<Awaited<ReturnType<typeof schoolFixture>>['merchant']>>;
  let supplies: typeof canteen;
  let principalWeb: Auth;
  let canteenWeb: Auth;
  let suppliesWeb: Auth;

  const get = (path: string, auth: Auth = con) => request(f.app).get(`/api/v1${path}`).set(auth);
  const post = (path: string, body: object, auth: Auth) =>
    request(f.app).post(`/api/v1${path}`).set(auth).set('Idempotency-Key', randomUUID()).send(body);
  const setRoles = (profileId: string, codes: string[]) =>
    request(f.app)
      .put(`/api/v1/console/staff-accounts/${profileId}/roles`)
      .set(con)
      .send({ roleIds: codes.map((c) => roles[c]) });
  /** A console session as the profile's app account; app routes are named with the surface. */
  const onWeb = async (profileId: string) => {
    const p = await f.profileRow(profileId);
    const acc = await f.t.db
      .selectFrom('platform_accounts')
      .select('email')
      .where('id', '=', String(p.account_id))
      .executeTakeFirstOrThrow();
    return { ...(await f.signedIn('console', acc.email!)), 'X-RingPe-Surface': 'console' };
  };

  beforeAll(async () => {
    f = await schoolFixture('Roles Web School');
    con = f.school.con;
    roles = Object.fromEntries(
      (await get('/console/roles')).body.items.map((r: { code: string; id: string }) => [
        r.code,
        r.id,
      ]),
    );
    // The principal: a member of the school with the Principal user type and an app account.
    await request(f.app)
      .post('/api/v1/console/user-types')
      .set(con)
      .set('Idempotency-Key', randomUUID())
      .send({ name: 'Principal', category: 'PRINCIPAL', departments: ['Office'] });
    const principalType = (await get('/console/user-types')).body.items.find(
      (x: { name: string }) => x.name === 'Principal',
    ).id as string;
    const mob = mobile();
    await f.signUp(mob, 'Kavitha');
    const p = await request(f.app)
      .post('/api/v1/console/members')
      .set(con)
      .set('Idempotency-Key', randomUUID())
      .send({ userTypeId: principalType, firstName: 'Kavitha', mobile: mob });
    expect(p.status, JSON.stringify(p.body)).toBe(201);
    principalId = p.body.id as string;
    canteen = await f.merchant('Campus Canteen');
    supplies = await f.merchant('Lab Supplies Co', { subType: 'VENDOR' });
  }, 300_000);
  afterAll(async () => {
    await f?.t.drop();
  });

  it('offers the three roles and gives each only to the matching profile', async () => {
    expect(Object.keys(roles)).toEqual(
      expect.arrayContaining(['PRINCIPAL', 'MERCHANT', 'VENDOR_MERCHANT']),
    );
    // The administrator's own console holds none of them.
    const admin = (await get('/console/session')).body.subTasks as string[];
    expect(admin).not.toContain('task.principal');
    expect(admin).not.toContain('task.business');
    // Merchants are listed with their type, so the matching role can be chosen.
    const accounts = (await get('/console/staff-accounts')).body.items as {
      id: string;
      merchantType: string | null;
    }[];
    expect(accounts.find((a) => a.id === canteen.id)?.merchantType).toBe('REGULAR');
    expect(accounts.find((a) => a.id === supplies.id)?.merchantType).toBe('VENDOR');
    const wrong = async (profileId: string, codes: string[]) => {
      const r = await setRoles(profileId, codes);
      expect(r.status, JSON.stringify(r.body)).toBe(409);
      return r.body;
    };
    expect(await wrong(canteen.id, ['VENDOR_MERCHANT'])).toMatchObject({
      code: 'IDN.ROLE_WRONG_PROFILE',
      detail: 'The Vendor merchant role can be given only to a vendor merchant.',
    });
    expect((await wrong(supplies.id, ['MERCHANT'])).code).toBe('IDN.ROLE_WRONG_PROFILE');
    expect((await wrong(canteen.id, ['ACCOUNTANT'])).code).toBe('IDN.ROLE_WRONG_PROFILE');
    expect((await wrong(principalId, ['MERCHANT'])).code).toBe('IDN.ROLE_WRONG_PROFILE');
    expect((await wrong(canteen.id, ['PRINCIPAL'])).code).toBe('IDN.ROLE_WRONG_PROFILE');
    for (const [id, code] of [
      [principalId, 'PRINCIPAL'],
      [canteen.id, 'MERCHANT'],
      [supplies.id, 'VENDOR_MERCHANT'],
    ] as const) {
      const r = await setRoles(id, [code]);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    }
    principalWeb = await onWeb(principalId);
    canteenWeb = await onWeb(canteen.id);
    suppliesWeb = await onWeb(supplies.id);
  });

  it('opens the principal’s desk on the web, and nothing else', async () => {
    const s = (await get('/console/session', principalWeb)).body;
    expect(s.subTasks).toEqual(
      expect.arrayContaining([
        'task.principal',
        'principal.view',
        'principal.leave',
        'principal.announce',
      ]),
    );
    expect(s.subTasks).not.toContain('home.view');
    const overview = await get('/principal/overview', principalWeb);
    expect(overview.status, JSON.stringify(overview.body)).toBe(200);
    expect(overview.body.principal.name).toContain('Kavitha');
    expect((await get('/principal/people?type=TEACHERS', principalWeb)).status).toBe(200);
    expect((await get('/principal/teacher-leaves', principalWeb)).status).toBe(200);
    expect((await get('/principal/attendance', principalWeb)).status).toBe(200);
    expect((await get('/principal/academics', principalWeb)).status).toBe(200);
    expect((await get('/principal/announcements', principalWeb)).status).toBe(200);
    expect((await get('/me/announcement-options', principalWeb)).status).toBe(200);
    // The principal's own pages, as a teacher's.
    expect((await get('/me/staff-leaves', principalWeb)).status).toBe(200);
    expect((await get('/me/notifications', principalWeb)).status).toBe(200);
    // Not the console's pages, nor a merchant's counter, nor a teacher's classes.
    expect((await get('/console/members', principalWeb)).status).toBe(403);
    expect((await get('/merchant/home', principalWeb)).status).toBe(403);
    expect((await get('/teacher/today', principalWeb)).status).toBe(403);
  });

  it('opens a merchant’s counter on the web: home, a dynamic QR request, collections, settlements and the wallet', async () => {
    const s = (await get('/console/session', canteenWeb)).body;
    expect(s.subTasks).toEqual(
      expect.arrayContaining(['task.business', 'business.view', 'business.collect']),
    );
    expect(s.subTasks).not.toContain('business.assets');
    const home = await get('/merchant/home', canteenWeb);
    expect(home.status, JSON.stringify(home.body)).toBe(200);
    expect(home.body.merchant).toMatchObject({ displayName: 'Campus Canteen' });
    // Dynamic QR on, then a request for ₹45 from the web, and its status.
    const d = await get(`/console/merchants/${canteen.id}`);
    await request(f.app)
      .put(`/api/v1/console/merchants/${canteen.id}/channels`)
      .set(con)
      .set('If-Match', `"v${d.body.version}"`)
      .send({ dynamicQr: true, nfc: false });
    const req = await post(
      '/merchant/payment-requests',
      { kind: 'DYNAMIC_QR', amount: inr('45.00') },
      canteenWeb,
    );
    expect(req.status, JSON.stringify(req.body)).toBe(201);
    expect(req.body.svg).toMatch(/^<svg/);
    const st = await get(`/merchant/payment-requests/${req.body.requestId}`, canteenWeb);
    expect(st.body).toMatchObject({ status: 'PENDING', amount: inr('45.00') });
    const cancel = await post(
      `/merchant/payment-requests/${req.body.requestId}/cancellation`,
      {},
      canteenWeb,
    );
    expect(cancel.status, JSON.stringify(cancel.body)).toBe(200);
    expect((await get('/merchant/qr-codes', canteenWeb)).body.items.length).toBe(1);
    expect((await get('/merchant/collections', canteenWeb)).status).toBe(200);
    expect((await get('/merchant/settlements', canteenWeb)).status).toBe(200);
    expect((await get('/me/wallets', canteenWeb)).status).toBe(200);
    expect((await get('/me/notifications', canteenWeb)).status).toBe(200);
    // A regular merchant has no vendor assets on the web; nor the principal's desk, nor messages.
    expect((await get('/merchant/assets', canteenWeb)).status).toBe(403);
    expect((await get('/principal/overview', canteenWeb)).status).toBe(403);
    expect((await get('/me/conversations', canteenWeb)).status).toBe(403);
  });

  it('opens a vendor merchant’s counter with its approved assets', async () => {
    const s = (await get('/console/session', suppliesWeb)).body;
    expect(s.subTasks).toEqual(expect.arrayContaining(['task.business', 'business.assets']));
    expect((await get('/merchant/home', suppliesWeb)).body.merchant).toMatchObject({
      displayName: 'Lab Supplies Co',
      subType: 'VENDOR',
    });
    const assets = await get('/merchant/assets', suppliesWeb);
    expect(assets.status, JSON.stringify(assets.body)).toBe(200);
    expect(assets.body.items).toEqual([]);
    // The administrator's console session holds no counter grant.
    expect((await get('/merchant/home', { ...con, 'X-RingPe-Surface': 'console' })).status).toBe(
      403,
    );
  });
});
