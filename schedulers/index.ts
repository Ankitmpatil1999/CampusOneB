/**
 * Scheduled jobs (brief §7.5, RNG-GOV-021/024/025). Each job states its schedule, time zone,
 * window, catch-up behaviour and what happens if it runs twice; the runner (./runner.ts) adds the
 * distributed lock, the run log (`job_runs`, `job_run_items`), failure alerts and manual runs.
 *
 * The first runner is the subscription billing run (Phase 2.7); the settlement run, roll-overs,
 * expiry and generation jobs arrive with their modules (Phases 3–8). What the back office shows for
 * every process is in ./catalogue.ts.
 */
import type { AllowancesService } from '../services/allowances.service';
import type { BankCreditsService } from '../services/bank-credits.service';
import type { CouponsService } from '../services/coupons.service';
import type { EventsService } from '../services/events.service';
import type { FeeRecordsService } from '../services/fee-records.service';
import type { PassesService } from '../services/passes.service';
import type { SettlementService } from '../services/settlement.service';
import type { AccountingService } from '../services/accounting.service';
import type { AttendanceAdminService } from '../services/attendance-admin.service';
import type { TripsService } from '../services/trips.service';
import type { AnnouncementsService } from '../services/announcements.service';
import type { CommReportService } from '../services/comm-report.service';
import type { JobItem, SubscriptionService } from '../services/subscription.service';

export type JobTrigger = 'SCHEDULE' | 'MANUAL' | 'CATCH_UP';

export interface JobContext {
  /** The period the run covers (the IST business date for daily jobs). */
  readonly periodKey: string;
  readonly trigger: JobTrigger;
  /** An institution's own run (GOV-007): the job touches only this institution (row id). */
  readonly scope?: { readonly institutionId: string } | undefined;
  /** Adds a line to the run log (one per institution and run; lines are merged). */
  item(i: JobItem): void;
}

export interface JobDefinition {
  /** Stable id, e.g. `settlement-run` (job_runs.job_id, the catalogue id). */
  readonly id: string;
  /** Cron expression (minute hour day-of-month month day-of-week) in `timeZone`. */
  readonly cron: string;
  readonly timeZone: 'Asia/Kolkata';
  /** How the period key is derived (business date, month…). */
  readonly window: string;
  readonly catchUp: string;
  readonly reRun: string;
  /** Moves money: run under period-derived idempotency keys and alert on any failure. */
  readonly money: boolean;
  /** Sub-task that may trigger a manual run. */
  readonly manualRunSubTask: string;
  /**
   * The console sub-task that may run the job for its own institution (GOV-007); only jobs that
   * honour `ctx.scope` name one.
   */
  readonly institutionRunSubTask?: string;
  readonly run: (ctx: JobContext) => Promise<void>;
}

/** The ids with a registered runner (the catalogue's "available"). */
export const RUNNABLE_JOB_IDS: readonly string[] = [
  'subscription-billing',
  'held-credit-release',
  'allowance-cycle',
  'coupon-expiry',
  'event-status',
  'tuition-autodebit',
  'settlement-run',
  'accounting-vouchers',
  'auto-absent',
  'trip-generation',
  'announcement-dispatch',
  'comm-log-purge',
];

/** The runners, built from the services they use. */
export function buildJobs(deps: {
  subscriptions: SubscriptionService;
  bankCredits?: BankCreditsService;
  allowances?: AllowancesService;
  coupons?: CouponsService;
  events?: EventsService;
  passes?: PassesService;
  feeRecords?: FeeRecordsService;
  settlement?: SettlementService;
  accounting?: AccountingService;
  attendance?: AttendanceAdminService;
  trips?: TripsService;
  announcements?: AnnouncementsService;
  commReport?: CommReportService;
}): JobDefinition[] {
  return [
    ...(deps.commReport
      ? [
          {
            id: 'comm-log-purge',
            cron: '0 2 * * *',
            timeZone: 'Asia/Kolkata' as const,
            window:
              'Rows past retention on the run date: sent or skipped after 30 days, failed after 90 (settings); nothing until the purge is switched on (Q15)',
            catchUp: 'A later run deletes whatever is past retention by then',
            reRun: 'Nothing is left to delete on a second run',
            money: false,
            manualRunSubTask: 'jobs.run',
            run: async (ctx: JobContext) => {
              await deps.commReport!.purge(ctx);
            },
          },
        ]
      : []),
    ...(deps.announcements
      ? [
          {
            id: 'announcement-dispatch',
            cron: '* * * * *',
            timeZone: 'Asia/Kolkata' as const,
            window:
              'Every minute: announcements whose send time has come, high importance first, and any left processing for 10 minutes',
            catchUp: 'Each run takes every due announcement, so a missed run is caught up',
            reRun:
              'An announcement is claimed once (QUEUED → PROCESSING); one message per account and channel',
            money: false,
            manualRunSubTask: 'jobs.run',
            institutionRunSubTask: 'comms.send',
            run: async (ctx: JobContext) => {
              await deps.announcements!.run(ctx);
            },
          },
        ]
      : []),
    ...(deps.trips
      ? [
          {
            id: 'trip-generation',
            cron: '10 0 * * *',
            timeZone: 'Asia/Kolkata' as const,
            window:
              'Today (IST): one trip per active vehicle assignment whose dates, session days, route and vehicle allow it; none on a holiday for everyone',
            catchUp:
              'A later run the same day creates any trip still missing; trips left Scheduled from earlier days are cancelled',
            reRun:
              'One trip per assignment and date (a unique key); a re-run creates nothing twice',
            money: false,
            manualRunSubTask: 'jobs.run',
            institutionRunSubTask: 'transport.edit',
            run: async (ctx: JobContext) => {
              await deps.trips!.run(ctx);
            },
          },
        ]
      : []),
    ...(deps.attendance
      ? [
          {
            id: 'auto-absent',
            cron: '*/15 * * * *',
            timeZone: 'Asia/Kolkata' as const,
            window:
              'Every 15 minutes: each institution that turned auto-absent on, once its cut-off has passed on a school day (OQ-14)',
            catchUp: 'A later run the same day marks the day if an earlier one was missed',
            reRun:
              'Once per institution and day (a unique run row); members already marked are never touched',
            money: false,
            manualRunSubTask: 'jobs.run',
            institutionRunSubTask: 'attendance.config',
            run: async (ctx: JobContext) => {
              await deps.attendance!.run(ctx);
            },
          },
        ]
      : []),
    ...(deps.accounting
      ? [
          {
            id: 'accounting-vouchers',
            cron: '*/15 * * * *',
            timeZone: 'Asia/Kolkata' as const,
            window:
              'Every 15 minutes: the mapped ledger postings since transfers were turned on, and every voucher due to be sent',
            catchUp: 'Each run takes every posting without a voucher, so a missed run is caught up',
            reRun:
              'One voucher per posting (unique key); a transferred voucher is never sent again',
            money: false,
            manualRunSubTask: 'jobs.run',
            institutionRunSubTask: 'vouchers.edit',
            run: async (ctx: JobContext) => {
              await deps.accounting!.run(ctx);
            },
          },
        ]
      : []),
    ...(deps.settlement
      ? [
          {
            id: 'settlement-run',
            cron: '30 23 * * *',
            timeZone: 'Asia/Kolkata' as const,
            window:
              "The IST business date: every successful credit to an active merchant's wallet up to 23:30 that no live settlement holds yet",
            catchUp:
              'The lines are the unsettled credits, not a fixed window, so the next run settles what a missed one left',
            reRun:
              'One live settlement per institution and date (unique key); a re-run finds it and changes nothing',
            money: true,
            manualRunSubTask: 'jobs.run',
            run: async (ctx: JobContext) => {
              await deps.settlement!.run(ctx);
            },
          },
        ]
      : []),
    ...(deps.feeRecords
      ? [
          {
            id: 'tuition-autodebit',
            cron: '0,30 8-19 * * *',
            timeZone: 'Asia/Kolkata' as const,
            window:
              'Every 30 minutes 08:00–20:00 IST: unpaid records past their due date become Overdue, then every pending collection is tried once',
            catchUp:
              'Each run takes every pending attempt, so a missed run is caught up by the next',
            reRun:
              'Each try is keyed by its attempt and try number (FEE-RETRY:<attempt>:<n>) and a paid record is refused at P3, so a re-run never pays twice',
            money: true,
            manualRunSubTask: 'jobs.run',
            institutionRunSubTask: 'fees.collect',
            run: async (ctx: JobContext) => {
              await deps.feeRecords!.retry(ctx, ctx.scope);
            },
          },
        ]
      : []),
    ...(deps.events && deps.passes
      ? [
          {
            id: 'event-status',
            cron: '50 23 * * *',
            timeZone: 'Asia/Kolkata' as const,
            window:
              'The IST business date: events whose end date has passed, and passes whose day has passed',
            catchUp: 'Each run takes every event and pass whose date has passed',
            reRun: 'Only Active events and live passes change, so a re-run finds nothing to change',
            money: false,
            manualRunSubTask: 'jobs.run',
            run: async (ctx: JobContext) => {
              await deps.events!.deactivateEnded(ctx);
              await deps.passes!.expire(ctx);
            },
          },
        ]
      : []),
    ...(deps.coupons
      ? [
          {
            id: 'coupon-expiry',
            cron: '0 0 * * *',
            timeZone: 'Asia/Kolkata' as const,
            window: 'The IST business date: every coupon still active whose date is before it',
            catchUp:
              'Each run takes every coupon whose date has passed, so a missed night is caught up',
            reRun: 'Only active coupons are expired, so a re-run finds nothing to change',
            money: false,
            manualRunSubTask: 'jobs.run',
            run: async (ctx: JobContext) => {
              await deps.coupons!.expire(ctx);
            },
          },
        ]
      : []),
    ...(deps.allowances
      ? [
          {
            id: 'allowance-cycle',
            cron: '5 0 * * *',
            timeZone: 'Asia/Kolkata' as const,
            window:
              'The IST business date: allowances expiring on or before it, then those starting on or before it',
            catchUp:
              'A missed day is caught up by the next run: every open grant whose date has passed is processed',
            reRun:
              'Each grant posts once (ALW-CREDIT:<grant> / ALW-EXPIRY:<grant>) and changes state under its row lock, so a re-run changes nothing',
            money: true,
            manualRunSubTask: 'jobs.run',
            run: async (ctx: JobContext) => {
              await deps.allowances!.runCycle(ctx);
            },
          },
        ]
      : []),
    ...(deps.bankCredits
      ? [
          {
            id: 'held-credit-release',
            cron: '*/15 * * * *',
            timeZone: 'Asia/Kolkata' as const,
            window: 'Every 15 minutes: credits held while a wallet was suspended or inactive',
            catchUp: 'Each run takes every held credit whose wallet is active again',
            reRun:
              'Each release posts once (HOLD-RELEASE:<credit> idempotency key) and moves the credit from Held to Credited, so a re-run changes nothing',
            money: true,
            manualRunSubTask: 'jobs.run',
            run: async (ctx: JobContext) => {
              await deps.bankCredits!.releaseHeld(ctx);
            },
          },
        ]
      : []),
    {
      id: 'subscription-billing',
      cron: '20 0 * * *',
      timeZone: 'Asia/Kolkata',
      window: 'The IST business date of the run',
      catchUp:
        'A missed day is caught up when the worker starts: earlier renewals roll over and missed invoices are issued',
      reRun:
        'Guarded by the renewal date, one invoice per period and one reminder per stage: a re-run changes nothing',
      money: false,
      manualRunSubTask: 'jobs.run',
      run: (ctx) => deps.subscriptions.billingRun(ctx),
    },
  ];
}

// --- schedule ---------------------------------------------------------------------------------------
const IST_OFFSET_MS = 330 * 60_000;

function field(spec: string, value: number, min: number, max: number): boolean {
  return spec.split(',').some((part) => {
    const [range, stepText] = part.split('/');
    const step = stepText ? Number(stepText) : 1;
    let lo = min;
    let hi = max;
    if (range !== '*') {
      const [a, b] = range!.split('-');
      lo = Number(a);
      hi = b === undefined ? (stepText ? max : lo) : Number(b);
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || !Number.isInteger(step) || step < 1) {
      return false;
    }
    return value >= lo && value <= hi && (value - lo) % step === 0;
  });
}

/** Does a five-field cron expression match this instant in IST? */
export function cronMatches(expr: string, at: Date): boolean {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) return false;
  const t = new Date(at.getTime() + IST_OFFSET_MS);
  return (
    field(f[0]!, t.getUTCMinutes(), 0, 59) &&
    field(f[1]!, t.getUTCHours(), 0, 23) &&
    field(f[2]!, t.getUTCDate(), 1, 31) &&
    field(f[3]!, t.getUTCMonth() + 1, 1, 12) &&
    field(f[4]!, t.getUTCDay(), 0, 6)
  );
}

/** Has the expression fired earlier on this IST day (up to and including `at`)? */
export function firedToday(expr: string, at: Date): boolean {
  const t = new Date(at.getTime() + IST_OFFSET_MS);
  const midnightIst = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()) - IST_OFFSET_MS;
  for (let m = midnightIst; m <= at.getTime(); m += 60_000) {
    if (cronMatches(expr, new Date(m))) return true;
  }
  return false;
}
