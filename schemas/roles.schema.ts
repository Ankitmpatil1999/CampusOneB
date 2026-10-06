/** Roles & tasks DTOs (IDN-063…069, IDN-039, IDN-081; prototype o.roles). */
import { z } from 'zod';

const req = (max: number) =>
  z
    .string({ message: 'VALIDATION.REQUIRED' })
    .min(1, { message: 'VALIDATION.REQUIRED' })
    .max(max, { message: 'VALIDATION.FORMAT' });
const reason = req(200).describe('Why (recorded in the change record)');

export const scopeQuerySchema = z
  .object({ scope: z.enum(['OPERATOR', 'INSTITUTION']).optional() })
  .meta({ id: 'RoleScopeQuery' });

export const tasksSchema = z
  .object({
    items: z.array(
      z.object({
        scope: z.enum(['OPERATOR', 'INSTITUTION']),
        code: z.string(),
        labelKey: z.string(),
        name: z.string(),
        cr: z.string().nullable(),
        subTasks: z.array(z.object({ code: z.string(), labelKey: z.string(), name: z.string() })),
      }),
    ),
  })
  .meta({ id: 'TaskCatalogue' });

export const rolesSchema = z
  .object({
    items: z.array(
      z.object({
        id: z.uuid(),
        code: z.string().nullable(),
        name: z.string(),
        description: z.string().nullable(),
        scope: z.enum(['OPERATOR', 'INSTITUTION']),
        status: z.enum(['ACTIVE', 'INACTIVE']),
        readOnly: z.boolean(),
        tasks: z.array(z.string()).describe('Assigned tasks (menus)'),
        subTasks: z.array(z.string()).describe('Granted sub-tasks (actions)'),
        holders: z.array(z.object({ name: z.string() })).describe('Operator roles only'),
        holderCount: z.number().int(),
        version: z.number().int(),
      }),
    ),
  })
  .meta({ id: 'Roles' });

export const roleCreateSchema = z
  .strictObject({ name: req(40), description: req(160) })
  .meta({ id: 'RoleCreate' });

export const roleCreatedSchema = z.object({ roleId: z.uuid() }).meta({ id: 'RoleCreated' });

export const roleChangeSchema = z
  .strictObject({
    action: z.enum(['ASSIGN_TASK', 'REMOVE_TASK', 'GRANT', 'REVOKE', 'ENABLE', 'DISABLE'], {
      message: 'VALIDATION.FORMAT',
    }),
    task: z.string().max(24).optional().describe('ASSIGN_TASK / REMOVE_TASK'),
    subTask: z.string().max(48).optional().describe('GRANT / REVOKE'),
    reason,
  })
  .meta({ id: 'RoleChange' });

export const versionSchema = z.object({ version: z.number().int() }).meta({ id: 'Version' });

export const operatorAccountsSchema = z
  .object({
    items: z.array(
      z.object({
        id: z.uuid(),
        accountId: z.uuid().describe('Platform account (used to release a sign-in lock)'),
        name: z.string(),
        email: z.string().nullable(),
        role: z.object({ id: z.uuid(), name: z.string() }),
        lastSignInAt: z.iso.datetime().nullable(),
        status: z.enum(['ACTIVE', 'INACTIVE']),
        statusNote: z.string().nullable(),
        locked: z.boolean(),
        version: z.number().int(),
      }),
    ),
  })
  .meta({ id: 'OperatorAccounts' });

export const assignSchema = z
  .strictObject({ email: req(254), roleId: z.uuid({ message: 'VALIDATION.REQUIRED' }), reason })
  .meta({ id: 'OperatorAssign' });

export const accountChangeSchema = z
  .strictObject({
    roleId: z.uuid().optional(),
    status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
    reason,
  })
  .meta({ id: 'OperatorAccountChange' });

export const accountSavedSchema = z
  .object({ id: z.uuid(), version: z.number().int() })
  .meta({ id: 'OperatorAccountSaved' });

export const unlockSchema = z.strictObject({ reason }).meta({ id: 'Unlock' });

export const roleChangesSchema = z
  .object({
    items: z.array(
      z.object({
        id: z.uuid(),
        at: z.iso.datetime(),
        by: z.string(),
        change: z.string(),
        reason: z.string(),
      }),
    ),
  })
  .meta({ id: 'RoleChanges' });
