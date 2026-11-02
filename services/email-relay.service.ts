/**
 * Sends the e-mailed notices (client 2026-10-16; migration 0078 email_outbox). `notify` writes a row
 * in the business transaction; the API process sends it after the commit, a few at a time:
 *
 * - The rows are claimed with SKIP LOCKED and leased for five minutes, so several API instances never
 *   send one twice.
 * - The address was chosen with the notice (comm-events emailRecipients): the student and parents as
 *   people, one e-mail per address.
 * - The school is the sender's name and its office e-mail the reply-to address.
 * - A sent row is deleted; a failed one is tried again 1, 5, 15 and 60 minutes later and kept as
 *   FAILED after `com.email.maxAttempts` with the address masked (deleted 90 days later).
 * - Every outcome is in the communication log (CR-16), the address masked and no content.
 */
import { sql, type Kysely } from 'kysely';
import { LIMITS } from '../config/registers';
import type { Loggers } from '../controllers/logger';
import type { MessageSender } from '../integrations/sms.provider';
import type { Database } from '../models/campusone_models';
import { binToUuid } from '../utils/idGenerator';
import { logCommSafely, maskEmail, type CommLogRow } from './comm-log.service';
import { brandFields, schoolBrand, type LogoFiles, type SchoolBrand } from './school-brand';
import { defaultValues, type SettingValues } from './settings.service';

const BACKOFF_MINUTES = [1, 5, 15, 60];
const LEASE_MS = 5 * 60_000;
const KEEP_FAILED_DAYS = 90;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class EmailRelay {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly deps: {
      db: Kysely<Database>;
      email: MessageSender;
      loggers: Loggers;
      /** The school's logo for its notices (client 2026-10-26). */
      files?: LogoFiles;
      settings?: { values(): Promise<SettingValues> };
      now?: () => Date;
    },
  ) {}

  private now() {
    return this.deps.now?.() ?? new Date();
  }

  private async maxAttempts() {
    const v = this.deps.settings ? await this.deps.settings.values() : defaultValues();
    return Number(v[LIMITS.emailMaxAttempts.key] ?? LIMITS.emailMaxAttempts.value);
  }

  /** Claims the rows due now (leased, so another instance skips them). */
  private async claim(limit: number) {
    const at = this.now();
    return this.deps.db.transaction().execute(async (trx) => {
      const rows = await trx
        .selectFrom('email_outbox')
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
          .updateTable('email_outbox')
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

  /** Sends what is due; returns what happened (tests and the run log). */
  async runOnce(limit = 25) {
    const out = { sent: 0, failed: 0, retried: 0, skipped: 0 };
    const rows = await this.claim(limit);
    if (!rows.length) return out;
    const max = await this.maxAttempts();
    const schools = new Map<string, SchoolBrand | null>();
    for (const r of rows) {
      const at = this.now();
      const log = (row: Omit<CommLogRow, 'institutionId' | 'kind' | 'channel'>) =>
        logCommSafely(
          this.deps.db,
          [
            {
              institutionId: r.institution_id === null ? null : String(r.institution_id),
              kind: 'NOTIFICATION',
              channel: 'EMAIL',
              recipientAccountId: r.account_id === null ? null : String(r.account_id),
              recipientProfileId: r.profile_id === null ? null : String(r.profile_id),
              refType: `notification.${r.event_key.toLowerCase()}`.slice(0, 30),
              refId: r.notification_ref ? binToUuid(r.notification_ref) : null,
              subject: r.subject,
              ...row,
            },
          ],
          at,
        );
      const to = r.to_email;
      if (!EMAIL.test(to)) {
        await this.deps.db.deleteFrom('email_outbox').where('id', '=', r.id).execute();
        await log({ outcome: 'SKIPPED', reason: 'No e-mail address' });
        out.skipped++;
        continue;
      }
      const school =
        r.institution_id === null ? null : await this.school(schools, r.institution_id);
      try {
        await this.deps.email.send({
          to,
          purpose: `notification.${r.event_key.toLowerCase()}`,
          subject: r.subject,
          text: `${r.body}\n\nOpen the CampusOne app to see more.`,
          ...brandFields(school),
          log: false,
        });
        await this.deps.db.deleteFrom('email_outbox').where('id', '=', r.id).execute();
        await log({ outcome: 'SUCCESS', recipient: maskEmail(to) });
        out.sent++;
      } catch (e) {
        const reason = (e instanceof Error ? e.message : String(e)).slice(0, 300);
        const attempts = r.attempts + 1;
        if (attempts >= max) {
          await this.deps.db
            .updateTable('email_outbox')
            .set({
              status: 'FAILED',
              attempts,
              last_error: reason,
              next_attempt_at: at,
              to_email: maskEmail(to) ?? '',
            })
            .where('id', '=', r.id)
            .execute();
          await log({ outcome: 'FAILED', recipient: maskEmail(to), reason: reason.slice(0, 200) });
          out.failed++;
        } else {
          const wait = BACKOFF_MINUTES[Math.min(attempts - 1, BACKOFF_MINUTES.length - 1)]!;
          await this.deps.db
            .updateTable('email_outbox')
            .set({
              attempts,
              last_error: reason,
              next_attempt_at: new Date(at.getTime() + wait * 60_000),
            })
            .where('id', '=', r.id)
            .execute();
          out.retried++;
        }
        this.deps.loggers.app.warn('email.notice_failed', { attempts, error: reason });
      }
    }
    return out;
  }

  /** The school's name, office address and logo, once per run. */
  private async school(cache: Map<string, SchoolBrand | null>, institutionId: string | number) {
    const k = String(institutionId);
    if (!cache.has(k)) cache.set(k, await schoolBrand(this.deps.db, this.deps.files, k));
    return cache.get(k) ?? null;
  }

  /** Deletes notices that failed long ago (they are in the communication log). */
  async purge() {
    const before = new Date(this.now().getTime() - KEEP_FAILED_DAYS * 86_400_000);
    await this.deps.db
      .deleteFrom('email_outbox')
      .where('status', '=', 'FAILED')
      .where('next_attempt_at', '<', before)
      .execute();
  }

  /** Starts sending every few seconds (the API process; stopped at shutdown). */
  start(intervalMs = 5000) {
    if (this.timer) return;
    let ticks = 0;
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = true;
      const purge = ticks++ % 720 === 0; // about once an hour
      (async () => {
        await this.runOnce();
        if (purge) await this.purge();
      })()
        .catch((e: unknown) =>
          this.deps.loggers.app.error('email.relay_failed', { error: String(e) }),
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

/** For tests: how many notices wait (or failed) for an account. */
export async function outboxCount(db: Kysely<Database>, accountId?: string) {
  let q = db.selectFrom('email_outbox').select(sql<number>`COUNT(*)`.as('n'));
  if (accountId) q = q.where('account_id', '=', accountId);
  return Number((await q.executeTakeFirstOrThrow()).n);
}
