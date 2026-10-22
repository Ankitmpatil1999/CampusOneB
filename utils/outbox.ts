/**
 * Realtime events through the transactional outbox (docs/03 §9.1; COM-025). Call `emit` inside the
 * business transaction: the event is sent only if that transaction commits. Rooms are built here from
 * internal ids, never from anything a client sends (OI-INT-05).
 */
import type { Kysely, Transaction } from 'kysely';
import type { Database } from '../models/ringpe_models';
import { NIL_UUID_BIN, isUuid, newPublicIdPair, uuidToBin } from './idGenerator';
import { getContext } from './request-context';

type Db = Kysely<Database> | Transaction<Database>;

export type RealtimeEvent =
  | 'notification.created'
  | 'payment.completed'
  | 'payment.request.updated'
  | 'wallet.credited'
  | 'approval.created'
  | 'coupon.redeemed'
  | 'pos.order.updated'
  | 'ticket.updated'
  | 'attendance.updated'
  | 'trip.updated'
  | 'message.created'
  | 'message.read';

export type Surface = 'member' | 'console' | 'ops' | 'portal';

/** Server-side room names. */
export const rooms = {
  account: (accountId: string, surface: Surface) => `acc:${accountId}:${surface}`,
  profile: (profileId: string) => `prf:${profileId}`,
  institutionConsole: (institutionId: string) => `inst:${institutionId}:console`,
  ops: () => 'ops',
} as const;

export async function emit(
  db: Db,
  e: {
    readonly institutionId: string | null;
    readonly type: RealtimeEvent;
    readonly rooms: readonly string[];
    /** Identifiers only; clients re-read with their own authorisation. */
    readonly data: Readonly<Record<string, string | number | null>>;
  },
) {
  const to = [...new Set(e.rooms)];
  if (!to.length) return;
  const correlation = getContext()?.correlationId;
  await db
    .insertInto('outbox_events')
    .values({
      event_id: newPublicIdPair().bin,
      institution_id: e.institutionId,
      aggregate_type: 'realtime',
      event_type: e.type,
      rooms: JSON.stringify(to),
      payload: JSON.stringify(e.data),
      correlation_id: isUuid(correlation ?? '') ? uuidToBin(correlation!) : NIL_UUID_BIN,
    })
    .execute();
}

/**
 * A push to accounts' devices on a surface (client 2026-10-19), sent by the push relay only if the
 * business transaction commits. The accounts are internal ids; the payload never leaves the server
 * except as the notification's title and body.
 */
export async function enqueuePush(
  db: Db,
  p: {
    readonly institutionId: string | null;
    readonly accountIds: readonly string[];
    readonly surface: 'MEMBER' | 'CONSOLE';
    /** The title's message key and parameters: the relay words it in each phone's language. */
    readonly titleKey: string;
    readonly params: Readonly<Record<string, string | number>>;
    readonly body: string;
    readonly link: string | null;
    readonly category: string;
  },
) {
  const accounts = [...new Set(p.accountIds)];
  if (!accounts.length) return;
  const correlation = getContext()?.correlationId;
  await db
    .insertInto('outbox_events')
    .values({
      event_id: newPublicIdPair().bin,
      institution_id: p.institutionId,
      aggregate_type: 'push',
      event_type: 'notification',
      rooms: null,
      payload: JSON.stringify({
        accounts,
        surface: p.surface,
        titleKey: p.titleKey,
        params: p.params,
        body: p.body.slice(0, 300),
        link: p.link,
        category: p.category,
      }),
      correlation_id: isUuid(correlation ?? '') ? uuidToBin(correlation!) : NIL_UUID_BIN,
    })
    .execute();
}
