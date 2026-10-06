import { Router, type Request, type RequestHandler } from 'express';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { defineRoute } from '../config/openapi-registry';
import type { Loggers } from '../controllers/logger';
import { authorize, requireSurface, requireTenant } from '../middlewares/auth.middleware';
import { idempotency } from '../middlewares/idempotency.middleware';
import type { Database } from '../models/ringpe_models';
import type { PartnersService } from '../services/partners.service';
import type { CaptureInput, PosService } from '../services/pos.service';
import type { TerminalsService } from '../services/terminals.service';
import { AuthenticationError, ValidationError } from '../utils/CustomAPIError';
import { expectedVersion, setEtag } from '../utils/etag';
import { uuidToBin } from '../utils/idGenerator';
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
const hhmm = z
  .string({ message: 'VALIDATION.REQUIRED' })
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'VALIDATION.FORMAT' });
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { message: 'VALIDATION.DATE' });
const orderType = z.enum(['DINE_IN', 'TAKEAWAY'], { message: 'VALIDATION.FORMAT' });
const lines = z
  .array(
    z.strictObject({
      itemId: id,
      qty: z
        .number({ message: 'VALIDATION.REQUIRED' })
        .int({ message: 'VALIDATION.FORMAT' })
        .min(1, { message: 'VALIDATION.FORMAT' })
        .max(99, { message: 'VALIDATION.FORMAT' }),
    }),
    { message: 'VALIDATION.REQUIRED' },
  )
  .min(1, { message: 'VALIDATION.REQUIRED' })
  .max(50, { message: 'VALIDATION.FORMAT' });

// --- requests ------------------------------------------------------------------------------------
export const operatorSignInSchema = z
  .strictObject({ operatorTag: text(40).describe('The token read from the operator’s NFC tag') })
  .meta({ id: 'PosOperatorSignIn' });
export const categoryInputSchema = z
  .strictObject({
    name: text(24).regex(/^[\p{L} &'-]+$/u, { message: 'VALIDATION.FORMAT' }),
  })
  .meta({ id: 'PosCategoryInput' });
export const itemInputSchema = z
  .strictObject({
    categoryId: id,
    name: text(40)
      .min(2, { message: 'VALIDATION.FORMAT' })
      .regex(/^[\p{L}0-9 &()'.,×-]+$/u, { message: 'VALIDATION.FORMAT' }),
    description: z.string().trim().max(200, { message: 'VALIDATION.FORMAT' }).nullish(),
    foodType: z.enum(['VEG', 'NON_VEG'], { message: 'VALIDATION.FORMAT' }).nullish(),
    price: moneyIn,
    gstRate: z.number({ message: 'VALIDATION.FORMAT' }).optional().describe('0, 5, 12, 18 or 28'),
    available: z.boolean({ message: 'VALIDATION.FORMAT' }).optional(),
  })
  .meta({ id: 'PosItemInput' });
export const itemPatchSchema = itemInputSchema.partial().meta({ id: 'PosItemPatch' });
export const outletInputSchema = z
  .strictObject({
    name: text(40).min(3, { message: 'VALIDATION.FORMAT' }),
    opensAt: hhmm,
    closesAt: hhmm,
    gstin: z.string().trim().max(15, { message: 'VALIDATION.FORMAT' }).nullish(),
  })
  .meta({ id: 'PosOutletInput' });
export const orderInputSchema = z
  .strictObject({ type: orderType, lines })
  .meta({ id: 'PosOrderInput' });
export const orderCancelSchema = z
  .strictObject({ reason: z.string().trim().max(200, { message: 'VALIDATION.FORMAT' }).nullish() })
  .meta({ id: 'PosOrderCancel' });
export const posRequestInputSchema = z
  .strictObject({ instrument: z.enum(['WALLET', 'ALLOWANCE'], { message: 'VALIDATION.FORMAT' }) })
  .meta({ id: 'PosRequestInput' });
export const collectionInputSchema = z
  .strictObject({
    instrument: z.enum(['WALLET', 'ALLOWANCE', 'COUPON'], { message: 'VALIDATION.FORMAT' }),
    cardToken: text(40),
    requestId: z
      .string()
      .trim()
      .max(40)
      .optional()
      .describe('The order’s NFC request (not for a coupon)'),
    nonce: z.string().trim().max(64).optional().describe('The request’s one-time nonce'),
  })
  .meta({ id: 'PosCollectionInput' });
const captureSchema = z.strictObject({
  captureKey: z
    .string({ message: 'VALIDATION.REQUIRED' })
    .regex(/^[A-Za-z0-9._:-]{8,64}$/, { message: 'VALIDATION.FORMAT' })
    .describe('The terminal’s idempotency key for this capture'),
  orderId: z.string().trim().max(40).nullish().describe('An order created online'),
  order: z
    .strictObject({ type: orderType, lines })
    .optional()
    .describe('An order created while offline: priced from the menu when it arrives'),
  cardToken: text(40),
  instrument: z.enum(['WALLET', 'ALLOWANCE'], { message: 'VALIDATION.FORMAT' }),
  amount: moneyIn,
  capturedAt: z.iso.datetime({ offset: true, message: 'VALIDATION.DATE' }),
  signature: z
    .string()
    .regex(/^[0-9a-f]{64}$/, { message: 'VALIDATION.FORMAT' })
    .optional()
    .describe(
      'Terminals: hex HMAC-SHA256 with the device secret of "<captureKey>.<cardToken>.<amount in paise>.<orderId or empty>.<capturedAt>"',
    ),
});
export const batchInputSchema = z
  .strictObject({
    batchId: z.uuid({ message: 'VALIDATION.FORMAT' }),
    captures: z.array(captureSchema).min(1, { message: 'VALIDATION.REQUIRED' }),
  })
  .meta({ id: 'PosOfflineBatchInput' });
export const tagInputSchema = z
  .strictObject({
    operatorName: text(40)
      .min(3, { message: 'VALIDATION.FORMAT' })
      .regex(/^[\p{L} .'-]+$/u, { message: 'VALIDATION.FORMAT' }),
    operatorMobile: z
      .string({ message: 'VALIDATION.REQUIRED' })
      .regex(/^[6-9]\d{9}$/, { message: 'VALIDATION.MOBILE' }),
  })
  .meta({ id: 'PosTagInput' });
export const tagReissueSchema = z
  .strictObject({ reason: text(200).min(3, { message: 'VALIDATION.FORMAT' }) })
  .meta({ id: 'PosTagReissue' });
export const partnerRequestInputSchema = z
  .strictObject({
    requestId: text(64).describe('The partner’s id for this call: accepted once'),
    terminalRef: id.describe('The POS terminal id (the counter)'),
    amount: moneyIn,
    orderRef: z.string().trim().max(40).optional().describe('A canteen order of the counter'),
  })
  .meta({ id: 'PosPartnerRequestInput' });
export const partnerCapturesSchema = z
  .strictObject({
    requestId: text(64),
    terminalRef: id,
    batchId: z.uuid({ message: 'VALIDATION.FORMAT' }),
    captures: z.array(captureSchema).min(1, { message: 'VALIDATION.REQUIRED' }),
  })
  .meta({ id: 'PosPartnerCapturesInput' });

// --- responses -----------------------------------------------------------------------------------
const operator = z.object({
  id: z.uuid(),
  name: z.string(),
  mobile: z.string().describe('Masked'),
  tag: z.string().describe('Masked tag token'),
  since: z.string().nullable(),
  expiresAt: z.string().nullable(),
});
const item = z
  .object({
    id: z.uuid(),
    categoryId: z.uuid(),
    name: z.string(),
    description: z.string().nullable(),
    foodType: z.enum(['VEG', 'NON_VEG']).nullable(),
    price: money,
    gstRate: z.number(),
    available: z.boolean(),
    version: z.number().int(),
  })
  .meta({ id: 'PosItem' });
const outlet = z
  .object({
    id: z.uuid(),
    name: z.string(),
    merchant: z.string(),
    opensAt: z.string().nullable(),
    closesAt: z.string().nullable(),
    gstin: z.string().nullable(),
    version: z.number().int(),
  })
  .meta({ id: 'PosOutlet' });
const category = z
  .object({ id: z.uuid(), name: z.string(), items: z.array(item) })
  .meta({ id: 'PosCategory' });
const order = z
  .object({
    id: z.uuid(),
    number: z.string(),
    type: orderType,
    status: z.enum(['CREATED', 'PAID', 'CANCELLED']),
    payment: z.enum(['PENDING', 'SUCCESS', 'FAILED', 'CANCELLED']),
    lastFailureCode: z.string().nullable(),
    lines: z.array(
      z.object({
        itemId: z.uuid(),
        name: z.string(),
        qty: z.number().int(),
        unitPrice: money,
        gstRate: z.number(),
        net: money,
        tax: money,
        total: money,
      }),
    ),
    subtotal: money,
    tax: money,
    cgst: money,
    sgst: money,
    total: money,
    instrument: z.enum(['WALLET', 'ALLOWANCE', 'COUPON']).nullable(),
    payer: z.object({ name: z.string() }).nullable(),
    reference: z.string().nullable(),
    operator: z.string().nullable(),
    offline: z.boolean(),
    createdAt: z.string().nullable(),
    paidAt: z.string().nullable(),
    cancelledAt: z.string().nullable(),
    version: z.number().int(),
  })
  .meta({ id: 'PosOrder' });
const batch = z
  .object({
    batchId: z.uuid(),
    receivedAt: z.string().nullable(),
    summary: z.object({ accepted: z.number(), refused: z.number(), replayed: z.number() }),
    captures: z.array(
      z.object({
        captureKey: z.string(),
        outcome: z.enum(['PROCESSING', 'ACCEPTED', 'REFUSED']),
        replayed: z.boolean().describe('Sent before: acknowledged with its first outcome'),
        code: z.string().nullable(),
        reference: z.string().nullable(),
        order: z.object({ id: z.uuid(), number: z.string() }).nullable(),
        amount: money,
        card: z.string().nullable(),
        capturedAt: z.string().nullable(),
      }),
    ),
  })
  .meta({ id: 'PosOfflineBatch' });
const tag = z
  .object({
    id: z.uuid(),
    operatorName: z.string(),
    mobile: z.string(),
    tag: z.string(),
    status: z.enum(['ACTIVE', 'INACTIVE']),
    reissueCount: z.number().int(),
    reissueReason: z.string().nullable(),
    issuedAt: z.string().nullable(),
    endedAt: z.string().nullable(),
    signedInNow: z.boolean().optional(),
  })
  .meta({ id: 'PosOperatorTag' });
const tagIssued = z
  .object({ tag, tagToken: z.string().describe('Written to the NFC tag; shown once') })
  .meta({ id: 'PosOperatorTagIssued' });
const posRequest = z
  .object({
    requestId: z.uuid(),
    orderId: z.uuid(),
    instrument: z.enum(['WALLET', 'ALLOWANCE']),
    amount: money,
    nonce: z.string().describe('One-time; the card tap returns it'),
    expiresAt: z.string(),
    ttlSeconds: z.number().int(),
  })
  .meta({ id: 'PosPaymentRequest' });
const collected = z
  .object({
    order,
    receipt: z
      .object({
        reference: z.string(),
        amount: money,
        instrument: z.enum(['WALLET', 'ALLOWANCE']),
        payer: z.object({ name: z.string() }),
        paidAt: z.string().nullable(),
      })
      .nullable(),
    coupon: z.object({ type: z.string(), holder: z.string(), redeemedAt: z.string() }).nullable(),
    replayed: z.boolean(),
  })
  .meta({ id: 'PosCollection' });

const doc = (tags: string[]) => (d: Omit<Parameters<typeof defineRoute>[0], 'tags'>) =>
  defineRoute({ ...d, tags });
const pos = doc(['Point of sale']);
const partner = doc(['Partner API']);
const T = 'terminal: pos';

pos({
  id: 'IDN-042',
  method: 'post',
  path: '/api/v1/terminal/pos/operators/signin',
  summary:
    'An operator signs in on the paired POS terminal with their NFC tag, for pos.operator.sessionMinutes (6.34, FR-MER-04)',
  auth: T,
  request: operatorSignInSchema,
  responses: { 200: { description: 'Signed in', schema: z.object({ operator }) } },
});
pos({
  id: 'MER-019',
  method: 'post',
  path: '/api/v1/terminal/pos/operators/signout',
  summary: 'The operator signs out; the terminal stays paired',
  auth: T,
  responses: { 204: { description: 'Signed out' } },
});
pos({
  id: 'MER-001',
  method: 'get',
  path: '/api/v1/terminal/pos/menu',
  summary:
    'The outlet (created on first use, OI-MER-10), its categories and items with availability, the GST settings and the operator signed in',
  auth: T,
  responses: {
    200: {
      description: 'Menu',
      schema: z
        .object({
          terminal: z.object({ id: z.uuid(), name: z.string() }),
          outlet,
          operator: operator.nullable(),
          pricesIncludeGst: z.boolean(),
          defaultGstRate: z.number(),
          gstRates: z.array(z.number()),
          categories: z.array(category),
        })
        .meta({ id: 'PosMenu' }),
    },
  },
});
pos({
  id: 'MER-002',
  method: 'post',
  path: '/api/v1/terminal/pos/categories',
  summary: 'Add a category (letters only, unique in the outlet); an operator is signed in',
  auth: T,
  request: categoryInputSchema,
  idempotent: 'required',
  responses: { 201: { description: 'Added', schema: category } },
});
pos({
  id: 'MER-003',
  method: 'post',
  path: '/api/v1/terminal/pos/items',
  summary:
    'Add a menu item: name unique in the outlet, a price from ₹1 to pos.item.maxPaise, a GST slab (default pos.item.defaultGstBp)',
  auth: T,
  request: itemInputSchema,
  idempotent: 'required',
  responses: { 201: { description: 'Added', schema: item } },
});
pos({
  id: 'MER-004',
  method: 'patch',
  path: '/api/v1/terminal/pos/items/{itemId}',
  summary: 'Change an item: availability, price, name, category or GST slab; If-Match',
  auth: T,
  request: itemPatchSchema,
  responses: { 200: { description: 'Item', schema: item } },
});
pos({
  id: 'MER-005',
  method: 'put',
  path: '/api/v1/terminal/pos/outlet',
  summary: 'Outlet details: name, opening hours, GSTIN; If-Match',
  auth: T,
  request: outletInputSchema,
  responses: { 200: { description: 'Outlet', schema: outlet } },
});
pos({
  id: 'MER-006',
  method: 'post',
  path: '/api/v1/terminal/pos/orders',
  summary:
    'Create an order: every line priced from the menu with its GST (the terminal sends no amounts, OI-MER-10); numbered ORD-MMDD-NNN',
  auth: T,
  request: orderInputSchema,
  idempotent: 'required',
  responses: { 201: { description: 'Created', schema: order } },
});
pos({
  id: 'MER-020',
  method: 'get',
  path: '/api/v1/terminal/pos/orders',
  summary:
    "The outlet's orders of a day (?date=YYYY-MM-DD, default today), newest first, with the day's totals",
  auth: T,
  responses: {
    200: {
      description: 'Orders',
      schema: z
        .object({
          date: z.string(),
          summary: z.object({
            orders: z.number(),
            collected: money,
            unpaid: z.object({ count: z.number(), amount: money }),
            offline: z.object({ accepted: z.number(), refused: z.number() }),
            lastSyncAt: z.string().nullable(),
          }),
          items: z.array(order),
        })
        .meta({ id: 'PosOrders' }),
    },
  },
});
pos({
  id: 'MER-007',
  method: 'post',
  path: '/api/v1/terminal/pos/orders/{orderId}/cancellation',
  summary: 'Cancel an unpaid order; its pending request is cancelled too',
  auth: T,
  request: orderCancelSchema,
  responses: { 200: { description: 'Cancelled', schema: order } },
});
pos({
  id: 'MER-017',
  method: 'post',
  path: '/api/v1/terminal/pos/orders/{orderId}/payment-requests',
  summary:
    "An NFC request for the order's total with a one-time nonce, valid pay.request.ttlSeconds (Q14 M7: 120 s); it replaces the order's earlier request",
  auth: T,
  request: posRequestInputSchema,
  idempotent: 'required',
  responses: { 201: { description: 'Created', schema: posRequest } },
});
pos({
  id: 'MER-018',
  method: 'post',
  path: '/api/v1/terminal/pos/payment-requests/{requestId}/cancellation',
  summary: 'Cancel a pending request; the order stays unpaid',
  auth: T,
  responses: {
    200: {
      description: 'Cancelled',
      schema: z.object({ requestId: z.uuid(), status: z.literal('CANCELLED') }),
    },
  },
});
pos({
  id: 'MER-008',
  method: 'post',
  path: '/api/v1/terminal/pos/orders/{orderId}/collections',
  summary:
    "Collect an order by card tap: the request's nonce once, the card active; the payment engine pays it (campus or allowance wallet) and marks the order PAID in the same transaction (P3). COUPON: the holder's coupon usable now covers it",
  auth: T,
  request: collectionInputSchema,
  idempotent: 'required',
  responses: { 201: { description: 'Collected', schema: collected } },
});
pos({
  id: 'MER-009',
  method: 'post',
  path: '/api/v1/terminal/pos/offline-batches',
  summary:
    'Offline captures, each signed by the terminal and posted at most once through the payment engine (its capture key); a capture sent before is acknowledged with its first outcome; refused when the member can’t afford it (Q14 M8) or it is older than pos.offline.maxAgeHours',
  auth: T,
  request: batchInputSchema,
  idempotent: 'required',
  responses: {
    200: { description: 'The batch was received before', schema: batch },
    201: { description: 'Processed', schema: batch },
  },
});
pos({
  id: 'MER-010',
  method: 'get',
  path: '/api/v1/terminal/pos/offline-batches/{batchId}',
  summary:
    'Per-capture outcome of a batch (accepted with its reference, refused with the reason, replayed)',
  auth: T,
  responses: { 200: { description: 'Batch', schema: batch } },
});
pos({
  id: 'MER-021',
  method: 'get',
  path: '/api/v1/terminal/pos/operator-tags',
  summary: "The outlet's operator tags, active first",
  auth: T,
  responses: {
    200: { description: 'Tags', schema: z.object({ items: z.array(tag) }).meta({ id: 'PosTags' }) },
  },
});
pos({
  id: 'MER-011',
  method: 'post',
  path: '/api/v1/terminal/pos/operator-tags',
  summary:
    'Register an operator tag: one active tag per operator mobile (RNG-MER-079); the token to write on the tag is shown once. The first tag of an outlet needs no operator',
  auth: T,
  request: tagInputSchema,
  idempotent: 'required',
  responses: { 201: { description: 'Registered', schema: tagIssued } },
});
pos({
  id: 'MER-022',
  method: 'post',
  path: '/api/v1/terminal/pos/operator-tags/{tagId}/reissue',
  summary:
    'Re-issue a tag with a reason: the old tag stops working at once and is kept Inactive; the re-issues are counted',
  auth: T,
  request: tagReissueSchema,
  idempotent: 'required',
  responses: { 201: { description: 'Re-issued', schema: tagIssued } },
});
pos({
  id: 'MER-012',
  method: 'get',
  path: '/api/v1/console/pos-terminals',
  summary:
    "POS counters: merchant and outlet, the operator signed in, last seen and last sync, today's orders, collections and offline outcomes",
  auth: 'merchants.view',
  responses: {
    200: {
      description: 'Counters',
      schema: z
        .object({
          date: z.string(),
          items: z.array(
            z.object({
              id: z.uuid(),
              name: z.string(),
              location: z.string().nullable(),
              status: z.enum(['ACTIVE', 'DISABLED']),
              merchant: z.string().nullable(),
              outlet: z.string().nullable(),
              operator: z.string().nullable(),
              lastSeenAt: z.string().nullable(),
              lastSyncAt: z.string().nullable(),
              today: z.object({
                orders: z.number(),
                paid: z.number(),
                collected: money,
                unpaid: z.number(),
                offlineAccepted: z.number(),
                offlineRefused: z.number(),
              }),
            }),
          ),
        })
        .meta({ id: 'PosTerminals' }),
    },
  },
});
partner({
  id: 'MER-014',
  method: 'post',
  path: '/api/v1/partners/pos/payment-requests',
  summary:
    "POS partner: a QR request for one of its institution's counters (optionally a canteen order of that counter, for its total), valid pay.request.ttlSeconds; members pay it from the app (channel POS QR). Signed as WAL-012; once per requestId",
  auth: 'partner (signed): pos.qr-create',
  request: partnerRequestInputSchema,
  responses: {
    200: {
      description: 'Created',
      schema: z
        .object({
          requestId: z.uuid(),
          amount: money,
          qrPayload: z.string(),
          svg: z.string(),
          expiresAt: z.string(),
          ttlSeconds: z.number().int(),
        })
        .meta({ id: 'PosPartnerRequest' }),
    },
  },
});
partner({
  id: 'MER-015',
  method: 'get',
  path: '/api/v1/partners/pos/payment-requests/{requestId}',
  summary:
    'POS partner: the status of its request (EXPIRED derived), the receipt reference once paid, and the linked order',
  auth: 'partner (signed): pos.qr-status',
  responses: {
    200: {
      description: 'Status',
      schema: z
        .object({
          requestId: z.uuid(),
          status: z.enum(['PENDING', 'SUCCESS', 'FAILED', 'CANCELLED', 'EXPIRED']),
          amount: money,
          expiresAt: z.string().nullable(),
          completedAt: z.string().nullable(),
          receiptRef: z.string().nullable(),
          order: z.object({ id: z.uuid(), number: z.string(), status: z.string() }).nullable(),
        })
        .meta({ id: 'PosPartnerRequestStatus' }),
    },
  },
});
partner({
  id: 'MER-016',
  method: 'post',
  path: '/api/v1/partners/pos/offline-captures',
  summary:
    'POS partner: offline captures of a counter, same rules as MER-009 (the signed call covers the captures); once per requestId',
  auth: 'partner (signed): pos.offline-sync',
  request: partnerCapturesSchema,
  responses: { 200: { description: 'Processed', schema: batch } },
});

const paise = (m: { amount: string }, field: string) => {
  try {
    return parseAmount(m.amount);
  } catch (e) {
    if (e instanceof MoneyError) throw new ValidationError([{ field, code: 'VALIDATION.AMOUNT' }]);
    throw e;
  }
};
const captures = (cs: z.infer<typeof batchInputSchema>['captures']): CaptureInput[] =>
  cs.map((c, i) => ({
    captureKey: c.captureKey,
    orderId: c.orderId ?? null,
    order: c.order,
    cardToken: c.cardToken,
    instrument: c.instrument,
    amountPaise: paise(c.amount, `captures.${i}.amount`),
    capturedAt: c.capturedAt,
    signature: c.signature,
  }));

/** Mounted under /api/v1. */
export function posRoutes(deps: {
  db: Kysely<Database>;
  pos: PosService;
  terminals: TerminalsService;
  partners: PartnersService;
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
  const terminal = requireSurface(L, 'terminal');
  const caller = (req: Request) => deps.terminals.caller(req, ['POS']);
  const param = (req: Request, k: string) => String(req.params[k]);
  const key = (req: Request) => String(req.get('Idempotency-Key'));

  // --- operators ------------------------------------------------------------------------------------
  router.post(
    '/terminal/pos/operators/signin',
    terminal,
    wrap(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.json(
        await deps.pos.signIn(await caller(req), operatorSignInSchema.parse(req.body ?? {})),
      );
    }),
  );
  router.post(
    '/terminal/pos/operators/signout',
    terminal,
    wrap(async (req, res) => {
      await deps.pos.signOut(await caller(req));
      res.status(204).end();
    }),
  );

  // --- outlet and menu ------------------------------------------------------------------------------
  router.get(
    '/terminal/pos/menu',
    terminal,
    wrap(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      const out = await deps.pos.menu(await caller(req));
      setEtag(res, out.outlet.version);
      res.json(out);
    }),
  );
  router.post(
    '/terminal/pos/categories',
    terminal,
    once,
    wrap(async (req, res) => {
      res
        .status(201)
        .json(
          await deps.pos.addCategory(await caller(req), categoryInputSchema.parse(req.body ?? {})),
        );
    }),
  );
  router.post(
    '/terminal/pos/items',
    terminal,
    once,
    wrap(async (req, res) => {
      const b = itemInputSchema.parse(req.body ?? {});
      const out = await deps.pos.addItem(await caller(req), {
        categoryId: b.categoryId,
        name: b.name,
        description: b.description,
        foodType: b.foodType,
        pricePaise: paise(b.price, 'price'),
        gstRate: b.gstRate,
        available: b.available,
      });
      setEtag(res, out.version);
      res.status(201).json(out);
    }),
  );
  router.patch(
    '/terminal/pos/items/:itemId',
    terminal,
    wrap(async (req, res) => {
      const t = await caller(req);
      const b = itemPatchSchema.parse(req.body ?? {});
      const out = await deps.pos.updateItem(t, param(req, 'itemId'), expectedVersion(req), {
        ...(b.categoryId !== undefined ? { categoryId: b.categoryId } : {}),
        ...(b.name !== undefined ? { name: b.name } : {}),
        ...(b.description !== undefined ? { description: b.description } : {}),
        ...(b.foodType !== undefined ? { foodType: b.foodType } : {}),
        ...(b.price !== undefined ? { pricePaise: paise(b.price, 'price') } : {}),
        ...(b.gstRate !== undefined ? { gstRate: b.gstRate } : {}),
        ...(b.available !== undefined ? { available: b.available } : {}),
      });
      setEtag(res, out.version);
      res.json(out);
    }),
  );
  router.put(
    '/terminal/pos/outlet',
    terminal,
    wrap(async (req, res) => {
      const t = await caller(req);
      const b = outletInputSchema.parse(req.body ?? {});
      const out = await deps.pos.updateOutlet(t, expectedVersion(req), {
        name: b.name,
        opensAt: b.opensAt,
        closesAt: b.closesAt,
        gstin: b.gstin ?? null,
      });
      setEtag(res, out.version);
      res.json(out);
    }),
  );

  // --- orders and collection ------------------------------------------------------------------------
  router.post(
    '/terminal/pos/orders',
    terminal,
    once,
    wrap(async (req, res) => {
      res
        .status(201)
        .json(
          await deps.pos.createOrder(await caller(req), orderInputSchema.parse(req.body ?? {})),
        );
    }),
  );
  router.get(
    '/terminal/pos/orders',
    terminal,
    wrap(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      const d = typeof req.query['date'] === 'string' ? req.query['date'] : undefined;
      res.json(await deps.pos.orders(await caller(req), { date: date.optional().parse(d) }));
    }),
  );
  router.post(
    '/terminal/pos/orders/:orderId/cancellation',
    terminal,
    wrap(async (req, res) => {
      res.json(
        await deps.pos.cancelOrder(
          await caller(req),
          param(req, 'orderId'),
          orderCancelSchema.parse(req.body ?? {}),
        ),
      );
    }),
  );
  router.post(
    '/terminal/pos/orders/:orderId/payment-requests',
    terminal,
    once,
    wrap(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res
        .status(201)
        .json(
          await deps.pos.createRequest(
            await caller(req),
            param(req, 'orderId'),
            posRequestInputSchema.parse(req.body ?? {}),
          ),
        );
    }),
  );
  router.post(
    '/terminal/pos/payment-requests/:requestId/cancellation',
    terminal,
    wrap(async (req, res) => {
      res.json(await deps.pos.cancelRequest(await caller(req), param(req, 'requestId')));
    }),
  );
  router.post(
    '/terminal/pos/orders/:orderId/collections',
    terminal,
    once,
    wrap(async (req, res) => {
      res
        .status(201)
        .json(
          await deps.pos.collect(
            await caller(req),
            param(req, 'orderId'),
            collectionInputSchema.parse(req.body ?? {}),
            key(req),
          ),
        );
    }),
  );

  // --- offline captures -----------------------------------------------------------------------------
  router.post(
    '/terminal/pos/offline-batches',
    terminal,
    once,
    wrap(async (req, res) => {
      const t = await caller(req);
      const b = batchInputSchema.parse(req.body ?? {});
      const before = await deps.db
        .selectFrom('pos_offline_batches')
        .select('id')
        .where('terminal_id', '=', t.id)
        .where('public_id', '=', uuidToBin(b.batchId))
        .executeTakeFirst();
      const out = await deps.pos.sync(t, { batchId: b.batchId, captures: captures(b.captures) });
      res.status(before ? 200 : 201).json(out);
    }),
  );
  router.get(
    '/terminal/pos/offline-batches/:batchId',
    terminal,
    wrap(async (req, res) => {
      res.json(await deps.pos.batch(await caller(req), param(req, 'batchId')));
    }),
  );

  // --- operator tags --------------------------------------------------------------------------------
  router.get(
    '/terminal/pos/operator-tags',
    terminal,
    wrap(async (req, res) => {
      res.json(await deps.pos.tags(await caller(req)));
    }),
  );
  router.post(
    '/terminal/pos/operator-tags',
    terminal,
    once,
    wrap(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res
        .status(201)
        .json(await deps.pos.registerTag(await caller(req), tagInputSchema.parse(req.body ?? {})));
    }),
  );
  router.post(
    '/terminal/pos/operator-tags/:tagId/reissue',
    terminal,
    once,
    wrap(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res
        .status(201)
        .json(
          await deps.pos.reissueTag(
            await caller(req),
            param(req, 'tagId'),
            tagReissueSchema.parse(req.body ?? {}),
          ),
        );
    }),
  );

  // --- console ----------------------------------------------------------------------------------------
  router.get(
    '/console/pos-terminals',
    requireSurface(L, 'console'),
    requireTenant(L),
    authorize('merchants.view', L),
    wrap(async (req, res) => {
      res.json(await deps.pos.consoleTerminals(principal(req)));
    }),
  );

  // --- the POS partner API (signed as WAL-012) ---------------------------------------------------------
  router.post(
    '/partners/pos/payment-requests',
    wrap(async (req, res) => {
      const c = await deps.partners.verifySigned(req, 'pos.qr-create');
      const b = partnerRequestInputSchema.parse(req.body ?? {});
      const out = await deps.partners.once(
        c.clientRowId,
        'pos.qr-create',
        b.requestId,
        req.rawBody,
        () =>
          deps.pos.partnerRequest(
            { rowId: c.clientRowId, institutionId: c.institutionId },
            {
              terminalRef: b.terminalRef,
              amountPaise: paise(b.amount, 'amount'),
              orderRef: b.orderRef,
            },
          ),
      );
      res.setHeader('Cache-Control', 'no-store');
      res.json(out);
    }),
  );
  router.get(
    '/partners/pos/payment-requests/:requestId',
    wrap(async (req, res) => {
      const c = await deps.partners.verifySigned(req, 'pos.qr-status');
      res.setHeader('Cache-Control', 'no-store');
      res.json(
        await deps.pos.partnerRequestStatus({ rowId: c.clientRowId }, param(req, 'requestId')),
      );
    }),
  );
  router.post(
    '/partners/pos/offline-captures',
    wrap(async (req, res) => {
      const c = await deps.partners.verifySigned(req, 'pos.offline-sync');
      const b = partnerCapturesSchema.parse(req.body ?? {});
      const out = await deps.partners.once(
        c.clientRowId,
        'pos.offline-sync',
        b.requestId,
        req.rawBody,
        async () => {
          const t = await deps.pos.partnerTerminal(
            { institutionId: c.institutionId },
            b.terminalRef,
          );
          return deps.pos.sync(
            t,
            { batchId: b.batchId, captures: captures(b.captures) },
            { apiClientId: c.clientRowId },
          );
        },
      );
      res.setHeader('Cache-Control', 'no-store');
      res.json(out);
    }),
  );
  return router;
}
