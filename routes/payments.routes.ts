import { Router, type Request, type RequestHandler } from 'express';
import type { Kysely } from 'kysely';
import { defineRoute } from '../config/openapi-registry';
import type { Loggers } from '../controllers/logger';
import { authorize, requireSurface, requireTenant } from '../middlewares/auth.middleware';
import { idempotency, IDEMPOTENCY_HEADER } from '../middlewares/idempotency.middleware';
import type { Database } from '../models/ringpe_models';
import {
  channelsSchema,
  collectionsQuerySchema,
  collectionsSchema,
  emailQrSchema,
  merchantCreatedSchema,
  merchantDetailSchema,
  merchantHomeSchema,
  merchantInputSchema,
  merchantListSchema,
  merchantPatchSchema,
  merchantsQuerySchema,
  merchantStatusSchema,
  payInputSchema,
  paymentResultSchema,
  qrEmailsResultSchema,
  qrEmailsSchema,
  qrGenerateSchema,
  qrListSchema,
  qrStatusSchema,
  qrCode,
  recipientLookupSchema,
  recipientsSchema,
  transferInputSchema,
  transferResultSchema,
  requestCreatedSchema,
  requestInputSchema,
  requestStatusSchema,
  resolvedSchema,
  resolveSchema,
} from '../schemas/payments.schema';
import { nfcTapSchema } from '../schemas/terminals.schema';
import type { MerchantsService } from '../services/merchants.service';
import type { PaymentsService } from '../services/payments.service';
import type { TransfersService } from '../services/transfers.service';
import { AuthenticationError, ValidationError } from '../utils/CustomAPIError';
import { expectedVersion, setEtag } from '../utils/etag';
import { MoneyError, parseAmount } from '../utils/money';

const doc = (tags: string[]) => (d: Omit<Parameters<typeof defineRoute>[0], 'tags'>) =>
  defineRoute({ ...d, tags });
const pay = doc(['Payments']);
const wal = doc(['Wallets']);
const mer = doc(['Merchants']);
const pdf = { 200: { description: 'PDF', contentType: 'application/pdf' } } as const;

pay({
  id: 'PAY-001',
  method: 'post',
  path: '/api/v1/me/payments/resolve',
  summary:
    "Decode a scanned RingPe code: the merchant, the kind, a request's amount and expiry, and the processing stages; another institution's code is not recognised",
  auth: 'member',
  request: resolveSchema,
  responses: { 200: { description: 'Resolved', schema: resolvedSchema } },
});
pay({
  id: 'PAY-002',
  method: 'post',
  path: '/api/v1/me/payments',
  summary:
    'Pay a merchant through the §9.11 engine (static QR with an amount, or a dynamic request) with the PIN; a refusal names its step (`check`) and stage, and after the record is written the failed attempt',
  auth: 'member',
  request: payInputSchema,
  idempotent: 'required',
  responses: { 201: { description: 'Paid', schema: paymentResultSchema } },
});
wal({
  id: 'WAL-006',
  method: 'post',
  path: '/api/v1/me/transfers/recipient-lookup',
  summary:
    "Find a recipient by mobile within the payer's institution (a number can carry a parent and children); names shortened",
  auth: 'member',
  request: recipientLookupSchema,
  responses: { 200: { description: 'Candidates', schema: recipientsSchema } },
});
wal({
  id: 'WAL-007',
  method: 'post',
  path: '/api/v1/me/transfers',
  summary:
    'Send money to a member of the institution through the payment engine (limit per transfer, pending guard, wallet status, PIN, daily cap)',
  auth: 'member',
  request: transferInputSchema,
  idempotent: 'required',
  responses: { 201: { description: 'Sent', schema: transferResultSchema } },
});
mer({
  id: 'PAY-007',
  method: 'get',
  path: '/api/v1/merchant/home',
  summary: "The merchant's home: today's collections, wallet, QR codes and open requests",
  auth: 'member',
  responses: { 200: { description: 'Home', schema: merchantHomeSchema } },
});
mer({
  id: 'PAY-008',
  method: 'get',
  path: '/api/v1/merchant/qr-codes',
  summary: "The merchant's static payment, allowance and coupon codes (SVG and payload)",
  auth: 'member',
  responses: { 200: { description: 'Codes', schema: qrListSchema } },
});
mer({
  id: 'PAY-009',
  method: 'post',
  path: '/api/v1/merchant/payment-requests',
  summary:
    'A single-use dynamic QR or NFC request for an amount (expires after pay.request.ttlSeconds); the channel must be switched on for the merchant',
  auth: 'member',
  request: requestInputSchema,
  idempotent: 'required',
  responses: { 201: { description: 'Created', schema: requestCreatedSchema } },
});
mer({
  id: 'PAY-010',
  method: 'get',
  path: '/api/v1/merchant/payment-requests/{requestId}',
  summary: 'Request status (Expired is derived from the expiry time), the payer and the receipt',
  auth: 'member',
  responses: { 200: { description: 'Status', schema: requestStatusSchema } },
});
mer({
  id: 'PAY-011',
  method: 'post',
  path: '/api/v1/merchant/payment-requests/{requestId}/cancellation',
  summary: 'Cancel a request still waiting for payment (RC-28)',
  auth: 'member',
  responses: { 200: { description: 'Cancelled', schema: requestStatusSchema } },
});
mer({
  id: 'PAY-012',
  method: 'post',
  path: '/api/v1/merchant/payment-requests/{requestId}/nfc-taps',
  summary:
    "A campus card tapped on the merchant's device for an NFC request: the request's nonce (once), an active card of the institution; the holder pays through the engine without a PIN, within the daily cap; a reused nonce is a replay",
  auth: 'member',
  request: nfcTapSchema,
  idempotent: 'required',
  responses: { 200: { description: 'Paid', schema: paymentResultSchema } },
});
mer({
  id: 'PAY-013',
  method: 'post',
  path: '/api/v1/merchant/qr-codes/{qrId}/email',
  summary: 'E-mail my QR code details (to the merchant e-mail unless another is given)',
  auth: 'member',
  request: emailQrSchema,
  idempotent: 'required',
  responses: { 202: { description: 'Sent' } },
});
mer({
  id: 'PAY-014',
  method: 'get',
  path: '/api/v1/merchant/collections',
  summary: 'Collections with date, status and channel filters, newest first, with totals',
  auth: 'member',
  query: collectionsQuerySchema,
  responses: { 200: { description: 'Collections', schema: collectionsSchema } },
});
mer({
  id: 'PAY-016',
  method: 'get',
  path: '/api/v1/console/merchants',
  summary:
    "Merchants: name, sub-type, merchant ID, accepts, status and today's collections, with the KPIs",
  auth: 'merchants.view',
  responses: { 200: { description: 'Merchants', schema: merchantListSchema } },
});
mer({
  id: 'PAY-017',
  method: 'post',
  path: '/api/v1/console/merchants',
  summary:
    'Register a merchant: display name, operator, sub-type, department, mobile, accepts, bank account (encrypted), cheque and logo; opens its wallet',
  auth: 'merchants.edit',
  request: merchantInputSchema,
  idempotent: 'required',
  responses: { 201: { description: 'Registered', schema: merchantCreatedSchema } },
});
mer({
  id: 'PAY-031',
  method: 'get',
  path: '/api/v1/console/merchants/{merchantId}',
  summary: 'The merchant drawer: profile, masked bank details, wallet, QR codes and today (ETag)',
  auth: 'merchants.view',
  responses: { 200: { description: 'Merchant', schema: merchantDetailSchema } },
});
mer({
  id: 'PAY-018',
  method: 'patch',
  path: '/api/v1/console/merchants/{merchantId}',
  summary: 'Rename (3–40, unique), accepts, bank account, cheque or logo (If-Match)',
  auth: 'merchants.edit',
  request: merchantPatchSchema,
  responses: { 200: { description: 'Merchant', schema: merchantDetailSchema } },
});
mer({
  id: 'PAY-019',
  method: 'post',
  path: '/api/v1/console/merchants/{merchantId}/status',
  summary:
    'Activate or deactivate with a reason (member status rules); the fee account cannot be deactivated',
  auth: 'merchants.status',
  request: merchantStatusSchema,
  responses: { 200: { description: 'Merchant', schema: merchantDetailSchema } },
});
mer({
  id: 'PAY-020',
  method: 'put',
  path: '/api/v1/console/merchants/{merchantId}/channels',
  summary: 'Switch dynamic QR and NFC collection on or off (If-Match)',
  auth: 'merchants.edit',
  request: channelsSchema,
  responses: { 200: { description: 'Merchant', schema: merchantDetailSchema } },
});
mer({
  id: 'PAY-021',
  method: 'get',
  path: '/api/v1/console/merchants/{merchantId}/qr-codes',
  summary: "The merchant's QR codes with status, SVG and payload",
  auth: 'merchants.view',
  responses: { 200: { description: 'Codes', schema: qrListSchema } },
});
mer({
  id: 'PAY-022',
  method: 'post',
  path: '/api/v1/console/merchants/{merchantId}/qr-codes',
  summary:
    'Generate a payment, allowance or coupon QR — once per kind; vendors and merchants not accepting the kind are refused',
  auth: 'merchants.edit',
  request: qrGenerateSchema,
  idempotent: 'required',
  responses: { 201: { description: 'Generated', schema: qrCode } },
});
mer({
  id: 'PAY-023',
  method: 'patch',
  path: '/api/v1/console/qr-codes/{qrId}',
  summary:
    'Activate or deactivate a QR (a reason to deactivate); an inactive code refuses payments (OI-PAY-01)',
  auth: 'merchants.edit',
  request: qrStatusSchema,
  responses: { 200: { description: 'Code', schema: qrCode } },
});
mer({
  id: 'PAY-024',
  method: 'post',
  path: '/api/v1/console/qr-codes/emails',
  summary: "E-mail the active QR codes of some or all merchants to the merchants' e-mails",
  auth: 'merchants.edit',
  request: qrEmailsSchema,
  idempotent: 'required',
  responses: { 202: { description: 'Sent', schema: qrEmailsResultSchema } },
});
mer({
  id: 'PAY-029',
  method: 'get',
  path: '/api/v1/console/qr-codes/{qrId}/card.pdf',
  summary: 'The printable QR card for the counter',
  auth: 'merchants.view',
  responses: pdf,
});
mer({
  id: 'PAY-030',
  method: 'get',
  path: '/api/v1/merchant/qr-codes/{qrId}/card.pdf',
  summary: 'My printable QR card',
  auth: 'member',
  responses: pdf,
});

const amountOf = (field: string, value: { amount: string } | undefined) => {
  if (!value) return undefined;
  try {
    return parseAmount(value.amount);
  } catch (e) {
    if (e instanceof MoneyError) throw new ValidationError([{ field, code: 'VALIDATION.AMOUNT' }]);
    throw e;
  }
};

/** Mounted under /api/v1. */
export function paymentsRoutes(deps: {
  db: Kysely<Database>;
  payments: PaymentsService;
  merchants: MerchantsService;
  transfers: TransfersService;
  loggers: Loggers;
}): Router {
  const router = Router();
  const L = deps.loggers;
  const member = requireSurface(L, 'member');
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
  const sendPdf = (res: Parameters<RequestHandler>[1], out: { name: string; data: Buffer }) => {
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${out.name.replace(/"/g, '')}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(out.data);
  };

  // --- member -------------------------------------------------------------------------------------
  router.post(
    '/me/payments/resolve',
    member,
    wrap(async (req, res) => {
      res.json(await deps.payments.resolve(principal(req), resolveSchema.parse(req.body ?? {})));
    }),
  );
  router.post(
    '/me/payments',
    member,
    once,
    wrap(async (req, res) => {
      const body = payInputSchema.parse(req.body ?? {});
      const out = await deps.payments.pay(
        principal(req),
        {
          qrPayload: body.qrPayload,
          eventId: body.eventId,
          amountPaise: amountOf('amount', body.amount),
          vendor: body.vendor,
          pin: body.pin,
        },
        String(req.get(IDEMPOTENCY_HEADER)),
      );
      res.status(201).json(out);
    }),
  );

  router.post(
    '/me/transfers/recipient-lookup',
    member,
    wrap(async (req, res) => {
      res.json(
        await deps.transfers.lookup(principal(req), recipientLookupSchema.parse(req.body ?? {})),
      );
    }),
  );
  router.post(
    '/me/transfers',
    member,
    once,
    wrap(async (req, res) => {
      const body = transferInputSchema.parse(req.body ?? {});
      const out = await deps.transfers.transfer(
        principal(req),
        {
          toProfileId: body.toProfileId,
          amountPaise: amountOf('amount', body.amount)!,
          note: body.note,
          pin: body.pin,
        },
        String(req.get(IDEMPOTENCY_HEADER)),
      );
      res.status(201).json(out);
    }),
  );

  // --- merchant (own app) ---------------------------------------------------------------------------
  router.get(
    '/merchant/home',
    member,
    wrap(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.json(await deps.merchants.home(principal(req)));
    }),
  );
  router.get(
    '/merchant/qr-codes',
    member,
    wrap(async (req, res) => {
      res.json(await deps.merchants.myQrCodes(principal(req)));
    }),
  );
  router.get(
    '/merchant/qr-codes/:qrId/card.pdf',
    member,
    wrap(async (req, res) => {
      sendPdf(res, await deps.merchants.myQrCard(principal(req), param(req, 'qrId')));
    }),
  );
  router.post(
    '/merchant/qr-codes/:qrId/email',
    member,
    once,
    wrap(async (req, res) => {
      const out = await deps.merchants.emailMyQr(
        principal(req),
        param(req, 'qrId'),
        emailQrSchema.parse(req.body ?? {}),
      );
      res.status(202).json(out);
    }),
  );
  router.get(
    '/merchant/collections',
    member,
    wrap(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.json(
        await deps.merchants.collections(principal(req), collectionsQuerySchema.parse(req.query)),
      );
    }),
  );
  router.post(
    '/merchant/payment-requests',
    member,
    once,
    wrap(async (req, res) => {
      const body = requestInputSchema.parse(req.body ?? {});
      const out = await deps.payments.createRequest(principal(req), {
        kind: body.kind,
        amountPaise: amountOf('amount', body.amount)!,
        instrument: body.instrument,
      });
      res.status(201).json(out);
    }),
  );
  router.post(
    '/merchant/payment-requests/:requestId/nfc-taps',
    member,
    once,
    wrap(async (req, res) => {
      const body = nfcTapSchema.parse(req.body ?? {});
      res.json(
        await deps.payments.nfcTap(
          principal(req),
          param(req, 'requestId'),
          { cardToken: body.cardToken, nonce: body.nonce },
          String(req.get(IDEMPOTENCY_HEADER)),
        ),
      );
    }),
  );
  router.get(
    '/merchant/payment-requests/:requestId',
    member,
    wrap(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.json(await deps.payments.request(principal(req), param(req, 'requestId')));
    }),
  );
  router.post(
    '/merchant/payment-requests/:requestId/cancellation',
    member,
    wrap(async (req, res) => {
      res.json(await deps.payments.cancelRequest(principal(req), param(req, 'requestId')));
    }),
  );

  // --- console ----------------------------------------------------------------------------------------
  const console = [requireSurface(L, 'console'), requireTenant(L)];
  router.get(
    '/console/merchants',
    ...console,
    authorize('merchants.view', L),
    wrap(async (req, res) => {
      res.json(await deps.merchants.list(principal(req), merchantsQuerySchema.parse(req.query)));
    }),
  );
  router.post(
    '/console/merchants',
    ...console,
    authorize('merchants.edit', L),
    once,
    wrap(async (req, res) => {
      const out = await deps.merchants.create(
        principal(req),
        merchantInputSchema.parse(req.body ?? {}),
      );
      res.status(201).json(out);
    }),
  );
  router.get(
    '/console/merchants/:merchantId',
    ...console,
    authorize('merchants.view', L),
    wrap(async (req, res) => {
      const out = await deps.merchants.detail(principal(req), param(req, 'merchantId'));
      setEtag(res, out.version);
      res.json(out);
    }),
  );
  router.patch(
    '/console/merchants/:merchantId',
    ...console,
    authorize('merchants.edit', L),
    wrap(async (req, res) => {
      const out = await deps.merchants.update(
        principal(req),
        param(req, 'merchantId'),
        expectedVersion(req),
        merchantPatchSchema.parse(req.body ?? {}),
      );
      setEtag(res, out.version);
      res.json(out);
    }),
  );
  router.post(
    '/console/merchants/:merchantId/status',
    ...console,
    authorize('merchants.status', L),
    wrap(async (req, res) => {
      const out = await deps.merchants.setStatus(
        principal(req),
        param(req, 'merchantId'),
        merchantStatusSchema.parse(req.body ?? {}),
      );
      setEtag(res, out.version);
      res.json(out);
    }),
  );
  router.put(
    '/console/merchants/:merchantId/channels',
    ...console,
    authorize('merchants.edit', L),
    wrap(async (req, res) => {
      const out = await deps.merchants.setChannels(
        principal(req),
        param(req, 'merchantId'),
        expectedVersion(req),
        channelsSchema.parse(req.body ?? {}),
      );
      setEtag(res, out.version);
      res.json(out);
    }),
  );
  router.get(
    '/console/merchants/:merchantId/qr-codes',
    ...console,
    authorize('merchants.view', L),
    wrap(async (req, res) => {
      res.json(await deps.merchants.qrCodes(principal(req), param(req, 'merchantId')));
    }),
  );
  router.post(
    '/console/merchants/:merchantId/qr-codes',
    ...console,
    authorize('merchants.edit', L),
    once,
    wrap(async (req, res) => {
      const out = await deps.merchants.generateQr(
        principal(req),
        param(req, 'merchantId'),
        qrGenerateSchema.parse(req.body ?? {}),
      );
      res.status(201).json(out);
    }),
  );
  router.post(
    '/console/qr-codes/emails',
    ...console,
    authorize('merchants.edit', L),
    once,
    wrap(async (req, res) => {
      res
        .status(202)
        .json(await deps.merchants.emailQrs(principal(req), qrEmailsSchema.parse(req.body ?? {})));
    }),
  );
  router.patch(
    '/console/qr-codes/:qrId',
    ...console,
    authorize('merchants.edit', L),
    wrap(async (req, res) => {
      const out = await deps.merchants.setQrStatus(
        principal(req),
        param(req, 'qrId'),
        expectedVersion(req),
        qrStatusSchema.parse(req.body ?? {}),
      );
      setEtag(res, out.version);
      res.json(out);
    }),
  );
  router.get(
    '/console/qr-codes/:qrId/card.pdf',
    ...console,
    authorize('merchants.view', L),
    wrap(async (req, res) => {
      sendPdf(res, await deps.merchants.qrCard(principal(req), param(req, 'qrId')));
    }),
  );
  return router;
}
