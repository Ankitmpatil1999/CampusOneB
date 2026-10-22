/**
 * The apps' phone tokens for pushes (client 2026-10-19: "even though the mobile is lock also i should
 * notify"; migration 0076). The member app (COM-034) and the staff app (COM-035) register the token
 * Firebase gave the phone for their signed-in session. Only an active session's token is pushed to,
 * so signing out, a sign-in elsewhere or the session's expiry ends the pushes; a token another
 * session held (the phone signed in as someone else) moves to the new session.
 */
import { createHash } from 'node:crypto';
import type { Kysely, Transaction } from 'kysely';
import type { Database } from '../models/ringpe_models';
import { NotFoundError } from '../utils/CustomAPIError';
import { binToUuid, isUuid, uuidToBin } from '../utils/idGenerator';
import type { Principal } from '../utils/principal';
import type { PushTokenRequest } from '../schemas/push.schema';

type Db = Kysely<Database> | Transaction<Database>;

export const tokenHash = (token: string) => createHash('sha256').update(token, 'utf8').digest();

/**
 * The Firebase tokens of these accounts' signed-in sessions on the surface (not ended, not
 * expired): the member app's, or the staff app's for the console.
 */
export async function activeTokens(
  db: Db,
  accountIds: readonly string[],
  surface: 'MEMBER' | 'CONSOLE',
  at: Date,
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

export class PushTokensService {
  constructor(private readonly deps: { readonly db: Kysely<Database>; now?: () => Date }) {}

  private now() {
    return this.deps.now?.() ?? new Date();
  }

  /** COM-034 (member app) and COM-035 (staff app): the phone's token for this signed-in session. */
  async register(p: Principal, input: PushTokenRequest) {
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
        .where('session_id', '!=', String(session.id))
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
