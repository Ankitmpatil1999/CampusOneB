/**
 * Phone pushes for in-app notices (client 2026-10-19: "even though the mobile is lock also i should
 * notify"; migrations 0079, 0084). The member app (COM-034) and the staff app (COM-037, its console
 * session) register their Firebase token for the signed-in session; `notify` queues a push for every
 * notified account with such a session on the notice's surface, in the notice's own transaction,
 * when the platform's push channel is on (INT-010) and the school lets the notice's event raise the
 * phone alert (COM-032/033) — the same notices the app's own alert shows. PushRelay
 * (push-relay.service.ts) sends them after the commit.
 */
import { createHash } from 'node:crypto';
import type { Kysely, Transaction } from 'kysely';
import type { CommEventKey } from '../config/registers';
import type { Database } from '../models/ringpe_models';
import { NotFoundError } from '../utils/CustomAPIError';
import { binToUuid, isUuid, uuidToBin } from '../utils/idGenerator';
import type { Principal } from '../utils/principal';
import { eventSwitches } from './comm-events.service';

type Db = Kysely<Database> | Transaction<Database>;

const on = (v: unknown) => v === true || Number(v) === 1;

export const tokenHash = (token: string) => createHash('sha256').update(token, 'utf8').digest();

/** Whether the platform's push channel is on (back office, INT-010). */
export async function pushChannelOn(db: Db) {
  const r = await db
    .selectFrom('messaging_channels')
    .select('enabled')
    .where('channel', '=', 'PUSH')
    .executeTakeFirst();
  return on(r?.enabled);
}

/** The surfaces whose notices are pushed: the member app's, and the staff app's console. */
export type PushSurface = 'MEMBER' | 'CONSOLE';

/**
 * The Firebase tokens of these accounts' signed-in sessions on the surface (not ended, not
 * expired): the member app's, or the staff app's for the console (the web console has no phone).
 */
export async function activeTokens(
  db: Db,
  accountIds: readonly string[],
  at: Date,
  surface: PushSurface = 'MEMBER',
) {
  if (!accountIds.length) return [];
  let q = db
    .selectFrom('session_push_tokens as t')
    .innerJoin('sessions as s', 's.id', 't.session_id')
    .select(['t.session_id', 't.account_id', 't.token', 't.lang_code'])
    .where('t.account_id', 'in', [...accountIds])
    .where('s.surface', '=', surface)
    .where('s.ended_at', 'is', null)
    .where('s.absolute_expires_at', '>', at);
  if (surface === 'CONSOLE') q = q.where('s.staff_app', '=', 1);
  return q.execute();
}

export interface PushQueueInput {
  readonly institutionId: string | null;
  readonly accountIds: readonly string[];
  readonly surface: PushSurface;
  /** The in-app notices' public ids, one per account in the same order. */
  readonly refs: readonly Buffer[];
  readonly eventKey: CommEventKey | null;
  readonly titleKey: string;
  readonly params: Readonly<Record<string, string | number>>;
  readonly body: string;
  readonly link: string | null;
}

/** Queues the pushes for a notice (called by `notify` in its transaction). */
export async function queuePushes(db: Db, n: PushQueueInput, at: Date) {
  if (!n.accountIds.length || !(await pushChannelOn(db))) return;
  if (n.institutionId && n.eventKey) {
    const sw = (await eventSwitches(db, n.institutionId)).get(n.eventKey);
    if (sw && !sw.alert) return;
  }
  const withPhone = new Set(
    (await activeTokens(db, n.accountIds, at, n.surface)).map((t) => String(t.account_id)),
  );
  const rows = n.accountIds.flatMap((accountId, i) =>
    withPhone.has(accountId)
      ? [
          {
            institution_id: n.institutionId,
            account_id: accountId,
            surface: n.surface,
            event_key: n.eventKey,
            notification_ref: n.refs[i]!,
            title_key: n.titleKey,
            params: JSON.stringify(n.params),
            body: n.body.slice(0, 300),
            link: n.link ? n.link.slice(0, 600) : null,
            next_attempt_at: at,
            created_at: at,
          },
        ]
      : [],
  );
  if (rows.length) await db.insertInto('push_outbox').values(rows).execute();
}

export interface PushTokenInput {
  readonly token: string;
  readonly platform: 'ANDROID' | 'IOS';
  readonly language: string;
}

export class PushTokensService {
  constructor(private readonly deps: { db: Kysely<Database>; now?: () => Date }) {}

  private now() {
    return this.deps.now?.() ?? new Date();
  }

  /**
   * COM-034 (member app) and COM-037 (staff app): the phone's token for this signed-in session. A
   * token another account's session held (the phone signed in as someone else) moves here, so
   * pushes reach only who is signed in on the phone now. The same person's member and staff
   * sessions on one phone (client 2026-10-27: one sign-in, both modes) both keep it, each for its own
   * surface's notices (migration 0091).
   */
  async register(p: Principal, input: PushTokenInput) {
    if (!isUuid(p.sessionId) || !isUuid(p.subject)) throw new NotFoundError();
    if (p.surface !== 'member' && p.surface !== 'console') throw new NotFoundError();
    const at = this.now();
    let q = this.deps.db
      .selectFrom('sessions as s')
      .innerJoin('platform_accounts as a', 'a.id', 's.account_id')
      .select(['s.id', 's.account_id', 'a.public_id'])
      .where('s.public_id', '=', uuidToBin(p.sessionId))
      .where('s.surface', '=', p.surface === 'member' ? 'MEMBER' : 'CONSOLE')
      .where('s.ended_at', 'is', null)
      .where('s.absolute_expires_at', '>', at);
    // On the console, only the staff app's session has a phone (the web's has none).
    if (p.surface === 'console') q = q.where('s.staff_app', '=', 1);
    const session = await q.executeTakeFirst();
    if (!session || binToUuid(session.public_id).toLowerCase() !== p.subject.toLowerCase()) {
      throw new NotFoundError();
    }
    const hash = tokenHash(input.token);
    await this.deps.db.transaction().execute(async (trx) => {
      await trx
        .deleteFrom('session_push_tokens')
        .where('token_hash', '=', hash)
        .where('account_id', '!=', String(session.account_id))
        .execute();
      await trx
        .insertInto('session_push_tokens')
        .values({
          session_id: String(session.id),
          account_id: String(session.account_id),
          token: input.token,
          token_hash: hash,
          platform: input.platform,
          lang_code: input.language,
          updated_at: at,
        })
        .onDuplicateKeyUpdate({
          token: input.token,
          token_hash: hash,
          platform: input.platform,
          lang_code: input.language,
          updated_at: at,
        })
        .execute();
    });
  }
}
