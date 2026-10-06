/**
 * A member session starts on the member's profile (IDN-001…007, IDN-013/014, PAY-001) on a real
 * MySQL: the profile the school created is linked at sign-up, and the tokens of sign-up and sign-in
 * carry the profile IDN-013 shows as active — so the app can pay straight after signing in, without
 * a profile switch first.
 */
import { randomUUID } from 'node:crypto';
import { decodeJwt } from 'jose';
import request from 'supertest';
import { adminUrl } from './db';
import { mobile, PASSWORD, PIN, schoolFixture } from './school';

describe.skipIf(!adminUrl)('member sessions start on the active profile (real MySQL)', () => {
  let f: Awaited<ReturnType<typeof schoolFixture>>;

  beforeAll(async () => {
    f = await schoolFixture('Session School');
  }, 180_000);
  afterAll(async () => {
    await f?.t.drop();
  });

  it('signs up and in with the school’s profile in the token, and pays without a switch', async () => {
    const mob = mobile();
    const created = await request(f.app)
      .post('/api/v1/console/members')
      .set(f.school.con)
      .set('Idempotency-Key', randomUUID())
      .send({ userTypeId: f.teacherTypeId, firstName: 'Nisha', mobile: mob });
    expect(created.status).toBe(201);
    const profileId = created.body.id as string;

    const tokens = await f.signUp(mob, 'Nisha');
    expect(decodeJwt(tokens.access)).toMatchObject({ prf: profileId, ins: f.school.id });
    const bearer = { Authorization: `Bearer ${tokens.access}` };
    const me = await request(f.app).get('/api/v1/me').set(bearer);
    expect(me.body.activeProfileId).toBe(profileId);

    // Straight to paying: PIN, then a merchant's code resolves and is paid.
    expect(
      (await request(f.app).post('/api/v1/me/tpin').set(bearer).send({ pin: PIN })).status,
    ).toBe(201);
    const m = await f.merchant('Session Canteen');
    const row = await f.profileRow(profileId);
    await f.credit(await f.walletOf(String(row.id), 'CAMPUS'), 10_000);
    const resolved = await request(f.app)
      .post('/api/v1/me/payments/resolve')
      .set(bearer)
      .send({ qrPayload: m.qr.payload });
    expect(resolved.status).toBe(200);
    const paid = await request(f.app)
      .post('/api/v1/me/payments')
      .set(bearer)
      .set('Idempotency-Key', randomUUID())
      .send({ qrPayload: m.qr.payload, amount: { amount: '25.00', currency: 'INR' }, pin: PIN });
    expect(paid.status).toBe(201);

    // Signing in again on the same device starts on the same profile.
    const again = await request(f.app)
      .post('/api/v1/auth/member/signin')
      .send({ mobile: mob, password: PASSWORD, device: { installId: tokens.installId } });
    expect(again.status).toBe(200);
    expect(decodeJwt(again.body.accessToken)).toMatchObject({ prf: profileId, ins: f.school.id });
  });

  it('starts a parent on their own profile, not on a child under the account (CR-04)', async () => {
    const mob = mobile();
    const tokens = await f.signUp(mob, 'Mahesh');
    // The child has no phone: it sits on the parent's account, and was created before the parent.
    const childId = await f.ward('Aarav', mob);
    const again = await request(f.app)
      .post('/api/v1/auth/member/signin')
      .send({ mobile: mob, password: PASSWORD, device: { installId: tokens.installId } });
    expect(again.status).toBe(200);
    const bearer = { Authorization: `Bearer ${again.body.accessToken as string}` };
    const me = await request(f.app).get('/api/v1/me').set(bearer);
    const ids = (me.body.profiles as { id: string }[]).map((p) => p.id);
    expect(ids).toContain(childId);
    const parentId = ids.find((id) => id !== childId);
    expect(me.body.activeProfileId).toBe(parentId);
    expect(decodeJwt(again.body.accessToken)['prf']).toBe(parentId);
  });

  it('starts a member without a school profile on no profile', async () => {
    const tokens = await f.signUp(mobile(), 'Ravi');
    expect(decodeJwt(tokens.access)['prf']).toBeUndefined();
    const me = await request(f.app)
      .get('/api/v1/me')
      .set({ Authorization: `Bearer ${tokens.access}` });
    expect(me.body.activeProfileId).toBeNull();
  });
});
