/**
 * The realtime channel (COM-025; docs/05 §1.9): socket.io on `/realtime`, authenticated on the
 * upgrade with the same access token as the REST API — a Bearer token in the handshake
 * (`auth.token`, the apps) or the surface's session cookie (`auth.surface`, the web).
 *
 * - Rooms are derived from the verified session only (OI-INT-05): the account on its surface, the
 *   active profile (members), the institution's console (staff), the back office (operators).
 * - Events carry identifiers only; the client re-reads with its own authorisation.
 * - The outbox relay runs here, where the sockets are: it sends every committed event (written by the
 *   API or the worker) to its rooms, marks it dispatched, and purges dispatched rows after 7 days.
 *   With several API instances, a Redis adapter would fan out across them (not needed on one server).
 */
import type { Server as HttpServer } from 'node:http';
import type { Server as HttpsServer } from 'node:https';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import { Server } from 'socket.io';
import type { Loggers } from '../controllers/logger';
import type { Database } from '../models/campusone_models';
import { cookieNames, COOKIE_SURFACES, type CookieSurface } from '../utils/cookies';
import { isUuid, uuidToBin } from '../utils/idGenerator';
import { rooms } from '../utils/outbox';
import type { Principal } from '../utils/principal';
import type { SessionRevocations } from '../utils/session-revocations';
import type { TokenVerifier } from '../utils/token-verifier';

export const REALTIME_PATH = '/realtime';

const cookieValue = (header: string | undefined, name: string) => {
  for (const part of (header ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
};

export interface RealtimeHandle {
  readonly io: Server;
  /** Runs the relay once (tests); returns how many events were sent. */
  relayOnce(): Promise<number>;
  close(): Promise<void>;
}

export function startRealtime(deps: {
  readonly server: HttpServer | HttpsServer;
  readonly db: Kysely<Database>;
  readonly verifier: TokenVerifier;
  readonly revocations?: SessionRevocations | undefined;
  readonly loggers: Loggers;
  readonly corsOrigins: readonly string[];
  /** Relay poll interval when idle (ms); 0 = no timer (tests call relayOnce). */
  readonly pollMs?: number;
}): RealtimeHandle {
  const io = new Server(deps.server, {
    path: REALTIME_PATH,
    serveClient: false,
    cors: { origin: [...deps.corsOrigins], credentials: true },
  });

  io.use(async (socket, next) => {
    try {
      const auth = (socket.handshake.auth ?? {}) as { token?: unknown; surface?: unknown };
      let token = typeof auth.token === 'string' ? auth.token : undefined;
      let cookieSurface: CookieSurface | undefined;
      if (!token && typeof auth.surface === 'string') {
        const s = auth.surface as CookieSurface;
        if ((COOKIE_SURFACES as readonly string[]).includes(s)) {
          cookieSurface = s;
          token = cookieValue(socket.handshake.headers.cookie, cookieNames(s).access);
        }
      }
      if (!token) throw new Error('missing_token');
      const p: Principal = await deps.verifier.verify(token);
      if (cookieSurface && p.surface !== cookieSurface) throw new Error('surface_mismatch');
      if (deps.revocations && (await deps.revocations.isRevoked(p.sessionId))) {
        throw new Error('session_ended');
      }
      socket.data['principal'] = p;
      next();
    } catch (e) {
      deps.loggers.security.warn('realtime.refused', {
        reason: e instanceof Error ? e.message : 'error',
        ip: socket.handshake.address,
      });
      next(new Error('unauthorized'));
    }
  });

  io.on('connection', async (socket) => {
    const p = socket.data['principal'] as Principal;
    try {
      const joined: string[] = [];
      const account = isUuid(p.subject)
        ? await deps.db
            .selectFrom('platform_accounts')
            .select('id')
            .where('public_id', '=', uuidToBin(p.subject))
            .executeTakeFirst()
        : undefined;
      if (account && p.surface !== 'partner' && p.surface !== 'terminal') {
        joined.push(rooms.account(String(account.id), p.surface));
      }
      if (p.surface === 'member' && p.profileId && isUuid(p.profileId)) {
        const prof = await deps.db
          .selectFrom('member_profiles')
          .select(['id', 'account_id'])
          .where('public_id', '=', uuidToBin(p.profileId))
          .executeTakeFirst();
        if (prof && account && String(prof.account_id) === String(account.id)) {
          joined.push(rooms.profile(String(prof.id)));
        }
      }
      if (p.surface === 'console' && p.institutionId && isUuid(p.institutionId)) {
        const inst = await deps.db
          .selectFrom('institutions')
          .select('id')
          .where('public_id', '=', uuidToBin(p.institutionId))
          .executeTakeFirst();
        if (inst) joined.push(rooms.institutionConsole(String(inst.id)));
      }
      if (p.surface === 'ops') joined.push(rooms.ops());
      await socket.join(joined);
      socket.emit('ready', { rooms: joined.length });
    } catch (e) {
      deps.loggers.app.error('realtime.join_failed', { error: e instanceof Error ? e.message : e });
      socket.disconnect(true);
    }
  });

  let purgedAt = 0;
  const relayOnce = async (): Promise<number> => {
    const sent = await deps.db.transaction().execute(async (trx) => {
      const rows = await trx
        .selectFrom('outbox_events')
        .select(['id', 'event_type', 'rooms', 'payload'])
        .where('aggregate_type', '=', 'realtime')
        .where('status', '=', 'PENDING')
        .where('available_at', '<=', sql<Date>`UTC_TIMESTAMP(3)`)
        .orderBy('id')
        .limit(200)
        .forUpdate()
        .skipLocked()
        .execute();
      for (const r of rows) {
        const to = (typeof r.rooms === 'string' ? JSON.parse(r.rooms) : r.rooms) as string[];
        const data = typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload;
        if (to.length) io.to(to).emit(r.event_type, data);
      }
      if (rows.length) {
        await trx
          .updateTable('outbox_events')
          .set({ status: 'DISPATCHED', dispatched_at: sql<Date>`UTC_TIMESTAMP(3)` })
          .where(
            'id',
            'in',
            rows.map((r) => r.id),
          )
          .execute();
      }
      return rows.length;
    });
    if (Date.now() - purgedAt > 3_600_000) {
      purgedAt = Date.now();
      await deps.db
        .deleteFrom('outbox_events')
        .where('aggregate_type', '=', 'realtime')
        .where('status', '=', 'DISPATCHED')
        .where('dispatched_at', '<', sql<Date>`UTC_TIMESTAMP(3) - INTERVAL 7 DAY`)
        .execute();
    }
    return sent;
  };

  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  const poll = deps.pollMs ?? 1000;
  if (poll > 0) {
    const tick = async () => {
      if (stopped) return;
      let sent = 0;
      try {
        sent = await relayOnce();
      } catch (e) {
        deps.loggers.app.warn('realtime.relay_failed', {
          error: e instanceof Error ? e.message : String(e),
        });
      }
      if (!stopped) timer = setTimeout(() => void tick(), sent ? 50 : poll);
    };
    timer = setTimeout(() => void tick(), poll);
  }

  return {
    io,
    relayOnce,
    async close() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await new Promise<void>((resolve) => {
        void io.close(() => resolve());
      });
    },
  };
}
