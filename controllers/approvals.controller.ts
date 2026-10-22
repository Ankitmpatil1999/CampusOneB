import type { Request, RequestHandler } from 'express';
import {
  approvalsQuerySchema,
  auditQuerySchema,
  correctionSchema,
  decisionSchema,
  markReadSchema,
  notificationsQuerySchema,
} from '../schemas/approvals.schema';
import type { ApprovalsService } from '../services/approvals.service';
import type { AuditEventsService } from '../services/audit-events.service';
import type { NotificationsService } from '../services/notifications.service';
import { AuthenticationError } from '../utils/CustomAPIError';
import { expectedVersion, setEtag } from '../utils/etag';

export function approvalsController(
  approvals: ApprovalsService,
  notifications: NotificationsService,
  audit: AuditEventsService,
) {
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
  const param = (req: Request, name: string) => String(req.params[name]);
  const fresh = (res: Parameters<RequestHandler>[1]) => res.setHeader('Cache-Control', 'no-store');

  const queue = (surface: 'console' | 'ops') => ({
    list: wrap(async (req, res) => {
      fresh(res);
      res.json(
        await approvals.list(principal(req), surface, approvalsQuerySchema.parse(req.query)),
      );
    }),
    detail: wrap(async (req, res) => {
      const out = await approvals.detail(principal(req), surface, param(req, 'approvalId'));
      fresh(res);
      setEtag(res, out.version);
      res.json(out);
    }),
    decide: wrap(async (req, res) => {
      const out = await approvals.decide(
        principal(req),
        surface,
        param(req, 'approvalId'),
        expectedVersion(req),
        decisionSchema.parse(req.body ?? {}),
      );
      setEtag(res, out.version);
      res.json(out);
    }),
  });

  const bell = (surface: 'CONSOLE' | 'MEMBER' | 'OPS') => ({
    list: wrap(async (req, res) => {
      fresh(res);
      res.json(
        await notifications.list(
          principal(req),
          surface,
          notificationsQuerySchema.parse(req.query),
        ),
      );
    }),
    read: wrap(async (req, res) => {
      await notifications.markRead(principal(req), surface, markReadSchema.parse(req.body ?? {}));
      res.status(204).end();
    }),
  });

  return {
    console: queue('console'),
    ops: queue('ops'),
    correction: wrap(async (req, res) => {
      const out = await approvals.requestProfileCorrection(
        principal(req),
        param(req, 'memberId'),
        correctionSchema.parse(req.body ?? {}),
      );
      res.status(out.applied ? 200 : 202).json(out);
    }),
    consoleBell: bell('CONSOLE'),
    memberBell: bell('MEMBER'),
    opsBell: bell('OPS'),
    audit: wrap(async (req, res) => {
      fresh(res);
      res.json(await audit.list(principal(req), auditQuerySchema.parse(req.query)));
    }),
  };
}
