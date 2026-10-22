/**
 * The push relay (client 2026-10-19): every committed notification is pushed to its accounts'
 * phones — the member app's devices for a member notification, the staff app's for a console one.
 * It reads the outbox's `push` rows (written by `notify`), leases a batch (so a slow gateway never
 * holds a lock), sends outside the transaction, and marks each row dispatched. A failed send is
 * tried again later, with a growing wait, until it is given up (DEAD). Each phone gets the title in
 * its app's language. Tokens Firebase no longer knows, and those of ended sessions, are forgotten.
 */
import { sql, type Kysely } from 'kysely';
import { renderMessage, type MessageKey } from '../config/registers';
import type { Loggers } from '../controllers/logger';
import type { PushSender } from '../integrations/push.provider';
import type { Database } from '../models/ringpe_models';
import { translate } from '../utils/translate';
import { activeTokens, tokenHash } from './push-tokens.service';

const BATCH = 50;
const MAX_ATTEMPTS = 5;
/** The lease on a claimed row: another relay leaves it alone until then. */
const LEASE_SECONDS = 120;

interface PushPayload {
  readonly accounts: readonly string[];
  readonly surface: 'MEMBER' | 'CONSOLE';
  readonly titleKey: string;
  readonly params?: Readonly<Record<string, string | number>>;
  readonly body: string;
  readonly link: string | null;
  readonly category: string;
}

const english = (key: string, params: Readonly<Record<string, string | number>>) => {
  try {
    return renderMessage(key as MessageKey, params);
  } catch {
    return translate(key, params);
  }
};

export function pushRelay(deps: {
  readonly db: Kysely<Database>;
  readonly sender: PushSender;
  readonly loggers: Loggers;
}) {
  const { db, sender, loggers } = deps;

  /** The title in an app language: its translation (back office, IDN-073/074), else the English. */
  const titleIn = async (
    cache: Map<string, string>,
    lang: string,
    key: string,
    params: Readonly<Record<string, string | number>>,
  ) => {
    if (lang === 'en') return english(key, params);
    const k = `${lang}\u0000${key}`;
    let template = cache.get(k);
    if (template === undefined) {
      const r = await db
        .selectFrom('translations')
        .select('text')
        .where('lang_code', '=', lang)
        .where('msg_key', '=', key)
        .executeTakeFirst();
      template = r?.text ?? '';
      cache.set(k, template);
    }
    return template ? translate(key, params, { [key]: template }) : english(key, params);
  };

  /** One pass: the pushes due now. Returns how many rows were handled. */
  const relayOnce = async (): Promise<number> => {
    const rows = await db.transaction().execute(async (trx) => {
      const due = await trx
        .selectFrom('outbox_events')
        .select(['id', 'payload', 'attempts'])
        .where('aggregate_type', '=', 'push')
        .where('status', '=', 'PENDING')
        .where('available_at', '<=', sql<Date>`UTC_TIMESTAMP(3)`)
        .orderBy('id')
        .limit(BATCH)
        .forUpdate()
        .skipLocked()
        .execute();
      if (due.length) {
        await trx
          .updateTable('outbox_events')
          .set({
            attempts: sql<number>`attempts + 1`,
            available_at: sql<Date>`UTC_TIMESTAMP(3) + INTERVAL ${LEASE_SECONDS} SECOND`,
          })
          .where(
            'id',
            'in',
            due.map((r) => r.id),
          )
          .execute();
      }
      return due;
    });
    const titles = new Map<string, string>();
    for (const r of rows) {
      const p = (typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload) as PushPayload;
      try {
        // Only signed-in sessions' phones: signing out or a sign-in elsewhere ends the pushes.
        const tokens = await activeTokens(db, p.accounts, p.surface, new Date());
        const byLang = new Map<string, string[]>();
        for (const t of tokens) byLang.set(t.lang_code, [...(byLang.get(t.lang_code) ?? []), t.token]);
        for (const [lang, list] of byLang) {
          const out = await sender.send({
            tokens: list,
            title: (await titleIn(titles, lang, p.titleKey, p.params ?? {})).slice(0, 200),
            body: p.body,
            data: { category: p.category, ...(p.link ? { link: p.link } : {}) },
          });
          // A phone whose token Firebase no longer knows (the app was removed) loses it.
          if (out.invalid.length) {
            await db
              .deleteFrom('session_push_tokens')
              .where('token_hash', 'in', out.invalid.map(tokenHash))
              .execute();
          }
        }
        await db
          .updateTable('outbox_events')
          .set({ status: 'DISPATCHED', dispatched_at: sql<Date>`UTC_TIMESTAMP(3)` })
          .where('id', '=', r.id)
          .execute();
      } catch (e) {
        const attempts = Number(r.attempts) + 1;
        const message = (e instanceof Error ? e.message : String(e)).slice(0, 500);
        loggers.app.warn('push.relay_failed', { attempts, error: message });
        await db
          .updateTable('outbox_events')
          .set({
            last_error: message,
            ...(attempts >= MAX_ATTEMPTS
              ? { status: 'DEAD' as const }
              : {
                  // 1, 2, 4, 8 minutes.
                  available_at: sql<Date>`UTC_TIMESTAMP(3) + INTERVAL ${60 * 2 ** (attempts - 1)} SECOND`,
                }),
          })
          .where('id', '=', r.id)
          .execute();
      }
    }
    return rows.length;
  };

  /** Dispatched pushes are kept a week; the tokens of ended sessions are forgotten. */
  const purge = async () => {
    await db
      .deleteFrom('outbox_events')
      .where('aggregate_type', '=', 'push')
      .where('status', '=', 'DISPATCHED')
      .where('dispatched_at', '<', sql<Date>`UTC_TIMESTAMP(3) - INTERVAL 7 DAY`)
      .execute();
    await db
      .deleteFrom('session_push_tokens')
      .where((eb) =>
        eb(
          'session_id',
          'in',
          eb
            .selectFrom('sessions')
            .select('id')
            .where((s) =>
              s.or([
                s('ended_at', 'is not', null),
                s('absolute_expires_at', '<', sql<Date>`UTC_TIMESTAMP(3)`),
              ]),
            ),
        ),
      )
      .execute();
  };

  return { relayOnce, purge };
}

/** The relay on a timer (the API server, beside the realtime relay). */
export function startPushRelay(deps: Parameters<typeof pushRelay>[0] & { pollMs?: number }) {
  const relay = pushRelay(deps);
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let purgedAt = 0;
  const poll = deps.pollMs ?? 2000;
  const tick = async () => {
    if (stopped) return;
    try {
      const n = await relay.relayOnce();
      if (Date.now() - purgedAt > 3_600_000) {
        purgedAt = Date.now();
        await relay.purge();
      }
      timer = setTimeout(() => void tick(), n ? 0 : poll);
    } catch (e) {
      deps.loggers.app.error('push.relay_error', { error: e instanceof Error ? e.message : e });
      timer = setTimeout(() => void tick(), poll * 5);
    }
  };
  if (poll > 0) timer = setTimeout(() => void tick(), poll);
  return {
    ...relay,
    close() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
