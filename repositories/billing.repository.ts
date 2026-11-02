/**
 * Billing (FR-SAS-07/08; SAS-030…032): institution invoices, their lines and the payments received.
 * Every invoice belongs to one institution; one invoice per institution, trigger and period.
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import type { Database, InvoiceStatusCode, InvoiceTrigger } from '../models/campusone_models';

type Db = Kysely<Database> | Transaction<Database>;

export interface NewInvoice {
  readonly publicId: Buffer;
  readonly institutionId: string;
  readonly trigger: InvoiceTrigger;
  readonly periodKey: string;
  readonly periodLabel: string;
  readonly periodFrom: string | null;
  readonly periodTo: string | null;
  readonly amountPaise: number;
  readonly taxBp: number;
  readonly taxPaise: number;
  readonly totalPaise: number;
  readonly issuedOn: string;
  readonly dueOn: string;
  readonly graceUntilOn: string;
  readonly by: Buffer | null;
  readonly lines: readonly { description: string; quantity: number; unitPricePaise: number }[];
}

const INVOICE_COLUMNS = [
  'v.id',
  'v.public_id',
  'v.institution_id',
  'v.invoice_no',
  'v.trigger_kind',
  'v.period_key',
  'v.period_label',
  'v.amount_paise',
  'v.tax_bp',
  'v.tax_paise',
  'v.total_paise',
  'v.issued_on',
  'v.due_on',
  'v.grace_until_on',
  'v.status',
  'v.paid_at',
  'v.reminder_stage',
  'v.transfer_utr',
  'v.transfer_paid_on',
  'v.transfer_reported_at',
  'v.row_version',
] as const;

export const billingRepository = {
  async exists(db: Db, institutionId: string, trigger: InvoiceTrigger, periodKey: string) {
    const r = await db
      .selectFrom('invoices')
      .select(['invoice_no', 'status'])
      .where('institution_id', '=', institutionId)
      .where('trigger_kind', '=', trigger)
      .where('period_key', '=', periodKey)
      .executeTakeFirst();
    return r ?? null;
  },

  async insert(db: Db, v: NewInvoice) {
    const r = await db
      .insertInto('invoices')
      .values({
        public_id: v.publicId,
        institution_id: v.institutionId,
        invoice_no: `TMP-${v.publicId.toString('hex').slice(0, 14)}`,
        trigger_kind: v.trigger,
        period_key: v.periodKey,
        period_label: v.periodLabel,
        period_from_on: v.periodFrom,
        period_to_on: v.periodTo,
        amount_paise: v.amountPaise,
        tax_bp: v.taxBp,
        tax_paise: v.taxPaise,
        total_paise: v.totalPaise,
        issued_on: v.issuedOn,
        due_on: v.dueOn,
        grace_until_on: v.graceUntilOn,
        status: 'DUE',
        paid_at: null,
        created_by: v.by,
      })
      .executeTakeFirstOrThrow();
    const id = String(r.insertId);
    const invoiceNo = `INV-${v.issuedOn.slice(0, 4)}-${id.padStart(5, '0')}`;
    await db.updateTable('invoices').set({ invoice_no: invoiceNo }).where('id', '=', id).execute();
    for (const l of v.lines) {
      await db
        .insertInto('invoice_lines')
        .values({
          institution_id: v.institutionId,
          invoice_id: id,
          description: l.description,
          quantity: l.quantity,
          unit_price_paise: l.unitPricePaise,
          amount_paise: l.quantity * l.unitPricePaise,
        })
        .execute();
    }
    return { id, invoiceNo };
  },

  async list(db: Db, f: { institutionId?: string | undefined }) {
    let q = db
      .selectFrom('invoices as v')
      .innerJoin('institutions as i', 'i.id', 'v.institution_id')
      .select(INVOICE_COLUMNS)
      .select(['i.public_id as institution_public_id', 'i.name as institution_name'])
      .orderBy('v.issued_on', 'desc')
      .orderBy('v.id', 'desc')
      .limit(500);
    if (f.institutionId) q = q.where('v.institution_id', '=', f.institutionId);
    return q.execute();
  },

  async lines(db: Db, invoiceIds: readonly string[]) {
    if (invoiceIds.length === 0) return [];
    return db
      .selectFrom('invoice_lines')
      .select(['invoice_id', 'description', 'quantity', 'unit_price_paise', 'amount_paise'])
      .where('invoice_id', 'in', [...invoiceIds])
      .orderBy('id')
      .execute();
  },

  async payments(db: Db, invoiceIds: readonly string[]) {
    if (invoiceIds.length === 0) return [];
    return db
      .selectFrom('invoice_payments')
      .select(['invoice_id', 'method', 'utr', 'amount_paise', 'paid_on', 'created_at'])
      .where('invoice_id', 'in', [...invoiceIds])
      .execute();
  },

  async byPublicId(db: Db, publicId: Buffer, lock = false) {
    let q = db
      .selectFrom('invoices as v')
      .select(INVOICE_COLUMNS)
      .where('v.public_id', '=', publicId);
    if (lock) q = q.forUpdate();
    return q.executeTakeFirst();
  },

  async utrTaken(db: Db, utr: string) {
    const r = await db
      .selectFrom('invoice_payments')
      .select('id')
      .where('utr', '=', utr)
      .executeTakeFirst();
    return Boolean(r);
  },

  /** Guarded: only an unpaid, issued invoice becomes Paid. */
  async markPaid(db: Db, id: string, at: Date) {
    const r = await db
      .updateTable('invoices')
      .set({
        status: 'PAID',
        paid_at: at,
        updated_at: sql<Date>`UTC_TIMESTAMP(3)`,
        row_version: sql<number>`row_version + 1`,
      })
      .where('id', '=', id)
      .where('status', 'in', ['DUE', 'GRACE', 'OVERDUE'] satisfies InvoiceStatusCode[])
      .executeTakeFirst();
    return Number(r.numUpdatedRows) === 1;
  },

  async addPayment(
    db: Db,
    v: {
      publicId: Buffer;
      institutionId: string;
      invoiceId: string;
      utr: string;
      amountPaise: number;
      paidOn: string;
      by: Buffer | null;
    },
  ) {
    await db
      .insertInto('invoice_payments')
      .values({
        public_id: v.publicId,
        institution_id: v.institutionId,
        invoice_id: v.invoiceId,
        method: 'BANK_TRANSFER',
        utr: v.utr,
        amount_paise: v.amountPaise,
        paid_on: v.paidOn,
        recorded_by: v.by,
      })
      .execute();
  },

  /** A bank transfer reported by the institution (SAS-039); a later report replaces it. */
  async reportTransfer(
    db: Db,
    id: string,
    v: { utr: string; paidOn: string; by: Buffer | null; at: Date },
  ) {
    const r = await db
      .updateTable('invoices')
      .set({
        transfer_utr: v.utr,
        transfer_paid_on: v.paidOn,
        transfer_reported_at: v.at,
        transfer_reported_by: v.by,
        updated_at: sql<Date>`UTC_TIMESTAMP(3)`,
        row_version: sql<number>`row_version + 1`,
      })
      .where('id', '=', id)
      .where('status', 'in', ['DUE', 'GRACE', 'OVERDUE'] satisfies InvoiceStatusCode[])
      .executeTakeFirst();
    return Number(r.numUpdatedRows) === 1;
  },

  /** Unpaid invoices past their due date whose reminders are not all sent (billing run). */
  async forReminders(db: Db, today: string) {
    return db
      .selectFrom('invoices as v')
      .innerJoin('institutions as i', 'i.id', 'v.institution_id')
      .select([
        'v.id',
        'v.institution_id',
        'v.invoice_no',
        'v.total_paise',
        'v.due_on',
        'v.grace_until_on',
        'v.status',
        'v.reminder_stage',
        'i.public_id as institution_public_id',
        'i.name as institution_name',
      ])
      .where('v.status', 'in', ['DUE', 'GRACE', 'OVERDUE'] satisfies InvoiceStatusCode[])
      .where('v.due_on', '<', today)
      .where('v.reminder_stage', '<', 2)
      .orderBy('v.id')
      .execute();
  },

  /** Guarded: the reminder stage and status move forward once (a second run finds nothing). */
  async advanceReminder(
    db: Db,
    id: string,
    from: { stage: number; status: InvoiceStatusCode },
    to: { stage: number; status: InvoiceStatusCode },
  ) {
    const r = await db
      .updateTable('invoices')
      .set({
        reminder_stage: to.stage,
        status: to.status,
        updated_at: sql<Date>`UTC_TIMESTAMP(3)`,
        row_version: sql<number>`row_version + 1`,
      })
      .where('id', '=', id)
      .where('reminder_stage', '=', from.stage)
      .where('status', '=', from.status)
      .executeTakeFirst();
    return Number(r.numUpdatedRows) === 1;
  },

  /** CampusOne's invoice and bank details (one row). */
  async profile(db: Db) {
    return db
      .selectFrom('platform_billing_profile')
      .selectAll()
      .where('id', '=', 1)
      .executeTakeFirst();
  },

  /** Guarded by the record version; a saved profile is no longer an example. */
  async updateProfile(
    db: Db,
    expected: number,
    v: {
      legal_name: string;
      gstin: string;
      address: string;
      state_code: string;
      sac_code: string;
      payee_name: string;
      payee_bank: string;
      payee_account_no: string;
      payee_ifsc: string;
      by: Buffer | null;
    },
  ) {
    const { by, ...fields } = v;
    const r = await db
      .updateTable('platform_billing_profile')
      .set({
        ...fields,
        is_example: false,
        updated_by: by,
        updated_at: sql<Date>`UTC_TIMESTAMP(3)`,
        row_version: sql<number>`row_version + 1`,
      })
      .where('id', '=', 1)
      .where('row_version', '=', expected)
      .executeTakeFirst();
    return Number(r.numUpdatedRows) === 1;
  },

  /** An invoice with what its document prints: the institution's name and address. */
  async forDocument(db: Db, publicId: Buffer) {
    return db
      .selectFrom('invoices as v')
      .innerJoin('institutions as i', 'i.id', 'v.institution_id')
      .select(INVOICE_COLUMNS)
      .select([
        'v.period_from_on',
        'v.period_to_on',
        'i.public_id as institution_public_id',
        'i.name as institution_name',
        'i.identifier as institution_identifier',
        'i.address_line1 as institution_address',
        'i.city as institution_city',
        'i.pin_code as institution_pin',
      ])
      .where('v.public_id', '=', publicId)
      .executeTakeFirst();
  },

  /** Unpaid invoices of an institution whose due date has passed (other than one). */
  async pastDue(db: Db, institutionId: string, today: string, exceptId: string) {
    return db
      .selectFrom('invoices')
      .select(['id', 'invoice_no'])
      .where('institution_id', '=', institutionId)
      .where('status', 'in', ['DUE', 'GRACE', 'OVERDUE'] satisfies InvoiceStatusCode[])
      .where('due_on', '<', today)
      .where('id', '!=', exceptId)
      .execute();
  },
};
