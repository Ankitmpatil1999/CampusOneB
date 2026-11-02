/**
 * Axis Bank Power E-coll (BNK-001…003; client 2026-10-12). Mounted before the /api/v1 router because
 * the bank reads its own answer format: a refused address, token or scope is answered as the earlier
 * application answered it ({Stts_flg: "N", Err_cd: "001", …}), never as a problem document. The token
 * is still CampusOne's partner token (ES256, ended on revocation), and the client is a Partner API client
 * from the back office with its address allow-list.
 *
 * Paths: /api/v1/partners/axis/bank/… and, for the base address the bank already holds, /cug/bank/….
 * Bodies: JSON or form fields.
 */
import express, { Router, type Request, type RequestHandler } from 'express';
import { AXIS_BANK_AUTH_ERRORS, type PartnerScope } from '../config/registers';
import { defineRoute } from '../config/openapi-registry';
import type { Loggers } from '../controllers/logger';
import {
  axisAnswerSchema,
  axisCallSchema,
  axisTokenRequestSchema,
  axisTokenResponseSchema,
} from '../schemas/axis-bank.schema';
import type { AxisBankService } from '../services/axis-bank.service';
import type { PartnersService } from '../services/partners.service';
import type { SessionRevocations } from '../utils/session-revocations';
import type { TokenVerifier } from '../utils/token-verifier';

export const AXIS_BANK_PREFIXES = ['/api/v1/partners/axis/bank/', '/cug/bank/'] as const;

const bank = (d: Omit<Parameters<typeof defineRoute>[0], 'tags'>) =>
  defineRoute({ ...d, tags: ['Axis Bank'] });
bank({
  id: 'BNK-001',
  method: 'post',
  path: '/api/v1/partners/axis/bank/token',
  summary:
    "Axis Bank: OAuth 2 client credentials (JSON or form fields) with the bank's scope names; a Partner API client with va.validate / va.notify and the bank's addresses. Also at /cug/bank/token. One token holds both scopes and is returned again while valid (setting bank.axis.tokenReuseMinSeconds). Refusals as the earlier application sent them (INVALID_CLIENT, INVALID_SCOPE, INVALID_GRANT_TYPE; address 403)",
  auth: 'public',
  request: axisTokenRequestSchema,
  responses: { 200: { description: 'Token', schema: axisTokenResponseSchema } },
});
bank({
  id: 'BNK-002',
  method: 'post',
  path: '/api/v1/partners/axis/bank/transaction/validate',
  summary:
    'Axis Bank, before crediting: is the virtual account ours and able to take money? Bearer token with transaction_validation, allowed address; Bene_acc_no with or without the corporate-code prefix; a repeat gets the same success while not posted; every call is logged with its answer. Also at /cug/bank/transaction/validate',
  auth: 'partner (bearer): va.validate',
  request: axisCallSchema,
  responses: { 200: { description: 'Answer', schema: axisAnswerSchema } },
});
bank({
  id: 'BNK-003',
  method: 'post',
  path: '/api/v1/partners/axis/bank/transaction/notify',
  summary:
    'Axis Bank, after crediting: post the credit once per UTR + Tran_id after a successful validation of the same UTR + Tran_id, account and amount (mandatory); an active wallet is credited, a suspended one held. Bearer token with transaction_notification_posting. Also at /cug/bank/transaction/notify',
  auth: 'partner (bearer): va.notify',
  request: axisCallSchema,
  responses: { 200: { description: 'Answer', schema: axisAnswerSchema } },
});

export function axisBankRoutes(deps: {
  readonly axis: AxisBankService;
  readonly partners: PartnersService;
  readonly verifier?: TokenVerifier | undefined;
  readonly revocations?: SessionRevocations | undefined;
  readonly loggers: Loggers;
  readonly formLimitBytes?: number;
}): Router {
  const router = Router();
  const L = deps.loggers;
  const form = express.urlencoded({ extended: false, limit: deps.formLimitBytes ?? 64 * 1024 });
  const wrap =
    (fn: (req: Request, res: express.Response) => Promise<void>): RequestHandler =>
    async (req, res, next) => {
      try {
        await fn(req, res);
      } catch (e) {
        next(e);
      }
    };
  const refuse = (res: express.Response, status: number, error: string, extra = {}) => {
    res.setHeader('Cache-Control', 'no-store');
    res.status(status).json({
      ...extra,
      Stts_flg: 'N',
      Err_cd: '001',
      message: 'Authentication failed',
      error,
    });
  };

  /** The bearer token, its client, address and scope — refused in the bank's format. */
  const bearer =
    (scope: PartnerScope): RequestHandler =>
    async (req, res, next) => {
      const m = /^Bearer ([A-Za-z0-9._~+/=-]+)$/.exec(req.get('authorization') ?? '');
      if (!m?.[1]) return refuse(res, 401, AXIS_BANK_AUTH_ERRORS.MISSING_TOKEN);
      let principal;
      try {
        if (!deps.verifier) throw new Error('no verifier');
        principal = await deps.verifier.verify(m[1]);
        if (deps.revocations && (await deps.revocations.isRevoked(principal.sessionId))) {
          throw new Error('session_ended');
        }
      } catch (e) {
        const expired = e instanceof Error && e.message === 'JWTExpired';
        L.security.warn('axis.token_rejected', { path: req.path, ip: req.ip, expired });
        return refuse(res, 401, expired ? 'jwt expired' : AXIS_BANK_AUTH_ERRORS.INVALID_TOKEN);
      }
      try {
        const c = await deps.partners.bearerClient(principal, req.ip, scope);
        if (!c.ok) {
          L.security.warn('axis.call_refused', { path: req.path, ip: req.ip, reason: c.reason });
          if (c.reason === 'IP_NOT_ALLOWED') {
            return refuse(res, 403, AXIS_BANK_AUTH_ERRORS.IP_NOT_ALLOWED, { status: false });
          }
          if (c.reason === 'INSUFFICIENT_SCOPE') {
            return refuse(res, 403, AXIS_BANK_AUTH_ERRORS.INSUFFICIENT_SCOPE);
          }
          return refuse(res, 401, AXIS_BANK_AUTH_ERRORS.INVALID_TOKEN);
        }
        res.locals['axisClientRowId'] = c.clientRowId;
        next();
      } catch (e) {
        next(e);
      }
    };

  for (const base of AXIS_BANK_PREFIXES) {
    router.post(
      `${base}token`,
      form,
      wrap(async (req, res) => {
        const out = await deps.axis.token(req.body as Record<string, unknown> | undefined, req.ip);
        if (out.status !== 200) {
          L.security.warn('axis.token_refused', { ip: req.ip, status: out.status });
        }
        res.setHeader('Cache-Control', 'no-store');
        res.status(out.status).json(out.body);
      }),
    );
    router.post(
      `${base}transaction/validate`,
      form,
      bearer('va.validate'),
      wrap(async (req, res) => {
        const out = await deps.axis.validate(
          (req.body ?? {}) as Record<string, unknown>,
          String(res.locals['axisClientRowId']),
          req.ip,
        );
        res.setHeader('Cache-Control', 'no-store');
        res.json(out);
      }),
    );
    router.post(
      `${base}transaction/notify`,
      form,
      bearer('va.notify'),
      wrap(async (req, res) => {
        const out = await deps.axis.notify(
          (req.body ?? {}) as Record<string, unknown>,
          String(res.locals['axisClientRowId']),
        );
        res.setHeader('Cache-Control', 'no-store');
        res.json(out);
      }),
    );
  }
  return router;
}
