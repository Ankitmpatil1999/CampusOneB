/**
 * Console reporting (SRS 24; FR-RPT-01/02; CR-13, CR-17; RPT-001…004; prototype c.home, c.reports).
 *
 * - The home (RPT-001): the figures of the signed-in user's role — administrator, accountant,
 *   counsellor, coordinator, transport, management, grievance officer, front desk — read live from the
 *   institution's own records (the session's institution only).
 * - The catalogue (RPT-002): the reports the role may open, by area, each tied to a task (`<task>.view`)
 *   and the screen that owns it (CR-17: campus modules only).
 * - A run (RPT-003): the report's columns and rows for the year in context (CR-13) or a date range,
 *   paged by key where the rows are records; an export (RPT-004) carries every row (report exports).
 * - Read only, parameterised SQL; money as { amount, currency }.
 */
import { sql, type Kysely, type RawBuilder } from 'kysely';
import {
  APPROVAL_REQUEST,
  CARD,
  MEMBER_PROFILE,
  PAYMENT_ATTEMPT,
  PAYMENT_CHANNELS,
  TICKET,
  type StatusDomain,
} from '../config/registers';
import { VOUCHER } from '../config/registers/status/accounting';
import { ADMISSION_PAYMENT } from '../config/registers/status/admissions';
import { ALLOWANCE_GRANT } from '../config/registers/status/allowances';
import { ATTENDANCE } from '../config/registers/status/attendance';
import { COMM_LOG } from '../config/registers/status/communication';
import { COUPON } from '../config/registers/status/coupons';
import { ENTRY_PASS, EVENT } from '../config/registers/status/events';
import { FEE_RECORD } from '../config/registers/status/fees';
import { SETTLEMENT } from '../config/registers/status/settlement';
import { STAFF_LEAVE } from '../config/registers/status/teaching';
import { TRIP } from '../config/registers/status/transport';
import type { Database } from '../models/campusone_models';
import { CustomAPIError, ValidationError } from '../utils/CustomAPIError';
import { istBusinessDate } from '../utils/format';
import { isUuid, uuidToBin } from '../utils/idGenerator';
import { formatAmount, toMoneyDto } from '../utils/money';
import type { Principal } from '../utils/principal';
import { institutionOf, yearFor } from './academic-year';
import type { CommReportService } from './comm-report.service';
import { usesProfile } from './member-roles';

type ColumnType = 'text' | 'number' | 'paise' | 'date' | 'datetime' | 'percent';
interface Column {
  readonly key: string;
  readonly label: string;
  readonly type: ColumnType;
  /** A coded column: the register label of each code (a code with none reads as words). */
  readonly labels?: (code: string) => string | undefined;
}
type Row = Record<string, unknown>;

export interface RunContext {
  readonly institutionId: string;
  readonly yearId: string;
  readonly from: string;
  readonly to: string;
}

interface ReportDefinition {
  readonly id: string;
  readonly area: string;
  readonly title: string;
  readonly description: string;
  readonly task: string;
  readonly screen: string;
  /** What the period filter means: the year in context, a date range, or nothing (as at now). */
  readonly period: 'year' | 'range' | 'now';
  readonly columns: readonly Column[];
  /** Rows after a key (records: newest first by id), at most `limit`; `key` pages on. */
  readonly rows: (
    db: Kysely<Database>,
    c: RunContext,
    after: string | undefined,
    limit: number,
  ) => Promise<{ key: string; row: Row }[]>;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const addDays = (ymd: string, n: number) =>
  new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const startOf = (ymd: string) => new Date(`${ymd}T00:00:00+05:30`);
const endOf = (ymd: string) => new Date(Date.parse(`${ymd}T00:00:00+05:30`) + 86_400_000);
const before = (col: string, after: string | undefined): RawBuilder<unknown> =>
  after ? sql`AND ${sql.ref(col)} < ${after}` : sql``;
const col = (key: string, label: string, type: ColumnType = 'text'): Column => ({
  key,
  label,
  type,
});
/** Labels of a status domain or a code list (register wording, never the stored code). */
const labelsOf = (values: readonly { readonly code: string; readonly label: string }[]) => {
  const m = new Map(values.map((v) => [v.code, v.label]));
  return (code: string) => m.get(code);
};
const domain = (d: StatusDomain) => labelsOf(d.values);
const noLabels = () => undefined;
/** A coded column (status, mode, channel…) shown with register labels. */
const coded = (
  key: string,
  label: string,
  labels: (code: string) => string | undefined,
): Column => ({
  key,
  label,
  type: 'text',
  labels,
});
/** A stored code with no register label reads as words: IN_APP → "In app". */
const words = (code: string) => code.charAt(0) + code.slice(1).toLowerCase().replace(/_/g, ' ');
const CODE = /^[A-Z][A-Z0-9_]*$/;
const display = (c: Column, v: unknown) =>
  c.labels && typeof v === 'string' && CODE.test(v) ? (c.labels(v) ?? words(v)) : v;
const run = async (db: Kysely<Database>, q: RawBuilder<Row>) => (await q.execute(db)).rows;
/** Grouped reports come back whole on one page; their keys don't page on. */
const whole = (rows: Row[]) => rows.map((row, i) => ({ key: `g${i}`, row }));
const pages = (key: string | undefined) => key !== undefined && /^\d+$/.test(key);
/** Record reports page by id. */
const byId = (rows: Row[]) =>
  rows.map((r) => {
    const { _id, ...row } = r as Row & { _id: unknown };
    return { key: String(_id), row };
  });

const REPORTS: readonly ReportDefinition[] = [
  // --- People & wallets -------------------------------------------------------------------------
  {
    id: 'institution-overview',
    area: 'People & wallets',
    title: 'Institution overview',
    description: 'Members by type and status, wallets opened, active and inactive.',
    task: 'reports',
    screen: 'c.members',
    period: 'now',
    columns: [
      col('userType', 'User type'),
      col('category', 'Category'),
      col('active', 'Active', 'number'),
      col('inactive', 'Inactive', 'number'),
      col('suspended', 'Suspended', 'number'),
      col('walletsActive', 'Wallets active', 'number'),
      col('walletsInactive', 'Wallets not active', 'number'),
    ],
    rows: async (db, c) =>
      whole(
        await run(
          db,
          sql`SELECT ut.name AS userType, ut.category,
                SUM(m.status = 'ACTIVE') AS active, SUM(m.status = 'INACTIVE') AS inactive,
                SUM(m.status = 'SUSPENDED') AS suspended,
                SUM(w.status = 'ACTIVE') AS walletsActive,
                SUM(w.id IS NOT NULL AND w.status <> 'ACTIVE') AS walletsInactive
              FROM member_profiles m
              JOIN user_types ut ON ut.id = m.user_type_id
              LEFT JOIN wallets w ON w.owner_profile_id = m.id AND w.kind = 'CAMPUS'
              WHERE m.institution_id = ${c.institutionId}
              GROUP BY ut.id, ut.name, ut.category ORDER BY ut.name`,
        ),
      ),
  },
  {
    id: 'user-summary',
    area: 'People & wallets',
    title: 'User summary',
    description:
      'Every member with admission or employee number, grade and section (CR-09), status and wallet balance.',
    task: 'members',
    screen: 'c.members',
    period: 'year',
    columns: [
      col('name', 'Name'),
      col('userType', 'User type'),
      col('number', 'Admission / employee no.'),
      col('classSection', 'Grade and section'),
      coded('status', 'Status', domain(MEMBER_PROFILE)),
      col('balance', 'Wallet balance', 'paise'),
    ],
    rows: async (db, c, after, limit) =>
      byId(
        await run(
          db,
          sql`SELECT m.id AS _id, CONCAT_WS(' ', m.first_name, m.last_name) AS name, ut.name AS userType,
                COALESCE(m.admission_no, m.employee_no) AS number,
                CONCAT(cl.name, ' ', s.name) AS classSection, m.status, b.available_paise AS balance
              FROM member_profiles m
              JOIN user_types ut ON ut.id = m.user_type_id
              LEFT JOIN enrolments en ON en.student_profile_id = m.id AND en.year_id = ${c.yearId}
              LEFT JOIN sections s ON s.id = en.section_id
              LEFT JOIN classes cl ON cl.id = s.class_id
              LEFT JOIN wallets w ON w.owner_profile_id = m.id AND w.kind = 'CAMPUS'
              LEFT JOIN wallet_balances b ON b.wallet_id = w.id
              WHERE m.institution_id = ${c.institutionId} ${before('m.id', after)}
              ORDER BY m.id DESC LIMIT ${limit}`,
        ),
      ),
  },
  {
    id: 'card-register',
    area: 'People & wallets',
    title: 'NFC card register',
    description: 'Issued, blocked and re-issued cards with the reason for each re-issue.',
    task: 'cards',
    screen: 'c.cards',
    period: 'now',
    columns: [
      col('member', 'Member'),
      coded('status', 'Status', domain(CARD)),
      col('issueReason', 'Issued because'),
      col('reissues', 'Re-issues', 'number'),
      col('issuedAt', 'Issued', 'datetime'),
      col('blockedAt', 'Blocked', 'datetime'),
      col('statusReason', 'Reason'),
    ],
    rows: async (db, c, after, limit) =>
      byId(
        await run(
          db,
          sql`SELECT k.id AS _id, CONCAT_WS(' ', m.first_name, m.last_name) AS member, k.status,
                k.issue_reason AS issueReason, k.reissue_count AS reissues, k.issued_at AS issuedAt,
                k.blocked_at AS blockedAt, k.status_reason AS statusReason
              FROM cards k JOIN member_profiles m ON m.id = k.profile_id
              WHERE k.institution_id = ${c.institutionId} ${before('k.id', after)}
              ORDER BY k.id DESC LIMIT ${limit}`,
        ),
      ),
  },
  {
    id: 'pii-corrections',
    area: 'People & wallets',
    title: 'Personal information corrections',
    description: 'Every correction request with evidence, maker, checker and outcome (CR-06).',
    task: 'members',
    screen: 'c.approvals',
    period: 'range',
    columns: [
      col('field', 'Field'),
      col('current', 'Current (masked)'),
      col('reason', 'Reason'),
      col('evidence', 'Evidence'),
      coded('outcome', 'Outcome', domain(APPROVAL_REQUEST)),
      col('requestedAt', 'Requested', 'datetime'),
      col('closedAt', 'Closed', 'datetime'),
    ],
    rows: async (db, c, after, limit) =>
      byId(
        await run(
          db,
          sql`SELECT p.id AS _id, p.field, p.current_masked AS current, p.reason,
                IF(p.evidence_file_id IS NULL, 'No', 'Yes') AS evidence,
                COALESCE(a.status, IF(p.applied_at IS NULL, 'PENDING', 'APPLIED')) AS outcome,
                p.created_at AS requestedAt, p.closed_at AS closedAt
              FROM pii_correction_requests p
              LEFT JOIN approval_requests a ON a.id = p.approval_request_id
              WHERE p.institution_id = ${c.institutionId}
                AND p.created_at >= ${startOf(c.from)} AND p.created_at < ${endOf(c.to)}
                ${before('p.id', after)}
              ORDER BY p.id DESC LIMIT ${limit}`,
        ),
      ),
  },
  // --- Payments & merchants ---------------------------------------------------------------------
  {
    id: 'transactions-by-member',
    area: 'Payments & merchants',
    title: 'Transactions by member',
    description: 'Payments, transfers, allowance and coupon use per member for a date range.',
    task: 'recon',
    screen: 'c.recon',
    period: 'range',
    columns: [
      col('member', 'Member'),
      col('wallet', 'Wallet'),
      col('entries', 'Entries', 'number'),
      col('credited', 'Credited', 'paise'),
      col('debited', 'Debited', 'paise'),
    ],
    rows: async (db, c) =>
      whole(
        await run(
          db,
          sql`SELECT CONCAT_WS(' ', m.first_name, m.last_name) AS member, w.kind AS wallet,
                COUNT(*) AS entries,
                SUM(IF(e.direction = 'C', e.amount_paise, 0)) AS credited,
                SUM(IF(e.direction = 'D', e.amount_paise, 0)) AS debited
              FROM ledger_entries e
              JOIN wallets w ON w.id = e.wallet_id
              JOIN member_profiles m ON m.id = w.owner_profile_id
              WHERE e.institution_id = ${c.institutionId} AND e.posted_on BETWEEN ${c.from} AND ${c.to}
                AND w.kind IN ('CAMPUS', 'ALLOWANCE', 'PERSONAL')
              GROUP BY m.id, m.first_name, m.last_name, w.kind
              ORDER BY debited DESC LIMIT 5000`,
        ),
      ),
  },
  {
    id: 'transactions-by-institution',
    area: 'Payments & merchants',
    title: 'Transactions by institution',
    description: 'All campus payments by channel, type and status.',
    task: 'recon',
    screen: 'c.recon',
    period: 'range',
    columns: [
      coded('channel', 'Channel', labelsOf(PAYMENT_CHANNELS)),
      coded('status', 'Status', domain(PAYMENT_ATTEMPT)),
      col('count', 'Payments', 'number'),
      col('amount', 'Amount', 'paise'),
    ],
    rows: async (db, c) =>
      whole(
        await run(
          db,
          sql`SELECT channel, status, COUNT(*) AS count, SUM(amount_paise) AS amount
              FROM payment_attempts
              WHERE institution_id = ${c.institutionId}
                AND attempted_at >= ${startOf(c.from)} AND attempted_at < ${endOf(c.to)}
              GROUP BY channel, status ORDER BY channel, status`,
        ),
      ),
  },
  {
    id: 'merchant-summary',
    area: 'Payments & merchants',
    title: 'Merchant summary',
    description: 'Collections, counts and platform fees per merchant.',
    task: 'merchants',
    screen: 'c.merchants',
    period: 'range',
    columns: [
      col('merchant', 'Merchant'),
      col('count', 'Transactions', 'number'),
      col('gross', 'Collected', 'paise'),
      col('fee', 'Platform fee', 'paise'),
      col('net', 'Net', 'paise'),
    ],
    rows: async (db, c) =>
      whole(
        await run(
          db,
          sql`SELECT COALESCE(mr.display_name, CONCAT_WS(' ', m.first_name, m.last_name)) AS merchant,
                COUNT(*) AS count, SUM(l.amount_paise) AS gross, SUM(l.fee_paise) AS fee,
                SUM(l.net_paise) AS net
              FROM settlement_lines l
              JOIN member_profiles m ON m.id = l.merchant_profile_id
              LEFT JOIN merchants mr ON mr.profile_id = l.merchant_profile_id
              WHERE l.institution_id = ${c.institutionId} AND l.posted_on BETWEEN ${c.from} AND ${c.to}
                AND l.active = 1
              GROUP BY l.merchant_profile_id, mr.display_name, m.first_name, m.last_name
              ORDER BY gross DESC`,
        ),
      ),
  },
  {
    id: 'allowance-report',
    area: 'Payments & merchants',
    title: 'Allowance report',
    description: 'Issued and expired allowance per student.',
    task: 'allowances',
    screen: 'c.allowances',
    period: 'range',
    columns: [
      col('student', 'Student'),
      col('allowance', 'Allowance'),
      col('amount', 'Amount', 'paise'),
      col('startDate', 'From', 'date'),
      col('expiryDate', 'Until', 'date'),
      coded('status', 'Status', domain(ALLOWANCE_GRANT)),
      col('ended', 'Ended because'),
      col('expired', 'Expired unspent', 'paise'),
    ],
    rows: async (db, c, after, limit) =>
      byId(
        await run(
          db,
          sql`SELECT g.id AS _id, CONCAT_WS(' ', m.first_name, m.last_name) AS student, g.name AS allowance,
                g.amount_paise AS amount, g.start_date AS startDate, g.expiry_date AS expiryDate,
                g.status, g.ended_reason AS ended, g.expired_paise AS expired
              FROM allowance_grants g JOIN member_profiles m ON m.id = g.profile_id
              WHERE g.institution_id = ${c.institutionId}
                AND g.start_date <= ${c.to} AND g.expiry_date >= ${c.from}
                ${before('g.id', after)}
              ORDER BY g.id DESC LIMIT ${limit}`,
        ),
      ),
  },
  {
    id: 'coupon-statement',
    area: 'Payments & merchants',
    title: 'Coupon statement',
    description: 'Issued, used and expired coupons by type (CR-15).',
    task: 'coupons',
    screen: 'c.coupons',
    period: 'range',
    columns: [
      col('type', 'Coupon type'),
      coded('status', 'Status', domain(COUPON)),
      col('count', 'Coupons', 'number'),
      col('value', 'Value', 'paise'),
    ],
    rows: async (db, c) =>
      whole(
        await run(
          db,
          sql`SELECT t.name AS type, k.status, COUNT(*) AS count, SUM(k.value_paise) AS value
              FROM coupons k JOIN coupon_types t ON t.id = k.type_id
              WHERE k.institution_id = ${c.institutionId} AND k.valid_on BETWEEN ${c.from} AND ${c.to}
              GROUP BY t.id, t.name, k.status ORDER BY t.name, k.status`,
        ),
      ),
  },
  {
    id: 'event-payments',
    area: 'Payments & merchants',
    title: 'Event payments',
    description: 'Each event with what it costs and who has paid.',
    task: 'events',
    screen: 'c.events',
    period: 'range',
    columns: [
      col('event', 'Event'),
      col('startDate', 'From', 'date'),
      col('endDate', 'Until', 'date'),
      col('price', 'Price', 'paise'),
      col('payments', 'Payments', 'number'),
      col('collected', 'Collected', 'paise'),
      coded('status', 'Status', domain(EVENT)),
    ],
    rows: async (db, c) =>
      whole(
        await run(
          db,
          sql`SELECT e.title AS event, e.start_date AS startDate, e.end_date AS endDate,
                e.total_paise AS price, COUNT(pa.id) AS payments, COALESCE(SUM(pa.amount_paise), 0) AS collected,
                e.status
              FROM events e
              LEFT JOIN payment_attempts pa ON pa.institution_id = e.institution_id
                AND pa.channel = 'EVENT' AND pa.status = 'SUCCESS'
                AND pa.event_ref = BIN_TO_UUID(e.public_id)
              WHERE e.institution_id = ${c.institutionId}
                AND e.start_date <= ${c.to} AND e.end_date >= ${c.from}
              GROUP BY e.id ORDER BY e.start_date DESC`,
        ),
      ),
  },
  {
    id: 'entry-pass-history',
    area: 'Payments & merchants',
    title: 'Entry-pass history',
    description: 'Passes created, authorised and scanned.',
    task: 'passes',
    screen: 'c.passes',
    period: 'range',
    columns: [
      col('holder', 'Holder'),
      coded('passType', 'Pass', noLabels),
      col('purpose', 'Purpose'),
      col('validOn', 'Valid on', 'date'),
      col('scans', 'Scans', 'number'),
      col('maxScans', 'Allowed scans', 'number'),
      coded('status', 'Status', domain(ENTRY_PASS)),
    ],
    rows: async (db, c, after, limit) =>
      byId(
        await run(
          db,
          sql`SELECT p.id AS _id, CONCAT_WS(' ', m.first_name, m.last_name) AS holder, p.pass_type AS passType,
                p.purpose, p.valid_on AS validOn, p.used_scans AS scans, p.max_scans AS maxScans, p.status
              FROM entry_passes p JOIN member_profiles m ON m.id = p.holder_profile_id
              WHERE p.institution_id = ${c.institutionId} AND p.valid_on BETWEEN ${c.from} AND ${c.to}
                ${before('p.id', after)}
              ORDER BY p.id DESC LIMIT ${limit}`,
        ),
      ),
  },
  {
    id: 'settlement-summary',
    area: 'Payments & merchants',
    title: 'Settlement summary',
    description: 'Daily settlements with gross, fee, net and payout reference.',
    task: 'settlements',
    screen: 'c.settlements',
    period: 'range',
    columns: [
      col('settlement', 'Settlement'),
      col('date', 'Date', 'date'),
      coded('status', 'Status', domain(SETTLEMENT)),
      col('lineCount', 'Lines', 'number'),
      col('gross', 'Gross', 'paise'),
      col('fee', 'Fee', 'paise'),
      col('net', 'Net', 'paise'),
      col('payoutUtr', 'Payout reference'),
    ],
    rows: async (db, c, after, limit) =>
      byId(
        await run(
          db,
          sql`SELECT id AS _id, settlement_no AS settlement, settlement_date AS date, status,
                line_count AS lineCount, gross_paise AS gross, fee_paise AS fee, net_paise AS net,
                payout_utr AS payoutUtr
              FROM settlements
              WHERE institution_id = ${c.institutionId} AND settlement_date BETWEEN ${c.from} AND ${c.to}
                ${before('id', after)}
              ORDER BY id DESC LIMIT ${limit}`,
        ),
      ),
  },
  {
    id: 'posted-vouchers',
    area: 'Payments & merchants',
    title: 'Posted vouchers',
    description: 'Accounting vouchers sent to the accounting package.',
    task: 'vouchers',
    screen: 'c.vouchers',
    period: 'range',
    columns: [
      col('reference', 'Reference'),
      col('event', 'Event'),
      col('date', 'Date', 'date'),
      col('amount', 'Amount', 'paise'),
      col('debit', 'Debit ledger'),
      col('credit', 'Credit ledger'),
      coded('status', 'Status', domain(VOUCHER)),
      col('externalRef', 'Package reference'),
    ],
    rows: async (db, c, after, limit) =>
      byId(
        await run(
          db,
          sql`SELECT id AS _id, reference, event, voucher_date AS date, amount_paise AS amount,
                debit_ledger AS debit, credit_ledger AS credit, status, external_ref AS externalRef
              FROM accounting_vouchers
              WHERE institution_id = ${c.institutionId} AND voucher_date BETWEEN ${c.from} AND ${c.to}
                ${before('id', after)}
              ORDER BY id DESC LIMIT ${limit}`,
        ),
      ),
  },
  // --- Fees -------------------------------------------------------------------------------------
  {
    id: 'tuition-collection',
    area: 'Fees',
    title: 'Tuition collection',
    description: 'Collections by class, section and status, with totals.',
    task: 'fees',
    screen: 'c.feerecords',
    period: 'year',
    columns: [
      col('class', 'Class'),
      col('section', 'Section'),
      coded('status', 'Status', domain(FEE_RECORD)),
      col('instalments', 'Instalments', 'number'),
      col('amount', 'Amount', 'paise'),
      col('paid', 'Paid', 'paise'),
      col('fines', 'Late fines', 'paise'),
    ],
    rows: async (db, c) =>
      whole(
        await run(
          db,
          sql`SELECT cl.name AS class, s.name AS section, r.status, COUNT(*) AS instalments,
                SUM(r.amount_paise) AS amount, SUM(r.paid_paise) AS paid, SUM(r.late_fine_paise) AS fines
              FROM fee_records r
              LEFT JOIN enrolments en ON en.student_profile_id = r.student_profile_id AND en.year_id = r.year_id
              LEFT JOIN sections s ON s.id = en.section_id
              LEFT JOIN classes cl ON cl.id = s.class_id
              WHERE r.institution_id = ${c.institutionId} AND r.year_id = ${c.yearId}
              GROUP BY cl.id, cl.name, cl.sort_order, s.id, s.name, r.status
              ORDER BY cl.sort_order, s.name, r.status`,
        ),
      ),
  },
  {
    id: 'dues-overdue',
    area: 'Fees',
    title: 'Dues and overdue',
    description: 'Unpaid instalments with late fines.',
    task: 'fees',
    screen: 'c.feerecords',
    period: 'year',
    columns: [
      col('student', 'Student'),
      col('admissionNo', 'Admission no.'),
      col('classSection', 'Grade and section'),
      col('instalment', 'Instalment'),
      col('dueDate', 'Due', 'date'),
      col('amount', 'Amount', 'paise'),
      col('paid', 'Paid', 'paise'),
      col('fine', 'Late fine', 'paise'),
      coded('status', 'Status', domain(FEE_RECORD)),
    ],
    rows: async (db, c, after, limit) =>
      byId(
        await run(
          db,
          sql`SELECT r.id AS _id, CONCAT_WS(' ', m.first_name, m.last_name) AS student,
                m.admission_no AS admissionNo, CONCAT(cl.name, ' ', s.name) AS classSection,
                r.label AS instalment, r.due_date AS dueDate, r.amount_paise AS amount,
                r.paid_paise AS paid, r.late_fine_paise AS fine, r.status
              FROM fee_records r
              JOIN member_profiles m ON m.id = r.student_profile_id
              LEFT JOIN enrolments en ON en.student_profile_id = r.student_profile_id AND en.year_id = r.year_id
              LEFT JOIN sections s ON s.id = en.section_id
              LEFT JOIN classes cl ON cl.id = s.class_id
              WHERE r.institution_id = ${c.institutionId} AND r.year_id = ${c.yearId}
                AND r.status IN ('DUE', 'PARTIALLY_PAID', 'OVERDUE')
                ${before('r.id', after)}
              ORDER BY r.id DESC LIMIT ${limit}`,
        ),
      ),
  },
  {
    id: 'admission-fees',
    area: 'Fees',
    title: 'Admission and application fees',
    description: 'Online and cash admission-fee collections by academic year.',
    task: 'admfees',
    screen: 'c.admfees',
    period: 'year',
    columns: [
      col('application', 'Application'),
      col('student', 'Student'),
      coded('feeType', 'Fee', noLabels),
      col('amount', 'Amount', 'paise'),
      coded('mode', 'Mode', labelsOf(PAYMENT_CHANNELS)),
      coded('status', 'Status', domain(ADMISSION_PAYMENT)),
      col('receipt', 'Receipt'),
      col('paidAt', 'Paid', 'datetime'),
    ],
    rows: async (db, c, after, limit) =>
      byId(
        await run(
          db,
          sql`SELECT p.id AS _id, a.application_no AS application,
                CONCAT_WS(' ', a.first_name, a.last_name) AS student, p.fee_type AS feeType,
                p.amount_paise AS amount, p.mode, p.status, p.receipt_no AS receipt, p.paid_at AS paidAt
              FROM admission_payments p JOIN admission_applications a ON a.id = p.application_id
              WHERE p.institution_id = ${c.institutionId} AND a.year_id = ${c.yearId}
                ${before('p.id', after)}
              ORDER BY p.id DESC LIMIT ${limit}`,
        ),
      ),
  },
  // --- Academics --------------------------------------------------------------------------------
  {
    id: 'marks-by-exam',
    area: 'Academics',
    title: 'Marks by exam',
    description: 'Marks, averages and pass rates by exam, class and section.',
    task: 'academics',
    screen: 'c.exams',
    period: 'year',
    columns: [
      col('exam', 'Exam'),
      col('class', 'Class'),
      col('section', 'Section'),
      col('subject', 'Subject'),
      col('date', 'Date', 'date'),
      col('maxMarks', 'Out of', 'number'),
      col('students', 'Students marked', 'number'),
      col('average', 'Average', 'number'),
      col('passRate', 'Pass rate', 'percent'),
    ],
    rows: async (db, c) =>
      whole(
        await run(
          db,
          sql`SELECT n.name AS exam, cl.name AS class, s.name AS section, sub.name AS subject,
                x.exam_date AS date, x.max_marks AS maxMarks, COUNT(mk.id) AS students,
                ROUND(AVG(IF(mk.is_absent = 1, NULL, mk.marks)), 1) AS average,
                ROUND(100 * SUM(mk.is_absent = 0 AND mk.marks >= x.pass_marks) / NULLIF(COUNT(mk.id), 0), 1) AS passRate
              FROM exams x
              JOIN exam_names n ON n.id = x.exam_name_id
              JOIN classes cl ON cl.id = x.class_id
              LEFT JOIN sections s ON s.id = x.section_id
              LEFT JOIN subjects sub ON sub.id = x.subject_id
              LEFT JOIN marks mk ON mk.exam_id = x.id
              WHERE x.institution_id = ${c.institutionId} AND x.year_id = ${c.yearId}
                AND x.withdrawn_at IS NULL
              GROUP BY x.id ORDER BY x.exam_date DESC, cl.sort_order`,
        ),
      ),
  },
  {
    id: 'enrolment-by-year',
    area: 'Academics',
    title: 'Enrolment by year',
    description: 'Students mapped to each class-section in the year in context (CR-13).',
    task: 'academics',
    screen: 'c.enrol',
    period: 'year',
    columns: [
      col('class', 'Class'),
      col('section', 'Section'),
      col('students', 'Students', 'number'),
    ],
    rows: async (db, c) =>
      whole(
        await run(
          db,
          sql`SELECT cl.name AS class, s.name AS section, COUNT(en.id) AS students
              FROM sections s JOIN classes cl ON cl.id = s.class_id
              LEFT JOIN enrolments en ON en.section_id = s.id AND en.year_id = ${c.yearId}
              WHERE cl.institution_id = ${c.institutionId}
              GROUP BY s.id ORDER BY cl.sort_order, s.name`,
        ),
      ),
  },
  {
    id: 'teacher-leave',
    area: 'Academics',
    title: 'Teacher leave',
    description: 'Requests with coordinator and principal decisions.',
    task: 'leave',
    screen: 'c.leave',
    period: 'year',
    columns: [
      col('teacher', 'Teacher'),
      coded('leaveType', 'Leave', noLabels),
      col('from', 'From', 'date'),
      col('to', 'To', 'date'),
      col('days', 'Days', 'number'),
      coded('coordinator', 'Coordinator', domain(STAFF_LEAVE)),
      coded('decision', 'Decision', domain(STAFF_LEAVE)),
      col('requestedAt', 'Requested', 'datetime'),
    ],
    rows: async (db, c, after, limit) =>
      byId(
        await run(
          db,
          sql`SELECT l.id AS _id, CONCAT_WS(' ', m.first_name, m.last_name) AS teacher,
                l.leave_type AS leaveType, l.from_date AS \`from\`, l.to_date AS \`to\`, l.days,
                IF(l.needs_coordinator = 1, COALESCE(l.coordinator_status, 'PENDING'), '—') AS coordinator,
                COALESCE(l.final_status, 'PENDING') AS decision, l.created_at AS requestedAt
              FROM staff_leaves l JOIN member_profiles m ON m.id = l.profile_id
              WHERE l.institution_id = ${c.institutionId} AND l.year_id = ${c.yearId}
                ${before('l.id', after)}
              ORDER BY l.id DESC LIMIT ${limit}`,
        ),
      ),
  },
  // --- Attendance -------------------------------------------------------------------------------
  {
    id: 'daily-attendance',
    area: 'Attendance',
    title: 'Daily attendance',
    description: 'Present, late, half-day and absent by class and section.',
    task: 'attendance',
    screen: 'c.attendance',
    period: 'range',
    columns: [
      col('date', 'Date', 'date'),
      col('class', 'Class'),
      col('section', 'Section'),
      col('present', 'Present', 'number'),
      col('late', 'Late', 'number'),
      col('halfDay', 'Half day', 'number'),
      col('absent', 'Absent', 'number'),
    ],
    rows: async (db, c) =>
      whole(
        await run(
          db,
          sql`SELECT d.att_date AS date, cl.name AS class, s.name AS section,
                SUM(d.status = 'PRESENT') AS present, SUM(d.status = 'LATE') AS late,
                SUM(d.status = 'HALF_DAY') AS halfDay, SUM(d.status = 'ABSENT') AS absent
              FROM attendance_days d
              JOIN sections s ON s.id = d.section_id JOIN classes cl ON cl.id = s.class_id
              WHERE d.institution_id = ${c.institutionId} AND d.att_date BETWEEN ${c.from} AND ${c.to}
              GROUP BY d.att_date, cl.id, cl.name, cl.sort_order, s.id, s.name
              ORDER BY d.att_date DESC, cl.sort_order, s.name LIMIT 20000`,
        ),
      ),
  },
  {
    id: 'reader-captures',
    area: 'Attendance',
    title: 'Reader captures',
    description: 'Every tap with the reader name in force at capture and its purpose (CR-10).',
    task: 'readers',
    screen: 'c.readers',
    period: 'range',
    columns: [
      col('at', 'Time', 'datetime'),
      col('member', 'Member'),
      coded('action', 'Action', noLabels),
      coded('status', 'Status', domain(ATTENDANCE)),
      col('reader', 'Reader'),
      coded('purpose', 'Purpose', noLabels),
    ],
    rows: async (db, c, after, limit) =>
      byId(
        await run(
          db,
          sql`SELECT ev.id AS _id, ev.at, CONCAT_WS(' ', m.first_name, m.last_name) AS member, ev.action,
                ev.new_status AS status, t.name AS reader, t.purpose
              FROM attendance_events ev
              JOIN attendance_days d ON d.id = ev.day_id
              JOIN member_profiles m ON m.id = d.profile_id
              JOIN terminals t ON t.id = ev.terminal_id
              WHERE ev.institution_id = ${c.institutionId}
                AND ev.at >= ${startOf(c.from)} AND ev.at < ${endOf(c.to)}
                ${before('ev.id', after)}
              ORDER BY ev.id DESC LIMIT ${limit}`,
        ),
      ),
  },
  // --- Transport --------------------------------------------------------------------------------
  {
    id: 'trip-history',
    area: 'Transport',
    title: 'Trip history',
    description: 'Trips, stops reached and skipped, and cancellations with remarks.',
    task: 'transport',
    screen: 'c.transport',
    period: 'range',
    columns: [
      col('date', 'Date', 'date'),
      col('route', 'Route'),
      col('session', 'Session'),
      col('vehicle', 'Vehicle'),
      coded('status', 'Status', domain(TRIP)),
      col('reached', 'Stops reached', 'number'),
      col('skipped', 'Stops skipped', 'number'),
      col('remarks', 'Cancellation remarks'),
    ],
    rows: async (db, c, after, limit) =>
      byId(
        await run(
          db,
          sql`SELECT t.id AS _id, t.trip_date AS date, CONCAT(r.code, ' · ', r.name) AS route,
                se.name AS session, v.name AS vehicle, t.status,
                (SELECT COUNT(*) FROM transport_trip_stops ts WHERE ts.trip_id = t.id AND ts.status IN ('REACHED','DEPARTED')) AS reached,
                (SELECT COUNT(*) FROM transport_trip_stops ts WHERE ts.trip_id = t.id AND ts.status = 'SKIPPED') AS skipped,
                t.cancel_remarks AS remarks
              FROM transport_trips t
              JOIN transport_routes r ON r.id = t.route_id
              JOIN transport_sessions se ON se.id = t.session_id
              JOIN transport_vehicles v ON v.id = t.vehicle_id
              WHERE t.institution_id = ${c.institutionId} AND t.trip_date BETWEEN ${c.from} AND ${c.to}
                ${before('t.id', after)}
              ORDER BY t.id DESC LIMIT ${limit}`,
        ),
      ),
  },
  {
    id: 'vehicle-utilisation',
    area: 'Transport',
    title: 'Vehicle utilisation',
    description: 'Seats allocated against capacity per vehicle.',
    task: 'transport',
    screen: 'c.fleet',
    period: 'year',
    columns: [
      col('vehicle', 'Vehicle'),
      col('registration', 'Registration'),
      col('capacity', 'Seats', 'number'),
      col('routes', 'Routes'),
      col('allocated', 'Passengers allocated', 'number'),
      col('utilisation', 'Seat use', 'percent'),
    ],
    rows: async (db, c) =>
      whole(
        await run(
          db,
          sql`SELECT v.name AS vehicle, v.registration, v.capacity,
                GROUP_CONCAT(DISTINCT r.code ORDER BY r.code SEPARATOR ', ') AS routes,
                COUNT(DISTINCT al.id) AS allocated,
                ROUND(100 * COUNT(DISTINCT al.id) / NULLIF(v.capacity, 0), 1) AS utilisation
              FROM transport_vehicles v
              LEFT JOIN transport_assignments a ON a.vehicle_id = v.id AND a.active = 1 AND a.year_id = ${c.yearId}
              LEFT JOIN transport_routes r ON r.id = a.route_id
              LEFT JOIN transport_allocations al ON al.route_id = a.route_id AND al.active = 1 AND al.year_id = ${c.yearId}
              WHERE v.institution_id = ${c.institutionId}
              GROUP BY v.id ORDER BY v.name`,
        ),
      ),
  },
  // --- Communication ----------------------------------------------------------------------------
  {
    id: 'communication-report',
    area: 'Communication',
    title: 'Communication report',
    description:
      'Every notification, announcement, message, one-time code and alert with its outcome (CR-16).',
    task: 'commreport',
    screen: 'c.commreport',
    period: 'range',
    columns: [
      col('at', 'Time', 'datetime'),
      coded('kind', 'Kind', noLabels),
      coded('channel', 'Channel', noLabels),
      col('raisedBy', 'Raised by'),
      col('recipient', 'Recipient'),
      col('subject', 'Subject'),
      coded('outcome', 'Outcome', domain(COMM_LOG)),
      col('reason', 'Reason'),
    ],
    rows: async (db, c, after, limit) =>
      byId(
        await run(
          db,
          sql`SELECT l.id AS _id, l.at, l.kind, l.channel,
                COALESCE(CONCAT_WS(' ', ra.first_name, ra.last_name), CONCAT('System (', COALESCE(l.ref_type, 'event'), ')')) AS raisedBy,
                COALESCE(CONCAT_WS(' ', mp.first_name, mp.last_name), l.recipient_masked) AS recipient,
                IF(l.kind = 'DIRECT_MESSAGE', 'Private message', l.subject) AS subject, l.outcome, l.reason
              FROM comm_log l
              LEFT JOIN member_profiles mp ON mp.id = l.recipient_profile_id
              LEFT JOIN platform_accounts ra ON ra.public_id = l.raiser
              WHERE l.institution_id = ${c.institutionId} AND l.logged_on BETWEEN ${c.from} AND ${c.to}
                ${before('l.id', after)}
              ORDER BY l.id DESC LIMIT ${limit}`,
        ),
      ),
  },
  {
    id: 'announcement-acknowledgements',
    area: 'Communication',
    title: 'Announcement acknowledgements',
    description: 'Who has and hasn’t acknowledged each announcement.',
    task: 'comms',
    screen: 'c.announcements',
    period: 'range',
    columns: [
      col('announcement', 'Announcement'),
      col('sentAt', 'Sent', 'datetime'),
      col('recipients', 'Recipients', 'number'),
      col('acknowledged', 'Acknowledged', 'number'),
      col('pending', 'Not yet', 'number'),
    ],
    rows: async (db, c, after, limit) =>
      byId(
        await run(
          db,
          sql`SELECT a.id AS _id, a.title AS announcement, a.dispatched_at AS sentAt,
                COUNT(r.profile_id) AS recipients, SUM(r.acknowledged_at IS NOT NULL) AS acknowledged,
                SUM(r.acknowledged_at IS NULL) AS pending
              FROM announcements a JOIN announcement_recipients r ON r.announcement_id = a.id
              WHERE a.institution_id = ${c.institutionId} AND a.ack_required = 1 AND a.withdrawn_at IS NULL
                AND a.send_at >= ${startOf(c.from)} AND a.send_at < ${endOf(c.to)}
                ${before('a.id', after)}
              GROUP BY a.id ORDER BY a.id DESC LIMIT ${limit}`,
        ),
      ),
  },
  // --- Controls ---------------------------------------------------------------------------------
  {
    id: 'grievance-summary',
    area: 'Controls',
    title: 'Grievance summary',
    description: 'Tickets by status and priority with the oldest open age.',
    task: 'grievances',
    screen: 'c.grievances',
    period: 'range',
    columns: [
      coded('status', 'Status', domain(TICKET)),
      col('priority', 'Priority', 'number'),
      col('tickets', 'Tickets', 'number'),
      col('oldestDays', 'Oldest (days)', 'number'),
    ],
    rows: async (db, c) =>
      whole(
        await run(
          db,
          sql`SELECT status, priority, COUNT(*) AS tickets,
                MAX(DATEDIFF(UTC_TIMESTAMP(), created_at)) AS oldestDays
              FROM tickets
              WHERE institution_id = ${c.institutionId}
                AND created_at >= ${startOf(c.from)} AND created_at < ${endOf(c.to)}
              GROUP BY status, priority ORDER BY status, priority`,
        ),
      ),
  },
  {
    id: 'maker-checker-log',
    area: 'Controls',
    title: 'Maker-checker log',
    description: 'Every approval request with its maker, checker, decision and remarks.',
    task: 'approvals',
    screen: 'c.approvals',
    period: 'range',
    columns: [
      coded('module', 'Module', noLabels),
      col('action', 'Action'),
      col('summary', 'Request'),
      coded('makerType', 'Maker', noLabels),
      coded('status', 'Decision', domain(APPROVAL_REQUEST)),
      col('remarks', 'Remarks'),
      col('requestedAt', 'Requested', 'datetime'),
      col('decidedAt', 'Decided', 'datetime'),
    ],
    rows: async (db, c, after, limit) =>
      byId(
        await run(
          db,
          sql`SELECT id AS _id, module, action, summary, maker_type AS makerType, status, remarks,
                created_at AS requestedAt, decided_at AS decidedAt
              FROM approval_requests
              WHERE institution_id = ${c.institutionId}
                AND created_at >= ${startOf(c.from)} AND created_at < ${endOf(c.to)}
                ${before('id', after)}
              ORDER BY id DESC LIMIT ${limit}`,
        ),
      ),
  },
];

const PAGE = 100;
const cursorOf = {
  encode: (k: string) => Buffer.from(`r:${k}`, 'utf8').toString('base64url'),
  decode(c: string | undefined) {
    if (!c) return undefined;
    const m = /^r:(\d{1,20})$/.exec(Buffer.from(c, 'base64url').toString('utf8'));
    if (!m?.[1]) throw new ValidationError([{ field: 'cursor', code: 'VALIDATION.FORMAT' }]);
    return m[1];
  },
};

const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
const ymdOf = (v: unknown) => {
  if (!v) return null;
  if (typeof v === 'string') return v.slice(0, 10);
  const d = v as Date;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/** A cell for the API: money as { amount, currency }, dates as text, numbers as numbers. */
function apiCell(c: Column, raw: unknown) {
  const type = c.type;
  const v = display(c, raw);
  if (v === null || v === undefined) return null;
  if (type === 'paise') return toMoneyDto(BigInt(String(v)));
  if (type === 'number' || type === 'percent') return Number(v);
  if (type === 'date') return ymdOf(v);
  if (type === 'datetime') return iso(v);
  return String(v);
}

/** A cell for an export: plain text, money in rupees with two decimals. */
function csvCell(c: Column, raw: unknown): string | number | null {
  const type = c.type;
  const v = display(c, raw);
  if (v === null || v === undefined) return null;
  if (type === 'paise') return formatAmount(BigInt(String(v)));
  if (type === 'number' || type === 'percent') return Number(v);
  if (type === 'date') return ymdOf(v);
  if (type === 'datetime') return iso(v);
  return String(v);
}

const HOME_VARIANT: readonly (readonly [string, string])[] = [
  ['INSTITUTION_ADMIN', 'admin'],
  ['MANAGEMENT', 'management'],
  ['ACCOUNTANT', 'accountant'],
  ['COUNSELLOR', 'counsellor'],
  ['ACADEMIC_COORDINATOR', 'coordinator'],
  ['TRANSPORT_ADMIN', 'transport'],
  ['GRIEVANCE_OFFICER', 'grievance'],
  ['FRONT_DESK', 'frontdesk'],
];

export class ReportsService {
  constructor(
    private readonly deps: {
      readonly db: Kysely<Database>;
      readonly commReport?: CommReportService;
      readonly now?: () => Date;
    },
  ) {}

  private now() {
    return this.deps.now?.() ?? new Date();
  }

  private visible(p: Principal) {
    return REPORTS.filter((r) => p.subTasks.includes(`${r.task}.view`));
  }

  /** RPT-002: the reports the role may open, by area (CR-17). */
  async catalogue(p: Principal) {
    await institutionOf(this.deps.db, p);
    return {
      areas: [...new Set(REPORTS.map((r) => r.area))],
      reports: this.visible(p).map(({ rows: _rows, columns, ...r }) => {
        void _rows;
        return { ...r, columns: columns.map(({ key, label, type }) => ({ key, label, type })) };
      }),
    };
  }

  /** The report, if the role may open it (another's is not found). */
  private definition(p: Principal, id: string) {
    const r = this.visible(p).find((x) => x.id === id);
    if (!r) throw new CustomAPIError(404, 'RPT.REPORT_NOT_FOUND');
    return r;
  }

  /** The run's context: the institution, the year in context and the range (default 30 days). */
  async context(
    p: Principal,
    reportId: string,
    q: { yearId?: string | undefined; from?: string | undefined; to?: string | undefined },
  ) {
    const def = this.definition(p, reportId);
    const inst = await institutionOf(this.deps.db, p);
    const year = await yearFor(this.deps.db, inst.id, q.yearId ?? null);
    const today = istBusinessDate(this.now());
    const to = q.to ?? today;
    const from = q.from ?? addDays(to, -29);
    const errors = [];
    if (!DAY.test(from)) errors.push({ field: 'from', code: 'VALIDATION.DATE' });
    if (!DAY.test(to)) errors.push({ field: 'to', code: 'VALIDATION.DATE' });
    if (!errors.length && from > to) errors.push({ field: 'to', code: 'COM.REPORT_RANGE' });
    if (!errors.length && Date.parse(to) - Date.parse(from) > 366 * 86_400_000) {
      errors.push({ field: 'from', code: 'RPT.PARAM_INVALID' });
    }
    if (errors.length) throw new ValidationError(errors);
    return {
      def,
      year,
      ctx: { institutionId: inst.id, yearId: year.id, from, to } satisfies RunContext,
    };
  }

  /** RPT-003: one page of the report. */
  async run(
    p: Principal,
    reportId: string,
    q: {
      yearId?: string | undefined;
      from?: string | undefined;
      to?: string | undefined;
      cursor?: string | undefined;
    },
  ) {
    const { def, year, ctx } = await this.context(p, reportId, q);
    const after = cursorOf.decode(q.cursor);
    const rows = await def.rows(this.deps.db, ctx, after, PAGE + 1);
    const shown = rows.slice(0, PAGE);
    const last = shown.at(-1);
    return {
      report: { id: def.id, title: def.title, area: def.area, period: def.period },
      year: { id: year.publicId, label: year.label },
      period: def.period === 'range' ? { from: ctx.from, to: ctx.to } : null,
      columns: def.columns.map(({ key, label, type }) => ({ key, label, type })),
      rows: shown.map((r) =>
        Object.fromEntries(def.columns.map((c) => [c.key, apiCell(c, r.row[c.key])])),
      ),
      nextCursor: rows.length > PAGE && last && pages(last.key) ? cursorOf.encode(last.key) : null,
    };
  }

  /** The rows of an export (RPT-004): every row of the run, as text. */
  async *exportRows(
    institutionId: string,
    params: Record<string, unknown>,
    max: number,
  ): AsyncGenerator<readonly (string | number | null)[]> {
    const def = REPORTS.find((r) => r.id === params['report']);
    if (!def) return;
    const ctx: RunContext = {
      institutionId,
      yearId: String(params['yearRowId']),
      from: String(params['from']),
      to: String(params['to']),
    };
    let after: string | undefined;
    let n = 0;
    while (n < max) {
      const want = Math.min(1000, max - n);
      const page = await def.rows(this.deps.db, ctx, after, want);
      for (const r of page.slice(0, max - n)) {
        yield def.columns.map((c) => csvCell(c, r.row[c.key]));
      }
      n += page.length;
      const last = page.at(-1)?.key;
      if (page.length < want || !pages(last)) return;
      after = last;
    }
  }

  /** The export's header, file name and stored parameters (checked like a run). */
  async exportRequest(
    p: Principal,
    reportId: string,
    q: { yearId?: string | undefined; from?: string | undefined; to?: string | undefined },
  ) {
    const { def, year, ctx } = await this.context(p, reportId, q);
    return {
      institutionId: ctx.institutionId,
      params: {
        report: def.id,
        yearRowId: ctx.yearId,
        yearLabel: year.label,
        from: ctx.from,
        to: ctx.to,
        period: def.period,
      },
    };
  }

  header(reportId: string) {
    return REPORTS.find((r) => r.id === reportId)?.columns.map((c) => c.label) ?? [];
  }

  fileName(params: Record<string, unknown>) {
    const id = String(params['report'] ?? 'report');
    const when =
      params['period'] === 'range'
        ? `${String(params['from'])}_${String(params['to'])}`
        : params['period'] === 'year'
          ? String(params['yearLabel'] ?? 'year')
          : istBusinessDate(this.now());
    return `${id}_${when}.csv`;
  }

  /** RPT-001: the home figures of the signed-in user's role. */
  async home(p: Principal) {
    const db = this.deps.db;
    const inst = await institutionOf(db, p);
    const roles = isUuid(p.subject)
      ? (
          await db
            .selectFrom('member_profiles as m')
            .innerJoin('platform_accounts as a', (j) => j.on(usesProfile))
            .innerJoin('profile_roles as pr', 'pr.profile_id', 'm.id')
            .innerJoin('roles as r', 'r.id', 'pr.role_id')
            .select('r.code')
            .where('a.public_id', '=', uuidToBin(p.subject))
            .where('m.institution_id', '=', inst.id)
            .execute()
        ).map((r) => r.code)
      : [];
    const variant =
      HOME_VARIANT.find(([code]) => roles.includes(code))?.[1] ??
      (p.subTasks.includes('members.edit') ? 'admin' : 'management');
    const today = istBusinessDate(this.now());
    const i = inst.id;
    const one = async (q: RawBuilder<Row>) => (await q.execute(db)).rows[0] ?? {};
    const n = (v: unknown) => Number(v ?? 0);
    const money = (v: unknown) => toMoneyDto(BigInt(String(v ?? 0)));
    const year = await yearFor(db, i, null).catch(() => null);
    const studentsToday = async () => {
      const r = await one(
        sql`SELECT COUNT(*) AS students,
              (SELECT COUNT(*) FROM attendance_days d JOIN member_profiles m2 ON m2.id = d.profile_id
                 JOIN user_types u2 ON u2.id = m2.user_type_id
               WHERE d.institution_id = ${i} AND d.att_date = ${today} AND u2.category = 'STUDENT'
                 AND d.status IN ('PRESENT', 'LATE', 'HALF_DAY')) AS attended,
              (SELECT COUNT(*) FROM attendance_days d JOIN member_profiles m2 ON m2.id = d.profile_id
                 JOIN user_types u2 ON u2.id = m2.user_type_id
               WHERE d.institution_id = ${i} AND d.att_date = ${today} AND u2.category = 'STUDENT'
                 AND d.status = 'ABSENT') AS absent
            FROM member_profiles m JOIN user_types ut ON ut.id = m.user_type_id
            WHERE m.institution_id = ${i} AND m.status = 'ACTIVE' AND ut.category = 'STUDENT'`,
      );
      const total = n(r['students']);
      return {
        students: total,
        attended: n(r['attended']),
        absent: n(r['absent']),
        percentage: total ? Math.round((n(r['attended']) * 1000) / total) / 10 : null,
      };
    };
    const members = async () => {
      const r = await one(
        sql`SELECT SUM(status = 'ACTIVE') AS active, SUM(status = 'INACTIVE') AS inactive,
              SUM(status = 'SUSPENDED') AS suspended FROM member_profiles WHERE institution_id = ${i}`,
      );
      return { active: n(r['active']), inactive: n(r['inactive']), suspended: n(r['suspended']) };
    };
    const paymentsSince = async (from: Date) => {
      const r = await one(
        sql`SELECT COUNT(*) AS n, COALESCE(SUM(amount_paise), 0) AS paise FROM payment_attempts
            WHERE institution_id = ${i} AND status = 'SUCCESS' AND completed_at >= ${from}`,
      );
      return { count: n(r['n']), amount: money(r['paise']) };
    };
    const kpis: Record<string, unknown> = {};
    if (variant === 'admin') {
      kpis['members'] = await members();
      kpis['collectionsToday'] = await paymentsSince(startOf(today));
      kpis['attendanceToday'] = await studentsToday();
      kpis['pendingApprovals'] = n(
        (
          await one(
            sql`SELECT COUNT(*) AS n FROM approval_requests WHERE institution_id = ${i} AND status = 'PENDING'`,
          )
        )['n'],
      );
    } else if (variant === 'management') {
      kpis['members'] = await members();
      kpis['collectionsThisMonth'] = await paymentsSince(startOf(`${today.slice(0, 8)}01`));
      const f = year
        ? await one(
            sql`SELECT COALESCE(SUM(amount_paise), 0) AS raised, COALESCE(SUM(paid_paise), 0) AS paid
                FROM fee_records WHERE institution_id = ${i} AND year_id = ${year.id} AND status <> 'CANCELLED'
                  AND due_date <= ${today}`,
          )
        : {};
      kpis['feeCollectionRate'] = n(f['raised'])
        ? Math.round((n(f['paid']) * 1000) / n(f['raised'])) / 10
        : null;
      kpis['attendanceToday'] = await studentsToday();
    } else if (variant === 'accountant') {
      const f = year
        ? await one(
            sql`SELECT
                  (SELECT COALESCE(SUM(c.amount_paise + c.fine_paise), 0) FROM fee_collections c
                     JOIN fee_records r ON r.id = c.record_id WHERE c.institution_id = ${i} AND r.year_id = ${year.id}) AS collected,
                  (SELECT COALESCE(SUM(amount_paise - paid_paise), 0) FROM fee_records
                     WHERE institution_id = ${i} AND year_id = ${year.id} AND status IN ('DUE','PARTIALLY_PAID') AND due_date >= ${today}) AS dueAhead,
                  (SELECT COUNT(*) FROM fee_records WHERE institution_id = ${i} AND year_id = ${year.id} AND status = 'OVERDUE') AS overdue,
                  (SELECT COUNT(DISTINCT r.student_profile_id) FROM fee_records r
                     WHERE r.institution_id = ${i} AND r.year_id = ${year.id} AND r.status <> 'CANCELLED'
                       AND NOT EXISTS (SELECT 1 FROM fee_consents fc WHERE fc.student_profile_id = r.student_profile_id
                         AND (fc.valid_until IS NULL OR fc.valid_until > UTC_TIMESTAMP()))) AS consentPending`,
          )
        : {};
      kpis['collectedThisYear'] = money(f['collected']);
      kpis['dueAhead'] = money(f['dueAhead']);
      kpis['overdue'] = n(f['overdue']);
      kpis['consentPending'] = n(f['consentPending']);
    } else if (variant === 'counsellor') {
      const r = await one(
        sql`SELECT SUM(status = 'SUBMITTED') AS waiting, SUM(status = 'APPROVED') AS admitted,
              SUM(mid_term = 1 AND status IN ('SUBMITTED', 'APPROVED')) AS midTerm
            FROM admission_applications WHERE institution_id = ${i}`,
      );
      kpis['waitingForReview'] = n(r['waiting']);
      kpis['admitted'] = n(r['admitted']);
      kpis['midTermApplications'] = n(r['midTerm']);
    } else if (variant === 'coordinator') {
      const r = year
        ? await one(
            sql`SELECT
                  (SELECT COUNT(*) FROM staff_leaves WHERE institution_id = ${i} AND needs_coordinator = 1
                     AND coordinator_status IS NULL AND final_status IS NULL) AS leaveCount,
                  (SELECT COUNT(*) FROM exams WHERE institution_id = ${i} AND year_id = ${year.id} AND withdrawn_at IS NULL) AS exams,
                  (SELECT COUNT(*) FROM timetable_slots ts JOIN sections s ON s.id = ts.section_id
                     JOIN classes c ON c.id = s.class_id WHERE c.institution_id = ${i}) AS periods`,
          )
        : {};
      kpis['teacherLeaveToReview'] = n(r['leaveCount']);
      kpis['attendanceToday'] = await studentsToday();
      kpis['exams'] = n(r['exams']);
      kpis['periodsAWeek'] = n(r['periods']);
    } else if (variant === 'transport') {
      const r = await one(
        sql`SELECT
              (SELECT COUNT(*) FROM transport_trips WHERE institution_id = ${i} AND trip_date = ${today}) AS trips,
              (SELECT COUNT(*) FROM transport_trips WHERE institution_id = ${i} AND trip_date = ${today} AND status = 'COMPLETED') AS completed,
              (SELECT COUNT(*) FROM transport_allocations WHERE institution_id = ${i} AND active = 1) AS allocated,
              (SELECT COUNT(*) FROM transport_vehicles WHERE institution_id = ${i} AND active = 1) AS vehiclesActive,
              (SELECT COUNT(*) FROM transport_vehicles WHERE institution_id = ${i}) AS vehicles,
              (SELECT COUNT(*) FROM transport_crew WHERE institution_id = ${i}) AS crew,
              (SELECT COUNT(*) FROM transport_trips WHERE institution_id = ${i} AND status = 'CANCELLED'
                 AND trip_date BETWEEN ${addDays(today, -6)} AND ${today}) AS cancelled`,
      );
      kpis['tripsToday'] = { total: n(r['trips']), completed: n(r['completed']) };
      kpis['passengersAllocated'] = n(r['allocated']);
      kpis['vehicles'] = {
        inService: n(r['vehiclesActive']),
        total: n(r['vehicles']),
        crew: n(r['crew']),
      };
      kpis['cancelledThisWeek'] = n(r['cancelled']);
    } else if (variant === 'grievance') {
      const r = await one(
        sql`SELECT SUM(status = 'OPEN') AS open,
              SUM(status IN ('ESCALATED_VENDOR', 'ESCALATED_INTERNAL')) AS escalated,
              SUM(status IN ('RESOLVED', 'CLOSED')) AS done,
              (SELECT COUNT(*) FROM approval_requests WHERE institution_id = ${i} AND status = 'PENDING'
                 AND module = 'GRIEVANCE_UPDATE') AS awaiting
            FROM tickets WHERE institution_id = ${i}`,
      );
      kpis['open'] = n(r['open']);
      kpis['escalated'] = n(r['escalated']);
      kpis['awaitingChecker'] = n(r['awaiting']);
      kpis['resolvedOrClosed'] = n(r['done']);
    } else {
      const r = await one(
        sql`SELECT
              (SELECT COUNT(*) FROM attendance_days d JOIN terminals t ON t.id = d.terminal_id
                 WHERE d.institution_id = ${i} AND d.att_date = ${today} AND t.purpose = 'ATTENDANCE') AS gate,
              (SELECT COUNT(*) FROM attendance_days d JOIN terminals t ON t.id = d.terminal_id
                 WHERE d.institution_id = ${i} AND d.att_date = ${today} AND t.purpose = 'ATTENDANCE'
                   AND d.checkin_status = 'LATE') AS late,
              (SELECT COUNT(*) FROM terminals WHERE institution_id = ${i} AND status = 'ACTIVE'
                 AND purpose IN ('ATTENDANCE', 'PERIOD_ATTENDANCE', 'LOCATION')) AS readers,
              (SELECT COUNT(*) FROM terminals WHERE institution_id = ${i} AND status = 'ACTIVE'
                 AND purpose IN ('ATTENDANCE', 'PERIOD_ATTENDANCE', 'LOCATION')
                 AND last_seen_at >= ${new Date(this.now().getTime() - 10 * 60_000)}) AS online,
              (SELECT COUNT(*) FROM location_attendance WHERE institution_id = ${i}
                 AND at >= ${startOf(today)}) AS locations`,
      );
      kpis['gateCheckInsToday'] = { total: n(r['gate']), late: n(r['late']) };
      kpis['attendanceToday'] = await studentsToday();
      kpis['readers'] = { online: n(r['online']), total: n(r['readers']) };
      kpis['locationCheckInsToday'] = n(r['locations']);
    }
    return {
      variant,
      date: today,
      year: year ? { id: year.publicId, label: year.label } : null,
      kpis,
    };
  }
}
