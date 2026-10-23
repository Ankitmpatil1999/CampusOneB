import { Router, type Request, type RequestHandler } from 'express';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { defineRoute } from '../config/openapi-registry';
import { singleFileUpload, uploadErrors } from '../controllers/file.controller';
import type { Loggers } from '../controllers/logger';
import { authorize, requireSurface, requireTenant } from '../middlewares/auth.middleware';
import { idempotency } from '../middlewares/idempotency.middleware';
import type { Database } from '../models/ringpe_models';
import {
  ADMISSION_DOC_TYPES,
  applicationInputSchema,
  approvalSchema,
  cashSchema,
  consoleApplicationSchema,
  deskOrderSchema,
  feePaymentStartSchema,
  feePaymentVerifySchema,
  linkEmailSchema,
  linkInputSchema,
  referenceInputSchema,
  rejectionSchema,
  resumeAskSchema,
  resumeVerifySchema,
  sectionUpdateSchema,
  statusLookupSchema,
  submissionSchema,
  tcSchema,
} from '../schemas/admissions.schema';
import type { AdmissionLinksService } from '../services/admission-links.service';
import { AdmissionsService } from '../services/admissions.service';
import { AuthenticationError, ValidationError } from '../utils/CustomAPIError';
import { expectedVersion, setEtag } from '../utils/etag';

const money = z.object({ amount: z.string(), currency: z.literal('INR') });
const appStatus = z.enum(['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED']);
// With the Aadhaar and PAN cards, front and back (client 2026-10-13).
const docType = z.enum(ADMISSION_DOC_TYPES, { message: 'VALIDATION.FORMAT' });
const application = z
  .looseObject({
    id: z.uuid(),
    applicationNo: z.string(),
    source: z.enum(['PUBLIC', 'COUNSELLOR', 'IMPORT']),
    status: appStatus,
    year: z.object({ id: z.uuid(), label: z.string() }),
    class: z.object({ id: z.uuid(), name: z.string() }).nullable(),
    midTerm: z.boolean(),
    joiningDate: z.string().nullable(),
    student: z.looseObject({ firstName: z.string().nullable() }),
    references: z.array(z.object({ id: z.uuid(), name: z.string() }).loose()),
    documents: z.array(
      z.object({ type: docType, name: z.string(), url: z.string().nullable() }).loose(),
    ),
    fees: z.array(
      z
        .object({
          id: z.uuid(),
          feeType: z.enum(['APPLICATION', 'ADMISSION']),
          amount: money,
          status: z.enum(['PENDING', 'PAID', 'FAILED']),
        })
        .loose(),
    ),
    version: z.number().int(),
  })
  .meta({ id: 'AdmissionApplication' });
const linkView = z
  .object({
    id: z.uuid(),
    status: z.enum(['ACTIVE', 'REPLACED']),
    url: z.string().nullable(),
    qrSvg: z.string().nullable(),
    year: z.string().nullable(),
    expiresAt: z.string().nullable(),
    expired: z.boolean(),
    createdAt: z.string().nullable(),
    replacedAt: z.string().nullable(),
  })
  .meta({ id: 'AdmissionLink' });
const tokenHeader = `${AdmissionsService.TOKEN_HEADER}: the resume token (or an admission-fee payment link token)`;

const doc = (d: Omit<Parameters<typeof defineRoute>[0], 'tags'>) =>
  defineRoute({ ...d, tags: ['Admissions'] });

// --- links ----------------------------------------------------------------------------------------------
doc({
  id: 'INS-027',
  method: 'get',
  path: '/api/v1/console/admission-links',
  summary: 'The current admission link and QR, and the earlier links (replaced, no longer working)',
  auth: 'admqr.view',
  responses: {
    200: {
      description: 'Links',
      schema: z
        .object({ current: linkView.nullable(), history: z.array(linkView) })
        .meta({ id: 'AdmissionLinks' }),
    },
  },
});
doc({
  id: 'INS-028',
  method: 'post',
  path: '/api/v1/console/admission-links',
  summary:
    'Generate the admission link and QR (optional preselected year and expiry); an earlier link stops working and stays in the history',
  auth: 'admqr.edit',
  request: linkInputSchema,
  idempotent: 'required',
  responses: { 201: { description: 'Generated', schema: linkView } },
});
doc({
  id: 'INS-029',
  method: 'post',
  path: '/api/v1/console/admission-links/{linkId}/email',
  summary: 'E-mail the current link to addresses',
  auth: 'admqr.edit',
  request: linkEmailSchema,
  idempotent: 'required',
  responses: { 202: { description: 'Sent', schema: z.object({ sent: z.number().int() }) } },
});

// --- public ---------------------------------------------------------------------------------------------
doc({
  id: 'ADM-001',
  method: 'get',
  path: '/api/v1/public/admissions/{linkToken}',
  summary:
    'Admission landing for a link: the institution’s name and city, the years open (regular or mid-term) with entry fees, classes with age bands, the institution’s fields, the transport pick-up stops, document and reference rules (RNG-GOV-007)',
  auth: 'public',
  responses: { 200: { description: 'Landing' } },
});
doc({
  id: 'ADM-002',
  method: 'post',
  path: '/api/v1/public/admissions/{linkToken}/resume',
  summary:
    'Resume: the identity number’s last 6 digits or the mobile; a one-time code goes to the mobile on the application. The answer is the same whether or not anything matched',
  auth: 'public',
  request: resumeAskSchema,
  responses: {
    202: {
      description: 'Code sent (if anything matched)',
      schema: z
        .object({
          challengeId: z.uuid(),
          requestToken: z.string(),
          sentTo: z.string().nullable(),
          testCode: z.string().optional().describe('Test mode only (OTP_TEST_SHOW_CODE)'),
        })
        .meta({ id: 'AdmissionResumeSent' }),
    },
  },
});
doc({
  id: 'ADM-003',
  method: 'post',
  path: '/api/v1/public/admissions/{linkToken}/resume/verify',
  summary:
    'Verify the code: the family’s applications (number, status, masked name, class, year) and a resume token — no personal record',
  auth: 'public',
  request: resumeVerifySchema,
  responses: { 200: { description: 'Applications' } },
});
doc({
  id: 'ADM-004',
  method: 'post',
  path: '/api/v1/public/admissions/{linkToken}/applications',
  summary:
    'Start a draft (class and year required; other sections optional) — returns the application and a resume token',
  auth: 'public',
  request: applicationInputSchema,
  idempotent: 'required',
  responses: {
    201: {
      description: 'Draft',
      schema: z.object({ application, resumeToken: z.string(), expiresAt: z.string() }),
    },
  },
});
doc({
  id: 'ADM-025',
  method: 'get',
  path: '/api/v1/public/admissions/applications/{applicationId}',
  summary: `The family’s draft to continue (${tokenHeader}); a payment link sees the checkout summary only`,
  auth: 'public (admission token)',
  responses: { 200: { description: 'Application', schema: application } },
});
doc({
  id: 'ADM-032',
  method: 'get',
  path: '/api/v1/public/admissions/applications/{applicationId}/form.pdf',
  summary: `The submitted application form as a PDF for the family (${tokenHeader}; not a payment link): every section as submitted, identity numbers masked, the attached pictures shown and other files by name (client 2026-10-13, 2026-10-14)`,
  auth: 'public (admission token)',
  responses: { 200: { description: 'PDF', contentType: 'application/pdf' } },
});
doc({
  id: 'ADM-005',
  method: 'patch',
  path: '/api/v1/public/admissions/applications/{applicationId}',
  summary: 'Save one section of the draft (If-Match optional); documents and references are kept',
  auth: 'public (admission token)',
  request: sectionUpdateSchema,
  responses: { 200: { description: 'Application', schema: application } },
});
doc({
  id: 'ADM-006',
  method: 'post',
  path: '/api/v1/public/admissions/applications/{applicationId}/documents',
  summary:
    'Attach a document (multipart: documentType + file; 2 MB, PDF/JPG/PNG; replaces the same type)',
  auth: 'public (admission token)',
  request: z.object({ documentType: docType, file: z.string() }),
  requestContentType: 'multipart/form-data',
  idempotent: 'required',
  responses: { 201: { description: 'Application', schema: application } },
});
doc({
  id: 'ADM-033',
  method: 'delete',
  path: '/api/v1/public/admissions/applications/{applicationId}/documents/{docType}',
  summary:
    'Remove an attachment from the draft (client 2026-10-13); a required one must be attached again before submitting',
  auth: 'public (admission token)',
  responses: { 200: { description: 'Application', schema: application } },
});
doc({
  id: 'ADM-034',
  method: 'get',
  path: '/api/v1/public/admissions/applications/{applicationId}/documents/{docType}',
  summary:
    'An attachment of the family’s application: a short-lived link to open it, with its name and type (client 2026-10-13)',
  auth: 'public (admission token)',
  responses: { 200: { description: 'The link' } },
});
doc({
  id: 'ADM-007',
  method: 'post',
  path: '/api/v1/public/admissions/applications/{applicationId}/references',
  summary: 'Add a reference (up to adm.references.max; one is required for a mid-term admission)',
  auth: 'public (admission token)',
  request: referenceInputSchema,
  idempotent: 'required',
  responses: { 201: { description: 'Application', schema: application } },
});
doc({
  id: 'ADM-008',
  method: 'delete',
  path: '/api/v1/public/admissions/applications/{applicationId}/references/{referenceId}',
  summary: 'Remove a reference',
  auth: 'public (admission token)',
  responses: { 204: { description: 'Removed' } },
});
doc({
  id: 'ADM-009',
  method: 'post',
  path: '/api/v1/public/admissions/applications/{applicationId}/submission',
  summary:
    'Submit with the declaration: everything is checked (student, address, contact, documents, age band; mid-term: TC or undertaking and a reference). Submitted at once, or after the application fee when it is mandatory',
  auth: 'public (admission token)',
  request: submissionSchema,
  idempotent: 'required',
  responses: {
    200: {
      description: 'Submitted, or waiting for the fee',
      schema: z
        .object({
          status: z.enum(['DRAFT', 'SUBMITTED']),
          applicationNo: z.string(),
          feeDue: z
            .object({ amount: z.string(), currency: z.literal('INR'), mandatory: z.boolean() })
            .nullable(),
        })
        .meta({ id: 'AdmissionSubmitted' }),
    },
  },
});
doc({
  id: 'ADM-010',
  method: 'post',
  path: '/api/v1/public/admissions/applications/{applicationId}/fee-payments',
  summary:
    'Start paying the application fee (or the admission fee, with the submitted form or after) through the gateway: an order for this fee row, reused across tries',
  auth: 'public (admission token)',
  request: feePaymentStartSchema,
  idempotent: 'required',
  responses: {
    201: {
      description: 'Order',
      schema: z
        .object({
          paymentId: z.uuid(),
          feeType: z.enum(['APPLICATION', 'ADMISSION']),
          amount: money,
          gatewayOrder: z.object({
            orderId: z.string(),
            amount: money,
            mode: z.enum(['test', 'live']),
            test: z.object({ paymentId: z.string(), signature: z.string() }).optional(),
            checkout: z
              .object({ keyId: z.string(), name: z.string() })
              .optional()
              .describe("Live (Razorpay): open the gateway's checkout with this key and the order"),
          }),
        })
        .meta({ id: 'AdmissionPaymentOrder' }),
    },
  },
});
doc({
  id: 'SAS-033',
  method: 'post',
  path: '/api/v1/partners/gateway/webhooks',
  auth: 'public',
  summary:
    "The payment gateway's webhook (Razorpay, client 2026-10-09): X-Razorpay-Signature = HMAC-SHA256 of the raw body with RAZORPAY_WEBHOOK_SECRET; each X-Razorpay-Event-Id once (webhook_receipts). payment.captured / order.paid marks the admission or application fee of that order paid; other events are acknowledged",
  responses: {
    200: {
      description: 'Received',
      schema: z.object({
        ok: z.boolean(),
        duplicate: z.boolean().optional(),
        outcome: z.string().optional(),
      }),
    },
  },
});
doc({
  id: 'INS-042',
  method: 'post',
  path: '/api/v1/partners/gateway/webhooks/{gatewayId}',
  auth: 'public',
  summary:
    "A school gateway's own webhook address (client 2026-10-09): signed with that gateway's webhook secret; settles only payments taken with that gateway; otherwise as SAS-033",
  responses: {
    200: {
      description: 'Received',
      schema: z.object({
        ok: z.boolean(),
        duplicate: z.boolean().optional(),
        outcome: z.string().optional(),
      }),
    },
  },
});
doc({
  id: 'ADM-011',
  method: 'post',
  path: '/api/v1/public/admissions/applications/{applicationId}/fee-payments/{paymentId}/verify',
  summary:
    'Verify the gateway’s answer on the server (signature over order and payment); a paid application fee submits the declared draft',
  auth: 'public (admission token)',
  request: feePaymentVerifySchema,
  responses: {
    200: {
      description: 'Paid',
      schema: z
        .object({
          status: z.literal('PAID'),
          receiptNo: z.string().nullable(),
          transactionId: z.string().describe('The payment gateway’s transaction ID'),
          applicationStatus: appStatus,
        })
        .meta({ id: 'AdmissionPaymentVerified' }),
    },
  },
});
doc({
  id: 'ADM-012',
  method: 'post',
  path: '/api/v1/public/admissions/status',
  summary:
    'Status by application number with the mobile (or date of birth): progress only — status, dates, fees due — never the family’s details (RNG-GOV-007)',
  auth: 'public',
  request: statusLookupSchema,
  responses: { 200: { description: 'Status' } },
});

// --- console: applications ------------------------------------------------------------------------------
doc({
  id: 'ADM-013',
  method: 'get',
  path: '/api/v1/console/applications',
  summary:
    'Applications (?status, ?yearId, ?classId, ?midTerm, ?q name/number/mobile, cursor) with counts by status and the KPIs',
  auth: 'admissions.view',
  responses: { 200: { description: 'Applications' } },
});
doc({
  id: 'ADM-014',
  method: 'get',
  path: '/api/v1/console/applications/{applicationId}',
  summary:
    'The full application (identity number masked), age on the reference date and its band, documents with signed links, references, fees (ETag)',
  auth: 'admissions.view',
  responses: { 200: { description: 'Application', schema: application } },
});
doc({
  id: 'ADM-035',
  method: 'get',
  path: '/api/v1/console/applications/form',
  summary:
    'What the counsellor’s application form needs, as the public landing gives it: the years open, classes with age bands, the institution’s fields, the transport pick-up stops, document and reference rules (client 2026-10-15)',
  auth: 'admissions.edit',
  responses: { 200: { description: 'The form’s lists and rules' } },
});
doc({
  id: 'ADM-036',
  method: 'delete',
  path: '/api/v1/console/applications/{applicationId}/documents/{docType}',
  summary:
    'Remove an attachment from a counsellor’s draft (client 2026-10-15; ADM-033 for the counsellor); a required one must be attached again before submitting',
  auth: 'admissions.edit',
  responses: { 200: { description: 'Application', schema: application } },
});
doc({
  id: 'ADM-015',
  method: 'post',
  path: '/api/v1/console/applications',
  summary:
    'A counsellor’s application (same model and checks as the public form; submit: true to submit)',
  auth: 'admissions.edit',
  request: consoleApplicationSchema,
  idempotent: 'required',
  responses: { 201: { description: 'Application', schema: application } },
});
doc({
  id: 'ADM-016',
  method: 'patch',
  path: '/api/v1/console/applications/{applicationId}',
  summary: 'Edit one section of a draft or submitted application (If-Match)',
  auth: 'admissions.edit',
  request: sectionUpdateSchema,
  responses: { 200: { description: 'Application', schema: application } },
});
doc({
  id: 'ADM-030',
  method: 'post',
  path: '/api/v1/console/applications/{applicationId}/submission',
  summary: 'Submit a counsellor’s draft (the same checks as the public form)',
  auth: 'admissions.edit',
  request: submissionSchema,
  idempotent: 'required',
  responses: { 200: { description: 'Submitted, or waiting for the fee' } },
});
doc({
  id: 'ADM-017',
  method: 'put',
  path: '/api/v1/console/applications/{applicationId}/transfer-certificate',
  summary:
    'Mid-term: record the transfer certificate received, or an undertaking with the date it is due',
  auth: 'admissions.edit',
  request: tcSchema,
  responses: { 200: { description: 'Application', schema: application } },
});
doc({
  id: 'ADM-028',
  method: 'post',
  path: '/api/v1/console/applications/{applicationId}/documents',
  summary: 'Attach a document from the counsellor’s desk (multipart: documentType + file; 2 MB)',
  auth: 'admissions.edit',
  request: z.object({ documentType: docType, file: z.string() }),
  requestContentType: 'multipart/form-data',
  idempotent: 'required',
  responses: { 201: { description: 'Application', schema: application } },
});
doc({
  id: 'ADM-026',
  method: 'post',
  path: '/api/v1/console/applications/{applicationId}/references',
  summary: 'Add a reference',
  auth: 'admissions.edit',
  request: referenceInputSchema,
  idempotent: 'required',
  responses: { 201: { description: 'Application', schema: application } },
});
doc({
  id: 'ADM-027',
  method: 'delete',
  path: '/api/v1/console/applications/{applicationId}/references/{referenceId}',
  summary: 'Remove a reference (a submitted mid-term application keeps at least one)',
  auth: 'admissions.edit',
  responses: { 200: { description: 'Application', schema: application } },
});
doc({
  id: 'ADM-018',
  method: 'post',
  path: '/api/v1/console/applications/{applicationId}/approval',
  summary:
    'Approve (If-Match): user type and department, a section of the class applied for, the admission number → the student member, wallets, guardian links and enrolment, in one transaction',
  auth: 'admissions.approve',
  request: approvalSchema,
  idempotent: 'required',
  responses: {
    200: {
      description: 'Approved',
      schema: z.object({ memberId: z.uuid(), application }).meta({ id: 'AdmissionApproved' }),
    },
  },
});
doc({
  id: 'ADM-019',
  method: 'post',
  path: '/api/v1/console/applications/{applicationId}/rejection',
  summary: 'Reject with a reason (If-Match)',
  auth: 'admissions.approve',
  request: rejectionSchema,
  idempotent: 'required',
  responses: { 200: { description: 'Rejected', schema: application } },
});
doc({
  id: 'ADM-029',
  method: 'get',
  path: '/api/v1/console/applications/imports/template',
  summary:
    "The existing-students sheet template (CSV): the public admission form's fields in its order, with the section and admission number, then the school's own form fields (client 2026-10-21)",
  auth: 'admissions.edit',
  responses: { 200: { description: 'Template', contentType: 'text/csv' } },
});
doc({
  id: 'ADM-020',
  method: 'post',
  path: '/api/v1/console/applications/imports',
  summary:
    'Existing students (CSV, 2 MB): each row checked like the form; a passing row creates the member, wallets, guardian link and enrolment with an Approved application; refused rows are reported',
  auth: 'admissions.edit',
  request: z.object({ file: z.string() }),
  requestContentType: 'multipart/form-data',
  idempotent: 'required',
  responses: { 201: { description: 'Report' } },
});

// --- console: fees --------------------------------------------------------------------------------------
doc({
  id: 'ADM-021',
  method: 'get',
  path: '/api/v1/console/admission-fees',
  summary:
    'Application and admission fees (?yearId, ?feeType, ?status) with collected and pending totals',
  auth: 'admfees.view',
  responses: { 200: { description: 'Fees' } },
});
doc({
  id: 'ADM-022',
  method: 'post',
  path: '/api/v1/console/applications/{applicationId}/admission-fee/cash',
  summary:
    'Record cash at the accounts desk (the application fee, or the admission fee from submission on): once, with who paid and who collected; a paid application fee submits a declared draft',
  auth: 'admfees.collect',
  request: cashSchema,
  idempotent: 'required',
  responses: { 201: { description: 'Receipt' } },
});
doc({
  id: 'ADM-023',
  method: 'post',
  path: '/api/v1/console/applications/{applicationId}/admission-fee/online',
  summary:
    'A payment link for the admission fee (valid adm.payLink.days, one day), sent at once (client 2026-10-22): by SMS and e-mail to the parents on the application — and the student once a member — through the school’s channels, and in the app to those with a RingPe account at the school; `sent` says where (masked)',
  auth: 'admfees.collect',
  idempotent: 'required',
  responses: { 201: { description: 'Link' } },
});
doc({
  id: 'ADM-037',
  method: 'post',
  path: '/api/v1/console/applications/{applicationId}/admission-fee/orders',
  summary:
    'Pay now at the accounts desk (client 2026-10-22): an order with the school’s gateway for the application or admission fee, whose checkout opens on the console — no link is created or sent; the rules of ADM-010 (the admission fee not before the application fee)',
  auth: 'admfees.collect',
  request: deskOrderSchema,
  idempotent: 'required',
  responses: { 201: { description: 'Order, as ADM-010' } },
});
doc({
  id: 'ADM-038',
  method: 'post',
  path: '/api/v1/console/applications/{applicationId}/admission-fee/orders/{paymentId}/verify',
  summary:
    'The desk checkout’s answer, verified on the server as ADM-011 (signature, then the payment as the gateway holds it); the fee is paid with its receipt',
  auth: 'admfees.collect',
  request: feePaymentVerifySchema,
  responses: { 200: { description: 'Paid, as ADM-011' } },
});
doc({
  id: 'ADM-039',
  method: 'get',
  path: '/api/v1/console/members/{memberId}/admission',
  summary:
    'A member’s admission records (client 2026-10-22): a student’s own application — from the public form, the counsellor’s or the members bulk upload — or each child’s for a parent, with how the member appears on it (STUDENT, FATHER, MOTHER, GUARDIAN), as ADM-014 shows it with the documents; `editable` when the caller may edit an admitted record',
  auth: 'members.view',
  responses: { 200: { description: 'Records' } },
});
doc({
  id: 'ADM-040',
  method: 'patch',
  path: '/api/v1/console/applications/{applicationId}/record',
  summary:
    'Edit a section of an admitted record (client 2026-10-22; If-Match): as ADM-016, except that the identity stays — the student’s name, gender and date of birth, each person’s name and mobile, the primary contact and every Aadhaar and PAN (omitted) — else 422 IDN.PII_READ_ONLY on the field; one with nothing stored (an older bulk upload’s) is filled once, a parent it never had added; the class section is the enrolment’s',
  auth: 'members.edit',
  request: sectionUpdateSchema,
  responses: { 200: { description: 'Application', schema: application } },
});
doc({
  id: 'ADM-041',
  method: 'post',
  path: '/api/v1/console/applications/{applicationId}/record-documents',
  summary:
    'Add a document to an admitted record, or replace one of the same type (client 2026-10-22; multipart: documentType + file; 2 MB)',
  auth: 'members.edit',
  request: z.object({ documentType: docType, file: z.string() }),
  requestContentType: 'multipart/form-data',
  idempotent: 'required',
  responses: { 201: { description: 'Application', schema: application } },
});
doc({
  id: 'ADM-031',
  method: 'post',
  path: '/api/v1/console/admission-payments/{paymentId}/confirmation',
  summary:
    'Accounts confirms a paid fee was received (online or cash), once; both fees confirmed let the Co-ordinator assign the admission number and section',
  auth: 'admfees.verify',
  idempotent: 'required',
  responses: { 200: { description: 'The confirmation and the application' } },
});
doc({
  id: 'ADM-024',
  method: 'get',
  path: '/api/v1/console/admission-receipts/{receiptId}',
  summary: 'A paid fee’s receipt (PDF)',
  auth: 'admfees.view',
  responses: { 200: { description: 'PDF', contentType: 'application/pdf' } },
});

/** Mounted under /api/v1. */
export function admissionsRoutes(deps: {
  db: Kysely<Database>;
  admissions: AdmissionsService;
  links: AdmissionLinksService;
  loggers: Loggers;
  authLimiter: RequestHandler;
}): Router {
  const router = Router();
  const L = deps.loggers;
  const A = deps.admissions;
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
  const param = (req: Request, k: string) => String(req.params[k]);
  const q = (req: Request, k: string) =>
    typeof req.query[k] === 'string' ? (req.query[k] as string) : undefined;
  const token = (req: Request) => req.get(AdmissionsService.TOKEN_HEADER) ?? q(req, 'token');
  const ifMatch = (req: Request) => (req.get('if-match') ? expectedVersion(req) : null);
  const console = [requireSurface(L, 'console'), requireTenant(L)];

  // INS-042: a school gateway's own webhook address (its keys, its payments only).
  router.post(
    '/partners/gateway/webhooks/:gatewayId',
    wrap(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.json(
        await A.gatewayEvent({
          rawBody: req.rawBody,
          signature: req.get('x-razorpay-signature'),
          eventId: req.get('x-razorpay-event-id'),
          ip: req.ip,
          gatewayPublicId: String(req.params['gatewayId']),
        }),
      );
    }),
  );
  // SAS-033: the gateway's signed webhook (no session; the signature is the authentication).
  router.post(
    '/partners/gateway/webhooks',
    wrap(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.json(
        await A.gatewayEvent({
          rawBody: req.rawBody,
          signature: req.get('x-razorpay-signature'),
          eventId: req.get('x-razorpay-event-id'),
          ip: req.ip,
        }),
      );
    }),
  );
  const fileOf = (req: Request) => {
    if (!req.file) throw new ValidationError([{ field: 'file', code: 'UPL.FILE_REQUIRED' }]);
    const t = docType.safeParse(
      String((req.body as Record<string, unknown> | undefined)?.['documentType'] ?? ''),
    );
    if (!t.success)
      throw new ValidationError([{ field: 'documentType', code: 'VALIDATION.FORMAT' }]);
    return {
      docType: t.data,
      fileName: req.file.originalname || 'document',
      data: req.file.buffer,
    };
  };

  // --- links ------------------------------------------------------------------------------------------
  router.get(
    '/console/admission-links',
    ...console,
    authorize('admqr.view', L),
    wrap(async (req, res) => {
      res.json(await deps.links.links(principal(req)));
    }),
  );
  router.post(
    '/console/admission-links',
    ...console,
    authorize('admqr.edit', L),
    once,
    wrap(async (req, res) => {
      res
        .status(201)
        .json(await deps.links.generate(principal(req), linkInputSchema.parse(req.body ?? {})));
    }),
  );
  router.post(
    '/console/admission-links/:linkId/email',
    ...console,
    authorize('admqr.edit', L),
    once,
    wrap(async (req, res) => {
      res
        .status(202)
        .json(
          await deps.links.email(
            principal(req),
            param(req, 'linkId'),
            linkEmailSchema.parse(req.body ?? {}),
          ),
        );
    }),
  );

  // --- public -----------------------------------------------------------------------------------------
  router.post(
    '/public/admissions/status',
    deps.authLimiter,
    wrap(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.json(await A.status(statusLookupSchema.parse(req.body ?? {})));
    }),
  );
  router.get(
    '/public/admissions/applications/:applicationId',
    wrap(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      const out = await A.publicRead(param(req, 'applicationId'), token(req));
      setEtag(res, out.version);
      res.json(out);
    }),
  );
  router.get(
    '/public/admissions/applications/:applicationId/form.pdf',
    wrap(async (req, res) => {
      const out = await A.publicFormPdf(param(req, 'applicationId'), token(req));
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${out.fileName}"`);
      res.send(out.pdf);
    }),
  );
  router.patch(
    '/public/admissions/applications/:applicationId',
    wrap(async (req, res) => {
      const b = sectionUpdateSchema.parse(req.body ?? {});
      const out = await A.publicUpdate(param(req, 'applicationId'), token(req), ifMatch(req), b);
      setEtag(res, out.version);
      res.json(out);
    }),
  );
  router.post(
    '/public/admissions/applications/:applicationId/documents',
    once,
    singleFileUpload,
    uploadErrors,
    wrap(async (req, res) => {
      res
        .status(201)
        .json(await A.publicDocument(param(req, 'applicationId'), token(req), fileOf(req)));
    }),
  );
  router.delete(
    '/public/admissions/applications/:applicationId/documents/:docType',
    wrap(async (req, res) => {
      const t = docType.safeParse(param(req, 'docType'));
      if (!t.success) throw new ValidationError([{ field: 'docType', code: 'VALIDATION.FORMAT' }]);
      res.json(await A.publicRemoveDocument(param(req, 'applicationId'), token(req), t.data));
    }),
  );
  router.get(
    '/public/admissions/applications/:applicationId/documents/:docType',
    wrap(async (req, res) => {
      const t = docType.safeParse(param(req, 'docType'));
      if (!t.success) throw new ValidationError([{ field: 'docType', code: 'VALIDATION.FORMAT' }]);
      res.setHeader('Cache-Control', 'no-store');
      res.json(await A.publicDocumentLink(param(req, 'applicationId'), token(req), t.data));
    }),
  );
  router.post(
    '/public/admissions/applications/:applicationId/references',
    once,
    wrap(async (req, res) => {
      res
        .status(201)
        .json(
          await A.publicAddReference(
            param(req, 'applicationId'),
            token(req),
            referenceInputSchema.parse(req.body ?? {}),
          ),
        );
    }),
  );
  router.delete(
    '/public/admissions/applications/:applicationId/references/:referenceId',
    wrap(async (req, res) => {
      await A.publicRemoveReference(
        param(req, 'applicationId'),
        token(req),
        param(req, 'referenceId'),
      );
      res.status(204).end();
    }),
  );
  router.post(
    '/public/admissions/applications/:applicationId/submission',
    once,
    wrap(async (req, res) => {
      const b = submissionSchema.parse(req.body ?? {});
      res.json(
        await A.publicSubmit(param(req, 'applicationId'), token(req), { payLater: b.payLater }),
      );
    }),
  );
  router.post(
    '/public/admissions/applications/:applicationId/fee-payments',
    once,
    wrap(async (req, res) => {
      res
        .status(201)
        .json(
          await A.startPayment(
            param(req, 'applicationId'),
            token(req),
            feePaymentStartSchema.parse(req.body ?? {}),
          ),
        );
    }),
  );
  router.post(
    '/public/admissions/applications/:applicationId/fee-payments/:paymentId/verify',
    wrap(async (req, res) => {
      res.json(
        await A.verifyPayment(
          param(req, 'applicationId'),
          token(req),
          param(req, 'paymentId'),
          feePaymentVerifySchema.parse(req.body ?? {}),
        ),
      );
    }),
  );
  router.get(
    '/public/admissions/:linkToken',
    wrap(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.json(await deps.links.landing(param(req, 'linkToken')));
    }),
  );
  router.post(
    '/public/admissions/:linkToken/resume',
    deps.authLimiter,
    wrap(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res
        .status(202)
        .json(await A.resumeAsk(param(req, 'linkToken'), resumeAskSchema.parse(req.body ?? {})));
    }),
  );
  router.post(
    '/public/admissions/:linkToken/resume/verify',
    deps.authLimiter,
    wrap(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.json(
        await A.resumeVerify(param(req, 'linkToken'), resumeVerifySchema.parse(req.body ?? {})),
      );
    }),
  );
  router.post(
    '/public/admissions/:linkToken/applications',
    deps.authLimiter,
    once,
    wrap(async (req, res) => {
      const out = await A.publicCreate(
        param(req, 'linkToken'),
        applicationInputSchema.parse(req.body ?? {}),
      );
      setEtag(res, out.application.version);
      res.status(201).json(out);
    }),
  );

  // --- console: applications --------------------------------------------------------------------------
  router.get(
    '/console/applications/imports/template',
    ...console,
    authorize('admissions.edit', L),
    wrap(async (req, res) => {
      const out = await A.importTemplate(principal(req));
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${out.fileName}"`);
      res.send(String.fromCharCode(0xfeff) + out.csv);
    }),
  );
  router.post(
    '/console/applications/imports',
    ...console,
    authorize('admissions.edit', L),
    once,
    singleFileUpload,
    uploadErrors,
    wrap(async (req, res) => {
      if (!req.file) throw new ValidationError([{ field: 'file', code: 'UPL.FILE_REQUIRED' }]);
      res.status(201).json(
        await A.import(principal(req), {
          fileName: req.file.originalname || 'students.csv',
          content: req.file.buffer.toString('utf8'),
        }),
      );
    }),
  );
  router.get(
    '/console/applications',
    ...console,
    authorize('admissions.view', L),
    wrap(async (req, res) => {
      res.json(
        await A.list(principal(req), {
          status: appStatus.optional().parse(q(req, 'status')),
          yearId: q(req, 'yearId'),
          classId: q(req, 'classId'),
          midTerm: q(req, 'midTerm') === 'true' || q(req, 'midTerm') === '1',
          q: q(req, 'q'),
          cursor: q(req, 'cursor'),
        }),
      );
    }),
  );
  // Before /console/applications/:applicationId.
  router.get(
    '/console/applications/form',
    ...console,
    authorize('admissions.edit', L),
    wrap(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.json(await deps.links.consoleForm(principal(req)));
    }),
  );
  router.get(
    '/console/applications/:applicationId',
    ...console,
    authorize('admissions.view', L),
    wrap(async (req, res) => {
      const out = await A.detail(principal(req), param(req, 'applicationId'));
      setEtag(res, out.version);
      res.json(out);
    }),
  );
  router.post(
    '/console/applications',
    ...console,
    authorize('admissions.edit', L),
    once,
    wrap(async (req, res) => {
      const out = await A.consoleCreate(
        principal(req),
        consoleApplicationSchema.parse(req.body ?? {}),
      );
      setEtag(res, out.version);
      res.status(201).json(out);
    }),
  );
  router.patch(
    '/console/applications/:applicationId',
    ...console,
    authorize('admissions.edit', L),
    wrap(async (req, res) => {
      const out = await A.consoleUpdate(
        principal(req),
        param(req, 'applicationId'),
        expectedVersion(req),
        sectionUpdateSchema.parse(req.body ?? {}),
      );
      setEtag(res, out.version);
      res.json(out);
    }),
  );
  router.post(
    '/console/applications/:applicationId/submission',
    ...console,
    authorize('admissions.edit', L),
    once,
    wrap(async (req, res) => {
      const b = submissionSchema.parse(req.body ?? {});
      res.json(
        await A.consoleSubmit(principal(req), param(req, 'applicationId'), {
          payLater: b.payLater,
        }),
      );
    }),
  );
  router.put(
    '/console/applications/:applicationId/transfer-certificate',
    ...console,
    authorize('admissions.edit', L),
    wrap(async (req, res) => {
      const out = await A.setTransferCertificate(
        principal(req),
        param(req, 'applicationId'),
        tcSchema.parse(req.body ?? {}),
      );
      setEtag(res, out.version);
      res.json(out);
    }),
  );
  router.post(
    '/console/applications/:applicationId/documents',
    ...console,
    authorize('admissions.edit', L),
    once,
    singleFileUpload,
    uploadErrors,
    wrap(async (req, res) => {
      // The application first: another institution's id is a 404 whatever the upload holds.
      await A.detail(principal(req), param(req, 'applicationId'));
      res
        .status(201)
        .json(await A.consoleDocument(principal(req), param(req, 'applicationId'), fileOf(req)));
    }),
  );
  // A member's admission record (client 2026-10-22): the Members page reads and edits it.
  router.get(
    '/console/members/:memberId/admission',
    ...console,
    authorize('members.view', L),
    wrap(async (req, res) => {
      res.json(await A.memberRecords(principal(req), param(req, 'memberId')));
    }),
  );
  router.patch(
    '/console/applications/:applicationId/record',
    ...console,
    authorize('members.edit', L),
    wrap(async (req, res) => {
      const { section, data } = sectionUpdateSchema.parse(req.body ?? {});
      const out = await A.recordUpdate(
        principal(req),
        param(req, 'applicationId'),
        expectedVersion(req),
        { section, data },
      );
      setEtag(res, out.version);
      res.json(out);
    }),
  );
  router.post(
    '/console/applications/:applicationId/record-documents',
    ...console,
    authorize('members.edit', L),
    once,
    singleFileUpload,
    uploadErrors,
    wrap(async (req, res) => {
      // The application first: another institution's id is a 404 whatever the upload holds.
      await A.detail(principal(req), param(req, 'applicationId'));
      res
        .status(201)
        .json(await A.recordDocument(principal(req), param(req, 'applicationId'), fileOf(req)));
    }),
  );
  router.delete(
    '/console/applications/:applicationId/documents/:docType',
    ...console,
    authorize('admissions.edit', L),
    wrap(async (req, res) => {
      const t = docType.safeParse(param(req, 'docType'));
      if (!t.success) throw new ValidationError([{ field: 'docType', code: 'VALIDATION.FORMAT' }]);
      res.json(await A.consoleRemoveDocument(principal(req), param(req, 'applicationId'), t.data));
    }),
  );
  router.post(
    '/console/applications/:applicationId/references',
    ...console,
    authorize('admissions.edit', L),
    once,
    wrap(async (req, res) => {
      res
        .status(201)
        .json(
          await A.consoleAddReference(
            principal(req),
            param(req, 'applicationId'),
            referenceInputSchema.parse(req.body ?? {}),
          ),
        );
    }),
  );
  router.delete(
    '/console/applications/:applicationId/references/:referenceId',
    ...console,
    authorize('admissions.edit', L),
    wrap(async (req, res) => {
      res.json(
        await A.consoleRemoveReference(
          principal(req),
          param(req, 'applicationId'),
          param(req, 'referenceId'),
        ),
      );
    }),
  );
  router.post(
    '/console/applications/:applicationId/approval',
    ...console,
    authorize('admissions.approve', L),
    once,
    wrap(async (req, res) => {
      res.json(
        await A.approve(
          principal(req),
          param(req, 'applicationId'),
          expectedVersion(req),
          approvalSchema.parse(req.body ?? {}),
        ),
      );
    }),
  );
  router.post(
    '/console/applications/:applicationId/rejection',
    ...console,
    authorize('admissions.approve', L),
    once,
    wrap(async (req, res) => {
      res.json(
        await A.reject(
          principal(req),
          param(req, 'applicationId'),
          expectedVersion(req),
          rejectionSchema.parse(req.body ?? {}),
        ),
      );
    }),
  );

  // --- console: fees ----------------------------------------------------------------------------------
  router.get(
    '/console/admission-fees',
    ...console,
    authorize('admfees.view', L),
    wrap(async (req, res) => {
      res.json(
        await A.fees(principal(req), {
          yearId: q(req, 'yearId'),
          feeType: z.enum(['APPLICATION', 'ADMISSION']).optional().parse(q(req, 'feeType')),
          status: z.enum(['PENDING', 'PAID', 'FAILED']).optional().parse(q(req, 'status')),
        }),
      );
    }),
  );
  router.post(
    '/console/applications/:applicationId/admission-fee/cash',
    ...console,
    authorize('admfees.collect', L),
    once,
    wrap(async (req, res) => {
      res
        .status(201)
        .json(
          await A.cash(
            principal(req),
            param(req, 'applicationId'),
            cashSchema.parse(req.body ?? {}),
          ),
        );
    }),
  );
  router.post(
    '/console/applications/:applicationId/admission-fee/online',
    ...console,
    authorize('admfees.collect', L),
    once,
    wrap(async (req, res) => {
      res.status(201).json(await A.onlineLink(principal(req), param(req, 'applicationId')));
    }),
  );
  router.post(
    '/console/applications/:applicationId/admission-fee/orders',
    ...console,
    authorize('admfees.collect', L),
    once,
    wrap(async (req, res) => {
      const { feeType } = deskOrderSchema.parse(req.body ?? {});
      res.status(201).json(await A.deskOrder(principal(req), param(req, 'applicationId'), feeType));
    }),
  );
  router.post(
    '/console/applications/:applicationId/admission-fee/orders/:paymentId/verify',
    ...console,
    authorize('admfees.collect', L),
    wrap(async (req, res) => {
      res.json(
        await A.deskVerify(
          principal(req),
          param(req, 'applicationId'),
          param(req, 'paymentId'),
          feePaymentVerifySchema.parse(req.body ?? {}),
        ),
      );
    }),
  );
  router.post(
    '/console/admission-payments/:paymentId/confirmation',
    ...console,
    authorize('admfees.verify', L),
    once,
    wrap(async (req, res) => {
      res.json(await A.confirmFee(principal(req), param(req, 'paymentId')));
    }),
  );
  router.get(
    '/console/admission-receipts/:receiptId',
    ...console,
    authorize('admfees.view', L),
    wrap(async (req, res) => {
      const out = await A.receiptPdf(principal(req), param(req, 'receiptId'));
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${out.fileName}"`);
      res.send(out.pdf);
    }),
  );
  return router;
}
