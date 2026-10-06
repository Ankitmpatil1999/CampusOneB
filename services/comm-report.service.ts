/**
 * The communication report (SRS 23.18.1, CR-16, RNG-COM-172…186; COM-007/008) and the log's retention
 * purge (18.6; job `comm-log-purge`).
 *
 * - Every message sent for the signed-in institution, whatever raised it and whatever carried it, from
 *   the communication log only: announcements, direct messages, in-app notifications, one-time codes
 *   and transactional messages (RNG-COM-172/173). It reads; it never sends (RNG-COM-184).
 * - Each row: time, kind, channel, who raised it (a person, or the business event), the recipient,
 *   the subject or first line, the outcome and the reason (RNG-COM-174). Never a direct message's body
 *   or first line (RNG-COM-178) and never a code (RNG-COM-179).
 * - Filters (date range, kind, channel, raiser, recipient, outcome) apply to the totals as well as the
 *   rows; totals by kind, channel and outcome, distinct recipients and the failed share are over the
 *   whole filtered set (RNG-COM-175/176). Newest first, paged.
 * - It says from which date the record is complete — the day every path began logging, or the
 *   retention cut-off when the purge is on — and how many log writes failed (RNG-COM-183/185).
 * - The purge deletes rows past retention (30 days sent or skipped, 90 failed: settings) only once
 *   switched on (`com.log.purge.enabled`): retention waits for the client (Q15, OQ-30, OI-COM-47).
 */
import { sql, type Kysely, type SelectQueryBuilder } from 'kysely';
import { LIMITS, type LimitDefinition } from '../config/registers';
import type {
  CommChannel,
  CommKind,
  CommLogTable,
  CommOutcome,
  Database,
} from '../models/ringpe_models';
import type { JobContext } from '../schedulers';
import { ValidationError } from '../utils/CustomAPIError';
import { istBusinessDate } from '../utils/format';
import { isUuid, uuidToBin } from '../utils/idGenerator';
import type { Principal } from '../utils/principal';
import { institutionOf } from './academic-year';
import type { SettingsService } from './settings.service';

export const COMM_KINDS = [
  'ANNOUNCEMENT',
  'DIRECT_MESSAGE',
  'NOTIFICATION',
  'OTP',
  'TRANSACTIONAL',
] as const;
export const COMM_CHANNELS = ['IN_APP', 'SMS', 'EMAIL', 'WHATSAPP', 'PUSH'] as const;
export const COMM_OUTCOMES = ['SUCCESS', 'SKIPPED', 'FAILED'] as const;

export interface CommReportFilters {
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly kind?: CommKind | undefined;
  readonly channel?: CommChannel | undefined;
  readonly outcome?: CommOutcome | undefined;
  /** `system`, or the account id of the person who raised it. */
  readonly raiser?: string | undefined;
  /** The recipient member's profile id. */
  readonly recipient?: string | undefined;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const PAGE = 50;
/** The version from which every dispatch path writes the log (CR-16, RNG-COM-181). */
const COMPLETE_SINCE_MIGRATION = '0060';
const nameOf = (first: string | null | undefined, last: string | null | undefined) =>
  [first, last].filter(Boolean).join(' ');
/** A DATE column as YYYY-MM-DD (the pool reads dates in UTC). */
const ymdOf = (d: Date | string) =>
  typeof d === 'string' ? d.slice(0, 10) : new Date(d).toISOString().slice(0, 10);
const addDays = (ymd: string, n: number) =>
  new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const cursor = {
  encode: (id: string) => Buffer.from(`l:${id}`, 'utf8').toString('base64url'),
  decode(c: string | undefined) {
    if (!c) return undefined;
    const m = /^l:(\d{1,20})$/.exec(Buffer.from(c, 'base64url').toString('utf8'));
    if (!m?.[1]) throw new ValidationError([{ field: 'cursor', code: 'VALIDATION.FORMAT' }]);
    return m[1];
  },
};

export interface CommReportRow {
  readonly id: string;
  readonly at: string;
  readonly kind: CommKind;
  readonly channel: CommChannel;
  readonly raisedBy: { readonly name: string | null; readonly event: string | null };
  readonly recipient: { readonly name: string | null; readonly address: string | null };
  readonly subject: string | null;
  readonly outcome: CommOutcome;
  readonly reason: string | null;
}

export class CommReportService {
  constructor(
    private readonly deps: {
      readonly db: Kysely<Database>;
      readonly settings?: SettingsService;
      readonly now?: () => Date;
    },
  ) {}

  private now() {
    return this.deps.now?.() ?? new Date();
  }

  private async limit(l: LimitDefinition<number>) {
    return this.deps.settings ? this.deps.settings.get(l) : l.value;
  }

  /** The date range in force (IST days; default the last 30 days), checked. */
  private range(f: CommReportFilters) {
    const today = istBusinessDate(this.now());
    const to = f.to ?? today;
    const from = f.from ?? addDays(to, -29);
    const errors = [];
    if (!DAY.test(from)) errors.push({ field: 'from', code: 'VALIDATION.DATE' });
    if (!DAY.test(to)) errors.push({ field: 'to', code: 'VALIDATION.DATE' });
    if (!errors.length && from > to) errors.push({ field: 'to', code: 'COM.REPORT_RANGE' });
    if (errors.length) throw new ValidationError(errors);
    return { from, to };
  }

  /** The filtered log of one institution (the session's, never the caller's: RNG-COM-177). */
  private async filtered(institutionId: string, f: CommReportFilters) {
    const db = this.deps.db;
    const { from, to } = this.range(f);
    let recipientRow: string | null = null;
    if (f.recipient) {
      const m = isUuid(f.recipient)
        ? await db
            .selectFrom('member_profiles')
            .select('id')
            .where('public_id', '=', uuidToBin(f.recipient))
            .where('institution_id', '=', institutionId)
            .executeTakeFirst()
        : undefined;
      if (!m) throw new ValidationError([{ field: 'recipient', code: 'VALIDATION.FORMAT' }]);
      recipientRow = String(m.id);
    }
    if (f.raiser && f.raiser !== 'system' && !isUuid(f.raiser)) {
      throw new ValidationError([{ field: 'raiser', code: 'VALIDATION.FORMAT' }]);
    }
    let q = db
      .selectFrom('comm_log as l')
      .where('l.institution_id', '=', institutionId)
      .where('l.logged_on', '>=', from)
      .where('l.logged_on', '<=', to);
    if (f.kind) q = q.where('l.kind', '=', f.kind);
    if (f.channel) q = q.where('l.channel', '=', f.channel);
    if (f.outcome) q = q.where('l.outcome', '=', f.outcome);
    if (f.raiser === 'system') q = q.where('l.raiser', 'is', null);
    else if (f.raiser) q = q.where('l.raiser', '=', uuidToBin(f.raiser));
    if (recipientRow) q = q.where('l.recipient_profile_id', '=', recipientRow);
    return { q, from, to };
  }

  /** Rows of a filtered page with names, never bodies (RNG-COM-174/178/179). */
  private rows(q: SelectQueryBuilder<Database & { l: CommLogTable }, 'l', object>) {
    return q
      .leftJoin('member_profiles as mp', 'mp.id', 'l.recipient_profile_id')
      .leftJoin('platform_accounts as ra', 'ra.id', 'l.recipient_account_id')
      .leftJoin('platform_accounts as rs', 'rs.public_id', 'l.raiser')
      .select([
        'l.id',
        'l.at',
        'l.kind',
        'l.channel',
        'l.recipient_masked',
        'l.outcome',
        'l.reason',
        'l.subject',
        'l.ref_type',
        'mp.first_name as mp_first',
        'mp.last_name as mp_last',
        'ra.first_name as ra_first',
        'ra.last_name as ra_last',
        'rs.first_name as rs_first',
        'rs.last_name as rs_last',
      ]);
  }

  private view(r: {
    id: string;
    at: Date;
    kind: CommKind;
    channel: CommChannel;
    recipient_masked: string | null;
    outcome: CommOutcome;
    reason: string | null;
    subject: string | null;
    ref_type: string | null;
    mp_first: string | null;
    mp_last: string | null;
    ra_first: string | null;
    ra_last: string | null;
    rs_first: string | null;
    rs_last: string | null;
  }): CommReportRow {
    const raiser = nameOf(r.rs_first, r.rs_last);
    return {
      id: String(r.id),
      at: new Date(r.at).toISOString(),
      kind: r.kind,
      channel: r.channel,
      raisedBy: raiser ? { name: raiser, event: null } : { name: null, event: r.ref_type },
      recipient: {
        name: nameOf(r.mp_first, r.mp_last) || nameOf(r.ra_first, r.ra_last) || null,
        address: r.recipient_masked,
      },
      subject: r.kind === 'DIRECT_MESSAGE' ? null : r.subject,
      outcome: r.outcome,
      reason: r.reason,
    };
  }

  /** From which date the record is complete (RNG-COM-185) and the retention in force. */
  private async coverage(institutionId: string, from: string, to: string) {
    const db = this.deps.db;
    const since = await db
      .selectFrom('schema_migrations')
      .select('applied_at')
      .where('version', 'like', `${COMPLETE_SINCE_MIGRATION}%`)
      .executeTakeFirst();
    const [purge, successDays, failedDays] = await Promise.all([
      this.limit(LIMITS.commLogPurgeEnabled),
      this.limit(LIMITS.commLogSuccessRetentionDays),
      this.limit(LIMITS.commLogFailedRetentionDays),
    ]);
    const today = istBusinessDate(this.now());
    let completeFrom = since ? istBusinessDate(new Date(since.applied_at)) : today;
    if (purge && successDays > 0) {
      const cut = addDays(today, -(successDays - 1));
      if (cut > completeFrom) completeFrom = cut;
    }
    const gaps = await db
      .selectFrom('comm_log_gaps')
      .select(sql<number>`COALESCE(SUM(failures), 0)`.as('n'))
      .where('institution_id', '=', institutionId)
      .where('day', '>=', from)
      .where('day', '<=', to)
      .executeTakeFirst();
    return {
      completeFrom,
      retention: { purging: Boolean(purge), successDays, failedDays },
      unrecorded: Number(gaps?.n ?? 0),
    };
  }

  /** COM-007: rows newest first with totals over the whole filtered set. */
  async report(p: Principal, f: CommReportFilters & { cursor?: string; limit?: number }) {
    const inst = await institutionOf(this.deps.db, p);
    const { q, from, to } = await this.filtered(inst.id, f);
    const limit = Math.min(Math.max(f.limit ?? PAGE, 1), 200);
    const before = cursor.decode(f.cursor);
    // The page's ids first (newest first, read backwards along the key), then only those rows with
    // names: joining before the limit made MySQL sort the whole month (load test, Phase 9.2).
    const ids = (
      await (before ? q.where('l.id', '<', before) : q)
        .select('l.id')
        .orderBy('l.id', 'desc')
        .limit(limit + 1)
        .execute()
    ).map((r) => String(r.id));
    const page = ids.length
      ? await this.rows(
          this.deps.db
            .selectFrom('comm_log as l')
            .where('l.id', 'in', ids)
            .where('l.logged_on', '>=', from)
            .where('l.logged_on', '<=', to),
        )
          .orderBy('l.id', 'desc')
          .execute()
      : [];
    const [groups, totals] = await Promise.all([
      this.groupTotals(inst.id, f, from, to, q),
      q
        .select(
          sql<number>`COUNT(DISTINCT COALESCE(CONCAT('p', l.recipient_profile_id), CONCAT('a', l.recipient_account_id), l.recipient_masked))`.as(
            'recipients',
          ),
        )
        .executeTakeFirst(),
    ]);
    const byKind: Record<string, number> = {};
    const byChannel: Record<string, number> = {};
    const byOutcome: Record<string, number> = {};
    let total = 0;
    for (const g of groups) {
      const n = Number(g.n);
      byKind[g.kind] = (byKind[g.kind] ?? 0) + n;
      byChannel[g.channel] = (byChannel[g.channel] ?? 0) + n;
      byOutcome[g.outcome] = (byOutcome[g.outcome] ?? 0) + n;
      total += n;
    }
    const shown = page.slice(0, limit);
    const last = shown.at(-1);
    return {
      period: { from, to },
      ...(await this.coverage(inst.id, from, to)),
      totals: {
        attempts: total,
        byKind,
        byChannel,
        byOutcome,
        recipients: Number(totals?.recipients ?? 0),
        failedShare: total ? Math.round(((byOutcome['FAILED'] ?? 0) / total) * 10_000) / 10_000 : 0,
      },
      items: shown.map((r) => this.view(r)),
      nextCursor: page.length > limit && last ? cursor.encode(String(last.id)) : null,
    };
  }

  /**
   * Attempts by kind, channel and outcome over the filtered set. A finished day's totals are counted
   * once and kept (migration 0064; the load test found a month of log cost half a second per read);
   * today, and any filter by raiser or recipient, is counted live.
   */
  private async groupTotals(
    institutionId: string,
    f: CommReportFilters,
    from: string,
    to: string,
    q: SelectQueryBuilder<Database & { l: CommLogTable }, 'l', object>,
  ) {
    const live = (query: typeof q) =>
      query
        .select(['l.kind', 'l.channel', 'l.outcome', sql<number>`COUNT(*)`.as('n')])
        .groupBy(['l.kind', 'l.channel', 'l.outcome'])
        .execute();
    if (f.raiser || f.recipient) return live(q);
    const db = this.deps.db;
    const today = istBusinessDate(this.now());
    const lastDone = to < today ? to : addDays(today, -1);
    if (from <= lastDone) {
      // Count the finished days not counted yet (each once; a quiet day is marked too).
      const done = new Set(
        (
          await db
            .selectFrom('comm_log_daily_done')
            .select('day')
            .where('institution_id', '=', institutionId)
            .where('day', '>=', from)
            .where('day', '<=', lastDone)
            .execute()
        ).map((d) => ymdOf(d.day)),
      );
      const missing: string[] = [];
      for (let d = from; d <= lastDone; d = addDays(d, 1)) if (!done.has(d)) missing.push(d);
      if (missing.length) {
        const counted = await db
          .selectFrom('comm_log')
          .select(['logged_on', 'kind', 'channel', 'outcome', sql<number>`COUNT(*)`.as('n')])
          .where('institution_id', '=', institutionId)
          .where('logged_on', 'in', missing)
          .groupBy(['logged_on', 'kind', 'channel', 'outcome'])
          .execute();
        await db.transaction().execute(async (trx) => {
          if (counted.length) {
            await trx
              .insertInto('comm_log_daily')
              .ignore()
              .values(
                counted.map((c) => ({
                  institution_id: institutionId,
                  day: ymdOf(c.logged_on),
                  kind: c.kind,
                  channel: c.channel,
                  outcome: c.outcome,
                  n: Number(c.n),
                })),
              )
              .execute();
          }
          await trx
            .insertInto('comm_log_daily_done')
            .ignore()
            .values(missing.map((day) => ({ institution_id: institutionId, day })))
            .execute();
        });
      }
    }
    let kept = db
      .selectFrom('comm_log_daily')
      .select(['kind', 'channel', 'outcome', sql<number>`SUM(n)`.as('n')])
      .where('institution_id', '=', institutionId)
      .where('day', '>=', from)
      .where('day', '<=', lastDone);
    if (f.kind) kept = kept.where('kind', '=', f.kind);
    if (f.channel) kept = kept.where('channel', '=', f.channel);
    if (f.outcome) kept = kept.where('outcome', '=', f.outcome);
    const [past, now] = await Promise.all([
      from <= lastDone ? kept.groupBy(['kind', 'channel', 'outcome']).execute() : [],
      to >= today ? live(q.where('l.logged_on', '>', lastDone)) : [],
    ]);
    return [...past, ...now];
  }

  /** The rows of an export: exactly the filtered set and the report's columns (RNG-COM-180). */
  async *exportRows(institutionId: string, f: CommReportFilters, max: number) {
    const { q } = await this.filtered(institutionId, f);
    let before: string | undefined;
    let n = 0;
    while (n < max) {
      const batch = await this.rows(before ? q.where('l.id', '<', before) : q)
        .orderBy('l.id', 'desc')
        .limit(Math.min(1000, max - n))
        .execute();
      if (!batch.length) return;
      for (const r of batch) yield this.view(r);
      n += batch.length;
      before = String(batch.at(-1)!.id);
    }
  }

  /** The tenant check before an export's body is read. */
  async institutionFor(p: Principal) {
    return (await institutionOf(this.deps.db, p)).id;
  }

  /** The job `comm-log-purge`: rows past retention, once the purge is switched on (Q15). */
  async purge(ctx: Pick<JobContext, 'item'>) {
    const [on, successDays, failedDays] = await Promise.all([
      this.limit(LIMITS.commLogPurgeEnabled),
      this.limit(LIMITS.commLogSuccessRetentionDays),
      this.limit(LIMITS.commLogFailedRetentionDays),
    ]);
    if (!on) {
      ctx.item({
        institutionId: null,
        status: 'SKIPPED',
        processed: 0,
        failed: 0,
        note: 'The purge is switched off until retention is decided (Q15)',
      });
      return;
    }
    const today = istBusinessDate(this.now());
    const purgeBefore = async (days: number, outcomes: CommOutcome[]) => {
      if (days <= 0) return 0; // zero keeps them for ever
      const cut = addDays(today, -(days - 1));
      let deleted = 0;
      for (;;) {
        // A purged day's kept totals go with its rows (migration 0064).
        await this.deps.db
          .deleteFrom('comm_log_daily')
          .where('day', '<', cut)
          .where('outcome', 'in', outcomes)
          .execute();
        const r = await this.deps.db
          .deleteFrom('comm_log')
          .where('logged_on', '<', cut)
          .where('outcome', 'in', outcomes)
          .limit(5000)
          .executeTakeFirst();
        const n = Number(r.numDeletedRows);
        deleted += n;
        if (n < 5000) return deleted;
      }
    };
    const sent = await purgeBefore(successDays, ['SUCCESS', 'SKIPPED']);
    const failed = await purgeBefore(failedDays, ['FAILED']);
    ctx.item({
      institutionId: null,
      status: 'SUCCESS',
      processed: sent + failed,
      failed: 0,
      note: `${sent} sent or skipped and ${failed} failed rows past retention deleted`,
    });
  }
}

export const commReportHeader = [
  'Time',
  'Kind',
  'Channel',
  'Raised by',
  'Recipient',
  'Address',
  'Subject',
  'Outcome',
  'Reason',
] as const;

export const commReportCsvRow = (r: CommReportRow) => [
  r.at,
  r.kind,
  r.channel,
  r.raisedBy.name ?? `System (${r.raisedBy.event ?? 'event'})`,
  r.recipient.name ?? '',
  r.recipient.address ?? '',
  r.kind === 'DIRECT_MESSAGE' ? 'Private message' : (r.subject ?? ''),
  r.outcome,
  r.reason ?? '',
];
