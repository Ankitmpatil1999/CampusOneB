/**
 * Notification settings per event (COM-032/033; client 2026-10-16): which notices a school also
 * e-mails and which raise the phone alert. The Institution Administrator (task config, as the
 * school's channel switches).
 */
import { Router, type Request, type RequestHandler } from 'express';
import { defineRoute } from '../config/openapi-registry';
import type { Loggers } from '../controllers/logger';
import { authorize, requireSurface, requireTenant } from '../middlewares/auth.middleware';
import { commEventListSchema, commEventUpdateSchema } from '../schemas/comm-events.schema';
import type { CommEventsService } from '../services/comm-events.service';
import { AuthenticationError } from '../utils/CustomAPIError';

const doc = (d: Omit<Parameters<typeof defineRoute>[0], 'tags'>) =>
  defineRoute({ ...d, tags: ['Communication'] });

doc({
  id: 'COM-032',
  method: 'get',
  path: '/api/v1/console/notification-events',
  summary:
    'Every notification event (fee assigned, fee due, absent, homework, results, class, transport, leave, announcements, messages, money added, payments, cards, tickets, approvals) with whether it is also e-mailed and whether it raises the phone alert at this school (every event on until switched off), and whether e-mail can go at all',
  auth: 'config.view',
  responses: { 200: { description: 'Events', schema: commEventListSchema } },
});
doc({
  id: 'COM-033',
  method: 'patch',
  path: '/api/v1/console/notification-events',
  summary:
    "Switch e-mail or the phone alert on or off for some events; each change carries the version it was read at (412 when someone changed it meanwhile). The in-app notice is always kept",
  auth: 'config.edit',
  request: commEventUpdateSchema,
  responses: { 200: { description: 'Changed', schema: commEventListSchema } },
});

export function commEventsRoutes(deps: { commEvents: CommEventsService; loggers: Loggers }): Router {
  const router = Router();
  const L = deps.loggers;
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
  router.get(
    '/console/notification-events',
    ...console,
    authorize('config.view', L),
    wrap(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.json(await deps.commEvents.list(principal(req)));
    }),
  );
  router.patch(
    '/console/notification-events',
    ...console,
    authorize('config.edit', L),
    wrap(async (req, res) => {
      const body = commEventUpdateSchema.parse(req.body ?? {});
      res.json(await deps.commEvents.update(principal(req), body.changes));
    }),
  );
  return router;
}
