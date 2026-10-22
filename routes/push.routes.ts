/**
 * Phone pushes (client 2026-10-19): the member app (COM-034) and the staff app (COM-035, its Bearer
 * console session) register their Firebase token for the signed-in session, so notices reach the
 * phone while the app is closed or the phone is locked. Signing out ends the session, and with it the
 * pushes.
 */
import { Router, type Request, type RequestHandler } from 'express';
import { defineRoute } from '../config/openapi-registry';
import type { Loggers } from '../controllers/logger';
import { requireSurface, requireTenant } from '../middlewares/auth.middleware';
import { pushTokenSchema } from '../schemas/push.schema';
import type { PushTokensService } from '../services/push-tokens.service';
import { AuthenticationError } from '../utils/CustomAPIError';

defineRoute({
  id: 'COM-034',
  method: 'put',
  path: '/api/v1/me/push-token',
  summary:
    "The phone's push token for this signed-in session (the app sends it after signing in and whenever it changes); a token another session held moves here",
  tags: ['Notifications'],
  auth: 'member',
  request: pushTokenSchema,
  responses: { 204: { description: 'Registered' } },
});
defineRoute({
  id: 'COM-035',
  method: 'put',
  path: '/api/v1/console/push-token',
  summary:
    "The staff app's push token for its signed-in console session (client 2026-10-19: Accounts, Co-ordinator, Counsellor); the console's notices are pushed to it",
  tags: ['Notifications'],
  auth: 'session (console)',
  request: pushTokenSchema,
  responses: { 204: { description: 'Registered' } },
});

export function pushRoutes(deps: { pushTokens: PushTokensService; loggers: Loggers }): Router {
  const router = Router();
  const L = deps.loggers;
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
  const register = wrap(async (req, res) => {
    await deps.pushTokens.register(principal(req), pushTokenSchema.parse(req.body ?? {}));
    res.status(204).end();
  });
  router.put('/me/push-token', requireSurface(L, 'member'), register);
  router.put('/console/push-token', requireSurface(L, 'console'), requireTenant(L), register);
  return router;
}
