/**
 * Console accounts and roles (IDN-038, IDN-060…062), the member app's active profile and
 * institution (IDN-014, IDN-093/094) and the back office's home and search (RPT-007, RPT-008).
 */
import { z } from 'zod';

const uuid = z.uuid({ message: 'VALIDATION.FORMAT' });
const money = z.object({ amount: z.string(), currency: z.literal('INR') });

export const consoleRolesSchema = z
  .object({
    items: z.array(
      z.object({
        id: z.uuid(),
        code: z.string().nullable(),
        name: z.string(),
        description: z.string().nullable(),
        readOnly: z.boolean(),
        assignable: z
          .boolean()
          .describe('False for the Institution Administrator (CampusOne gives it)'),
        tasks: z.array(z.string()),
        subTasks: z.array(z.string()),
      }),
    ),
  })
  .meta({ id: 'ConsoleRoles' });

export const staffAccountSchema = z
  .object({
    id: z.uuid().describe('The staff profile'),
    memberNo: z.string(),
    name: z.string(),
    userType: z.string(),
    email: z.string().nullable(),
    mobile: z.string().describe('Masked'),
    status: z.string(),
    roles: z.array(z.object({ id: z.uuid(), code: z.string().nullable(), name: z.string() })),
    locked: z.boolean(),
    lastSignInAt: z.string().nullable(),
  })
  .meta({ id: 'StaffAccount' });

export const staffAccountsSchema = z
  .object({ items: z.array(staffAccountSchema) })
  .meta({ id: 'StaffAccounts' });

export const setRolesSchema = z
  .strictObject({ roleIds: z.array(uuid).max(10) })
  .meta({ id: 'StaffRoles' });

export const unlockSchema = z
  .strictObject({
    reason: z
      .string({ message: 'VALIDATION.REQUIRED' })
      .trim()
      .min(1, { message: 'VALIDATION.REQUIRED' })
      .max(300, { message: 'VALIDATION.FORMAT' }),
  })
  .meta({ id: 'StaffUnlock' });

export const activeProfileSchema = z
  .strictObject({ profileId: uuid })
  .meta({ id: 'ActiveProfile' });

export const activeProfileResultSchema = z
  .object({ activeProfileId: z.uuid() })
  .meta({ id: 'ActiveProfileSet' });

/** IDN-094 (client 2026-10-27): the institution the app opened and the profile it works for. */
export const memberInstitutionSetSchema = z
  .object({ activeProfileId: z.uuid(), institutionId: z.uuid() })
  .meta({ id: 'MemberInstitutionSet' });

export const opsHomeSchema = z
  .object({
    kpis: z.object({
      tenants: z.number().int(),
      active: z.number().int(),
      onTrial: z.number().int(),
      pending: z.number().int(),
      openInvoices: z.number().int(),
      openAmount: money,
      overdueInvoices: z.number().int(),
      pendingApprovals: z.number().int(),
    }),
    byStatus: z.array(z.object({ status: z.string(), count: z.number().int() })),
    jobs: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        time: z.string().nullable(),
        money: z.boolean(),
        scheduled: z.boolean(),
        lastRun: z
          .object({ status: z.string(), startedAt: z.string(), endedAt: z.string().nullable() })
          .nullable(),
        health: z.enum(['NONE', 'OK', 'RUNNING', 'BAD']),
      }),
    ),
    alerts: z.array(
      z.object({
        tone: z.string(),
        icon: z.string(),
        title: z.string(),
        sub: z.string(),
        go: z.string(),
      }),
    ),
  })
  .meta({ id: 'OpsHome' });

export const opsSearchSchema = z
  .object({
    institutions: z.array(
      z.object({
        id: z.uuid(),
        identifier: z.string(),
        name: z.string(),
        shortName: z.string(),
        city: z.string(),
        status: z.string(),
        subscription: z
          .string()
          .nullable()
          .describe(
            'TRIAL, ACTIVE, GRACE, SUSPENDED or CANCELLED (a trial school is Active with a Trial subscription)',
          ),
        plan: z.string().nullable(),
      }),
    ),
    invoices: z.array(
      z.object({
        id: z.uuid(),
        invoiceNo: z.string(),
        institution: z.string(),
        status: z.string(),
        total: money,
        issuedOn: z.string(),
      }),
    ),
  })
  .meta({ id: 'OpsSearch' });
