/** Billing DTOs (SAS-030…032; FR-SAS-07/08; prototype o.plans). Money as {amount, currency}. */
import { z } from 'zod';
import { money } from '../utils/validators';

const moneyOut = z.object({ amount: z.string(), currency: z.literal('INR') });

export const invoiceSchema = z
  .object({
    id: z.uuid(),
    invoiceNo: z.string(),
    institution: z.object({ id: z.uuid(), name: z.string() }),
    trigger: z.enum(['PLAN_ACTIVATION', 'RENEWAL', 'PLAN_CHANGE', 'USAGE_OVERAGE', 'MANUAL']),
    period: z.string(),
    amount: moneyOut,
    taxPercent: z.string(),
    tax: moneyOut,
    total: moneyOut,
    issuedOn: z.string(),
    dueOn: z.string(),
    graceUntilOn: z.string(),
    status: z
      .enum(['DRAFT', 'DUE', 'GRACE', 'OVERDUE', 'PAID', 'VOID'])
      .describe('Grace and Overdue follow the due date and the grace setting'),
    paidAt: z.iso.datetime().nullable(),
    transfer: z
      .object({ utr: z.string(), paidOn: z.string(), reportedAt: z.iso.datetime() })
      .nullable()
      .describe('A bank transfer the institution reported, waiting for confirmation'),
    payment: z
      .object({
        method: z.enum(['BANK_TRANSFER', 'GATEWAY']),
        reference: z.string().nullable(),
        paidOn: z.string(),
      })
      .nullable(),
    lines: z.array(
      z.object({ description: z.string(), quantity: z.number().int(), amount: moneyOut }),
    ),
    version: z.number().int(),
  })
  .meta({ id: 'Invoice' });

export const invoicesSchema = z.object({ items: z.array(invoiceSchema) }).meta({ id: 'Invoices' });

export const invoicesQuerySchema = z
  .object({ institutionId: z.uuid({ message: 'VALIDATION.FORMAT' }).optional() })
  .meta({ id: 'InvoicesQuery' });

export const invoiceGenerateSchema = z
  .strictObject({
    institutionId: z.uuid({ message: 'VALIDATION.REQUIRED' }),
    trigger: z.enum(['RENEWAL', 'PLAN_ACTIVATION', 'USAGE_OVERAGE'], {
      message: 'VALIDATION.FORMAT',
    }),
    smsOver: z
      .number({ message: 'VALIDATION.FORMAT' })
      .int({ message: 'VALIDATION.FORMAT' })
      .min(0, { message: 'VALIDATION.RANGE' })
      .max(100_000_000, { message: 'VALIDATION.RANGE' })
      .optional()
      .describe('Usage overage: SMS above the allowance'),
    whatsappOver: z
      .number({ message: 'VALIDATION.FORMAT' })
      .int({ message: 'VALIDATION.FORMAT' })
      .min(0, { message: 'VALIDATION.RANGE' })
      .max(100_000_000, { message: 'VALIDATION.RANGE' })
      .optional(),
  })
  .meta({ id: 'InvoiceGenerate' });

export const invoicePaymentSchema = z
  .strictObject({
    utr: z
      .string({ message: 'VALIDATION.REQUIRED' })
      .trim()
      .min(1, { message: 'VALIDATION.REQUIRED' })
      .max(22, { message: 'SAS.UTR_FORMAT' })
      .describe('Bank reference of the transfer (unique)'),
    amount: money({ minPaise: 1 }).describe('Must equal the invoice total'),
    paidOn: z.iso.date({ message: 'VALIDATION.DATE' }),
  })
  .meta({ id: 'InvoicePayment' });

export const invoicePaidSchema = z
  .object({
    invoice: invoiceSchema,
    institutionRestored: z.boolean().describe('A suspended institution became Active again'),
  })
  .meta({ id: 'InvoicePaid' });

const text = (max: number) =>
  z
    .string({ message: 'VALIDATION.REQUIRED' })
    .trim()
    .min(1, { message: 'VALIDATION.REQUIRED' })
    .max(max, { message: 'VALIDATION.FORMAT' });

export const billingProfileSchema = z
  .object({
    legalName: z.string(),
    gstin: z.string(),
    address: z.string(),
    stateCode: z.string(),
    stateName: z.string().nullable(),
    sacCode: z.string(),
    payee: z.object({
      name: z.string(),
      bank: z.string(),
      accountNo: z.string(),
      ifsc: z.string(),
    }),
    example: z.boolean().describe('Example values until the client supplies the real details'),
    updatedAt: z.iso.datetime().nullable(),
    etag: z.number().int().describe('Send as If-Match "v<n>" to change the profile'),
  })
  .meta({ id: 'BillingProfile' });

export const billingProfileInputSchema = z
  .strictObject({
    legalName: text(120),
    gstin: text(15),
    address: text(300),
    sacCode: text(8),
    payee: z.strictObject({
      name: text(120),
      bank: text(80),
      accountNo: text(20),
      ifsc: text(11),
    }),
  })
  .meta({ id: 'BillingProfileInput' });
