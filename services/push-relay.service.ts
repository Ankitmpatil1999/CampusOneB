/**
 * Sends the pushed notices (client 2026-10-19; migrations 0079, 0084 push_outbox), as the e-mail relay:
 *
 * - The rows are claimed with SKIP LOCKED and leased for five minutes, so several API instances never
 *   send one twice.
 * - Each goes to every signed-in session's phone of the account on the notice's surface — the member
 *   app's, or the staff app's for a console notice (one session per account normally) — its title in
 *   that app's language (the translations, else English), the notice's own line, and that surface's
 *   unread count for the icon badge.
 * - A phone whose token Firebase no longer knows (the app was removed) loses it.
 * - A sent row is deleted; a failed one is tried again 1, 5, 15 and 60 minutes later and kept as
 *   FAILED after MAX_ATTEMPTS (deleted 90 days later). Tokens of ended sessions are deleted then too.
 * - Every outcome is in the communication log (CR-16), never the token.
 */
import { sql, type Kysely } from 'kysely';
import { renderMessage, type MessageKey } from '../config/registers';
import type { Loggers } from '../controllers/logger';
import type { PushSender } from '../integrations/push.provider';
import type { Database } from '../models/campusone_models';
import { notificationsRepository } from '../repositories/notifications.repository';
import { binToUuid } from '../utils/idGenerator';
import { translate } from '../utils/translate';
import { logCommSafely, type CommLogRow } from './comm-log.service';
import { activeTokens } from './push.service';

const BACKOFF_MINUTES = [1, 5, 15, 60];
const MAX_ATTEMPTS = 5;
const LEASE_MS = 5 * 60_000;
const KEEP_FAILED_DAYS = 90;

const parse = (v: unknown): Record<string, string | number> => {
  if (v === null || v === undefined) return {};
  try {
    const o = typeof v === 'string' ? (JSON.parse(v) as unknown) : v;
    return o && typeof o === 'object' ? (o as Record<string, string | number>) : {};
  } catch {
    return {};
  }
};

export class PushRelay {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly deps: {
      db: Kysely<Database>;
      /** null: no push provider configured (PUSH_PROVIDER=off). */
      push: PushSender | null;
      loggers: Loggers;
      now?: () => Date;
    },
  ) {}

  private now() {
    return this.deps.now?.() ?? new Date();
  }

  private async claim(limit: number) {
    const at = this.now();
    return this.deps.db.transaction().execute(async (trx) => {
      const rows = await trx
        .selectFrom('push_outbox')
        .selectAll()
        .where('status', '=', 'PENDING')
        .where('next_attempt_at', '<=', at)
        .orderBy('id')
        .limit(limit)
        .forUpdate()
        .skipLocked()
        .execute();
      if (rows.length) {
        await trx
          .updateTable('push_outbox')
          .set({ next_attempt_at: new Date(at.getTime() + LEASE_MS) })
          .where(
            'id',
            'in',
            rows.map((r) => r.id),
          )
          .execute();
      }
      return rows;
    });
  }

  /** The notice's title in an app language: its translation, else the English. */
  private async titleIn(
    cache: Map<string, string>,
    lang: string,
    key: string,
    params: Record<string, string | number>,
  ) {
    const english = () => renderMessageSafe(key, params);
    if (lang === 'en') return english();
    const k = `${lang}\u0000${key}`;
    let template = cache.get(k);
    if (template === undefined) {
      const r = await this.deps.db
        .selectFrom('translations')
        .select('text')
        .where('lang_code', '=', lang)
        .where('msg_key', '=', key)
        .executeTakeFirst();
      template = r?.text ?? '';
      cache.set(k, template);
    }
    return template ? translate(key, params, { [key]: template }) : english();
  }

  /** Sends what is due; returns what happened (tests and the run log). */
  async runOnce(limit = 25) {
    const out = { sent: 0, failed: 0, retried: 0, skipped: 0 };
    const rows = await this.claim(limit);
    if (!rows.length) return out;
    const titles = new Map<string, string>();
    for (const r of rows) {
      const at = this.now();
      const params = parse(r.params);
      const ref = binToUuid(r.notification_ref);
      const log = (row: Omit<CommLogRow, 'institutionId' | 'kind' | 'channel'>) =>
        logCommSafely(
          this.deps.db,
          [
            {
              institutionId: r.institution_id === null ? null : String(r.institution_id),
              kind: 'NOTIFICATION',
              channel: 'PUSH',
              recipientAccountId: String(r.account_id),
              refType: `notification.${(r.event_key ?? 'notice').toLowerCase()}`.slice(0, 30),
              refId: ref,
              subject: renderMessageSafe(r.title_key, params),
              ...row,
            },
          ],
          at,
        );
      const done = async () => {
        await this.deps.db.deleteFrom('push_outbox').where('id', '=', r.id).execute();
      };
      if (!this.deps.push) {
        await done();
        await log({ outcome: 'SKIPPED', reason: 'Push is not configured' });
        out.skipped++;
        continue;
      }
      // The member app's phones for a member notice; the staff app's for a console one.
      const tokens = await activeTokens(this.deps.db, [String(r.account_id)], at, r.surface);
      if (!tokens.length) {
        await done();
        await log({ outcome: 'SKIPPED', reason: 'No signed-in phone' });
        out.skipped++;
        continue;
      }
      const badge = await notificationsRepository.unread(
        this.deps.db,
        String(r.account_id),
        r.surface,
        null,
      );
      let sent = 0;
      let gone = 0;
      let error: string | null = null;
      for (const t of tokens) {
        try {
          const result = await this.deps.push.send({
            token: t.token,
            title: (await this.titleIn(titles, t.lang_code, r.title_key, params)).slice(0, 200),
            body: r.body,
            notificationId: ref,
            link: r.link,
            badge,
          });
          if (result === 'SENT') sent++;
          else {
            gone++;
            await this.deps.db
              .deleteFrom('session_push_tokens')
              .where('session_id', '=', String(t.session_id))
              .execute();
          }
        } catch (e) {
          error = (e instanceof Error ? e.message : String(e)).slice(0, 300);
        }
      }
      if (sent > 0) {
        await done();
        await log({ outcome: 'SUCCESS', recipient: 'Phone' });
        out.sent++;
      } else if (error === null) {
        await done();
        await log({ outcome: 'SKIPPED', reason: 'The phone is no longer registered' });
        out.skipped++;
      } else {
        const attempts = r.attempts + 1;
        if (attempts >= MAX_ATTEMPTS) {
          await this.deps.db
            .updateTable('push_outbox')
            .set({ status: 'FAILED', attempts, last_error: error, next_attempt_at: at })
            .where('id', '=', r.id)
            .execute();
          await log({ outcome: 'FAILED', recipient: 'Phone', reason: error.slice(0, 200) });
          out.failed++;
        } else {
          const wait = BACKOFF_MINUTES[Math.min(attempts - 1, BACKOFF_MINUTES.length - 1)]!;
          await this.deps.db
            .updateTable('push_outbox')
            .set({
              attempts,
              last_error: error,
              next_attempt_at: new Date(at.getTime() + wait * 60_000),
            })
            .where('id', '=', r.id)
            .execute();
          out.retried++;
        }
        this.deps.loggers.app.warn('push.notice_failed', { attempts, error, gone });
      }
    }
    return out;
  }

  /** Deletes pushes that failed long ago and the tokens of sessions that have ended. */
  async purge() {
    const at = this.now();
    const before = new Date(at.getTime() - KEEP_FAILED_DAYS * 86_400_000);
    await this.deps.db
      .deleteFrom('push_outbox')
      .where('status', '=', 'FAILED')
      .where('next_attempt_at', '<', before)
      .execute();
    await this.deps.db
      .deleteFrom('session_push_tokens')
      .where((eb) =>
        eb(
          'session_id',
          'in',
          eb
            .selectFrom('sessions')
            .select('id')
            .where((s) =>
              s.or([s('ended_at', 'is not', null), s('absolute_expires_at', '<=', at)]),
            ),
        ),
      )
      .execute();
  }

  /** Starts sending every few seconds (the API process; stopped at shutdown). */
  start(intervalMs = 3000) {
    if (this.timer) return;
    let ticks = 0;
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = true;
      const purge = ticks++ % 1200 === 0; // about once an hour
      (async () => {
        await this.runOnce();
        if (purge) await this.purge();
      })()
        .catch((e: unknown) =>
          this.deps.loggers.app.error('push.relay_failed', { error: String(e) }),
        )
        .finally(() => {
          this.running = false;
        });
    }, intervalMs);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

function renderMessageSafe(key: string, params: Record<string, string | number>) {
  try {
    return renderMessage(key as MessageKey, params);
  } catch {
    return translate(key, params);
  }
}

/** For tests: how many pushes wait (or failed) for an account. */
export async function pushOutboxCount(db: Kysely<Database>, accountId?: string) {
  let q = db.selectFrom('push_outbox').select(sql<number>`COUNT(*)`.as('n'));
  if (accountId) q = q.where('account_id', '=', accountId);
  return Number((await q.executeTakeFirstOrThrow()).n);
}
