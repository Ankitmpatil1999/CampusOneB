/**
 * Phone pushes (COM-034; client 2026-10-19): the member app registers its Firebase token for the
 * signed-in session, so notices reach the phone while the app is closed or the phone is locked.
 * Signing out ends the session, and with it the pushes.
 */
import { Router, type Request, type RequestHandler } from 'express';
import { defineRoute } from '../config/openapi-registry';
import type { Loggers } from '../controllers/logger';
import { requireSurface } from '../middlewares/auth.middleware';
import { pushTokenSchema } from '../schemas/push.schema';
import type { PushTokensService } from '../services/push.service';
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

export function pushRoutes(deps: { pushTokens: PushTokensService; loggers: Loggers }): Router {
  const router = Router();
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
  router.put(
    '/me/push-token',
    requireSurface(deps.loggers, 'member'),
    wrap(async (req, res) => {
      const body = pushTokenSchema.parse(req.body ?? {});
      await deps.pushTokens.register(principal(req), body);
      res.status(204).end();
    }),
  );
  return router;
}
