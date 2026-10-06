import { Router, type Request, type RequestHandler } from 'express';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { defineRoute } from '../config/openapi-registry';
import type { Loggers } from '../controllers/logger';
import {
  authorize,
  authorizeAny,
  requireSurface,
  requireTenant,
} from '../middlewares/auth.middleware';
import { idempotency } from '../middlewares/idempotency.middleware';
import type { Database } from '../models/ringpe_models';
import { singleFileUpload, uploadErrors } from '../controllers/file.controller';
import type { FeeRecordsService } from '../services/fee-records.service';
import type { FeeUploadsService } from '../services/fee-uploads.service';
import type { FeesService } from '../services/fees.service';
import { AuthenticationError, ValidationError } from '../utils/CustomAPIError';
import { expectedVersion, setEtag } from '../utils/etag';
import { MoneyError, parseAmount } from '../utils/money';

const money = z.object({ amount: z.string(), currency: z.literal('INR') });
const moneyIn = z.object({
  amount: z
    .string({ message: 'VALIDATION.AMOUNT' })
    .regex(/^\d{1,9}(\.\d{1,2})?$/, { message: 'VALIDATION.AMOUNT' }),
  currency: z.literal('INR', { message: 'VALIDATION.FORMAT' }),
});
const text = (max: number) =>
  z
    .string({ message: 'VALIDATION.REQUIRED' })
    .trim()
    .min(1, { message: 'VALIDATION.REQUIRED' })
    .max(max, { message: 'VALIDATION.FORMAT' });
const id = z.string({ message: 'VALIDATION.REQUIRED' }).trim().max(40);
const date = z
  .string({ message: 'VALIDATION.REQUIRED' })
  .regex(/^\d{4}-\d{2}-\d{2}$/, { message: 'VALIDATION.DATE' });

// --- requests ------------------------------------------------------------------------------------
export const headInputSchema = z
  .strictObject({
    name: text(30).regex(/^[A-Za-z][A-Za-z &/-]{1,29}$/, { message: 'VALIDATION.FORMAT' }),
  })
  .meta({ id: 'FeeHeadInput' });
export const structureInputSchema = z
  .strictObject({
    yearId: id,
    name: text(60),
    classIds: z
      .array(id, { message: 'VALIDATION.REQUIRED' })
      .min(1, { message: 'VALIDATION.REQUIRED' })
      .max(60, { message: 'VALIDATION.FORMAT' }),
    heads: z
      .array(
        z.strictObject({
          headId: id,
          amount: moneyIn,
          optional: z.boolean({ message: 'VALIDATION.FORMAT' }).optional(),
        }),
        { message: 'VALIDATION.REQUIRED' },
      )
      .min(1, { message: 'VALIDATION.REQUIRED' })
      .max(30, { message: 'VALIDATION.FORMAT' }),
    instalments: z
      .array(
        z.strictObject({
          label: text(30),
          dueDate: date,
          share: z
            .string({ message: 'VALIDATION.REQUIRED' })
            .trim()
            .describe('Percent of each head, e.g. "50" or "33.33"'),
        }),
        { message: 'VALIDATION.REQUIRED' },
      )
      .min(1, { message: 'VALIDATION.REQUIRED' })
      .max(12, { message: 'VALIDATION.FORMAT' }),
    lateFine: moneyIn,
    total: moneyIn
      .optional()
      .describe('The total the screen showed; refused when it is not the server’s (RNG-FEE-165)'),
  })
  .meta({ id: 'FeeStructureInput' });
export const submitSchema = z
  .strictObject({ note: z.string().trim().max(200, { message: 'VALIDATION.FORMAT' }).nullish() })
  .meta({ id: 'FeeStructureSubmit' });
export const assignSchema = z
  .strictObject({
    classIds: z.array(id).max(60).optional(),
    optional: z
      .array(z.strictObject({ studentId: id, headIds: z.array(id).max(30) }))
      .max(5000)
      .optional()
      .describe('Students who take optional heads (Transport, Hostel)'),
    preview: z.boolean({ message: 'VALIDATION.FORMAT' }),
  })
  .meta({ id: 'FeeAssignmentInput' });
export const entryFeesInputSchema = z
  .strictObject({
    applicationFee: moneyIn,
    applicationMandatory: z.boolean({ message: 'VALIDATION.FORMAT' }),
    admissionFee: moneyIn,
  })
  .meta({ id: 'EntryFeesInput' });

// --- responses -----------------------------------------------------------------------------------
const head = z
  .object({
    id: z.uuid(),
    name: z.string(),
    status: z.enum(['ACTIVE', 'INACTIVE']),
    structures: z.number(),
  })
  .meta({ id: 'FeeHead' });
const state = z.enum(['DRAFT', 'PENDING', 'ACTIVE', 'SUPERSEDED']);
const version = z
  .object({
    id: z.uuid(),
    no: z.number().int(),
    state,
    classes: z.array(z.object({ id: z.uuid(), name: z.string() })),
    heads: z.array(
      z.object({ headId: z.uuid(), name: z.string(), optional: z.boolean(), amount: money }),
    ),
    instalments: z.array(
      z.object({
        seq: z.number().int(),
        label: z.string(),
        dueDate: z.string(),
        share: z.string(),
        amount: money,
      }),
    ),
    total: money,
    optional: money,
    lateFine: money,
    returnedRemarks: z.string().nullable(),
    approval: z.object({ id: z.uuid(), no: z.string() }).nullable(),
    createdAt: z.string(),
    submittedAt: z.string().nullable(),
    activatedAt: z.string().nullable(),
    version: z.number().int(),
  })
  .meta({ id: 'FeeStructureVersion' });
const structure = z
  .object({
    id: z.uuid(),
    name: z.string(),
    year: z.object({ id: z.uuid(), label: z.string() }),
    status: state,
    current: version,
    active: version.nullable().describe('The approved version while a newer draft is open'),
    versions: z.array(
      z.object({ no: z.number(), state, total: money, activatedAt: z.string().nullable() }),
    ),
    assigned: z.object({ students: z.number(), records: z.number() }),
  })
  .meta({ id: 'FeeStructure' });
const entryFeesRow = z
  .object({
    year: z.object({ id: z.uuid(), label: z.string(), status: z.string(), current: z.boolean() }),
    fees: z
      .object({
        applicationFee: money,
        applicationMandatory: z.boolean(),
        admissionFee: money,
        updatedAt: z.string().nullable(),
        version: z.number().int(),
      })
      .nullable(),
  })
  .meta({ id: 'EntryFees' });
const assignment = z
  .object({
    preview: z.boolean(),
    version: z.number().int(),
    instalments: z.array(
      z.object({ seq: z.number(), label: z.string(), dueDate: z.string(), raised: z.boolean() }),
    ),
    perClass: z.array(
      z.object({
        class: z.object({ id: z.uuid(), name: z.string() }),
        students: z.number(),
        already: z.number(),
        toAssign: z.number(),
        records: z.number(),
        amount: money,
      }),
    ),
    totals: z.object({ students: z.number(), records: z.number(), amount: money }),
    recordsCreated: z.number().optional(),
    studentsAssigned: z.number().optional(),
  })
  .meta({ id: 'FeeAssignment' });

// --- fee records (13.3, 13.15) -------------------------------------------------------------------
const recordStatus = z.enum(['DUE', 'PARTIALLY_PAID', 'PAID', 'OVERDUE', 'CANCELLED'], {
  message: 'VALIDATION.FORMAT',
});
const attemptStatus = z.enum(['PENDING', 'SUCCEEDED', 'CANCELLED'], {
  message: 'VALIDATION.FORMAT',
});
export const recordInputSchema = z
  .strictObject({
    studentId: id,
    yearId: id,
    label: text(30),
    dueDate: date,
    amount: moneyIn,
    headId: id.optional().describe('Default: Tuition'),
    lateFine: moneyIn.optional().describe('Charged once if it becomes overdue; default none'),
    remarks: z.string().trim().max(300, { message: 'VALIDATION.FORMAT' }).nullish(),
  })
  .meta({ id: 'FeeRecordInput' });
export const recordChangeSchema = z
  .strictObject({
    amount: moneyIn.optional(),
    dueDate: date.optional(),
    remarks: z.string().trim().max(300, { message: 'VALIDATION.FORMAT' }).nullish(),
    reason: text(200).min(5, { message: 'VALIDATION.REQUIRED' }),
  })
  .meta({ id: 'FeeRecordChangeInput' });
export const uploadCommitSchema = z
  .strictObject({
    mode: z
      .enum(['ALL', 'ACCEPTED'], { message: 'VALIDATION.FORMAT' })
      .optional()
      .describe('ALL: only when no row was rejected; ACCEPTED (default): the accepted rows only'),
  })
  .meta({ id: 'FeeUploadCommit' });
const feeUpload = z
  .object({
    id: z.uuid(),
    fileName: z.string(),
    year: z.string(),
    status: z.enum(['VALIDATED', 'COMMITTED']),
    total: z.number().int(),
    accepted: z.number().int(),
    rejected: z.number().int(),
    recordsPlanned: z.number().int(),
    recordsCreated: z.number().int().nullable(),
    uploadedBy: z.string().nullable(),
    uploadedAt: z.string().nullable(),
    committedAt: z.string().nullable(),
  })
  .meta({ id: 'FeeUpload' });
const record = z
  .object({
    id: z.uuid(),
    student: z.object({
      id: z.uuid(),
      name: z.string(),
      admissionNo: z.string().nullable(),
      classSection: z.string().nullable(),
    }),
    year: z.object({ id: z.uuid(), label: z.string() }),
    source: z.enum(['STRUCTURE', 'MANUAL', 'UPLOAD']),
    structure: z.object({ name: z.string(), version: z.number().nullable() }).nullable(),
    instalment: z.object({
      seq: z.number(),
      label: z.string(),
      share: z
        .string()
        .nullable()
        .describe('Percent of the structure, e.g. "40"; null for a manual record'),
    }),
    dueDate: z.string(),
    amount: money,
    lateFine: money,
    fine: money.describe('The late fine once applied (overdue)'),
    paid: money,
    outstanding: money,
    status: recordStatus,
    financed: z.boolean(),
    remarks: z.string().nullable(),
    pendingAttempt: z
      .object({
        id: z.uuid(),
        tries: z.number(),
        lastFailureCode: z.string().nullable(),
        lastTriedAt: z.string().nullable(),
      })
      .nullable(),
    consent: z.object({ valid: z.boolean(), validUntil: z.string().nullable() }),
    changePending: z.boolean().describe('A change (FEE-013) waits for a checker'),
    paidAt: z.string().nullable(),
    paidReference: z
      .string()
      .nullable()
      .describe('Paid history from a sheet, or the financing partner'),
    createdAt: z.string().nullable(),
    version: z.number().int(),
  })
  .meta({ id: 'FeeRecord' });
const recordDetail = record
  .extend({
    heads: z.array(z.object({ name: z.string(), amount: money })),
    collections: z.array(
      z.object({
        reference: z.string(),
        amount: money.describe('The fee part'),
        fine: money.describe('The late-fine part; the wallet was debited amount + fine'),
        source: z.enum(['CONSOLE', 'JOB', 'MEMBER']),
        status: z.enum(['COLLECTED', 'SETTLED']),
        collectedAt: z.string().nullable(),
      }),
    ),
    attempts: z.array(
      z.object({
        reference: z.string(),
        status: z.string(),
        failureCode: z.string().nullable(),
        amount: money,
        at: z.string().nullable(),
      }),
    ),
  })
  .meta({ id: 'FeeRecordDetail' });
const reportRow = z.object({
  students: z.number(),
  records: z.number(),
  billed: money,
  collected: money,
  outstanding: money,
  overdue: z.number(),
});

const doc = (tags: string[]) => (d: Omit<Parameters<typeof defineRoute>[0], 'tags'>) =>
  defineRoute({ ...d, tags });
const fee = doc(['Fees']);

fee({
  id: 'FEE-001',
  method: 'get',
  path: '/api/v1/console/fee-heads',
  summary:
    'Fee head master (seeded with Tuition, Annual, Transport, Laboratory, Activity, Hostel, Other)',
  auth: 'fees.view',
  responses: { 200: { description: 'Heads', schema: z.object({ items: z.array(head) }) } },
});
fee({
  id: 'FEE-002',
  method: 'post',
  path: '/api/v1/console/fee-heads',
  summary: 'Add a fee head (unique per institution)',
  auth: 'fees.edit',
  request: headInputSchema,
  idempotent: 'required',
  responses: { 201: { description: 'Added', schema: head } },
});
fee({
  id: 'FEE-003',
  method: 'get',
  path: '/api/v1/console/fee-structures',
  summary:
    'Fee structures (?yearId, ?status) with their current and approved versions, assigned counts, and the KPIs',
  auth: 'fees.view',
  responses: {
    200: {
      description: 'Structures',
      schema: z
        .object({
          items: z.array(structure),
          kpis: z
            .object({
              structures: z.number(),
              approved: z.number(),
              pending: z.number(),
              classesCovered: z.number(),
              classes: z.number(),
            })
            .nullable(),
          maxInstalments: z.number().optional(),
        })
        .meta({ id: 'FeeStructures' }),
    },
  },
});
fee({
  id: 'FEE-004',
  method: 'post',
  path: '/api/v1/console/fee-structures',
  summary:
    'Create a draft structure: classes, heads with annual amounts (mandatory or optional), instalments with shares and due dates, late fine; priced by the one formula (a stated total that differs is refused)',
  auth: 'fees.edit',
  request: structureInputSchema,
  idempotent: 'required',
  responses: { 201: { description: 'Created', schema: structure } },
});
fee({
  id: 'FEE-005',
  method: 'patch',
  path: '/api/v1/console/fee-structures/{structureId}',
  summary:
    'Edit the draft; on an approved structure a new draft version opens (records already raised keep theirs). If-Match',
  auth: 'fees.edit',
  request: structureInputSchema,
  responses: { 200: { description: 'Structure', schema: structure } },
});
fee({
  id: 'FEE-006',
  method: 'post',
  path: '/api/v1/console/fee-structures/{structureId}/submissions',
  summary:
    'Submit the draft for approval (maker-checker; an administrator’s own request applies directly, ADR-0015)',
  auth: 'fees.edit',
  request: submitSchema,
  idempotent: 'required',
  responses: {
    202: {
      description: 'Waiting for a checker, or applied directly',
      schema: z
        .object({
          approvalId: z.uuid(),
          no: z.string(),
          appliedDirectly: z.boolean(),
          structure,
        })
        .meta({ id: 'FeeStructureSubmitted' }),
    },
  },
});
fee({
  id: 'FEE-007',
  method: 'post',
  path: '/api/v1/console/fee-structures/{structureId}/assignments',
  summary:
    'Assign the approved version to its classes: preview what will be raised, then commit one record per remaining instalment per student (one assignment per student and year)',
  auth: 'fees.edit',
  request: assignSchema,
  idempotent: 'required',
  responses: {
    200: { description: 'Preview', schema: assignment },
    201: { description: 'Records raised', schema: assignment },
  },
});
fee({
  id: 'FEE-008',
  method: 'get',
  path: '/api/v1/console/entry-fees',
  summary: 'Application and admission fees per academic year',
  auth: 'fees.view,admissions.view,admfees.view',
  responses: {
    200: { description: 'Entry fees', schema: z.object({ items: z.array(entryFeesRow) }) },
  },
});
fee({
  id: 'FEE-009',
  method: 'put',
  path: '/api/v1/console/entry-fees/{yearId}',
  summary:
    'Set the entry fees of a year and the application-fee mandatory flag (If-Match once set)',
  auth: 'fees.edit',
  request: entryFeesInputSchema,
  responses: { 200: { description: 'Entry fees', schema: entryFeesRow } },
});
fee({
  id: 'FEE-010',
  method: 'get',
  path: '/api/v1/console/fee-records',
  summary:
    'Fee records (?yearId, ?sectionId, ?studentId, ?status, cursor): student with class and section, structure version, instalment, due date, amount, fine, paid, outstanding, status, financed and any pending attempt',
  auth: 'fees.view',
  responses: {
    200: {
      description: 'Records',
      schema: z
        .object({ items: z.array(record), nextCursor: z.string().nullable() })
        .meta({ id: 'FeeRecords' }),
    },
  },
});
fee({
  id: 'FEE-011',
  method: 'get',
  path: '/api/v1/console/fee-records/{recordId}',
  summary: 'A record with its head breakdown, collections and payment attempts (ETag)',
  auth: 'fees.view',
  responses: { 200: { description: 'Record', schema: recordDetail } },
});
fee({
  id: 'FEE-012',
  method: 'post',
  path: '/api/v1/console/fee-records',
  summary:
    'A manual record (one head, default Tuition), due today or later inside the year; one per student, year and instalment',
  auth: 'fees.edit',
  request: recordInputSchema,
  idempotent: 'required',
  responses: { 201: { description: 'Created', schema: recordDetail } },
});
fee({
  id: 'FEE-013',
  method: 'post',
  path: '/api/v1/console/fee-records/{recordId}/change-requests',
  summary:
    'Ask to change an unpaid record’s amount, due date or remarks (maker → checker; an administrator’s own request applies directly, ADR-0015); one change waits per record',
  auth: 'fees.edit',
  request: recordChangeSchema,
  idempotent: 'required',
  responses: {
    202: {
      description: 'Waiting for a checker, or applied directly',
      schema: z
        .object({
          approvalId: z.uuid(),
          no: z.string(),
          appliedDirectly: z.boolean(),
          record: recordDetail,
        })
        .meta({ id: 'FeeRecordChangeRequested' }),
    },
  },
});
const uploadReport = feeUpload
  .extend({
    rows: z.array(
      z.object({
        row: z.number().int(),
        name: z.string(),
        admissionNo: z.string(),
        classSection: z.string(),
        total: money,
        instalments: z.array(money).describe('The split, equal whole rupees, remainder last'),
        dueDate: z.string().nullable(),
        dueDefaulted: z.boolean().describe('No due date given: the year’s last day'),
        paid: z.boolean().describe('Recorded as paid history: no collection, no posting'),
        accepted: z.boolean(),
        errors: z.array(z.object({ column: z.string(), message: z.string() })),
      }),
    ),
  })
  .meta({ id: 'FeeUploadReport' });
fee({
  id: 'FEE-014',
  method: 'post',
  path: '/api/v1/console/fee-records/uploads',
  summary:
    'Upload a fee sheet (CSV, 2 MB; one row per student): every row is checked and reported — student by admission number, repeats in the file and the same row already uploaded today, total, instalments, late fine, due date in the year, paid history; nothing is created until it is committed',
  auth: 'fees.edit',
  request: z.object({ file: z.string().describe('The filled-in template (CSV, at most 2 MB)') }),
  requestContentType: 'multipart/form-data',
  idempotent: 'required',
  responses: { 201: { description: 'Row report', schema: uploadReport } },
});
fee({
  id: 'FEE-015',
  method: 'post',
  path: '/api/v1/console/fee-records/uploads/{uploadId}/commit',
  summary:
    'Create the records in one transaction: all rows (only when none was rejected) or the accepted rows only; rows marked paid are recorded as history (no collection, no ledger posting at upload)',
  auth: 'fees.edit',
  request: uploadCommitSchema,
  idempotent: 'required',
  responses: {
    200: {
      description: 'Committed',
      schema: z
        .object({ created: z.number().int(), skipped: z.number().int() })
        .meta({ id: 'FeeUploadCommitted' }),
    },
  },
});
fee({
  id: 'FEE-039',
  method: 'get',
  path: '/api/v1/console/fee-records/uploads/template',
  summary: 'The fee sheet template (CSV) with one example row',
  auth: 'fees.edit',
  responses: { 200: { description: 'Template', contentType: 'text/csv' } },
});
fee({
  id: 'FEE-040',
  method: 'get',
  path: '/api/v1/console/fee-records/uploads',
  summary: 'Fee sheet uploads, newest first: who, when, file, accepted, rejected and records',
  auth: 'fees.view',
  responses: {
    200: {
      description: 'Uploads',
      schema: z.object({ items: z.array(feeUpload) }).meta({ id: 'FeeUploads' }),
    },
  },
});
fee({
  id: 'FEE-041',
  method: 'get',
  path: '/api/v1/console/fee-records/uploads/{uploadId}',
  summary: 'An upload with its row report',
  auth: 'fees.view',
  responses: { 200: { description: 'Row report', schema: uploadReport } },
});
fee({
  id: 'FEE-016',
  method: 'post',
  path: '/api/v1/console/fee-records/{recordId}/collections',
  summary:
    'Collect the outstanding amount now from the student’s wallet to the fee account through the payment engine (TUITION, RPTF); a short balance keeps one pending attempt for the auto-debit job (202)',
  auth: 'fees.collect',
  idempotent: 'required',
  responses: {
    201: {
      description: 'Collected',
      schema: z
        .object({
          collected: z.literal(true),
          receipt: z.object({ reference: z.string(), amount: money }),
          record: recordDetail,
        })
        .meta({ id: 'FeeCollected' }),
    },
    202: {
      description: 'Waiting for a top-up',
      schema: z
        .object({
          collected: z.literal(false),
          pendingAttempt: z.object({ id: z.uuid(), tries: z.number(), reasonCode: z.string() }),
          record: recordDetail,
        })
        .meta({ id: 'FeeCollectionPending' }),
    },
  },
});
fee({
  id: 'FEE-017',
  method: 'get',
  path: '/api/v1/console/fee-collections/report',
  summary:
    'Billed, collected and outstanding by class and section (?yearId; ?from and ?to on the due date)',
  auth: 'fees.view',
  responses: {
    200: {
      description: 'Report',
      schema: z
        .object({
          rows: z.array(reportRow.extend({ classSection: z.string() })),
          totals: reportRow.nullable(),
        })
        .meta({ id: 'FeeCollectionReport' }),
    },
  },
});
fee({
  id: 'FEE-018',
  method: 'get',
  path: '/api/v1/console/fee-collection-attempts',
  summary:
    'Collection attempts waiting for a top-up (?status, default PENDING): the auto-debit queue',
  auth: 'fees.view',
  responses: {
    200: {
      description: 'Attempts',
      schema: z
        .object({
          items: z.array(
            z.object({
              id: z.uuid(),
              status: attemptStatus,
              tries: z.number(),
              lastFailureCode: z.string().nullable(),
              lastTriedAt: z.string().nullable(),
              createdAt: z.string().nullable(),
              record: z.object({ id: z.uuid(), label: z.string() }),
              student: z.object({ name: z.string() }),
              outstanding: money,
            }),
          ),
        })
        .meta({ id: 'FeeCollectionAttempts' }),
    },
  },
});

/** ₹0 is allowed here (no late fine, a free application); callers that need more check it. */
const paise = (m: { amount: string }, field: string) => {
  try {
    return parseAmount(m.amount, { allowZero: true });
  } catch (e) {
    if (e instanceof MoneyError) throw new ValidationError([{ field, code: 'VALIDATION.AMOUNT' }]);
    throw e;
  }
};
const structureIn = (b: z.infer<typeof structureInputSchema>) => ({
  yearId: b.yearId,
  name: b.name,
  classIds: b.classIds,
  heads: b.heads.map((h, i) => {
    const amountPaise = paise(h.amount, `heads.${i}.amount`);
    if (amountPaise <= 0)
      throw new ValidationError([{ field: `heads.${i}.amount`, code: 'VALIDATION.AMOUNT' }]);
    return { headId: h.headId, amountPaise, optional: h.optional };
  }),
  instalments: b.instalments,
  lateFinePaise: paise(b.lateFine, 'lateFine'),
  statedTotalPaise: b.total ? paise(b.total, 'total') : undefined,
});

/** Mounted under /api/v1. */
export function feesRoutes(deps: {
  db: Kysely<Database>;
  fees: FeesService;
  records: FeeRecordsService;
  uploads: FeeUploadsService;
  loggers: Loggers;
}): Router {
  const router = Router();
  const L = deps.loggers;
  const once = idempotency({ db: deps.db, mode: 'required' });
  const wrap =
    (fn: RequestHandler): RequestHandler =>
    async (req, res, next) => {
      try {
        await fn(req, res, next);
      } catch (e) {
        next(e);
      }
    };
  const principal = (req: Request) => {
    if (!req.principal) throw new AuthenticationError();
    return req.principal;
  };
  const console = [requireSurface(L, 'console'), requireTenant(L)];
  const param = (req: Request, k: string) => String(req.params[k]);
  const q = (req: Request, k: string) =>
    typeof req.query[k] === 'string' ? (req.query[k] as string) : undefined;

  router.get(
    '/console/fee-heads',
    ...console,
    authorize('fees.view', L),
    wrap(async (req, res) => {
      res.json(await deps.fees.heads(principal(req)));
    }),
  );
  router.post(
    '/console/fee-heads',
    ...console,
    authorize('fees.edit', L),
    once,
    wrap(async (req, res) => {
      res
        .status(201)
        .json(await deps.fees.addHead(principal(req), headInputSchema.parse(req.body ?? {})));
    }),
  );
  router.get(
    '/console/fee-structures',
    ...console,
    authorize('fees.view', L),
    wrap(async (req, res) => {
      res.json(
        await deps.fees.structures(principal(req), {
          yearId: q(req, 'yearId'),
          status: z.enum(['DRAFT', 'PENDING', 'ACTIVE']).optional().parse(q(req, 'status')),
        }),
      );
    }),
  );
  router.post(
    '/console/fee-structures',
    ...console,
    authorize('fees.edit', L),
    once,
    wrap(async (req, res) => {
      const out = await deps.fees.create(
        principal(req),
        structureIn(structureInputSchema.parse(req.body ?? {})),
      );
      setEtag(res, out.current.version);
      res.status(201).json(out);
    }),
  );
  router.patch(
    '/console/fee-structures/:structureId',
    ...console,
    authorize('fees.edit', L),
    wrap(async (req, res) => {
      const out = await deps.fees.update(
        principal(req),
        param(req, 'structureId'),
        expectedVersion(req),
        structureIn(structureInputSchema.parse(req.body ?? {})),
      );
      setEtag(res, out.current.version);
      res.json(out);
    }),
  );
  router.post(
    '/console/fee-structures/:structureId/submissions',
    ...console,
    authorize('fees.edit', L),
    once,
    wrap(async (req, res) => {
      res
        .status(202)
        .json(
          await deps.fees.submit(
            principal(req),
            param(req, 'structureId'),
            submitSchema.parse(req.body ?? {}),
          ),
        );
    }),
  );
  router.post(
    '/console/fee-structures/:structureId/assignments',
    ...console,
    authorize('fees.edit', L),
    once,
    wrap(async (req, res) => {
      const b = assignSchema.parse(req.body ?? {});
      const out = await deps.fees.assign(principal(req), param(req, 'structureId'), b);
      res.status(b.preview ? 200 : 201).json(out);
    }),
  );
  // --- fee records and collection (13.3, 13.15) ---------------------------------------------------
  router.get(
    '/console/fee-records',
    ...console,
    authorize('fees.view', L),
    wrap(async (req, res) => {
      res.json(
        await deps.records.list(principal(req), {
          yearId: q(req, 'yearId'),
          sectionId: q(req, 'sectionId'),
          classId: q(req, 'classId'),
          financed: q(req, 'financed') === undefined ? undefined : q(req, 'financed') === 'true',
          waiting: q(req, 'waiting') === 'true',
          q: q(req, 'q'),
          studentId: q(req, 'studentId'),
          status: recordStatus.optional().parse(q(req, 'status')),
          cursor: q(req, 'cursor'),
        }),
      );
    }),
  );
  // --- fee sheet uploads (before /fee-records/:recordId) -------------------------------------------
  router.get(
    '/console/fee-records/uploads/template',
    ...console,
    authorize('fees.edit', L),
    wrap(async (req, res) => {
      const out = await deps.uploads.template(principal(req));
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${out.fileName}"`);
      res.send(String.fromCharCode(0xfeff) + out.csv);
    }),
  );
  router.get(
    '/console/fee-records/uploads',
    ...console,
    authorize('fees.view', L),
    wrap(async (req, res) => {
      res.json(await deps.uploads.list(principal(req)));
    }),
  );
  router.post(
    '/console/fee-records/uploads',
    ...console,
    authorize('fees.edit', L),
    once,
    singleFileUpload,
    uploadErrors,
    wrap(async (req, res) => {
      if (!req.file) throw new ValidationError([{ field: 'file', code: 'UPL.FILE_REQUIRED' }]);
      res.status(201).json(
        await deps.uploads.upload(principal(req), {
          fileName: req.file.originalname || 'fee-sheet.csv',
          content: req.file.buffer.toString('utf8'),
        }),
      );
    }),
  );
  router.get(
    '/console/fee-records/uploads/:uploadId',
    ...console,
    authorize('fees.view', L),
    wrap(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.json(await deps.uploads.status(principal(req), param(req, 'uploadId')));
    }),
  );
  router.post(
    '/console/fee-records/uploads/:uploadId/commit',
    ...console,
    authorize('fees.edit', L),
    once,
    wrap(async (req, res) => {
      const b = uploadCommitSchema.parse(req.body ?? {});
      res.json(
        await deps.uploads.commit(principal(req), param(req, 'uploadId'), {
          mode: b.mode ?? 'ACCEPTED',
        }),
      );
    }),
  );
  router.get(
    '/console/fee-records/:recordId',
    ...console,
    authorize('fees.view', L),
    wrap(async (req, res) => {
      const out = await deps.records.detail(principal(req), param(req, 'recordId'));
      setEtag(res, out.version);
      res.json(out);
    }),
  );
  router.post(
    '/console/fee-records',
    ...console,
    authorize('fees.edit', L),
    once,
    wrap(async (req, res) => {
      const b = recordInputSchema.parse(req.body ?? {});
      const amountPaise = paise(b.amount, 'amount');
      if (amountPaise <= 0)
        throw new ValidationError([{ field: 'amount', code: 'VALIDATION.AMOUNT' }]);
      const out = await deps.records.manual(principal(req), {
        studentId: b.studentId,
        yearId: b.yearId,
        label: b.label,
        dueDate: b.dueDate,
        amountPaise,
        headId: b.headId,
        remarks: b.remarks,
        lateFinePaise: b.lateFine ? paise(b.lateFine, 'lateFine') : 0,
      });
      setEtag(res, out.version);
      res.status(201).json(out);
    }),
  );
  router.post(
    '/console/fee-records/:recordId/change-requests',
    ...console,
    authorize('fees.edit', L),
    once,
    wrap(async (req, res) => {
      const b = recordChangeSchema.parse(req.body ?? {});
      res.status(202).json(
        await deps.records.requestChange(principal(req), param(req, 'recordId'), {
          amountPaise: b.amount ? paise(b.amount, 'amount') : undefined,
          dueDate: b.dueDate,
          remarks: b.remarks,
          reason: b.reason,
        }),
      );
    }),
  );
  router.post(
    '/console/fee-records/:recordId/collections',
    ...console,
    authorize('fees.collect', L),
    once,
    wrap(async (req, res) => {
      const out = await deps.records.collect(
        principal(req),
        param(req, 'recordId'),
        String(req.get('Idempotency-Key')),
      );
      res.status(out.collected ? 201 : 202).json(out);
    }),
  );
  router.get(
    '/console/fee-collections/report',
    ...console,
    authorize('fees.view', L),
    wrap(async (req, res) => {
      res.json(
        await deps.records.report(principal(req), {
          yearId: q(req, 'yearId'),
          from: date.optional().parse(q(req, 'from')),
          to: date.optional().parse(q(req, 'to')),
        }),
      );
    }),
  );
  router.get(
    '/console/fee-collection-attempts',
    ...console,
    authorize('fees.view', L),
    wrap(async (req, res) => {
      res.json(
        await deps.records.attempts(principal(req), {
          status: attemptStatus.optional().parse(q(req, 'status')),
        }),
      );
    }),
  );
  router.get(
    '/console/entry-fees',
    ...console,
    // The counsellor's application and admission-fee screens show the entry fees too.
    authorizeAny(['fees.view', 'admissions.view', 'admfees.view'], L),
    wrap(async (req, res) => {
      res.json(await deps.fees.entryFees(principal(req)));
    }),
  );
  router.put(
    '/console/entry-fees/:yearId',
    ...console,
    authorize('fees.edit', L),
    wrap(async (req, res) => {
      const b = entryFeesInputSchema.parse(req.body ?? {});
      const out = await deps.fees.setEntryFees(
        principal(req),
        param(req, 'yearId'),
        req.get('if-match') ? expectedVersion(req) : null,
        {
          applicationFeePaise: paise(b.applicationFee, 'applicationFee'),
          applicationMandatory: b.applicationMandatory,
          admissionFeePaise: paise(b.admissionFee, 'admissionFee'),
        },
      );
      if (out.fees) setEtag(res, out.fees.version);
      res.json(out);
    }),
  );
  return router;
}
