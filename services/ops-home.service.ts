/**
 * The back office's home and search (SRS 24.1, 26.6, RNG-GOV-008; RPT-007, RPT-008; prototype
 * o.home, o.search): tenants by status, open invoices, platform requests, job health and alerts —
 * never one institution's personal records. Searches find institutions and invoices and are
 * recorded in the activity log. Settlements, reconciliation and tickets join with their modules.
 */
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { Database } from '../models/campusone_models';
import { JOB_CATALOGUE } from '../schedulers/catalogue';
import { recordAudit } from './audit.service';
import { toMoneyDto } from '../utils/money';
import { binToUuid } from '../utils/idGenerator';
import { formatDateTime } from '../utils/format';
import type { Principal } from '../utils/principal';

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);

/** "1 invoice", "2 invoices". */
const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

export class OpsHomeService {
  constructor(
    private readonly deps: { readonly db: Kysely<Database>; readonly now?: () => Date },
  ) {}

  private now() {
    return this.deps.now?.() ?? new Date();
  }

  // --- RPT-007 ------------------------------------------------------------------------------------
  async home(_p: Principal) {
    const db = this.deps.db;
    const [byStatus, trials, invoices, approvals, cancellations, runs] = await Promise.all([
      db
        .selectFrom('institutions')
        .select(['status', sql<number>`COUNT(*)`.as('n')])
        .groupBy('status')
        .execute(),
      db
        .selectFrom('subscriptions')
        .select(sql<number>`COUNT(*)`.as('n'))
        .where('status', '=', 'TRIAL')
        .executeTakeFirst(),
      db
        .selectFrom('invoices')
        .select([
          sql<number>`SUM(status NOT IN ('PAID','VOID'))`.as('open'),
          sql<number>`COALESCE(SUM(CASE WHEN status NOT IN ('PAID','VOID') THEN total_paise END), 0)`.as(
            'openPaise',
          ),
          sql<number>`SUM(status NOT IN ('PAID','VOID') AND grace_until_on < UTC_DATE())`.as(
            'overdue',
          ),
          sql<number>`SUM(transfer_utr IS NOT NULL AND status NOT IN ('PAID','VOID'))`.as(
            'transfers',
          ),
        ])
        .executeTakeFirst(),
      db
        .selectFrom('approval_requests')
        .select(sql<number>`COUNT(*)`.as('n'))
        .where('institution_id', 'is', null)
        .where('status', '=', 'PENDING')
        .executeTakeFirst(),
      db
        .selectFrom('cancellation_requests')
        .select(sql<number>`COUNT(*)`.as('n'))
        .where('status', '=', 'PENDING')
        .executeTakeFirst(),
      db
        .selectFrom('job_runs as r')
        .select(['r.job_id', 'r.status', 'r.started_at', 'r.ended_at', 'r.failed'])
        .where(
          'r.id',
          'in',
          db
            .selectFrom('job_runs')
            .select(sql<string>`MAX(id)`.as('id'))
            .groupBy('job_id'),
        )
        .execute(),
    ]);
    const statuses = ['PENDING_ACTIVATION', 'ACTIVE', 'SUSPENDED', 'CANCELLED'] as const;
    const count = (s: string) => Number(byStatus.find((r) => r.status === s)?.n ?? 0);
    const jobs = JOB_CATALOGUE.map((j) => {
      const r = runs.find((x) => x.job_id === j.id);
      return {
        id: j.id,
        name: j.name,
        time: j.time,
        money: j.money,
        scheduled: j.scheduled,
        lastRun: r
          ? { status: r.status, startedAt: iso(r.started_at)!, endedAt: iso(r.ended_at) }
          : null,
        health: !r
          ? 'NONE'
          : r.status === 'SUCCESS'
            ? 'OK'
            : r.status === 'STARTED'
              ? 'RUNNING'
              : 'BAD',
      };
    });
    const overdue = Number(invoices?.overdue ?? 0);
    const transfers = Number(invoices?.transfers ?? 0);
    const pendingApprovals = Number(approvals?.n ?? 0);
    const pendingCancellations = Number(cancellations?.n ?? 0);
    const failedJobs = jobs.filter((j) => j.health === 'BAD');
    const alerts = [
      ...(overdue
        ? [
            {
              tone: 'bad',
              icon: 'receipt',
              title: `${plural(overdue, 'invoice')} overdue`,
              sub: 'Past the grace period — the institution may be suspended',
              go: 'o.plans',
            },
          ]
        : []),
      ...(transfers
        ? [
            {
              tone: 'warn',
              icon: 'bank',
              title: `${plural(transfers, 'bank transfer')} to confirm`,
              sub: 'Reported by institutions; mark the invoices paid when the money arrives',
              go: 'o.plans',
            },
          ]
        : []),
      ...(pendingApprovals
        ? [
            {
              tone: 'warn',
              icon: 'approve',
              title: `${plural(pendingApprovals, 'request')} waiting for a decision`,
              sub: 'Corrections and institution detail changes',
              go: 'o.approvals',
            },
          ]
        : []),
      ...(pendingCancellations
        ? [
            {
              tone: 'warn',
              icon: 'xc',
              title: `${plural(pendingCancellations, 'cancellation request')}`,
              sub: 'Confirm with Cancel, or decline with a reason',
              go: 'o.institutions',
            },
          ]
        : []),
      ...failedJobs.map((j) => ({
        tone: 'bad',
        icon: 'timer',
        title: `${j.name} failed`,
        sub: j.lastRun ? `Last run ${formatDateTime(j.lastRun.startedAt)}` : 'Last run unknown',
        go: 'o.jobs',
      })),
    ];
    return {
      kpis: {
        tenants: statuses.reduce((n, s) => n + count(s), 0),
        active: count('ACTIVE'),
        onTrial: Number(trials?.n ?? 0),
        pending: count('PENDING_ACTIVATION'),
        openInvoices: Number(invoices?.open ?? 0),
        openAmount: toMoneyDto(Number(invoices?.openPaise ?? 0)),
        overdueInvoices: overdue,
        pendingApprovals,
      },
      byStatus: statuses.map((s) => ({ status: s, count: count(s) })),
      jobs,
      alerts,
    };
  }

  // --- RPT-008 ------------------------------------------------------------------------------------
  /** Institutions and invoices matching the text (no personal records); recorded. */
  async search(p: Principal, q: string) {
    const text = q.trim();
    if (text.length < 2) return { institutions: [], invoices: [] };
    const db = this.deps.db;
    const like = `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const [institutions, invoices] = await Promise.all([
      db
        .selectFrom('institutions as i')
        .leftJoin('subscriptions as s', 's.institution_id', 'i.id')
        .leftJoin('plans as pl', 'pl.id', 's.plan_id')
        .select([
          'i.public_id',
          'i.identifier',
          'i.name',
          'i.short_name',
          'i.city',
          'i.status',
          's.status as subscription_status',
          'pl.name as plan',
        ])
        .where((eb) =>
          eb.or([
            eb('i.name', 'like', like),
            eb('i.identifier', 'like', like),
            eb('i.city', 'like', like),
            eb('i.short_name', 'like', like),
          ]),
        )
        .orderBy('i.name')
        .limit(20)
        .execute(),
      db
        .selectFrom('invoices as v')
        .innerJoin('institutions as i', 'i.id', 'v.institution_id')
        .select([
          'v.public_id',
          'v.invoice_no',
          'v.status',
          'v.total_paise',
          'v.issued_on',
          'i.name as institution',
        ])
        .where('v.invoice_no', 'like', like)
        .orderBy('v.id', 'desc')
        .limit(10)
        .execute(),
    ]);
    await recordAudit(db, {
      action: 'OPS_SEARCHED',
      entityType: 'search',
      after: { q: text.slice(0, 80), results: institutions.length + invoices.length },
      actor: { type: 'operator', ref: p.subject },
    });
    return {
      institutions: institutions.map((i) => ({
        id: binToUuid(i.public_id),
        identifier: i.identifier,
        name: i.name,
        shortName: i.short_name,
        city: i.city,
        status: i.status,
        subscription: i.subscription_status ?? null,
        plan: i.plan,
      })),
      invoices: invoices.map((v) => ({
        id: binToUuid(v.public_id),
        invoiceNo: v.invoice_no,
        institution: v.institution,
        status: v.status,
        total: toMoneyDto(Number(v.total_paise)),
        issuedOn:
          typeof v.issued_on === 'string'
            ? v.issued_on
            : new Date(v.issued_on).toISOString().slice(0, 10),
      })),
    };
  }
}
