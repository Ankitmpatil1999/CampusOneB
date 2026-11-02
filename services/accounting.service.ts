/**
 * Accounting vouchers (SRS 13.13; FEE-034…037; FR-INT-06; OQ-04 open — Q14 M15 example: vouchers
 * pushed to the institution's package with retry; RC-36).
 *
 * - The institution names its accounting company and maps the postings it wants in its books to a
 *   debit and a credit ledger (tuition collections, event payments, allowance funding, refunds).
 * - The job `accounting-vouchers` writes one voucher per mapped ledger posting made since transfers
 *   were turned on (a unique key, so a re-run writes nothing twice) and sends the due ones to the
 *   package. A refusal is kept with its reason and retried after `acc.transfer.retryMinutes`, up to
 *   `acc.transfer.maxAttempts`; then it waits for an officer's retry (FEE-035).
 * - Nothing here moves money: a voucher copies a posting the ledger already holds. Sending never
 *   blocks or reverses a collection (RNG-FEE-124).
 */
import { sql, type Kysely } from 'kysely';
import { LIMITS } from '../config/registers';
import type { AccountingPackage } from '../integrations/accounting.provider';
import type { AccountingEvent, Database, VoucherStatus } from '../models/campusone_models';
import type { JobContext } from '../schedulers';
import {
  CustomAPIError,
  NotFoundError,
  PreconditionFailedError,
  ValidationError,
} from '../utils/CustomAPIError';
import { istBusinessDate } from '../utils/format';
import { binToUuid, isUuid, newPublicIdPair, uuidToBin } from '../utils/idGenerator';
import { toMoneyDto } from '../utils/money';
import type { Principal } from '../utils/principal';
import { recordAudit } from './audit.service';
import { defaultValues, type SettingValues } from './settings.service';

/** The postings an institution can send, and the ledger movement each one is. */
export const ACCOUNTING_EVENTS: Record<AccountingEvent, { label: string; ledgerType: string }> = {
  TUITION: { label: 'Fee collections', ledgerType: 'TUITION' },
  EVENT: { label: 'Event payments', ledgerType: 'EVENT' },
  ALLOWANCE_CREDIT: { label: 'Allowance funding', ledgerType: 'ALLOWANCE_CREDIT' },
  REFUND: { label: 'Refunds', ledgerType: 'REFUND' },
};
const STATUS_LABEL: Record<VoucherStatus, string> = {
  PENDING: 'Pending Transfer',
  TRANSFERRED: 'Transferred',
  FAILED: 'Failed',
};
const NAME = /^[\p{L}\p{N} .,&()'/-]{2,100}$/u;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);
const ymd = (d: Date | string) => (typeof d === 'string' ? d.slice(0, 10) : istBusinessDate(d));

export class AccountingService {
  constructor(
    private readonly deps: {
      readonly db: Kysely<Database>;
      readonly package: AccountingPackage;
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

  // --- the job (accounting-vouchers) ---------------------------------------------------------------------
  async run(ctx: Pick<JobContext, 'item'> & { scope?: { institutionId: string } | undefined }) {
    let q = this.deps.db
      .selectFrom('accounting_settings')
      .select('institution_id')
      .where('enabled', '=', 1)
      .orderBy('institution_id');
    if (ctx.scope) q = q.where('institution_id', '=', ctx.scope.institutionId);
    for (const s of await q.execute()) {
      const id = String(s.institution_id);
      try {
        const written = await this.collect(id);
        const sent = await this.transmitDue(id);
        ctx.item({
          institutionId: id,
          status: sent.failed ? 'FAILED' : written || sent.transferred ? 'SUCCESS' : 'SKIPPED',
          processed: sent.transferred,
          failed: sent.failed,
          note: `${written} vouchers written, ${sent.transferred} transferred, ${sent.failed} failed`,
        });
      } catch {
        ctx.item({
          institutionId: id,
          status: 'FAILED',
          processed: 0,
          failed: 1,
          note: 'Vouchers could not be written; the next run tries again',
        });
      }
    }
  }

  /** One voucher per mapped posting since transfers were turned on (INSERT IGNORE on the unique key). */
  async collect(institutionId: string) {
    const db = this.deps.db;
    const s = await db
      .selectFrom('accounting_settings')
      .selectAll()
      .where('institution_id', '=', institutionId)
      .executeTakeFirst();
    if (!s || !Number(s.enabled) || !s.enabled_at) return 0;
    const maps = await db
      .selectFrom('accounting_mappings')
      .selectAll()
      .where('institution_id', '=', institutionId)
      .execute();
    if (!maps.length) return 0;
    const byType = new Map(maps.map((m) => [ACCOUNTING_EVENTS[m.event].ledgerType, m]));
    const rows = await db
      .selectFrom('ledger_transactions as t')
      .select(['t.id', 't.reference', 't.type', 't.amount_paise', 't.posted_on', 't.narration'])
      .where('t.institution_id', '=', institutionId)
      .where('t.type', 'in', [...byType.keys()] as never[])
      .where('t.posted_at', '>=', new Date(s.enabled_at))
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom('accounting_vouchers as v')
              .select('v.id')
              .where('v.institution_id', '=', institutionId)
              .whereRef('v.ledger_txn_id', '=', 't.id'),
          ),
        ),
      )
      .orderBy('t.id')
      .limit(1000)
      .execute();
    if (!rows.length) return 0;
    const at = this.now();
    const res = await db
      .insertInto('accounting_vouchers')
      .ignore()
      .values(
        rows.map((t) => {
          const m = byType.get(t.type)!;
          return {
            public_id: newPublicIdPair().bin,
            institution_id: institutionId,
            ledger_txn_id: String(t.id),
            reference: t.reference,
            event: m.event,
            voucher_date: ymd(t.posted_on),
            amount_paise: Number(t.amount_paise),
            company_name: s.company_name,
            debit_ledger: m.debit_ledger,
            credit_ledger: m.credit_ledger,
            narration:
              `${ACCOUNTING_EVENTS[m.event].label} · ${t.reference}${t.narration ? ` · ${t.narration}` : ''}`.slice(
                0,
                200,
              ),
            created_at: at,
            updated_at: at,
          };
        }),
      )
      .executeTakeFirst();
    return Number(res.numInsertedOrUpdatedRows ?? 0);
  }

  /** Sends every voucher that is due: new ones, and failed ones whose pause has passed. */
  async transmitDue(institutionId: string) {
    const max = await this.limit(LIMITS.accountingMaxAttempts);
    const now = this.now();
    const due = await this.deps.db
      .selectFrom('accounting_vouchers')
      .select('id')
      .where('institution_id', '=', institutionId)
      .where((eb) =>
        eb.or([
          eb('status', '=', 'PENDING'),
          eb.and([
            eb('status', '=', 'FAILED'),
            eb('attempts', '<', max),
            eb('next_attempt_at', '<=', now),
          ]),
        ]),
      )
      .orderBy('id')
      .limit(500)
      .execute();
    let transferred = 0;
    let failed = 0;
    for (const v of due) {
      const out = await this.send(String(v.id));
      if (out === 'TRANSFERRED') transferred++;
      if (out === 'FAILED') failed++;
    }
    return { transferred, failed };
  }

  /**
   * Sends one voucher; a guarded update keeps two senders from both recording it. A failed voucher is
   * sent with the company and ledgers mapped now, so correcting a mapping lets its retry succeed; the
   * voucher records the names it was last sent with.
   */
  private async send(rowId: string): Promise<VoucherStatus | null> {
    const db = this.deps.db;
    const v = await db
      .selectFrom('accounting_vouchers')
      .selectAll()
      .where('id', '=', rowId)
      .executeTakeFirst();
    if (!v || v.status === 'TRANSFERRED') return null;
    let names = {
      company_name: v.company_name,
      debit_ledger: v.debit_ledger,
      credit_ledger: v.credit_ledger,
    };
    if (v.status === 'FAILED') {
      const now = await db
        .selectFrom('accounting_settings as s')
        .leftJoin('accounting_mappings as m', (j) =>
          j.onRef('m.institution_id', '=', 's.institution_id').on('m.event', '=', v.event),
        )
        .select(['s.company_name', 'm.debit_ledger', 'm.credit_ledger'])
        .where('s.institution_id', '=', String(v.institution_id))
        .executeTakeFirst();
      if (now?.debit_ledger && now.credit_ledger) {
        names = {
          company_name: now.company_name,
          debit_ledger: now.debit_ledger,
          credit_ledger: now.credit_ledger,
        };
      }
    }
    const result = await this.deps.package.send({
      company: names.company_name,
      reference: v.reference,
      date: ymd(v.voucher_date),
      amountPaise: Number(v.amount_paise),
      debitLedger: names.debit_ledger,
      creditLedger: names.credit_ledger,
      narration: v.narration,
    });
    if (!result) return null; // the package is off: the voucher waits.
    const at = this.now();
    const retryMinutes = await this.limit(LIMITS.accountingRetryMinutes);
    const max = await this.limit(LIMITS.accountingMaxAttempts);
    const attempts = v.attempts + 1;
    const set = result.ok
      ? {
          status: 'TRANSFERRED' as const,
          external_ref: result.externalRef,
          transferred_at: at,
          last_error: null,
          next_attempt_at: null,
        }
      : {
          status: 'FAILED' as const,
          last_error: result.reason.slice(0, 300),
          next_attempt_at: attempts < max ? new Date(at.getTime() + retryMinutes * 60_000) : null,
        };
    const r = await db
      .updateTable('accounting_vouchers')
      .set({
        ...set,
        ...names,
        attempts,
        updated_at: at,
        row_version: sql<number>`row_version + 1`,
      })
      .where('id', '=', rowId)
      .where('row_version', '=', v.row_version)
      .executeTakeFirst();
    return Number(r.numUpdatedRows) === 1 ? set.status : null;
  }

  // --- FEE-034 / FEE-035 ---------------------------------------------------------------------------------
  private rows(db: Kysely<Database>) {
    return db.selectFrom('accounting_vouchers as v').selectAll('v');
  }

  private view(v: Awaited<ReturnType<ReturnType<AccountingService['rows']>['execute']>>[number]) {
    return {
      id: binToUuid(v.public_id),
      reference: v.reference,
      event: v.event,
      eventLabel: ACCOUNTING_EVENTS[v.event].label,
      date: ymd(v.voucher_date),
      amount: toMoneyDto(Number(v.amount_paise)),
      company: v.company_name,
      debitLedger: v.debit_ledger,
      creditLedger: v.credit_ledger,
      narration: v.narration,
      status: v.status,
      statusLabel: STATUS_LABEL[v.status],
      attempts: v.attempts,
      lastError: v.last_error,
      nextAttemptAt: iso(v.next_attempt_at),
      externalRef: v.external_ref,
      transferredAt: iso(v.transferred_at),
      createdAt: iso(v.created_at),
      version: v.row_version,
    };
  }

  async list(
    p: Principal,
    f: {
      status?: VoucherStatus | undefined;
      from?: string | undefined;
      to?: string | undefined;
      cursor?: string | undefined;
    },
  ) {
    const institutionId = await this.inst(p);
    for (const [k, d] of [
      ['from', f.from],
      ['to', f.to],
    ] as const) {
      if (d !== undefined && !DAY.test(d))
        throw new ValidationError([{ field: k, code: 'VALIDATION.DATE' }]);
    }
    let q = this.rows(this.deps.db).where('v.institution_id', '=', institutionId);
    if (f.status) q = q.where('v.status', '=', f.status);
    if (f.from) q = q.where('v.voucher_date', '>=', f.from);
    if (f.to) q = q.where('v.voucher_date', '<=', f.to);
    if (f.cursor && /^\d+$/.test(f.cursor)) q = q.where('v.id', '<', f.cursor);
    const rows = await q.orderBy('v.id', 'desc').limit(51).execute();
    const page = rows.slice(0, 50);
    const counts = await this.deps.db
      .selectFrom('accounting_vouchers')
      .select(['status', sql<number>`COUNT(*)`.as('n')])
      .where('institution_id', '=', institutionId)
      .groupBy('status')
      .execute();
    const n = (s: VoucherStatus) => Number(counts.find((c) => c.status === s)?.n ?? 0);
    return {
      mode: this.deps.package.mode,
      counts: { pending: n('PENDING'), transferred: n('TRANSFERRED'), failed: n('FAILED') },
      items: page.map((v) => this.view(v)),
      nextCursor: rows.length > 50 ? String(page.at(-1)!.id) : null,
    };
  }

  /** FEE-035: a failed voucher is sent again now. */
  async retry(p: Principal, id: string) {
    const institutionId = await this.inst(p);
    if (!isUuid(id)) throw new CustomAPIError(404, 'ACC.VOUCHER_NOT_FOUND');
    const v = await this.rows(this.deps.db)
      .where('v.public_id', '=', uuidToBin(id))
      .where('v.institution_id', '=', institutionId)
      .executeTakeFirst();
    if (!v) throw new CustomAPIError(404, 'ACC.VOUCHER_NOT_FOUND');
    if (v.status !== 'FAILED') throw new CustomAPIError(409, 'ACC.NOT_FAILED');
    if (this.deps.package.mode === 'off') throw new CustomAPIError(503, 'ACC.PACKAGE_OFF');
    await recordAudit(this.deps.db, {
      institutionId,
      action: 'VOUCHER_RETRIED',
      entityType: 'accounting_voucher',
      entityRef: id,
      before: { status: v.status, attempts: v.attempts },
    });
    await this.send(String(v.id));
    const after = await this.rows(this.deps.db).where('v.id', '=', v.id).executeTakeFirstOrThrow();
    return this.view(after);
  }

  // --- FEE-036 / FEE-037 ---------------------------------------------------------------------------------
  async mappings(p: Principal) {
    const institutionId = await this.inst(p);
    const db = this.deps.db;
    const s = await db
      .selectFrom('accounting_settings')
      .selectAll()
      .where('institution_id', '=', institutionId)
      .executeTakeFirst();
    const maps = await db
      .selectFrom('accounting_mappings')
      .selectAll()
      .where('institution_id', '=', institutionId)
      .execute();
    return {
      mode: this.deps.package.mode,
      company: s?.company_name ?? null,
      enabled: !!Number(s?.enabled ?? 0),
      enabledAt: iso(s?.enabled_at),
      events: (Object.keys(ACCOUNTING_EVENTS) as AccountingEvent[]).map((e) => {
        const m = maps.find((x) => x.event === e);
        return {
          event: e,
          label: ACCOUNTING_EVENTS[e].label,
          debitLedger: m?.debit_ledger ?? null,
          creditLedger: m?.credit_ledger ?? null,
        };
      }),
      version: s?.row_version ?? 0,
    };
  }

  async saveMappings(
    p: Principal,
    expected: number,
    input: {
      companyName: string;
      enabled: boolean;
      mappings: readonly { event: AccountingEvent; debitLedger: string; creditLedger: string }[];
    },
  ) {
    const institutionId = await this.inst(p);
    const company = input.companyName.trim();
    if (!NAME.test(company))
      throw new ValidationError([{ field: 'companyName', code: 'ACC.COMPANY' }]);
    const seen = new Set<string>();
    const maps = input.mappings.map((m, i) => {
      const debit = m.debitLedger.trim();
      const credit = m.creditLedger.trim();
      if (!NAME.test(debit) || !NAME.test(credit) || debit === credit || seen.has(m.event)) {
        throw new ValidationError([{ field: `mappings.${i}`, code: 'ACC.LEDGER' }]);
      }
      seen.add(m.event);
      return { event: m.event, debit, credit };
    });
    if (input.enabled && !maps.length) {
      throw new ValidationError([{ field: 'mappings', code: 'ACC.MAPPING_NEEDED' }]);
    }
    const by = p.subject && isUuid(p.subject) ? uuidToBin(p.subject) : null;
    await this.deps.db.transaction().execute(async (trx) => {
      const s = await trx
        .selectFrom('accounting_settings')
        .selectAll()
        .where('institution_id', '=', institutionId)
        .forUpdate()
        .executeTakeFirst();
      if ((s?.row_version ?? 0) !== expected) throw new PreconditionFailedError();
      const at = this.now();
      const enabledAt = input.enabled
        ? s?.enabled_at && Number(s.enabled)
          ? s.enabled_at
          : at
        : null;
      if (s) {
        await trx
          .updateTable('accounting_settings')
          .set({
            company_name: company,
            enabled: input.enabled ? 1 : 0,
            enabled_at: enabledAt,
            updated_by: by,
            updated_at: at,
            row_version: sql<number>`row_version + 1`,
          })
          .where('institution_id', '=', institutionId)
          .execute();
      } else {
        await trx
          .insertInto('accounting_settings')
          .values({
            institution_id: institutionId,
            company_name: company,
            enabled: input.enabled ? 1 : 0,
            enabled_at: enabledAt,
            updated_by: by,
            updated_at: at,
          })
          .execute();
      }
      await trx
        .deleteFrom('accounting_mappings')
        .where('institution_id', '=', institutionId)
        .execute();
      if (maps.length) {
        await trx
          .insertInto('accounting_mappings')
          .values(
            maps.map((m) => ({
              institution_id: institutionId,
              event: m.event,
              debit_ledger: m.debit,
              credit_ledger: m.credit,
            })),
          )
          .execute();
      }
      // Failed vouchers are sent again by the next run with the new names.
      await trx
        .updateTable('accounting_vouchers')
        .set({ next_attempt_at: at, updated_at: at, row_version: sql<number>`row_version + 1` })
        .where('institution_id', '=', institutionId)
        .where('status', '=', 'FAILED')
        .where('next_attempt_at', 'is not', null)
        .execute();
      await recordAudit(trx, {
        institutionId,
        action: 'ACCOUNTING_MAPPING_CHANGED',
        entityType: 'accounting_settings',
        before: s ? { company: s.company_name, enabled: !!Number(s.enabled) } : null,
        after: { company, enabled: input.enabled, events: maps.map((m) => m.event) },
      });
    });
    return this.mappings(p);
  }
}
