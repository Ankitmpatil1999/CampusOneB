/**
 * Grievances (SRS 16; GRV-001…014; RC-20; OI-GRV-01…11 adopted; Q14 M16; prototype m.tickets,
 * m.ticket, m.feedback, m.fraud, c.grievances).
 *
 * - A member raises a ticket against a transaction of their own wallet (a party to it — OI-GRV-02),
 *   a failed attempt included; one ticket that is not Closed per profile and transaction (a unique
 *   key). Feedback and fraud reports are tickets of their own kind with their own numbers, and reach
 *   the institution's console (OI-GRV-07, OI-GRV-08).
 * - The console works the queue: status, priority, a reason, the resolution and a comment for the
 *   history; Closed is read-only; transitions follow RC-20. A Priority-1 update waits as an approval
 *   request and the ticket shows "awaiting approval" until a checker decides. A refund resolution
 *   needs Priority 1: the checker's approval is the refund's approval and posts the ledger refund
 *   (Q14 M16). The member is told of every applied update (OI-GRV-05).
 * - Calls are logged with or without a ticket. The support desk looks tickets and a member's last
 *   transactions up across institutions; every look-up is recorded with its reason (RNG-GOV-008).
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import { PAYMENT_ATTEMPT } from '../config/registers';
import { checkTransition, LIMITS, TICKET, type MessageKey } from '../config/registers';
import type { Database, TicketChannel, TicketKind, TicketStatus } from '../models/ringpe_models';
import {
  CustomAPIError,
  NotFoundError,
  PreconditionFailedError,
  ValidationError,
} from '../utils/CustomAPIError';
import { formatInr, istBusinessDate } from '../utils/format';
import { binToUuid, isUuid, newPublicIdPair, uuidToBin } from '../utils/idGenerator';
import { toMoneyDto } from '../utils/money';
import { emit, rooms } from '../utils/outbox';
import type { Principal } from '../utils/principal';
import { raiseApproval } from './approvals.service';
import { recordAudit } from './audit.service';
import { notify } from './notifications.service';
import type { RefundsService } from './refunds.service';
import { defaultValues, type SettingValues } from './settings.service';

type Db = Kysely<Database> | Transaction<Database>;

/** What went wrong (prototype m.tickets). */
export const TICKET_CATEGORIES = {
  DEBITED_NOT_PAID: 'Money debited but payment failed',
  PAID_TWICE: 'Paid twice for one purchase',
  MERCHANT_NOT_RECEIVED: 'Merchant says payment not received',
  WRONG_AMOUNT: 'Wrong amount',
  NOT_AUTHORISED: 'Didn’t authorise this payment',
  OTHER: 'Something else',
} as const;
export const FEEDBACK_KINDS = {
  FEEDBACK: 'Feedback',
  GRIEVANCE: 'Grievance',
  SUGGESTION: 'Suggestion',
} as const;
export const FRAUD_CATEGORIES = {
  OTP_PIN_ASKED: 'Someone asked for my OTP or PIN',
  UNKNOWN_PAYMENT: 'Payment I didn’t make',
  FAKE_QR: 'Fake QR code at a counter',
  SUSPICIOUS_MESSAGE: 'Suspicious message or link',
  OTHER: 'Other',
} as const;
/** Vendor-neutral reasons per status (OI-GRV-10); "OTHER" needs the resolution text. */
export const TICKET_REASONS: Record<Exclude<TicketStatus, 'OPEN'>, Record<string, string>> = {
  ESCALATED_VENDOR: {
    PAYMENT_PARTNER: 'Escalated to the payment partner',
    BANK: 'Escalated to the bank',
    NETWORK: 'Escalated to the payment network',
    OTHER: 'Other',
  },
  ESCALATED_INTERNAL: {
    RECON_TEAM: 'Escalated to reconciliation',
    TECH_TEAM: 'Escalated to the technical team',
    OPERATIONS: 'Escalated to operations',
    OTHER: 'Other',
  },
  RESOLVED: {
    REFUNDED: 'Refunded — issue resolved',
    TECH_RESOLVED: 'Technical issue resolved',
    CLARIFIED: 'Clarified to the member',
    SUGGESTION_ACCEPTED: 'Suggestion accepted',
    OTHER: 'Other',
  },
  CLOSED: {
    REFUNDED: 'Refunded — issue closed',
    TECH_RESOLVED: 'Technical issue resolved',
    CLARIFIED: 'Clarified to the member — issue closed',
    SUGGESTION_ACCEPTED: 'Suggestion accepted — issue closed',
    DUPLICATE: 'Duplicate of another ticket',
    OTHER: 'Other',
  },
};
const PREFIX: Record<TicketKind, string> = { TRANSACTION: 'TKT', FEEDBACK: 'FBK', FRAUD: 'FRD' };
/** Letters, numbers and basic punctuation (prototype m.tickets); never markup or control characters. */
/** Any text but markup and code symbols or control characters (line breaks and tabs allowed). */
const TEXT = /^(?:[^<>{}\\`\p{Cc}]|[\n\r\t])+$/u;
const DONE: readonly TicketStatus[] = ['RESOLVED', 'CLOSED'];

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);
const nameOf = (first: string | null | undefined, last: string | null | undefined) =>
  [first, last]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .replace(/(^|[\s.'-])([a-z])/g, (_m, a: string, b: string) => a + b.toUpperCase());
const maskMobile = (m: string | null | undefined) =>
  m ? `•••••• ${m.replace(/\D/g, '').slice(-4)}` : null;
const statusLabel = (s: TicketStatus) => TICKET.values.find((v) => v.code === s)!.label;

export interface TicketUpdate {
  readonly status: TicketStatus;
  readonly priority: number;
  readonly reasonCode?: string | null | undefined;
  readonly resolution?: string | null | undefined;
  readonly comment: string;
  /** A refund resolution (Priority 1 only): the amount, or the whole transaction. */
  readonly refund?: { readonly amountPaise?: number | undefined } | null | undefined;
}

export class GrievancesService {
  constructor(
    private readonly deps: {
      readonly db: Kysely<Database>;
      readonly refunds: RefundsService;
      readonly members?: { adminSelfApplies(db: Kysely<Database>, p: Principal): Promise<boolean> };
      /** Signed links to the member's screenshot (console detail). */
      readonly files?: { linkFor(fileId: string): { url: string; expiresAt: string } };
      readonly settings?: { values(): Promise<SettingValues> };
      readonly now?: () => Date;
    },
  ) {}

  private now() {
    return this.deps.now?.() ?? new Date();
  }

  private async limit(l: { key: string; value: number }) {
    const v = this.deps.settings ? await this.deps.settings.values() : defaultValues();
    return Number(v[l.key] ?? l.value);
  }

  private by(p: Principal) {
    if (!isUuid(p.subject)) throw new NotFoundError();
    return uuidToBin(p.subject);
  }

  // --- the member ----------------------------------------------------------------------------------------
  private async self(p: Principal) {
    if (!isUuid(p.subject) || !p.profileId || !isUuid(p.profileId)) throw new NotFoundError();
    const m = await this.deps.db
      .selectFrom('member_profiles as m')
      .innerJoin('platform_accounts as a', 'a.id', 'm.account_id')
      .select(['m.id', 'm.public_id', 'm.institution_id', 'm.account_id'])
      .where('a.public_id', '=', uuidToBin(p.subject))
      .where('m.public_id', '=', uuidToBin(p.profileId))
      .executeTakeFirst();
    if (!m) throw new NotFoundError();
    return {
      rowId: String(m.id),
      institutionId: String(m.institution_id),
      accountId: m.account_id === null ? null : String(m.account_id),
    };
  }

  private async text(value: string | undefined, field: string, min: number, max: number) {
    const t = (value ?? '').trim();
    if (t.length < min || t.length > max || !TEXT.test(t)) {
      throw new ValidationError([{ field, code: 'GRV.ISSUE_FORMAT', params: { min, max } }]);
    }
    return t;
  }

  private async attachment(p: Principal, id: string | null | undefined) {
    if (!id) return null;
    if (!isUuid(id)) throw new ValidationError([{ field: 'attachmentId', code: 'GRV.ATTACHMENT' }]);
    const f = await this.deps.db
      .selectFrom('files')
      .select(['id', 'scan_status', 'purpose'])
      .where('public_id', '=', uuidToBin(id))
      .where('created_by', '=', this.by(p))
      .executeTakeFirst();
    if (
      !f ||
      f.scan_status === 'INFECTED' ||
      !['evidence', 'photo', 'document'].includes(f.purpose)
    ) {
      throw new ValidationError([{ field: 'attachmentId', code: 'GRV.ATTACHMENT' }]);
    }
    return String(f.id);
  }

  /** The transaction a member reports: a ledger movement of their wallet, or a payment attempt of theirs. */
  private async transactionOf(me: { rowId: string; institutionId: string }, reference: string) {
    const ref = reference.trim().toUpperCase();
    const db = this.deps.db;
    const t = await db
      .selectFrom('ledger_transactions')
      .select(['id', 'institution_id', 'reference', 'type', 'amount_paise', 'posted_at'])
      .where('reference', '=', ref)
      .executeTakeFirst();
    if (t && String(t.institution_id) === me.institutionId) {
      const wallets = await db
        .selectFrom('ledger_entries as e')
        .innerJoin('wallets as w', 'w.id', 'e.wallet_id')
        .select(['w.owner_profile_id'])
        .where('e.ledger_txn_id', '=', t.id)
        .execute();
      if (!wallets.some((w) => String(w.owner_profile_id) === me.rowId)) {
        throw new CustomAPIError(403, 'GRV.NOT_A_PARTY');
      }
      return {
        ledgerTxnId: String(t.id),
        reference: t.reference,
        type: t.type,
        amount: Number(t.amount_paise),
        at: new Date(t.posted_at),
        status: 'Success',
      };
    }
    // A failed or pending payment has no ledger movement: its attempt.
    const a = await db
      .selectFrom('payment_attempts')
      .select([
        'reference',
        'channel',
        'amount_paise',
        'attempted_at',
        'status',
        'payer_profile_id',
        'payee_profile_id',
      ])
      .where('institution_id', '=', me.institutionId)
      .where('reference', '=', ref)
      .executeTakeFirst();
    if (!a) throw new CustomAPIError(404, 'GRV.TXN_NOT_FOUND');
    if (String(a.payer_profile_id) !== me.rowId && String(a.payee_profile_id) !== me.rowId) {
      throw new CustomAPIError(403, 'GRV.NOT_A_PARTY');
    }
    return {
      ledgerTxnId: null,
      reference: a.reference,
      type: a.channel === 'TRANSFER' ? 'TRANSFER' : 'PAYMENT',
      amount: Number(a.amount_paise),
      at: new Date(a.attempted_at),
      status: a.status === 'SUCCESS' ? 'Success' : a.status === 'PENDING' ? 'Pending' : 'Failure',
    };
  }

  private async insert(
    trx: Transaction<Database>,
    v: {
      institutionId: string;
      kind: TicketKind;
      profileId: string;
      accountId: string | null;
      channel: TicketChannel;
      category: string | null;
      issue: string;
      txn?: {
        ledgerTxnId: string | null;
        reference: string;
        type: string;
        amount: number;
        at: Date;
      } | null;
      fraudAt?: Date | null;
      fraudLocation?: string | null;
      attachmentId?: string | null;
      actor: Buffer;
    },
  ) {
    const at = this.now();
    const pub = newPublicIdPair();
    const ins = await trx
      .insertInto('tickets')
      .values({
        public_id: pub.bin,
        institution_id: v.institutionId,
        kind: v.kind,
        profile_id: v.profileId,
        account_id: v.accountId,
        ledger_txn_id: v.txn?.ledgerTxnId ?? null,
        transaction_ref: v.txn?.reference ?? null,
        txn_type: v.txn?.type ?? null,
        txn_amount_paise: v.txn?.amount ?? null,
        txn_at: v.txn?.at ?? null,
        category: v.category,
        issue: v.issue,
        channel: v.channel,
        fraud_at: v.fraudAt ?? null,
        fraud_location: v.fraudLocation ?? null,
        attachment_file_id: v.attachmentId ?? null,
        created_at: at,
        updated_at: at,
      })
      .executeTakeFirstOrThrow();
    const rowId = String(ins.insertId);
    const no = `${PREFIX[v.kind]}-${rowId.padStart(6, '0')}`;
    await trx.updateTable('tickets').set({ ticket_no: no }).where('id', '=', rowId).execute();
    await trx
      .insertInto('ticket_events')
      .values({
        ticket_id: rowId,
        institution_id: v.institutionId,
        status: 'OPEN',
        priority: 2,
        comments: null,
        actor_type: 'MEMBER',
        actor_ref: v.actor,
        at,
      })
      .execute();
    await emit(trx, {
      institutionId: v.institutionId,
      type: 'ticket.updated',
      rooms: [rooms.institutionConsole(v.institutionId)],
      data: { ticket: pub.id },
    });
    await recordAudit(trx, {
      institutionId: v.institutionId,
      action: 'TICKET_RAISED',
      entityType: 'ticket',
      entityRef: pub.id,
      after: { ticketNo: no, kind: v.kind, reference: v.txn?.reference ?? null },
    });
    return { id: pub.id, ticketNo: no };
  }

  /** GRV-001: a ticket against a transaction of the member's own wallet. */
  async raise(
    p: Principal,
    input: { transactionRef: string; category: string; issue: string; channel?: 'APP' | 'WEB' },
  ) {
    const me = await this.self(p);
    if (!(input.category in TICKET_CATEGORIES)) {
      throw new ValidationError([{ field: 'category', code: 'GRV.CATEGORY' }]);
    }
    const issue = await this.text(
      input.issue,
      'issue',
      await this.limit(LIMITS.grievanceIssueMin),
      await this.limit(LIMITS.grievanceIssueMax),
    );
    const txn = await this.transactionOf(me, input.transactionRef ?? '');
    try {
      const out = await this.deps.db.transaction().execute(async (trx) => {
        const live = await trx
          .selectFrom('tickets')
          .select('id')
          .where('profile_id', '=', me.rowId)
          .where('kind', '=', 'TRANSACTION')
          .where('transaction_ref', '=', txn.reference)
          .where('status', '<>', 'CLOSED')
          .executeTakeFirst();
        if (live) throw new CustomAPIError(409, 'GRV.TICKET_OPEN_EXISTS');
        return this.insert(trx, {
          institutionId: me.institutionId,
          kind: 'TRANSACTION',
          profileId: me.rowId,
          accountId: me.accountId,
          channel: input.channel ?? 'APP',
          category: input.category,
          issue,
          txn,
          actor: this.by(p),
        });
      });
      return { ...(await this.myTicket(p, out.id)), code: 'GRV.RAISED' as MessageKey };
    } catch (e) {
      if ((e as { errno?: number }).errno === 1062) {
        throw new CustomAPIError(409, 'GRV.TICKET_OPEN_EXISTS');
      }
      throw e;
    }
  }

  /** GRV-004: feedback, a general grievance or a suggestion, to the member's institution. */
  async feedback(
    p: Principal,
    input: { kind?: string; text: string; attachmentId?: string | null; channel?: 'APP' | 'WEB' },
  ) {
    const me = await this.self(p);
    const kind = input.kind ?? 'FEEDBACK';
    if (!(kind in FEEDBACK_KINDS)) {
      throw new ValidationError([{ field: 'kind', code: 'VALIDATION.FORMAT' }]);
    }
    const text = await this.text(input.text, 'text', 10, 1000);
    const attachmentId = await this.attachment(p, input.attachmentId);
    const out = await this.deps.db.transaction().execute((trx) =>
      this.insert(trx, {
        institutionId: me.institutionId,
        kind: 'FEEDBACK',
        profileId: me.rowId,
        accountId: me.accountId,
        channel: input.channel ?? 'APP',
        category: kind,
        issue: text,
        attachmentId,
        actor: this.by(p),
      }),
    );
    return { id: out.id, feedbackNo: out.ticketNo, code: 'GRV.FEEDBACK_RECEIVED' as MessageKey };
  }

  /** GRV-005: a report of suspected fraud, with its own number (OI-GRV-08). */
  async fraud(
    p: Principal,
    input: {
      category: string;
      details: string;
      happenedOn?: string | undefined;
      location?: string | undefined;
      transactionRef?: string | undefined;
      attachmentId?: string | null;
      channel?: 'APP' | 'WEB';
    },
  ) {
    const me = await this.self(p);
    if (!(input.category in FRAUD_CATEGORIES)) {
      throw new ValidationError([{ field: 'category', code: 'GRV.CATEGORY' }]);
    }
    const details = await this.text(input.details, 'details', 15, 800);
    if (input.happenedOn && input.happenedOn > istBusinessDate(this.now())) {
      throw new ValidationError([{ field: 'happenedOn', code: 'VALIDATION.DATE' }]);
    }
    const txn = input.transactionRef?.trim()
      ? await this.transactionOf(me, input.transactionRef)
      : null;
    const attachmentId = await this.attachment(p, input.attachmentId);
    const out = await this.deps.db.transaction().execute((trx) =>
      this.insert(trx, {
        institutionId: me.institutionId,
        kind: 'FRAUD',
        profileId: me.rowId,
        accountId: me.accountId,
        channel: input.channel ?? 'APP',
        category: input.category,
        issue: details,
        txn,
        fraudAt: input.happenedOn ? new Date(`${input.happenedOn}T12:00:00+05:30`) : null,
        fraudLocation: input.location?.trim().slice(0, 200) || null,
        attachmentId,
        actor: this.by(p),
      }),
    );
    return { id: out.id, reportNo: out.ticketNo };
  }

  private ticketRows(db: Db) {
    return db
      .selectFrom('tickets as t')
      .innerJoin('member_profiles as m', 'm.id', 't.profile_id')
      .leftJoin('platform_accounts as a', 'a.id', 't.account_id')
      .selectAll('t')
      .select([
        'm.public_id as profile_public_id',
        'm.first_name',
        'm.last_name',
        'a.mobile',
        (eb) =>
          eb
            .selectFrom('approval_requests as ar')
            .select('ar.public_id')
            .where('ar.module', '=', 'GRIEVANCE_UPDATE')
            .whereRef('ar.subject_ref', '=', 't.public_id')
            .where('ar.status', '=', 'PENDING')
            .limit(1)
            .as('pending_approval'),
      ]);
  }

  private ticketView(
    t: Awaited<ReturnType<ReturnType<GrievancesService['ticketRows']>['execute']>>[number],
    ageingDays: number,
  ) {
    const now = this.now().getTime();
    const age = Math.floor((now - new Date(t.created_at).getTime()) / 86_400_000);
    const category =
      t.kind === 'TRANSACTION'
        ? TICKET_CATEGORIES[t.category as keyof typeof TICKET_CATEGORIES]
        : t.kind === 'FEEDBACK'
          ? FEEDBACK_KINDS[t.category as keyof typeof FEEDBACK_KINDS]
          : FRAUD_CATEGORIES[t.category as keyof typeof FRAUD_CATEGORIES];
    return {
      id: binToUuid(t.public_id),
      ticketNo: t.ticket_no ?? '',
      kind: t.kind,
      category: t.category,
      categoryLabel: category ?? t.category,
      issue: t.issue,
      channel: t.channel,
      status: t.status,
      statusLabel: statusLabel(t.status),
      priority: t.priority,
      awaitingApproval: t.pending_approval ? binToUuid(t.pending_approval) : null,
      reasonCode: t.reason_code,
      resolution: t.resolution,
      member: {
        id: binToUuid(t.profile_public_id),
        name: nameOf(t.first_name, t.last_name),
        mobile: maskMobile(t.mobile),
      },
      transaction: t.transaction_ref
        ? {
            reference: t.transaction_ref,
            type: t.txn_type,
            amount: t.txn_amount_paise === null ? null : toMoneyDto(Number(t.txn_amount_paise)),
            at: iso(t.txn_at),
          }
        : null,
      fraud:
        t.kind === 'FRAUD'
          ? {
              happenedOn: t.fraud_at ? istBusinessDate(t.fraud_at) : null,
              location: t.fraud_location,
            }
          : null,
      hasAttachment: t.attachment_file_id !== null,
      createdAt: iso(t.created_at),
      updatedAt: iso(t.updated_at),
      closedAt: iso(t.closed_at),
      ageDays: age,
      old: !DONE.includes(t.status) && age >= ageingDays,
      version: t.row_version,
    };
  }

  private async history(db: Db, ticketRowId: string) {
    const rows = await db
      .selectFrom('ticket_events as e')
      .leftJoin('platform_accounts as a', 'a.public_id', 'e.actor_ref')
      .select([
        'e.status',
        'e.priority',
        'e.reason_code',
        'e.resolution',
        'e.comments',
        'e.actor_type',
        'e.approval_id',
        'e.at',
        'a.first_name',
        'a.last_name',
      ])
      .where('e.ticket_id', '=', ticketRowId)
      .orderBy('e.id', 'desc')
      .execute();
    return rows.map((e) => ({
      status: e.status,
      statusLabel: statusLabel(e.status),
      priority: e.priority,
      reasonCode: e.reason_code,
      resolution: e.resolution,
      comment: e.comments,
      by:
        e.actor_type === 'MEMBER'
          ? 'You'
          : e.actor_type === 'SYSTEM'
            ? 'RingPe'
            : nameOf(e.first_name, e.last_name) ||
              (e.actor_type === 'OPERATOR' ? 'RingPe support' : 'School office'),
      byType: e.actor_type,
      approved: e.approval_id !== null,
      at: iso(e.at),
    }));
  }

  /** GRV-002: the member's tickets, newest first. */
  async myTickets(
    p: Principal,
    f: {
      status?: 'open' | 'closed' | undefined;
      transactionRef?: string | undefined;
      cursor?: string | undefined;
    },
  ) {
    const me = await this.self(p);
    const ageing = await this.limit(LIMITS.grievanceAgeingDays);
    let q = this.ticketRows(this.deps.db).where('t.profile_id', '=', me.rowId);
    if (f.status === 'open') q = q.where('t.status', 'not in', [...DONE]);
    if (f.status === 'closed') q = q.where('t.status', 'in', [...DONE]);
    if (f.transactionRef) {
      q = q.where('t.transaction_ref', '=', f.transactionRef.trim().toUpperCase());
    }
    if (f.cursor && /^\d+$/.test(f.cursor)) q = q.where('t.id', '<', f.cursor);
    const rows = await q.orderBy('t.id', 'desc').limit(51).execute();
    const page = rows.slice(0, 50);
    const counts = await this.deps.db
      .selectFrom('tickets')
      .select([
        sql<number>`COUNT(*)`.as('all'),
        sql<number>`SUM(status NOT IN ('RESOLVED','CLOSED'))`.as('open'),
      ])
      .where('profile_id', '=', me.rowId)
      .executeTakeFirst();
    return {
      counts: {
        all: Number(counts?.all ?? 0),
        open: Number(counts?.open ?? 0),
        closed: Number(counts?.all ?? 0) - Number(counts?.open ?? 0),
      },
      items: page.map((t) => this.ticketView(t, ageing)),
      nextCursor: rows.length > 50 ? String(page.at(-1)!.id) : null,
    };
  }

  /** GRV-003: one of the member's tickets with its history. */
  async myTicket(p: Principal, id: string) {
    const me = await this.self(p);
    if (!isUuid(id)) throw new CustomAPIError(404, 'GRV.TICKET_NOT_FOUND');
    const t = await this.ticketRows(this.deps.db)
      .where('t.public_id', '=', uuidToBin(id))
      .where('t.profile_id', '=', me.rowId)
      .executeTakeFirst();
    if (!t) throw new CustomAPIError(404, 'GRV.TICKET_NOT_FOUND');
    return {
      ...this.ticketView(t, await this.limit(LIMITS.grievanceAgeingDays)),
      history: await this.history(this.deps.db, String(t.id)),
    };
  }

  /** GRV-014: the member closes a resolved ticket ("I'm satisfied"). */
  async closeMine(p: Principal, id: string) {
    const me = await this.self(p);
    if (!isUuid(id)) throw new CustomAPIError(404, 'GRV.TICKET_NOT_FOUND');
    await this.deps.db.transaction().execute(async (trx) => {
      const t = await trx
        .selectFrom('tickets')
        .selectAll()
        .where('public_id', '=', uuidToBin(id))
        .where('profile_id', '=', me.rowId)
        .forUpdate()
        .executeTakeFirst();
      if (!t) throw new CustomAPIError(404, 'GRV.TICKET_NOT_FOUND');
      if (t.status !== 'RESOLVED') throw new CustomAPIError(409, 'GRV.NOT_RESOLVED');
      const at = this.now();
      await trx
        .updateTable('tickets')
        .set({
          status: 'CLOSED',
          closed_at: at,
          updated_at: at,
          row_version: sql<number>`row_version + 1`,
        })
        .where('id', '=', t.id)
        .where('status', '=', 'RESOLVED')
        .execute();
      await trx
        .insertInto('ticket_events')
        .values({
          ticket_id: t.id,
          institution_id: t.institution_id,
          status: 'CLOSED',
          priority: t.priority,
          comments: 'Closed by the member',
          actor_type: 'MEMBER',
          actor_ref: this.by(p),
          at,
        })
        .execute();
      await emit(trx, {
        institutionId: String(t.institution_id),
        type: 'ticket.updated',
        rooms: [rooms.institutionConsole(String(t.institution_id))],
        data: { ticket: id },
      });
    });
    return this.myTicket(p, id);
  }

  // --- the console -----------------------------------------------------------------------------------------
  private async inst(p: Principal) {
    if (!p.institutionId || !isUuid(p.institutionId)) throw new NotFoundError();
    const i = await this.deps.db
      .selectFrom('institutions')
      .select('id')
      .where('public_id', '=', uuidToBin(p.institutionId))
      .executeTakeFirst();
    if (!i) throw new NotFoundError();
    return String(i.id);
  }

  /** GRV-006: the institution's queue with the summary tiles (16.7; ageing from creation, OI-GRV-09). */
  async list(
    p: Principal,
    f: {
      status?: TicketStatus | 'ESCALATED' | 'AWAITING_APPROVAL' | undefined;
      priority?: number | undefined;
      kind?: TicketKind | undefined;
      q?: string | undefined;
      cursor?: string | undefined;
    },
  ) {
    const institutionId = await this.inst(p);
    const ageing = await this.limit(LIMITS.grievanceAgeingDays);
    const db = this.deps.db;
    const old = new Date(this.now().getTime() - ageing * 86_400_000);
    const tiles = await db
      .selectFrom('tickets as t')
      .select([
        sql<number>`COUNT(*)`.as('total'),
        sql<number>`SUM(t.status = 'OPEN')`.as('open'),
        sql<number>`SUM(t.status IN ('ESCALATED_VENDOR','ESCALATED_INTERNAL'))`.as('escalated'),
        sql<number>`SUM(t.status = 'RESOLVED')`.as('resolved'),
        sql<number>`SUM(t.status = 'CLOSED')`.as('closed'),
        sql<number>`SUM(t.priority = 1 AND t.status NOT IN ('RESOLVED','CLOSED'))`.as('p1'),
        sql<number>`SUM(t.status NOT IN ('RESOLVED','CLOSED') AND t.created_at < ${old})`.as('old'),
        sql<number>`SUM(EXISTS (SELECT 1 FROM approval_requests ar WHERE ar.module = 'GRIEVANCE_UPDATE' AND ar.subject_ref = t.public_id AND ar.status = 'PENDING'))`.as(
          'awaiting',
        ),
      ])
      .where('t.institution_id', '=', institutionId)
      .executeTakeFirst();
    let q = this.ticketRows(db).where('t.institution_id', '=', institutionId);
    if (f.status === 'ESCALATED') {
      q = q.where('t.status', 'in', ['ESCALATED_VENDOR', 'ESCALATED_INTERNAL']);
    } else if (f.status === 'AWAITING_APPROVAL') {
      q = q.where(
        sql<boolean>`EXISTS (SELECT 1 FROM approval_requests ar WHERE ar.module = 'GRIEVANCE_UPDATE' AND ar.subject_ref = t.public_id AND ar.status = 'PENDING')`,
      );
    } else if (f.status) q = q.where('t.status', '=', f.status);
    if (f.priority) q = q.where('t.priority', '=', f.priority);
    if (f.kind) q = q.where('t.kind', '=', f.kind);
    const text = f.q?.trim();
    if (text) {
      const like = `%${text.replace(/[%_\\]/g, '')}%`;
      q = q.where((eb) =>
        eb.or([
          eb('t.ticket_no', 'like', like),
          eb('t.transaction_ref', 'like', like),
          eb(sql`CONCAT(m.first_name, ' ', COALESCE(m.last_name, ''))`, 'like', like),
          eb('t.issue', 'like', like),
        ]),
      );
    }
    if (f.cursor && /^\d+$/.test(f.cursor)) q = q.where('t.id', '<', f.cursor);
    const rows = await q.orderBy('t.id', 'desc').limit(51).execute();
    const page = rows.slice(0, 50);
    const total = Number(tiles?.total ?? 0);
    const tile = (n: unknown) => ({
      count: Number(n ?? 0),
      share: total ? Math.round((Number(n ?? 0) * 100) / total) : 0,
    });
    return {
      tiles: {
        total,
        open: tile(tiles?.open),
        escalated: tile(tiles?.escalated),
        awaitingApproval: tile(tiles?.awaiting),
        resolved: tile(tiles?.resolved),
        closed: tile(tiles?.closed),
        priority1Open: tile(tiles?.p1),
        olderThanAgeing: tile(tiles?.old),
        ageingDays: ageing,
      },
      reasons: TICKET_REASONS,
      items: page.map((t) => this.ticketView(t, ageing)),
      nextCursor: rows.length > 50 ? String(page.at(-1)!.id) : null,
    };
  }

  private async consoleTicket(db: Db, institutionId: string, id: string) {
    if (!isUuid(id)) throw new CustomAPIError(404, 'GRV.TICKET_NOT_FOUND');
    const t = await this.ticketRows(db)
      .where('t.public_id', '=', uuidToBin(id))
      .where('t.institution_id', '=', institutionId)
      .executeTakeFirst();
    if (!t) throw new CustomAPIError(404, 'GRV.TICKET_NOT_FOUND');
    return t;
  }

  /** The member's last five movements and their total count (FR-GRV-04). */
  private async lastTransactions(db: Db, institutionId: string, profileId: string) {
    const wallets = (
      await db
        .selectFrom('wallets')
        .select('id')
        .where('institution_id', '=', institutionId)
        .where('owner_profile_id', '=', profileId)
        .execute()
    ).map((w) => String(w.id));
    if (!wallets.length) return { total: 0, items: [] };
    const base = db
      .selectFrom('ledger_entries as e')
      .innerJoin('ledger_transactions as t', (j) =>
        j.onRef('t.id', '=', 'e.ledger_txn_id').onRef('t.posted_on', '=', 'e.posted_on'),
      )
      .where('e.institution_id', '=', institutionId)
      .where('e.wallet_id', 'in', wallets);
    const total = await base.select(sql<number>`COUNT(*)`.as('n')).executeTakeFirst();
    const items = await base
      .select([
        't.reference',
        't.type',
        't.narration',
        't.posted_at',
        'e.direction',
        'e.amount_paise',
      ])
      .orderBy('e.id', 'desc')
      .limit(5)
      .execute();
    return {
      total: Number(total?.n ?? 0),
      items: items.map((x) => ({
        reference: x.reference,
        type: x.type,
        direction: x.direction === 'C' ? 'CREDIT' : 'DEBIT',
        amount: toMoneyDto(Number(x.amount_paise)),
        remarks: x.narration,
        at: iso(x.posted_at),
      })),
    };
  }

  private async callRows(db: Db, institutionId: string, ticketRowId?: string) {
    let q = db
      .selectFrom('call_logs as c')
      .leftJoin('tickets as t', 't.id', 'c.ticket_id')
      .leftJoin('platform_accounts as a', 'a.public_id', 'c.logged_by')
      .select([
        'c.id',
        'c.public_id',
        'c.direction',
        'c.caller',
        'c.minutes',
        'c.summary',
        'c.source',
        'c.logged_at',
        't.public_id as ticket_public_id',
        't.ticket_no',
        'a.first_name',
        'a.last_name',
      ])
      .where('c.institution_id', '=', institutionId);
    if (ticketRowId) q = q.where('c.ticket_id', '=', ticketRowId);
    return q;
  }

  private callView(c: {
    public_id: Buffer;
    direction: 'INBOUND' | 'OUTBOUND';
    caller: string;
    minutes: number;
    summary: string;
    source: 'CONSOLE' | 'SUPPORT';
    logged_at: Date;
    ticket_public_id: Buffer | null;
    ticket_no: string | null;
    first_name: string | null;
    last_name: string | null;
  }) {
    return {
      id: binToUuid(c.public_id),
      direction: c.direction,
      caller: c.caller,
      minutes: c.minutes,
      summary: c.summary,
      source: c.source,
      ticket: c.ticket_public_id
        ? { id: binToUuid(c.ticket_public_id), ticketNo: c.ticket_no }
        : null,
      loggedBy: nameOf(c.first_name, c.last_name) || null,
      at: iso(c.logged_at),
    };
  }

  /** GRV-007: the ticket with its transaction, the member's last transactions, history and calls. */
  /**
   * The reported transaction as it stands now, with both parties (Phase 6 gap): the payment attempt
   * by its reference, or for a movement without one, the wallets the ledger debited and credited.
   */
  private async transactionParties(db: Db, institutionId: string, reference: string | null) {
    if (!reference) return null;
    // A merchant reads as its shop name (the canteen), not the person behind it.
    const name = async (profileId: string | null) => {
      if (!profileId) return null;
      const shop = await db
        .selectFrom('merchants')
        .select('display_name')
        .where('profile_id', '=', profileId)
        .where('institution_id', '=', institutionId)
        .executeTakeFirst();
      if (shop) return shop.display_name;
      const m = await db
        .selectFrom('member_profiles')
        .select(['first_name', 'last_name'])
        .where('id', '=', profileId)
        .where('institution_id', '=', institutionId)
        .executeTakeFirst();
      return m ? nameOf(m.first_name, m.last_name) : null;
    };
    const a = await db
      .selectFrom('payment_attempts')
      .select(['status', 'channel', 'payer_profile_id', 'payee_profile_id'])
      .where('institution_id', '=', institutionId)
      .where('reference', '=', reference)
      .executeTakeFirst();
    if (a) {
      return {
        status: a.status,
        statusLabel: PAYMENT_ATTEMPT.values.find((v) => v.code === a.status)?.label ?? a.status,
        channel: a.channel,
        payer: await name(a.payer_profile_id === null ? null : String(a.payer_profile_id)),
        payee: await name(a.payee_profile_id === null ? null : String(a.payee_profile_id)),
      };
    }
    const legs = await db
      .selectFrom('ledger_transactions as lt')
      .innerJoin('ledger_entries as e', 'e.ledger_txn_id', 'lt.id')
      .leftJoin('wallets as w', 'w.id', 'e.wallet_id')
      .select(['e.direction', 'w.owner_profile_id'])
      .where('lt.institution_id', '=', institutionId)
      .where('lt.reference', '=', reference)
      .execute();
    if (!legs.length) return null;
    const owner = (d: 'D' | 'C') => {
      const l = legs.find((x) => x.direction === d && x.owner_profile_id !== null);
      return l ? String(l.owner_profile_id) : null;
    };
    return {
      status: 'SUCCESS',
      statusLabel: PAYMENT_ATTEMPT.values.find((v) => v.code === 'SUCCESS')?.label ?? 'Success',
      channel: null,
      payer: await name(owner('D')),
      payee: await name(owner('C')),
    };
  }

  /** The member's screenshot, through a short-lived signed link (never an infected file). */
  private async attachmentLink(db: Db, fileRowId: string | null) {
    if (!fileRowId || !this.deps.files) return null;
    const f = await db
      .selectFrom('files')
      .select(['public_id', 'original_name', 'scan_status'])
      .where('id', '=', fileRowId)
      .executeTakeFirst();
    if (!f || f.scan_status === 'INFECTED') return null;
    return { name: f.original_name, ...this.deps.files.linkFor(binToUuid(f.public_id)) };
  }

  async detail(p: Principal, id: string) {
    const institutionId = await this.inst(p);
    const db = this.deps.db;
    const t = await this.consoleTicket(db, institutionId, id);
    const view = this.ticketView(t, await this.limit(LIMITS.grievanceAgeingDays));
    const parties = await this.transactionParties(db, institutionId, t.transaction_ref);
    const calls = await (
      await this.callRows(db, institutionId, String(t.id))
    )
      .orderBy('c.id', 'desc')
      .execute();
    return {
      ...view,
      transaction: view.transaction ? { ...view.transaction, now: parties } : null,
      attachment: await this.attachmentLink(
        db,
        t.attachment_file_id === null ? null : String(t.attachment_file_id),
      ),
      member: {
        ...this.ticketView(t, 0).member,
        transactions: await this.lastTransactions(db, institutionId, String(t.profile_id)),
      },
      refundable:
        t.kind === 'TRANSACTION' &&
        t.ledger_txn_id !== null &&
        ['PAYMENT', 'TUITION', 'EVENT', 'TRANSFER', 'ALLOWANCE_PAYMENT'].includes(t.txn_type ?? ''),
      reasons: TICKET_REASONS,
      history: await this.history(db, String(t.id)),
      calls: calls.map((c) => this.callView(c)),
    };
  }

  /** The checks every update passes, at request time and again when an approval applies it. */
  private check(
    t: {
      status: TicketStatus;
      priority: number;
      resolution: string | null;
      reason_code: string | null;
    },
    u: TicketUpdate,
    kind: TicketKind,
    ledgerTxn: string | null,
    txnType: string | null,
  ) {
    if (t.status === 'CLOSED') throw new CustomAPIError(409, 'GRV.CLOSED_READ_ONLY');
    if (!u.status) throw new ValidationError([{ field: 'status', code: 'GRV.STATUS_REQUIRED' }]);
    if (u.status !== t.status) {
      const ok = checkTransition(TICKET, t.status, u.status);
      if (!ok.ok) {
        throw new CustomAPIError(409, 'GRV.TRANSITION_INVALID', {
          params: { from: statusLabel(t.status), to: statusLabel(u.status) },
        });
      }
    }
    const comment = u.comment.trim();
    if (comment.length < 5 || comment.length > 400) {
      throw new ValidationError([{ field: 'comment', code: 'GRV.COMMENT' }]);
    }
    const reasons = u.status === 'OPEN' ? {} : TICKET_REASONS[u.status];
    if (u.reasonCode && !(u.reasonCode in reasons)) {
      throw new ValidationError([{ field: 'reasonCode', code: 'GRV.REASON_REQUIRED' }]);
    }
    const resolution = u.resolution?.trim() || null;
    if (DONE.includes(u.status) && !u.reasonCode && !resolution) {
      throw new ValidationError([{ field: 'reasonCode', code: 'GRV.REASON_REQUIRED' }]);
    }
    if (u.reasonCode === 'OTHER' && !resolution) {
      throw new ValidationError([{ field: 'resolution', code: 'GRV.OTHER_COMMENT' }]);
    }
    if (
      u.status === t.status &&
      u.priority === t.priority &&
      (resolution ?? null) === (t.resolution ?? null) &&
      (u.reasonCode ?? null) === (t.reason_code ?? null) &&
      !u.refund
    ) {
      throw new ValidationError([{ field: 'status', code: 'GRV.NOTHING_CHANGED' }]);
    }
    if (u.refund) {
      if (
        kind !== 'TRANSACTION' ||
        !ledgerTxn ||
        !['PAYMENT', 'TUITION', 'EVENT', 'TRANSFER', 'ALLOWANCE_PAYMENT'].includes(txnType ?? '')
      ) {
        throw new CustomAPIError(409, 'GRV.REFUND_NOT_POSSIBLE');
      }
      if (u.priority !== 1)
        throw new ValidationError([{ field: 'priority', code: 'GRV.REFUND_PRIORITY' }]);
    }
    return { comment, resolution };
  }

  /** GRV-008: apply now (Priority 2/3), or wait for a checker (Priority 1, and every refund). */
  async update(p: Principal, id: string, expected: number, u: TicketUpdate) {
    const institutionId = await this.inst(p);
    const by = this.by(p);
    const out = await this.deps.db.transaction().execute(async (trx) => {
      const t = await trx
        .selectFrom('tickets')
        .selectAll()
        .where('public_id', '=', isUuid(id) ? uuidToBin(id) : Buffer.alloc(16))
        .where('institution_id', '=', institutionId)
        .forUpdate()
        .executeTakeFirst();
      if (!t) throw new CustomAPIError(404, 'GRV.TICKET_NOT_FOUND');
      if (t.status === 'CLOSED') throw new CustomAPIError(409, 'GRV.CLOSED_READ_ONLY');
      const waiting = await trx
        .selectFrom('approval_requests')
        .select('id')
        .where('module', '=', 'GRIEVANCE_UPDATE')
        .where('subject_ref', '=', t.public_id)
        .where('status', '=', 'PENDING')
        .executeTakeFirst();
      if (waiting) throw new CustomAPIError(409, 'GRV.UPDATE_PENDING');
      if (t.row_version !== expected) throw new PreconditionFailedError();
      const { comment, resolution } = this.check(t, u, t.kind, t.ledger_txn_id, t.txn_type);
      const at = this.now();
      const payload = {
        ticket: id,
        version: t.row_version,
        status: u.status,
        priority: u.priority,
        reasonCode: u.reasonCode ?? null,
        resolution,
        comment,
        ...(u.refund ? { refundPaise: u.refund.amountPaise ?? null } : {}),
        maker: by.toString('hex'),
      };
      if (u.priority === 1 || t.priority === 1) {
        // An administrator's own request applies directly (ADR-0015) — never a refund (money).
        const direct =
          !u.refund && this.deps.members
            ? await this.deps.members.adminSelfApplies(trx as unknown as Kysely<Database>, p)
            : false;
        const raised = await raiseApproval(trx, {
          institutionId,
          module: 'GRIEVANCE_UPDATE',
          summary:
            `${t.ticket_no} — ${statusLabel(t.status)} → ${statusLabel(u.status)}, Priority ${u.priority}${u.refund ? `, refund ${u.refund.amountPaise ? formatInr(u.refund.amountPaise) : 'in full'}` : ''}: ${comment}`.slice(
              0,
              300,
            ),
          payload,
          makerType: 'staff',
          makerRef: by,
          subjectType: 'ticket',
          subjectRef: t.public_id,
          at,
          appliedDirectly: direct,
        });
        if (direct) {
          await this.applyUpdate(trx, payload, at, {
            checker: by,
            approvalId: null,
            actor: 'STAFF',
          });
          return { approvalId: raised.id, appliedDirectly: true };
        }
        await recordAudit(trx, {
          institutionId,
          action: 'TICKET_UPDATE_REQUESTED',
          entityType: 'ticket',
          entityRef: id,
          after: { status: u.status, priority: u.priority, refund: !!u.refund },
        });
        return { approvalId: raised.id, appliedDirectly: false };
      }
      await this.applyUpdate(trx, payload, at, { checker: by, approvalId: null, actor: 'STAFF' });
      return { approvalId: null, appliedDirectly: true };
    });
    const ticket = await this.detail(p, id);
    return {
      ...out,
      code: (out.approvalId && !out.appliedDirectly
        ? 'GRV.SENT_FOR_APPROVAL'
        : 'GRV.UPDATED') as MessageKey,
      ticket,
    };
  }

  /**
   * Applies an update (now, or when its Priority-1 request is approved — MKR-003): checked again under
   * the ticket's lock; a refund resolution is requested by the maker and processed by the checker in
   * the same transaction (Q14 M16), through the ledger.
   */
  async applyUpdate(
    trx: Transaction<Database>,
    payload: Record<string, unknown>,
    at: Date,
    who: { checker: Buffer; approvalId: string | null; actor: 'STAFF' | 'OPERATOR' },
  ) {
    const id = String(payload['ticket'] ?? '');
    if (!isUuid(id)) throw new CustomAPIError(404, 'GRV.TICKET_NOT_FOUND');
    const t = await trx
      .selectFrom('tickets')
      .selectAll()
      .where('public_id', '=', uuidToBin(id))
      .forUpdate()
      .executeTakeFirst();
    if (!t) throw new CustomAPIError(404, 'GRV.TICKET_NOT_FOUND');
    if (t.row_version !== Number(payload['version'])) throw new PreconditionFailedError();
    const u: TicketUpdate = {
      status: payload['status'] as TicketStatus,
      priority: Number(payload['priority']),
      reasonCode: (payload['reasonCode'] as string | null) ?? null,
      resolution: (payload['resolution'] as string | null) ?? null,
      comment: String(payload['comment'] ?? ''),
      refund:
        'refundPaise' in payload
          ? {
              amountPaise:
                payload['refundPaise'] === null ? undefined : Number(payload['refundPaise']),
            }
          : null,
    };
    const { comment, resolution } = this.check(t, u, t.kind, t.ledger_txn_id, t.txn_type);
    let refundId: string | null = null;
    if (u.refund) {
      const maker =
        typeof payload['maker'] === 'string' ? Buffer.from(payload['maker'], 'hex') : null;
      const r = await this.deps.refunds.createRefund(trx, {
        transactionRef: t.transaction_ref ?? undefined,
        amountPaise: u.refund.amountPaise,
        reason: `${t.ticket_no}: ${resolution ?? comment}`.slice(0, 300),
        source: 'GRIEVANCE',
        requestedBy: maker,
      });
      await this.deps.refunds.process(trx, r.rowId, who.checker, comment, at);
      refundId = r.rowId;
    }
    await trx
      .updateTable('tickets')
      .set({
        status: u.status,
        priority: u.priority,
        reason_code: u.reasonCode ?? null,
        resolution,
        comments: comment,
        ...(refundId ? { refund_id: refundId } : {}),
        ...(u.status === 'CLOSED' ? { closed_at: at } : {}),
        updated_at: at,
        row_version: sql<number>`row_version + 1`,
      })
      .where('id', '=', t.id)
      .execute();
    await trx
      .insertInto('ticket_events')
      .values({
        ticket_id: t.id,
        institution_id: t.institution_id,
        status: u.status,
        priority: u.priority,
        reason_code: u.reasonCode ?? null,
        resolution,
        comments: comment,
        actor_type: who.actor,
        actor_ref:
          typeof payload['maker'] === 'string' ? Buffer.from(payload['maker'], 'hex') : who.checker,
        approval_id: who.approvalId,
        at,
      })
      .execute();
    // The member is told of every applied update (OI-GRV-05).
    if (t.account_id) {
      await notify(
        trx,
        {
          institutionId: String(t.institution_id),
          accountIds: [String(t.account_id)],
          surface: 'MEMBER',
          category: 'ACCOUNT',
          titleKey: 'NTF.TICKET_UPDATED',
          params: { ticketNo: t.ticket_no ?? '', status: statusLabel(u.status) },
          body: resolution ?? comment,
          link: `/tickets/${id}`,
        },
        at,
      );
    }
    await emit(trx, {
      institutionId: String(t.institution_id),
      type: 'ticket.updated',
      rooms: [
        rooms.institutionConsole(String(t.institution_id)),
        rooms.profile(String(t.profile_id)),
      ],
      data: { ticket: id },
    });
    await recordAudit(trx, {
      institutionId: String(t.institution_id),
      action: 'TICKET_UPDATED',
      entityType: 'ticket',
      entityRef: id,
      before: { status: t.status, priority: t.priority },
      after: { status: u.status, priority: u.priority, refund: refundId !== null },
    });
  }

  /** What a Priority-1 request changes, for the approvals queue. */
  async changeRows(db: Db, payload: Record<string, unknown>) {
    const id = String(payload['ticket'] ?? '');
    if (!isUuid(id)) return [];
    const t = await db
      .selectFrom('tickets')
      .select(['status', 'priority', 'resolution', 'txn_amount_paise'])
      .where('public_id', '=', uuidToBin(id))
      .executeTakeFirst();
    if (!t) return [];
    const rows = [
      {
        label: 'Status',
        from: statusLabel(t.status),
        to: statusLabel(payload['status'] as TicketStatus),
      },
      {
        label: 'Priority',
        from: `Priority ${t.priority}`,
        to: `Priority ${Number(payload['priority'])}`,
      },
    ];
    if (payload['resolution']) {
      rows.push({
        label: 'Resolution',
        from: t.resolution ?? '—',
        to: String(payload['resolution']),
      });
    }
    if ('refundPaise' in payload) {
      const amount =
        payload['refundPaise'] === null
          ? Number(t.txn_amount_paise ?? 0)
          : Number(payload['refundPaise']);
      rows.push({ label: 'Refund', from: '—', to: formatInr(amount) });
    }
    return rows;
  }

  // --- calls (GRV-009 / GRV-010 / GRV-013) -------------------------------------------------------------------
  async calls(p: Principal, f: { ticketId?: string | undefined; cursor?: string | undefined }) {
    const institutionId = await this.inst(p);
    let ticketRowId: string | undefined;
    if (f.ticketId)
      ticketRowId = String((await this.consoleTicket(this.deps.db, institutionId, f.ticketId)).id);
    let q = await this.callRows(this.deps.db, institutionId, ticketRowId);
    if (f.cursor && /^\d+$/.test(f.cursor)) q = q.where('c.id', '<', f.cursor);
    const rows = await q.orderBy('c.id', 'desc').limit(51).execute();
    const page = rows.slice(0, 50);
    return {
      items: page.map((c) => this.callView(c)),
      nextCursor: rows.length > 50 ? String(page.at(-1)!.id) : null,
    };
  }

  private callInput(input: { caller: string; minutes: number; summary: string }) {
    const caller = (input.caller ?? '').trim();
    if (caller.length < 2 || caller.length > 100) {
      throw new ValidationError([{ field: 'caller', code: 'GRV.CALL_CALLER' }]);
    }
    if (!Number.isInteger(input.minutes) || input.minutes < 1 || input.minutes > 180) {
      throw new ValidationError([{ field: 'minutes', code: 'GRV.CALL_MINUTES' }]);
    }
    const summary = (input.summary ?? '').trim();
    if (summary.length < 5 || summary.length > 400) {
      throw new ValidationError([{ field: 'summary', code: 'GRV.CALL_NOTES' }]);
    }
    return { caller, summary };
  }

  private async logCallIn(
    institutionId: string,
    ticketRowId: string | null,
    input: { direction: 'INBOUND' | 'OUTBOUND'; caller: string; minutes: number; summary: string },
    source: 'CONSOLE' | 'SUPPORT',
    by: Buffer,
  ) {
    const { caller, summary } = this.callInput(input);
    const pub = newPublicIdPair();
    await this.deps.db.transaction().execute(async (trx) => {
      const at = this.now();
      await trx
        .insertInto('call_logs')
        .values({
          public_id: pub.bin,
          institution_id: institutionId,
          ticket_id: ticketRowId,
          direction: input.direction,
          caller,
          minutes: input.minutes,
          summary,
          source,
          logged_by: by,
          logged_at: at,
        })
        .execute();
      await recordAudit(trx, {
        institutionId,
        action: 'CALL_LOGGED',
        entityType: 'call_log',
        entityRef: pub.id,
        after: { source, minutes: input.minutes, ticket: ticketRowId !== null },
      });
    });
    const row = await (
      await this.callRows(this.deps.db, institutionId)
    )
      .where('c.public_id', '=', pub.bin)
      .executeTakeFirstOrThrow();
    return this.callView(row);
  }

  async logCall(
    p: Principal,
    input: {
      ticketId?: string | null | undefined;
      direction: 'INBOUND' | 'OUTBOUND';
      caller: string;
      minutes: number;
      summary: string;
    },
  ) {
    const institutionId = await this.inst(p);
    const ticketRowId = input.ticketId
      ? String((await this.consoleTicket(this.deps.db, institutionId, input.ticketId)).id)
      : null;
    return this.logCallIn(institutionId, ticketRowId, input, 'CONSOLE', this.by(p));
  }

  // --- the support desk (GRV-011…013; RNG-GOV-008: every look-up recorded) ---------------------------------
  private reason(reason: string | undefined) {
    const r = (reason ?? '').trim();
    if (r.length < 3 || r.length > 200) {
      throw new ValidationError([{ field: 'reason', code: 'GRV.LOOKUP_REASON' }]);
    }
    return r;
  }

  private async institutionRow(publicId: string) {
    if (!isUuid(publicId)) throw new NotFoundError();
    const i = await this.deps.db
      .selectFrom('institutions')
      .select(['id', 'name'])
      .where('public_id', '=', uuidToBin(publicId))
      .executeTakeFirst();
    if (!i) throw new NotFoundError();
    return { id: String(i.id), name: i.name };
  }

  async supportTickets(
    p: Principal,
    f: {
      ticketNo?: string | undefined;
      mobile?: string | undefined;
      institutionId?: string | undefined;
      reason?: string | undefined;
    },
  ) {
    const reason = this.reason(f.reason);
    const ticketNo = f.ticketNo?.trim().toUpperCase();
    const mobile = f.mobile?.replace(/\D/g, '').slice(-10);
    if (!ticketNo && !mobile) {
      throw new ValidationError([{ field: 'ticketNo', code: 'GRV.LOOKUP_CRITERIA' }]);
    }
    const inst = f.institutionId ? await this.institutionRow(f.institutionId) : null;
    let q = this.ticketRows(this.deps.db)
      .innerJoin('institutions as i', 'i.id', 't.institution_id')
      .select(['i.public_id as institution_public_id', 'i.name as institution_name']);
    if (ticketNo) q = q.where('t.ticket_no', '=', ticketNo);
    if (mobile) q = q.where('a.mobile', 'like', `%${mobile}`);
    if (inst) q = q.where('t.institution_id', '=', inst.id);
    const rows = await q.orderBy('t.id', 'desc').limit(20).execute();
    await recordAudit(this.deps.db, {
      institutionId: inst?.id ?? null,
      action: 'SUPPORT_TICKET_LOOKUP',
      entityType: 'ticket',
      after: { ticketNo: ticketNo ?? null, byMobile: !!mobile, found: rows.length },
      reason,
    });
    const ageing = await this.limit(LIMITS.grievanceAgeingDays);
    return {
      items: rows.map((t) => ({
        ...this.ticketView(t, ageing),
        institution: { id: binToUuid(t.institution_public_id), name: t.institution_name },
      })),
    };
  }

  async supportTransactions(
    p: Principal,
    institutionId: string,
    memberId: string,
    reason?: string,
  ) {
    const why = this.reason(reason);
    const inst = await this.institutionRow(institutionId);
    if (!isUuid(memberId)) throw new NotFoundError();
    const m = await this.deps.db
      .selectFrom('member_profiles')
      .select(['id', 'first_name', 'last_name'])
      .where('public_id', '=', uuidToBin(memberId))
      .where('institution_id', '=', inst.id)
      .executeTakeFirst();
    if (!m) throw new NotFoundError();
    await recordAudit(this.deps.db, {
      institutionId: inst.id,
      action: 'SUPPORT_MEMBER_LOOKUP',
      entityType: 'member',
      entityRef: memberId,
      after: { view: 'last-transactions' },
      reason: why,
    });
    return {
      institution: { id: institutionId, name: inst.name },
      member: { id: memberId, name: nameOf(m.first_name, m.last_name) },
      ...(await this.lastTransactions(this.deps.db, inst.id, String(m.id))),
    };
  }

  async supportCall(
    p: Principal,
    input: {
      institutionId: string;
      ticketId?: string | null | undefined;
      direction: 'INBOUND' | 'OUTBOUND';
      caller: string;
      minutes: number;
      summary: string;
    },
  ) {
    const inst = await this.institutionRow(input.institutionId);
    const ticketRowId = input.ticketId
      ? String((await this.consoleTicket(this.deps.db, inst.id, input.ticketId)).id)
      : null;
    return this.logCallIn(inst.id, ticketRowId, input, 'SUPPORT', this.by(p));
  }
}
