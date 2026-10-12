/**
 * A school's own payment gateways (INS-038…041; client 2026-10-09): the Institution Administrator
 * and the Accountant (task "gateways") list, add, change and check them. Credentials go in but never
 * come out.
 */
import { Router, type Request, type RequestHandler } from 'express';
import type { Kysely } from 'kysely';
import { defineRoute } from '../config/openapi-registry';
import type { Loggers } from '../controllers/logger';
import { authorize, requireSurface, requireTenant } from '../middlewares/auth.middleware';
import { idempotency } from '../middlewares/idempotency.middleware';
import type { Database } from '../models/ringpe_models';
import {
  gatewayCreateSchema,
  gatewayListSchema,
  gatewaySchema,
  gatewayUpdateSchema,
} from '../schemas/payment-gateways.schema';
import type { PaymentGatewaysService } from '../services/payment-gateways.service';
import { AuthenticationError } from '../utils/CustomAPIError';
import { expectedVersion, setEtag } from '../utils/etag';

const doc = (d: Omit<Parameters<typeof defineRoute>[0], 'tags'>) =>
  defineRoute({ ...d, tags: ['Payment gateways'] });

doc({
  id: 'INS-038',
  method: 'get',
  path: '/api/v1/console/payment-gateways',
  summary:
    "The school's payment gateways: provider, name, masked key id, test or live, default, webhook address and the last check — never a secret",
  auth: 'gateways.view',
  responses: { 200: { description: 'Gateways', schema: gatewayListSchema } },
});
doc({
  id: 'INS-039',
  method: 'post',
  path: '/api/v1/console/payment-gateways',
  summary:
    'Add a gateway account: every credential is stored encrypted; the first one is the default; the gateway is asked at once whether it accepts the keys. Production refuses test keys',
  auth: 'gateways.edit',
  request: gatewayCreateSchema,
  responses: { 201: { description: 'Added', schema: gatewaySchema } },
});
doc({
  id: 'INS-040',
  method: 'patch',
  path: '/api/v1/console/payment-gateways/{gatewayId}',
  summary:
    'Change the name or keys (a secret left out is kept), make it the default, or disable it (the newest active gateway becomes the default). If-Match',
  auth: 'gateways.edit',
  request: gatewayUpdateSchema,
  responses: { 200: { description: 'Changed', schema: gatewaySchema } },
});
doc({
  id: 'INS-041',
  method: 'post',
  path: '/api/v1/console/payment-gateways/{gatewayId}/check',
  summary: 'Ask the gateway whether it accepts the keys (a read-only call; nothing is created)',
  auth: 'gateways.edit',
  responses: { 200: { description: 'Checked', schema: gatewaySchema } },
});

export function paymentGatewaysRoutes(deps: {
  db: Kysely<Database>;
  gateways: PaymentGatewaysService;
  loggers: Loggers;
}): Router {
  const router = Router();
  const L = deps.loggers;
  const G = deps.gateways;
  const once = idempotency({ db: deps.db, mode: 'required' });
  const console = [requireSurface(L, 'console'), requireTenant(L)];
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

  router.get(
    '/console/payment-gateways',
    ...console,
    authorize('gateways.view', L),
    wrap(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.json(await G.list(principal(req)));
    }),
  );
  router.post(
    '/console/payment-gateways',
    ...console,
    authorize('gateways.edit', L),
    once,
    wrap(async (req, res) => {
      const out = await G.create(principal(req), gatewayCreateSchema.parse(req.body ?? {}));
      setEtag(res, out.version);
      res.status(201).json(out);
    }),
  );
  router.patch(
    '/console/payment-gateways/:gatewayId',
    ...console,
    authorize('gateways.edit', L),
    wrap(async (req, res) => {
      const out = await G.update(
        principal(req),
        param(req, 'gatewayId'),
        expectedVersion(req),
        gatewayUpdateSchema.parse(req.body ?? {}),
      );
      setEtag(res, out.version);
      res.json(out);
    }),
  );
  router.post(
    '/console/payment-gateways/:gatewayId/check',
    ...console,
    authorize('gateways.edit', L),
    wrap(async (req, res) => {
      const out = await G.check(principal(req), param(req, 'gatewayId'));
      setEtag(res, out.version);
      res.json(out);
    }),
  );
  return router;
}
