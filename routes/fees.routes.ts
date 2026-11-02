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
import type { Database } from '../models/campusone_models';
import { singleFileUpload, uploadErrors } from '../controllers/file.controller';
import { FeeCollectionService } from '../services/fee-collection.service';
import type { FeePaymentsService } from '../services/fee-payments.service';
import type { FeeRecordsService } from '../services/fee-records.service';
import type { FeeUploadsService } from '../services/fee-uploads.service';
import type { FeesService } from '../services/fees.service';
import { AuthenticationError, ValidationError } from '../utils/CustomAPIError';
import { expectedVersion, setEtag } from '../utils/etag';
import { MoneyError, parseAmount } from '../utils/money';
import { PATTERNS } from '../utils/validators';

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
        mode: z
          .enum(['WALLET', 'CASH', 'ONLINE'])
          .describe('From the wallet, in cash, or through the gateway (client 2026-10-19)'),
        paidBy: z.string().nullable(),
        transactionId: z.string().nullable().describe('The gateway’s, for an online payment'),
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
const sums = z.object({ amount: money, collected: money, pending: money });
/** An application or admission fee: the payment made, or the admission fee still owed. */
const entryFee = sums.extend({
  status: z.enum(['PENDING', 'PAID', 'FAILED']),
  mode: z.enum(['ONLINE', 'CASH']).nullable(),
  receiptNo: z.string().nullable(),
});
fee({
  id: 'FEE-044',
  method: 'get',
  path: '/api/v1/console/fee-collection',
  summary:
    'Fee collection details of an academic year (?yearId, the current one by default), narrowed by ?classId, ?sectionId, ?q and an approved ?structureId (then only its heads and its assigned students): every head of the year as a column, each student with what every head has collected, the application and admission fees and the total collected; summary cards over every student the filters keep; ?page and ?pageSize (15, at most 100) (client 2026-10-16, 2026-10-19). From the records and collections; the fee part only, a record’s collection shared between its heads by amount',
  auth: 'fees.view',
  responses: {
    200: {
      description: 'Collection details',
      schema: z
        .object({
          year: z.object({ id: z.uuid(), label: z.string() }),
          structure: z
            .object({ id: z.uuid(), name: z.string(), version: z.number().int() })
            .nullable(),
          heads: z.array(z.object({ id: z.string(), name: z.string() })),
          cards: z.object({
            heads: z.array(z.object({ headId: z.string(), collected: money })),
            applicationFee: sums,
            admissionFee: sums,
            total: sums,
          }),
          students: z.array(
            z.object({
              id: z.uuid(),
              name: z.string(),
              admissionNo: z.string().nullable(),
              classSection: z.string().nullable(),
              heads: z.array(sums.extend({ headId: z.string() }).nullable()),
              applicationFee: entryFee.nullable(),
              admissionFee: entryFee.nullable(),
              total: sums,
              due: money.describe(
                'What the open, unfinanced instalments still owe (client 2026-10-22)',
              ),
              collectable: z.boolean().describe('Collect fee has an instalment to take'),
            }),
          ),
          page: z.number().int(),
          pageSize: z.number().int(),
          total: z.number().int(),
        })
        .meta({ id: 'FeeCollectionDetails' }),
    },
  },
});
fee({
  id: 'FEE-045',
  method: 'get',
  path: '/api/v1/console/fee-collection/students/{studentId}',
  summary:
    'One student’s instalments of every head in the academic year (?yearId, the current one by default), of an approved ?structureId when one is chosen: amount, collected, pending and status of each (client 2026-10-16, 2026-10-19)',
  auth: 'fees.view',
  responses: {
    200: {
      description: 'The student’s heads and instalments',
      schema: z
        .object({
          student: z.object({
            id: z.uuid(),
            name: z.string(),
            admissionNo: z.string().nullable(),
            classSection: z.string().nullable(),
          }),
          heads: z.array(
            sums.extend({
              id: z.uuid(),
              name: z.string(),
              instalments: z.array(
                sums.extend({
                  seq: z.number().int(),
                  label: z.string(),
                  dueDate: z.string(),
                  status: z.string(),
                }),
              ),
            }),
          ),
        })
        .meta({ id: 'FeeCollectionStudent' }),
    },
  },
});
fee({
  id: 'FEE-043',
  method: 'get',
  path: '/api/v1/console/fee-records/students',
  summary:
    'Active students to bill (?q name or admission number, ?yearId; the current year unless given): name, admission number and class — fee staff pick a student without the member directory (client 2026-10-15)',
  auth: 'fees.edit',
  responses: {
    200: {
      description: 'Students',
      schema: z
        .object({
          items: z.array(
            z.object({
              id: z.uuid(),
              name: z.string(),
              admissionNo: z.string().nullable(),
              grade: z.object({ class: z.string(), section: z.string().nullable() }).nullable(),
            }),
          ),
        })
        .meta({ id: 'FeeStudents' }),
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
// --- Collect Fee (client 2026-10-19) ----------------------------------------------------------------
const FEE_PAY_TOKEN = 'X-Fee-Pay-Token';
const feePayToken = `${FEE_PAY_TOKEN}: the payment link's token (or ?token=)`;
const gatewayOrderSchema = z.object({
  orderId: z.string(),
  amount: money,
  mode: z.enum(['test', 'live']),
  test: z.object({ paymentId: z.string(), signature: z.string() }).optional(),
  checkout: z.object({ keyId: z.string(), name: z.string() }).optional(),
});
/** A collection's receipt (client 2026-10-22): what the receipt view and its PDF show. */
const feeReceipt = z
  .object({
    collectionId: z.uuid(),
    receiptNo: z.string(),
    paidAt: z.string(),
    mode: z.enum(['CASH', 'ONLINE', 'WALLET']),
    paidBy: z.string().nullable().describe('Cash: who paid'),
    transactionId: z.string().nullable().describe('Online: the gateway’s payment id'),
    school: z.object({ name: z.string() }),
    student: z.object({
      name: z.string(),
      admissionNo: z.string().nullable(),
      classSection: z.string().nullable(),
    }),
    year: z.string().nullable(),
    instalment: z.object({ label: z.string(), dueDate: z.string() }),
    amount: money.describe('The fee part'),
    fine: money.describe('The late fine part'),
    total: money,
  })
  .meta({ id: 'FeeReceipt' });
const feePaySummary = z
  .object({
    school: z.object({ id: z.uuid(), name: z.string() }),
    student: z.object({
      name: z.string(),
      admissionNo: z.string().nullable(),
      classSection: z.string().nullable(),
    }),
    year: z.object({ label: z.string() }).nullable(),
    instalment: z.object({ label: z.string(), dueDate: z.string() }),
    amount: money,
    status: z
      .enum(['OPEN', 'PAID', 'CLOSED'])
      .describe('PAID: paid through this link; CLOSED: paid another way, or withdrawn'),
    receiptNo: z.string().nullable(),
    transactionId: z.string().nullable(),
    receipt: feeReceipt.nullable().describe('Once this link paid it'),
  })
  .meta({ id: 'FeePaymentPage' });
/** Cash at the desk, recorded as the admission fee's (ADM-022; client 2026-10-22). */
export const feeCashSchema = z
  .strictObject({
    receivedAt: date,
    receiptNo: z
      .string()
      .trim()
      .max(30, { message: 'VALIDATION.FORMAT' })
      .regex(/^[A-Za-z0-9/-]*$/, { message: 'VALIDATION.FORMAT' })
      .nullish()
      .describe('The counterfoil book’s number, unique in the school; empty: CampusOne numbers it'),
    paidBy: z
      .string({ message: 'VALIDATION.REQUIRED' })
      .trim()
      .min(1, { message: 'VALIDATION.REQUIRED' })
      .max(100, { message: 'VALIDATION.FORMAT' })
      .regex(PATTERNS.personName, { message: 'VALIDATION.FORMAT' }),
  })
  .meta({ id: 'FeeCashInput' });
export const feePayRequestSchema = z
  .strictObject({ channel: z.enum(['LINK', 'QR'], { message: 'VALIDATION.FORMAT' }) })
  .meta({ id: 'FeePaymentRequestInput' });
export const feePayVerifySchema = z
  .strictObject({
    gatewayPaymentId: z.string().min(1).max(64),
    signature: z.string().min(1).max(256),
  })
  .meta({ id: 'FeePaymentVerifyInput' });
fee({
  id: 'FEE-046',
  method: 'get',
  path: '/api/v1/console/fee-collection/students/{studentId}/collect',
  summary:
    'Collect Fee: the student’s virtual account number (VAN), the year’s instalments (?yearId, the current year by default) with what is outstanding on each and whether it can be collected, and where a payment link would be sent (masked)',
  auth: 'fees.collect',
  responses: {
    200: {
      description: 'The student to collect from',
      schema: z
        .object({
          year: z.object({ id: z.uuid(), label: z.string() }),
          student: z.object({
            id: z.uuid(),
            name: z.string(),
            admissionNo: z.string().nullable(),
            classSection: z.string().nullable(),
          }),
          van: z.object({ number: z.string(), active: z.boolean() }).nullable(),
          sendTo: z.object({ mobile: z.string().nullable(), email: z.string().nullable() }),
          instalments: z.array(
            z.object({
              recordId: z.uuid(),
              label: z.string(),
              dueDate: z.string(),
              amount: money,
              fine: money,
              paid: money,
              outstanding: money,
              status: z.string(),
              financed: z.boolean(),
              collectable: z.boolean(),
              collections: z
                .array(
                  z.object({
                    collectionId: z.uuid(),
                    receiptNo: z.string(),
                    paidAt: z.string(),
                    mode: z.enum(['CASH', 'ONLINE', 'WALLET']),
                    total: money,
                  }),
                )
                .describe(
                  'What was collected on it, oldest first; each opens its receipt (FEE-056)',
                ),
            }),
          ),
        })
        .meta({ id: 'FeeCollectStudent' }),
    },
  },
});
fee({
  id: 'FEE-047',
  method: 'post',
  path: '/api/v1/console/fee-records/{recordId}/cash',
  summary:
    'Collect an instalment’s outstanding amount (with any late fine) in cash, recorded as the admission fee’s (client 2026-10-22): the day received (not in the future), who paid and the counterfoil’s receipt number (unique; empty: CampusOne numbers it — 409 FEE.RECEIPT_TAKEN when used); the record is paid; any auto-debit waiting and the record’s open payment links end',
  auth: 'fees.collect',
  idempotent: 'required',
  request: feeCashSchema,
  responses: {
    201: {
      description: 'Collected',
      schema: z
        .object({
          receiptNo: z.string(),
          amount: money,
          mode: z.literal('CASH'),
          recordId: z.uuid(),
          status: z.literal('PAID'),
          collectionId: z.uuid(),
          receipt: feeReceipt,
        })
        .meta({ id: 'FeeCashCollected' }),
    },
  },
});
fee({
  id: 'FEE-048',
  method: 'post',
  path: '/api/v1/console/fee-records/{recordId}/payment-requests',
  summary:
    'A payment link (channel LINK: sent to the student and every parent — by SMS and e-mail through the school’s channels, and in the app to those with a CampusOne account; client 2026-10-22) or a QR code (channel QR: an SVG of the same link) for an instalment’s outstanding amount; the family pays on the school’s payment page through the school’s gateway. Valid fee.payLink.days (one day)',
  auth: 'fees.collect',
  idempotent: 'required',
  request: feePayRequestSchema,
  responses: {
    201: {
      description: 'The link or QR code',
      schema: z
        .object({
          id: z.uuid(),
          channel: z.enum(['LINK', 'QR']),
          link: z.string(),
          amount: money,
          expiresAt: z.string(),
          qrSvg: z.string().optional(),
          sentTo: z
            .object({
              mobiles: z.array(z.string()),
              emails: z.array(z.string()),
              inApp: z.number().int().describe('CampusOne accounts notified in the app'),
            })
            .optional()
            .describe('Where the link was sent (masked); an empty list: not sent that way'),
        })
        .meta({ id: 'FeePaymentRequest' }),
    },
  },
});
fee({
  id: 'FEE-052',
  method: 'post',
  path: '/api/v1/console/fee-records/{recordId}/orders',
  summary:
    'Pay now at the accounts desk (client 2026-10-22): an order with the school’s gateway for the instalment’s outstanding amount, whose checkout opens on the console — no link is created or sent; kept as a DESK payment request so the gateway’s webhook settles it too',
  auth: 'fees.collect',
  idempotent: 'required',
  responses: {
    201: {
      description: 'Order',
      schema: z
        .object({ requestId: z.uuid(), amount: money, gatewayOrder: gatewayOrderSchema })
        .meta({ id: 'FeeDeskOrder' }),
    },
  },
});
fee({
  id: 'FEE-053',
  method: 'post',
  path: '/api/v1/console/fee-records/{recordId}/orders/{requestId}/verify',
  summary:
    'The desk checkout’s answer, verified as FEE-051 (signature, then the payment as the gateway holds it); the instalment is collected once, here or by the webhook, with a receipt',
  auth: 'fees.collect',
  request: feePayVerifySchema,
  responses: {
    200: {
      description: 'Collected',
      schema: z
        .object({
          receiptNo: z.string().nullable(),
          transactionId: z.string(),
          amount: money,
          mode: z.literal('ONLINE'),
          recordId: z.uuid(),
          status: z.literal('PAID'),
          collectionId: z.uuid().nullable(),
          receipt: feeReceipt.nullable(),
        })
        .meta({ id: 'FeeDeskCollected' }),
    },
  },
});
fee({
  id: 'FEE-054',
  method: 'get',
  path: '/api/v1/console/fee-collections/{collectionId}/receipt',
  summary:
    'A collection’s receipt (PDF; client 2026-10-22): the school, the student with the admission number, class and year, the instalment, fee and fine, how and when it was paid',
  auth: 'fees.view',
  responses: { 200: { description: 'PDF', contentType: 'application/pdf' } },
});
fee({
  id: 'FEE-055',
  method: 'get',
  path: '/api/v1/public/fee-payments/{requestId}/receipt',
  summary: `The receipt (PDF) of an instalment this link paid, for the family to keep (client 2026-10-22). ${feePayToken}`,
  auth: 'public (payment link token)',
  responses: { 200: { description: 'PDF', contentType: 'application/pdf' } },
});
fee({
  id: 'FEE-056',
  method: 'get',
  path: '/api/v1/console/fee-collections/{collectionId}',
  summary:
    'A collection’s receipt for the console’s receipt view (client 2026-10-22): a paid instalment’s, or a row of the Receipts tab; a wallet collection is numbered by its payment reference',
  auth: 'fees.view',
  responses: { 200: { description: 'Receipt', schema: feeReceipt } },
});
const feeReceiptsQuery = z.object({
  yearId: z.string().max(40).optional(),
  classId: z.string().max(40).optional(),
  sectionId: z.string().max(40).optional(),
  q: z.string().max(60).optional(),
  mode: z.enum(['CASH', 'ONLINE', 'WALLET'], { message: 'VALIDATION.FORMAT' }).optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
});
const modeTotal = z.object({ count: z.number().int(), amount: money });
fee({
  id: 'FEE-057',
  method: 'get',
  path: '/api/v1/console/fee-collections',
  summary:
    'The receipts of an academic year (?yearId, the current one by default), newest first, for the Receipts tab of the fee collection details (client 2026-10-22): narrowed by ?classId, ?sectionId, ?mode and ?q (the student’s name or admission number, or the receipt number); totals by mode over every receipt the filters keep; ?page and ?pageSize (15, at most 100)',
  auth: 'fees.view',
  query: feeReceiptsQuery,
  responses: {
    200: {
      description: 'Receipts',
      schema: z
        .object({
          year: z.object({ id: z.uuid(), label: z.string() }),
          items: z.array(
            z.object({
              collectionId: z.uuid(),
              receiptNo: z.string(),
              paidAt: z.string(),
              mode: z.enum(['CASH', 'ONLINE', 'WALLET']),
              paidBy: z.string().nullable(),
              transactionId: z.string().nullable(),
              amount: money,
              fine: money,
              total: money,
              student: z.object({
                id: z.uuid(),
                name: z.string(),
                admissionNo: z.string().nullable(),
                classSection: z.string().nullable(),
              }),
              instalment: z.object({ recordId: z.uuid(), label: z.string() }),
            }),
          ),
          totals: z.object({
            count: z.number().int(),
            collected: money,
            cash: modeTotal,
            online: modeTotal,
            wallet: modeTotal,
          }),
          page: z.number().int(),
          pageSize: z.number().int(),
          total: z.number().int(),
        })
        .meta({ id: 'FeeReceipts' }),
    },
  },
});
fee({
  id: 'FEE-049',
  method: 'get',
  path: '/api/v1/public/fee-payments/{requestId}',
  summary: `The payment page of a link or QR code: the school, the student, the instalment, the amount and whether it is paid. ${feePayToken}`,
  auth: 'public (payment link token)',
  responses: { 200: { description: 'The payment page', schema: feePaySummary } },
});
fee({
  id: 'FEE-050',
  method: 'post',
  path: '/api/v1/public/fee-payments/{requestId}/orders',
  summary: `An order with the school’s gateway for what is outstanding on the instalment now. ${feePayToken}`,
  auth: 'public (payment link token)',
  idempotent: 'required',
  responses: {
    201: {
      description: 'Order',
      schema: z
        .object({ amount: money, gatewayOrder: gatewayOrderSchema })
        .meta({ id: 'FeePaymentOrder' }),
    },
  },
});
fee({
  id: 'FEE-051',
  method: 'post',
  path: '/api/v1/public/fee-payments/{requestId}/verify',
  summary: `The checkout’s answer: its signature, then the payment as the gateway holds it (this order, the whole amount, captured); the instalment is paid once, here or by the gateway’s webhook. ${feePayToken}`,
  auth: 'public (payment link token)',
  request: feePayVerifySchema,
  responses: { 200: { description: 'Paid', schema: feePaySummary } },
});

export function feesRoutes(deps: {
  db: Kysely<Database>;
  fees: FeesService;
  records: FeeRecordsService;
  uploads: FeeUploadsService;
  payments: FeePaymentsService;
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
  // Fee collection details (client 2026-10-16).
  const collection = new FeeCollectionService({ db: deps.db });
  router.get(
    '/console/fee-collection',
    ...console,
    authorize('fees.view', L),
    wrap(async (req, res) => {
      const n = (k: string) => {
        const v = Number(q(req, k));
        return Number.isFinite(v) && v > 0 ? v : undefined;
      };
      res.json(
        await collection.view(principal(req), {
          yearId: q(req, 'yearId') || undefined,
          structureId: q(req, 'structureId') || undefined,
          classId: q(req, 'classId') || undefined,
          sectionId: q(req, 'sectionId') || undefined,
          q: q(req, 'q'),
          page: n('page'),
          pageSize: n('pageSize'),
        }),
      );
    }),
  );
  router.get(
    '/console/fee-collection/students/:studentId',
    ...console,
    authorize('fees.view', L),
    wrap(async (req, res) => {
      res.json(
        await collection.student(principal(req), param(req, 'studentId'), {
          yearId: q(req, 'yearId') || undefined,
          structureId: q(req, 'structureId') || undefined,
        }),
      );
    }),
  );
  // Collect Fee (client 2026-10-19): cash, a QR code or a payment link.
  const P = deps.payments;
  const payToken = (req: Request) => req.get(FEE_PAY_TOKEN) ?? q(req, 'token');
  router.get(
    '/console/fee-collection/students/:studentId/collect',
    ...console,
    authorize('fees.collect', L),
    wrap(async (req, res) => {
      res.json(
        await P.student(principal(req), param(req, 'studentId'), {
          yearId: q(req, 'yearId') || undefined,
        }),
      );
    }),
  );
  router.post(
    '/console/fee-records/:recordId/cash',
    ...console,
    authorize('fees.collect', L),
    once,
    wrap(async (req, res) => {
      res
        .status(201)
        .json(
          await P.cash(principal(req), param(req, 'recordId'), feeCashSchema.parse(req.body ?? {})),
        );
    }),
  );
  router.post(
    '/console/fee-records/:recordId/payment-requests',
    ...console,
    authorize('fees.collect', L),
    once,
    wrap(async (req, res) => {
      res
        .status(201)
        .json(
          await P.request(
            principal(req),
            param(req, 'recordId'),
            feePayRequestSchema.parse(req.body ?? {}),
          ),
        );
    }),
  );
  router.post(
    '/console/fee-records/:recordId/orders',
    ...console,
    authorize('fees.collect', L),
    once,
    wrap(async (req, res) => {
      res.status(201).json(await P.deskOrder(principal(req), param(req, 'recordId')));
    }),
  );
  router.post(
    '/console/fee-records/:recordId/orders/:requestId/verify',
    ...console,
    authorize('fees.collect', L),
    wrap(async (req, res) => {
      res.json(
        await P.deskVerify(
          principal(req),
          param(req, 'recordId'),
          param(req, 'requestId'),
          feePayVerifySchema.parse(req.body ?? {}),
        ),
      );
    }),
  );
  router.get(
    '/public/fee-payments/:requestId',
    wrap(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.json(await P.summary(param(req, 'requestId'), payToken(req)));
    }),
  );
  router.post(
    '/public/fee-payments/:requestId/orders',
    once,
    wrap(async (req, res) => {
      res.status(201).json(await P.order(param(req, 'requestId'), payToken(req)));
    }),
  );
  router.post(
    '/public/fee-payments/:requestId/verify',
    wrap(async (req, res) => {
      res.json(
        await P.verify(
          param(req, 'requestId'),
          payToken(req),
          feePayVerifySchema.parse(req.body ?? {}),
        ),
      );
    }),
  );
  router.get(
    '/public/fee-payments/:requestId/receipt',
    wrap(async (req, res) => {
      const out = await P.publicReceiptPdf(param(req, 'requestId'), payToken(req));
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${out.fileName}"`);
      res.send(out.pdf);
    }),
  );
  router.get(
    '/console/fee-collections/:collectionId/receipt',
    ...console,
    authorize('fees.view', L),
    wrap(async (req, res) => {
      const out = await P.collectionReceiptPdf(principal(req), param(req, 'collectionId'));
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${out.fileName}"`);
      res.send(out.pdf);
    }),
  );
  router.get(
    '/console/fee-records/students',
    ...console,
    authorize('fees.edit', L),
    wrap(async (req, res) => {
      res.json(
        await deps.records.students(principal(req), {
          q: q(req, 'q'),
          yearId: q(req, 'yearId'),
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
  // After /fee-collections/report, which /:collectionId would otherwise take.
  router.get(
    '/console/fee-collections',
    ...console,
    authorize('fees.view', L),
    wrap(async (req, res) => {
      res.json(await P.receipts(principal(req), feeReceiptsQuery.parse(req.query)));
    }),
  );
  router.get(
    '/console/fee-collections/:collectionId',
    ...console,
    authorize('fees.view', L),
    wrap(async (req, res) => {
      res.json(await P.collectionReceipt(principal(req), param(req, 'collectionId')));
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
