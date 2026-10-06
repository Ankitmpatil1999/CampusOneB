import { Router, type Request, type RequestHandler } from 'express';
import type { Kysely } from 'kysely';
import { defineRoute } from '../config/openapi-registry';
import type { Loggers } from '../controllers/logger';
import { authorize, requireSurface, requireTenant } from '../middlewares/auth.middleware';
import { idempotency } from '../middlewares/idempotency.middleware';
import type { Database } from '../models/ringpe_models';
import {
  apiClientCreatedSchema,
  apiClientInputSchema,
  apiClientPatchSchema,
  apiClientSchema,
  apiClientsSchema,
  balanceCheckSchema,
  bankAnswerSchema,
  bankCreditSchema,
  heldCreditsSchema,
  heldQuerySchema,
  reconQuerySchema,
  returnRaisedSchema,
  returnSchema,
  revokeSchema,
  rotatedSchema,
  rotationSchema,
  tokenPolicyInputSchema,
  tokenPolicySchema,
  tokenRequestSchema,
  tokenResponseSchema,
  tokensSchema,
} from '../schemas/partners.schema';
import type { BankCreditsService } from '../services/bank-credits.service';
import type { PartnersService } from '../services/partners.service';
import type { ReconService } from '../services/recon.service';
import { AuthenticationError } from '../utils/CustomAPIError';
import { expectedVersion, setEtag } from '../utils/etag';

const doc = (tags: string[]) => (d: Omit<Parameters<typeof defineRoute>[0], 'tags'>) =>
  defineRoute({ ...d, tags });
const partner = doc(['Partner API']);
const ops = doc(['Partner clients']);
const wal = doc(['Wallets']);
const rec = doc(['Reconciliation']);

partner({
  id: 'IDN-043',
  method: 'post',
  path: '/api/v1/partners/oauth/token',
  summary:
    'OAuth 2 client credentials (JSON body): a partner access token with its scopes; refusals are OAuth errors (invalid_client, invalid_scope, IP_NOT_ALLOWED) and are logged',
  auth: 'public',
  request: tokenRequestSchema,
  responses: { 200: { description: 'Token', schema: tokenResponseSchema } },
});
partner({
  id: 'WAL-012',
  method: 'post',
  path: '/api/v1/partners/bank/va/validate',
  summary:
    'Sponsor bank, before crediting: is the virtual account ours and able to take money? Bearer token with va.validate, X-RingPe-Timestamp and X-RingPe-Signature (v1=HMAC-SHA256(secret, "<timestamp>.<raw body>")), allowed address; once per requestId',
  auth: 'partner (signed): va.validate',
  request: bankCreditSchema,
  responses: { 200: { description: 'Answer', schema: bankAnswerSchema } },
});
partner({
  id: 'WAL-013',
  method: 'post',
  path: '/api/v1/partners/bank/va/notify',
  summary:
    'Sponsor bank, after crediting: post the credit once per UTR + bank transaction id (an active wallet is credited, a suspended or inactive one held); same signing as WAL-012',
  auth: 'partner (signed): va.notify',
  request: bankCreditSchema,
  responses: { 200: { description: 'Answer', schema: bankAnswerSchema } },
});
ops({
  id: 'INT-001',
  method: 'get',
  path: '/api/v1/ops/api-clients',
  summary: 'Partner API clients: scopes, address allow-list, status, last rotation, last token',
  auth: 'partners.edit',
  responses: { 200: { description: 'Clients', schema: apiClientsSchema } },
});
ops({
  id: 'INT-002',
  method: 'post',
  path: '/api/v1/ops/api-clients',
  summary: 'Create a client; the secret is shown once and kept encrypted',
  auth: 'partners.edit',
  request: apiClientInputSchema,
  idempotent: 'required',
  responses: { 201: { description: 'Created', schema: apiClientCreatedSchema } },
});
ops({
  id: 'INT-003',
  method: 'patch',
  path: '/api/v1/ops/api-clients/{clientId}',
  summary: 'Edit name, scopes or allow-list, or suspend with a reason (ends live tokens); If-Match',
  auth: 'partners.edit',
  request: apiClientPatchSchema,
  responses: { 200: { description: 'Client', schema: apiClientSchema } },
});
ops({
  id: 'INT-004',
  method: 'post',
  path: '/api/v1/ops/api-clients/{clientId}/secret-rotations',
  summary:
    'Rotate the secret; the previous one keeps working for the overlap (int.secret.overlapHours)',
  auth: 'partners.edit',
  request: rotationSchema,
  idempotent: 'required',
  responses: { 201: { description: 'Rotated', schema: rotatedSchema } },
});
ops({
  id: 'INT-005',
  method: 'get',
  path: '/api/v1/ops/api-clients/{clientId}/tokens',
  summary: 'Token requests, issued and refused (with the reason), newest first',
  auth: 'partners.edit',
  responses: { 200: { description: 'Tokens', schema: tokensSchema } },
});
ops({
  id: 'INT-006',
  method: 'post',
  path: '/api/v1/ops/api-clients/{clientId}/token-revocations',
  summary: "End all of the client's live tokens",
  auth: 'partners.edit',
  request: revokeSchema,
  responses: { 204: { description: 'Ended' } },
});
ops({
  id: 'INT-007',
  method: 'get',
  path: '/api/v1/ops/token-policy',
  summary: 'Partner token lifetime (auth.partner.tokenMinutes); ETag',
  auth: 'partners.edit',
  responses: { 200: { description: 'Policy', schema: tokenPolicySchema } },
});
ops({
  id: 'INT-008',
  method: 'put',
  path: '/api/v1/ops/token-policy',
  summary: 'Change the partner token lifetime with a reason (5–60 minutes); If-Match',
  auth: 'partners.edit',
  request: tokenPolicyInputSchema,
  responses: { 200: { description: 'Policy', schema: tokenPolicySchema } },
});
wal({
  id: 'WAL-010',
  method: 'get',
  path: '/api/v1/console/held-credits',
  summary:
    'Bank credits held for suspended or inactive wallets (CR-08), and those released or returned since',
  auth: 'recon.view',
  responses: { 200: { description: 'Held credits', schema: heldCreditsSchema } },
});
wal({
  id: 'WAL-011',
  method: 'post',
  path: '/api/v1/ops/held-credits/{holdId}/return',
  summary:
    'Ask to return a held credit to the remitter on an instruction; another operator approves (BANK_CREDIT_RETURN)',
  auth: 'recon.resolve',
  request: returnSchema,
  idempotent: 'required',
  responses: { 202: { description: 'Waiting for approval', schema: returnRaisedSchema } },
});
rec({
  id: 'REC-012',
  method: 'get',
  path: '/api/v1/ops/recon/balance-vs-ledger',
  summary:
    "Every wallet's stored balance against the sum of its ledger entries; differences are reported, never corrected",
  auth: 'recon.upload',
  responses: { 200: { description: 'Check', schema: balanceCheckSchema } },
});
rec({
  id: 'REC-017',
  method: 'get',
  path: '/api/v1/console/recon/ledger-check',
  summary: "The institution's wallets against the ledger",
  auth: 'recon.view',
  responses: { 200: { description: 'Check', schema: balanceCheckSchema } },
});

/** Mounted under /api/v1. */
export function partnersRoutes(deps: {
  db: Kysely<Database>;
  partners: PartnersService;
  bankCredits: BankCreditsService;
  recon: ReconService;
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
  const param = (req: Request, k: string) => String(req.params[k]);

  // --- partner calls ------------------------------------------------------------------------------
  router.post(
    '/partners/oauth/token',
    wrap(async (req, res) => {
      const parsed = tokenRequestSchema.safeParse(req.body ?? {});
      res.setHeader('Cache-Control', 'no-store');
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_request' });
        return;
      }
      const b = parsed.data;
      const out = await deps.partners.issueToken(
        {
          grantType: b.grant_type,
          clientId: b.client_id,
          clientSecret: b.client_secret,
          scope: b.scope,
        },
        req.ip,
      );
      if (!out.ok) {
        const status =
          out.error === 'invalid_client' ? 401 : out.error === 'IP_NOT_ALLOWED' ? 403 : 400;
        res.status(status).json({ error: out.error });
        return;
      }
      res.json({
        access_token: out.accessToken,
        token_type: 'Bearer',
        expires_in: out.expiresIn,
        scope: out.scope,
      });
    }),
  );
  const signed = (scope: 'va.validate' | 'va.notify', endpoint: string) =>
    wrap(async (req, res) => {
      const { clientRowId } = await deps.partners.verifySigned(req, scope);
      const body = bankCreditSchema.parse(req.body ?? {});
      const out = await deps.partners.once(
        clientRowId,
        endpoint,
        body.requestId,
        req.rawBody,
        () =>
          scope === 'va.validate'
            ? deps.bankCredits.validate(body)
            : deps.bankCredits.notify(body, clientRowId),
      );
      res.setHeader('Cache-Control', 'no-store');
      res.json(out);
    });
  router.post('/partners/bank/va/validate', signed('va.validate', 'va.validate'));
  router.post('/partners/bank/va/notify', signed('va.notify', 'va.notify'));

  // --- back office: partner clients ------------------------------------------------------------------
  const opsOnly = requireSurface(L, 'ops');
  const can = authorize('partners.edit', L);
  router.get(
    '/ops/api-clients',
    opsOnly,
    can,
    wrap(async (_req, res) => {
      res.json(await deps.partners.list());
    }),
  );
  router.post(
    '/ops/api-clients',
    opsOnly,
    can,
    once,
    wrap(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res
        .status(201)
        .json(
          await deps.partners.create(principal(req), apiClientInputSchema.parse(req.body ?? {})),
        );
    }),
  );
  router.patch(
    '/ops/api-clients/:clientId',
    opsOnly,
    can,
    wrap(async (req, res) => {
      const out = await deps.partners.update(
        principal(req),
        param(req, 'clientId'),
        expectedVersion(req),
        apiClientPatchSchema.parse(req.body ?? {}),
      );
      setEtag(res, out.version);
      res.json(out);
    }),
  );
  router.post(
    '/ops/api-clients/:clientId/secret-rotations',
    opsOnly,
    can,
    once,
    wrap(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res
        .status(201)
        .json(
          await deps.partners.rotate(
            principal(req),
            param(req, 'clientId'),
            rotationSchema.parse(req.body ?? {}),
          ),
        );
    }),
  );
  router.get(
    '/ops/api-clients/:clientId/tokens',
    opsOnly,
    can,
    wrap(async (req, res) => {
      res.json(
        await deps.partners.tokens(param(req, 'clientId'), {
          cursor: typeof req.query['cursor'] === 'string' ? req.query['cursor'] : undefined,
        }),
      );
    }),
  );
  router.post(
    '/ops/api-clients/:clientId/token-revocations',
    opsOnly,
    can,
    wrap(async (req, res) => {
      await deps.partners.revokeAll(
        principal(req),
        param(req, 'clientId'),
        revokeSchema.parse(req.body ?? {}),
      );
      res.status(204).end();
    }),
  );
  router.get(
    '/ops/token-policy',
    opsOnly,
    can,
    wrap(async (_req, res) => {
      const out = await deps.partners.tokenPolicy();
      setEtag(res, out.version);
      res.json(out);
    }),
  );
  router.put(
    '/ops/token-policy',
    opsOnly,
    can,
    wrap(async (req, res) => {
      const out = await deps.partners.setTokenPolicy(
        principal(req),
        expectedVersion(req),
        tokenPolicyInputSchema.parse(req.body ?? {}),
      );
      setEtag(res, out.version);
      res.json(out);
    }),
  );

  // --- held credits ----------------------------------------------------------------------------------
  router.get(
    '/console/held-credits',
    requireSurface(L, 'console'),
    requireTenant(L),
    authorize('recon.view', L),
    wrap(async (req, res) => {
      res.json(await deps.bankCredits.held(principal(req), heldQuerySchema.parse(req.query)));
    }),
  );
  router.post(
    '/ops/held-credits/:holdId/return',
    opsOnly,
    authorize('recon.resolve', L),
    once,
    wrap(async (req, res) => {
      res
        .status(202)
        .json(
          await deps.bankCredits.requestReturn(
            principal(req),
            param(req, 'holdId'),
            returnSchema.parse(req.body ?? {}),
          ),
        );
    }),
  );

  // --- reconciliation ----------------------------------------------------------------------------------
  router.get(
    '/ops/recon/balance-vs-ledger',
    opsOnly,
    authorize('recon.upload', L),
    wrap(async (req, res) => {
      res.json(await deps.recon.platform(reconQuerySchema.parse(req.query)));
    }),
  );
  router.get(
    '/console/recon/ledger-check',
    requireSurface(L, 'console'),
    requireTenant(L),
    authorize('recon.view', L),
    wrap(async (req, res) => {
      res.json(await deps.recon.institution(principal(req), reconQuerySchema.parse(req.query)));
    }),
  );
  return router;
}
