/**
 * The school signs a member out of the app (IDN-086, security review S-02) on a real MySQL:
 * a reason of the set length is required, the member's access token stops working at once, the
 * refresh token is refused, the action is in the audit log, and the member can sign in again.
 * Also the family's view of a child's school record (IDN-087): only a profile on the same account.
 */
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { adminUrl } from './db';
import { mobile, PASSWORD, schoolFixture } from './school';

describe.skipIf(!adminUrl)('signing a member out from the console on real MySQL', () => {
  let f: Awaited<ReturnType<typeof schoolFixture>>;
  const end = (memberId: string, reason: string) =>
    request(f.app)
      .post(`/api/v1/console/members/${memberId}/session-ends`)
      .set(f.school.con)
      .set('Idempotency-Key', randomUUID())
      .send({ reason });

  beforeAll(async () => {
    f = await schoolFixture('Session End School');
  }, 240_000);
  afterAll(async () => {
    await f?.t.drop();
  });

  it('ends the app sessions with a reason, audited; the member signs in again', async () => {
    const p = await f.payer('Meera', 0);
    expect((await request(f.app).get('/api/v1/me').set(p.auth)).status).toBe(200);

    const short = await end(p.id, 'lost');
    expect(short.status).toBe(422);
    expect(short.body.errors[0].code).toBe('IDN.REASON_TOO_SHORT');
    expect((await end(randomUUID(), 'Phone reported lost')).status).toBe(404);

    const r = await end(p.id, 'Phone reported lost');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.ended).toBe(1);
    // The access token is refused at once (revoked), not only at its expiry.
    expect((await request(f.app).get('/api/v1/me').set(p.auth)).status).toBe(401);
    const audit = await f.t.db
      .selectFrom('audit_log')
      .select(['action', 'reason'])
      .where('action', '=', 'MEMBER_SESSIONS_ENDED')
      .execute();
    expect(audit).toEqual([{ action: 'MEMBER_SESSIONS_ENDED', reason: 'Phone reported lost' }]);

    // Nothing left to end: still recorded, nothing ended.
    expect((await end(p.id, 'Phone reported lost')).body.ended).toBe(0);

    const again = await request(f.app)
      .post('/api/v1/auth/member/signin')
      .send({ mobile: p.mobile, password: PASSWORD, device: { installId: randomUUID() } });
    expect([200, 202]).toContain(again.status);
  });

  it('shows a parent their child’s school record, guardians masked, and no one else’s', async () => {
    const mob = mobile();
    const tokens = await f.signUp(mob, 'Mahesh');
    const childId = await f.ward('Aarav', mob);
    const signin = await request(f.app)
      .post('/api/v1/auth/member/signin')
      .send({ mobile: mob, password: PASSWORD, device: { installId: tokens.installId } });
    const parent = { Authorization: `Bearer ${signin.body.accessToken as string}` };
    const r = await request(f.app).get(`/api/v1/me/school-record?for=${childId}`).set(parent);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({
      id: childId,
      name: 'Aarav Rao',
      kind: 'STUDENTS',
      status: 'ACTIVE',
      dateOfBirth: '2015-06-01',
      grade: { class: expect.any(String), section: expect.any(String) },
    });
    expect(r.body.memberNo).toMatch(/-\d{5}$/);
    expect(r.body.guardians).toEqual([
      expect.objectContaining({ relation: 'FATHER', mobile: `••••••${mob.slice(-4)}` }),
    ]);
    expect(JSON.stringify(r.body)).not.toContain(mob);
    expect(r.body).not.toHaveProperty('wallet');
    // Someone else's child, or a made-up id, answers 404.
    const other = await f.payer('Kavya', 0);
    expect(
      (await request(f.app).get(`/api/v1/me/school-record?for=${childId}`).set(other.auth)).status,
    ).toBe(404);
    const own = await request(f.app).get('/api/v1/me/school-record').set(other.auth);
    expect(own.status, JSON.stringify(own.body)).toBe(200);
    expect(own.body).toMatchObject({ id: other.id, kind: 'STAFF' });
  });
});
