/** Wallet, statement, receipt and member-home DTOs (WAL-001…005, WAL-008/009, RPT-006). */
import { z } from 'zod';

const money = z.object({ amount: z.string(), currency: z.literal('INR') });
const uuid = z.uuid({ message: 'VALIDATION.FORMAT' });
const date = z.iso.date({ message: 'VALIDATION.DATE' });

export const walletSchema = z
  .object({
    id: z.uuid(),
    kind: z.enum(['CAMPUS', 'ALLOWANCE', 'PERSONAL', 'MERCHANT']),
    walletNo: z.string(),
    status: z.enum(['ACTIVE', 'INACTIVE', 'SUSPENDED']),
    balance: money,
    held: money,
    virtualAccount: z.string().nullable(),
    spentToday: money,
    spentThisMonth: money,
  })
  .meta({ id: 'Wallet' });

const profile = z.object({
  id: z.uuid(),
  memberNo: z.string(),
  name: z.string(),
  userType: z.string(),
  kind: z.enum(['STUDENTS', 'PARENTS', 'STAFF', 'MERCHANTS']),
  status: z.string(),
  institution: z.string(),
});

export const myWalletsSchema = z
  .object({ profile, wallets: z.array(walletSchema) })
  .meta({ id: 'MyWallets' });

export const forQuerySchema = z.object({ for: uuid.optional() }).meta({ id: 'ForProfile' });

export const statementQuerySchema = z
  .object({
    from: date.optional(),
    to: date.optional(),
    walletId: uuid.optional(),
    cursor: z.string().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .meta({ id: 'StatementQuery' });

export const statementRowSchema = z
  .object({
    id: z.string(),
    reference: z.string(),
    type: z.string(),
    title: z.string(),
    channel: z.string(),
    channelLabel: z.string(),
    direction: z.enum(['DEBIT', 'CREDIT']),
    amount: money,
    balanceAfter: money.nullable(),
    counterparty: z.string().nullable(),
    narration: z.string().nullable(),
    at: z.string(),
  })
  .meta({ id: 'StatementRow' });

export const statementSchema = z
  .object({
    items: z.array(statementRowSchema),
    openingBalance: money.nullable(),
    closingBalance: money.nullable(),
    nextCursor: z.string().nullable(),
  })
  .meta({ id: 'Statement' });

export const virtualAccountSchema = z
  .object({
    vaNumber: z.string(),
    beneficiary: z.string(),
    bankName: z.string(),
    ifsc: z.string(),
    example: z.boolean().describe('True while the bank details are example values (C-11)'),
  })
  .meta({ id: 'VirtualAccount' });

const party = z
  .object({ name: z.string(), walletNo: z.string().nullable(), kind: z.string().nullable() })
  .nullable();

export const receiptSchema = z
  .object({
    reference: z.string(),
    type: z.string(),
    title: z.string(),
    channel: z.string(),
    channelLabel: z.string(),
    status: z.literal('SUCCESS'),
    amount: money,
    direction: z.enum(['DEBIT', 'CREDIT']),
    balanceAfter: money.nullable(),
    from: party,
    to: party,
    narration: z.string().nullable(),
    at: z.string(),
  })
  .meta({ id: 'Receipt' });

export const consoleWalletsSchema = z
  .object({ wallets: z.array(walletSchema) })
  .meta({ id: 'MemberWallets' });

export const memberHomeSchema = z
  .object({
    profile,
    profiles: z.array(profile),
    wallets: z.array(walletSchema),
    recent: z.array(statementRowSchema),
    unreadNotifications: z.number().int(),
  })
  .meta({ id: 'MemberHome' });
