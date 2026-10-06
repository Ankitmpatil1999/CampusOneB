/**
 * The realtime channel on a real MySQL (COM-025; OI-INT-05): a socket needs a valid, live session;
 * rooms come from the session; an event written in a committed transaction reaches only its rooms.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomInt, randomUUID } from 'node:crypto';
import request from 'supertest';
import { io as connect, type Socket } from 'socket.io-client';
import { adminUrl, createTestDatabase, type TestDatabase } from './db';
import { buildHttpApp, codeOf } from './http-app';
import { notify } from '../../services/notifications.service';
import { startRealtime, type RealtimeHandle } from '../../services/realtime.service';
import { uuidToBin } from '../../utils/idGenerator';

const PASSWORD = 'Ringpe@2026';
let panSeq = randomInt(0, 5_000);

describe.skipIf(!adminUrl)('realtime channel on real MySQL', () => {
  let t: TestDatabase;
  let h: Awaited<ReturnType<typeof buildHttpApp>>;
  let server: Server;
  let rt: RealtimeHandle;
  let url = '';
  const sockets: Socket[] = [];

  /** A member signed up; returns the access token and the account's internal id. */
  async function member() {
    const mob = `9${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`;
    const start = await request(h.app)
      .post('/api/v1/auth/member/signup/otp')
      .send({ mobile: mob, consentVersion: '2026.10' });
    const verify = await request(h.app)
      .post('/api/v1/auth/member/signup/otp/verify')
      .send({ challengeId: start.body.challengeId, otp: codeOf(h.sms.sent.at(-1)) });
    const created = await request(h.app)
      .post('/api/v1/auth/member/signup')
      .set('Idempotency-Key', randomUUID())
      .send({
        signupToken: verify.body.signupToken,
        mobile: mob,
        consentVersion: '2026.10',
        termsVersion: '2026.10',
        termsAccepted: true,
        pan: `ABCDE${String(++panSeq % 10_000).padStart(4, '0')}F`,
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
    const acc = await t.db
      .selectFrom('platform_accounts')
      .select('id')
      .where('mobile', '=', mob)
      .executeTakeFirstOrThrow();
    return { token: created.body.accessToken as string, accountId: String(acc.id) };
  }

  const open = (auth: Record<string, unknown>) =>
    new Promise<{ socket: Socket; error?: string; rooms?: number }>((resolve) => {
      const socket = connect(url, {
        path: '/realtime',
        auth,
        transports: ['websocket'],
        reconnection: false,
      });
      sockets.push(socket);
      socket.on('ready', (r: { rooms: number }) => resolve({ socket, rooms: r.rooms }));
      socket.on('connect_error', (e) => resolve({ socket, error: e.message }));
    });
  const next = (socket: Socket, event: string, ms = 3000) =>
    new Promise<unknown>((resolve) => {
      const timer = setTimeout(() => resolve(null), ms);
      socket.once(event, (data: unknown) => {
        clearTimeout(timer);
        resolve(data);
      });
    });

  beforeAll(async () => {
    t = await createTestDatabase();
    h = await buildHttpApp(t);
    server = createServer(h.app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    rt = startRealtime({
      server,
      db: t.db,
      verifier: h.security.verifier,
      revocations: h.security.revocations,
      loggers: h.services.loggers,
      corsOrigins: [],
      pollMs: 0,
    });
  }, 120_000);
  afterAll(async () => {
    for (const s of sockets) s.disconnect();
    await rt?.close();
    await t?.drop();
  });

  it('refuses a socket without a valid, live session', async () => {
    expect((await open({})).error).toBe('unauthorized');
    expect((await open({ token: 'not-a-token' })).error).toBe('unauthorized');
    const m = await member();
    // A web session must match the surface it names.
    expect((await open({ surface: 'console' })).error).toBe('unauthorized');
    const sid = JSON.parse(Buffer.from(m.token.split('.')[1]!, 'base64url').toString())
      .sid as string;
    await h.security.revocations.revoke(sid, Math.floor(Date.now() / 1000) + 3600);
    expect((await open({ token: m.token })).error).toBe('unauthorized');
  });

  it('delivers a committed event to its rooms only (notification.created)', async () => {
    const a = await member();
    const b = await member();
    const sa = await open({ token: a.token });
    const sb = await open({ token: b.token });
    expect(sa.rooms).toBe(1);
    expect(sb.rooms).toBe(1);
    const gotA = next(sa.socket, 'notification.created');
    const gotB = next(sb.socket, 'notification.created', 1200);
    await t.db.transaction().execute((trx) =>
      notify(trx, {
        institutionId: null,
        accountIds: [a.accountId],
        surface: 'MEMBER',
        category: 'ACCOUNT',
        titleKey: 'NTF.CORRECTION_APPROVED',
        body: 'Test',
      }),
    );
    // A rolled-back transaction sends nothing.
    await t.db
      .transaction()
      .execute(async (trx) => {
        await notify(trx, {
          institutionId: null,
          accountIds: [b.accountId],
          surface: 'MEMBER',
          category: 'ACCOUNT',
          titleKey: 'NTF.CORRECTION_APPROVED',
          body: 'Rolled back',
        });
        throw new Error('rollback');
      })
      .catch(() => undefined);
    expect(await rt.relayOnce()).toBe(1);
    expect(await gotA).toEqual({ category: 'ACCOUNT' });
    expect(await gotB).toBeNull();
    const row = await t.db
      .selectFrom('outbox_events')
      .select(['status', 'dispatched_at'])
      .orderBy('id', 'desc')
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('DISPATCHED');
    expect(await rt.relayOnce()).toBe(0);
    void uuidToBin;
  });
});
