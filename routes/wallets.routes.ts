import { Router, type Request, type RequestHandler } from 'express';
import { defineRoute } from '../config/openapi-registry';
import type { Loggers } from '../controllers/logger';
import { authorize, requireSurface, requireTenant } from '../middlewares/auth.middleware';
import {
  consoleWalletsSchema,
  forQuerySchema,
  memberHomeSchema,
  myWalletsSchema,
  receiptSchema,
  statementQuerySchema,
  statementSchema,
  virtualAccountSchema,
} from '../schemas/wallets.schema';
import type { WalletsService } from '../services/wallets.service';
import { AuthenticationError } from '../utils/CustomAPIError';

const tags = ['Wallets'];
const doc = (d: Omit<Parameters<typeof defineRoute>[0], 'tags'>) => defineRoute({ ...d, tags });

doc({
  id: 'WAL-001',
  method: 'get',
  path: '/api/v1/me/wallets',
  summary:
    "The profile's campus and allowance wallets: balance, held, status, wallet number, virtual account, spend today and this month (never cached); `for` picks a profile on the account (a child)",
  auth: 'member',
  responses: { 200: { description: 'Wallets', schema: myWalletsSchema } },
});
doc({
  id: 'WAL-002',
  method: 'get',
  path: '/api/v1/me/wallets/{walletId}/statement',
  summary:
    'Statement from the ledger, newest first: every movement with the other party and the balance after it',
  auth: 'member',
  responses: { 200: { description: 'Statement', schema: statementSchema } },
});
doc({
  id: 'WAL-003',
  method: 'get',
  path: '/api/v1/me/wallets/{walletId}/virtual-account',
  summary:
    'The virtual account (corporate code + wallet number) at the sponsor bank, with how to add money (example bank details until the bank is named)',
  auth: 'member',
  responses: { 200: { description: 'Virtual account', schema: virtualAccountSchema } },
});
doc({
  id: 'WAL-004',
  method: 'get',
  path: '/api/v1/me/transactions/{reference}',
  summary: 'A movement the member is party to: amount, parties, channel, status, balance after',
  auth: 'member',
  responses: { 200: { description: 'Receipt', schema: receiptSchema } },
});
doc({
  id: 'WAL-005',
  method: 'get',
  path: '/api/v1/me/transactions/{reference}/receipt.pdf',
  summary: 'The receipt as a PDF',
  auth: 'member',
  responses: { 200: { description: 'PDF', contentType: 'application/pdf' } },
});
doc({
  id: 'RPT-006',
  method: 'get',
  path: '/api/v1/me/home',
  summary:
    'The member home: the profile (and the others on the account), its wallets, the latest movements and unread notifications',
  auth: 'member',
  responses: { 200: { description: 'Home', schema: memberHomeSchema } },
});
doc({
  id: 'WAL-008',
  method: 'get',
  path: '/api/v1/console/members/{memberId}/wallets',
  summary: "A member's wallets and balances (read-only)",
  auth: 'members.view',
  responses: { 200: { description: 'Wallets', schema: consoleWalletsSchema } },
});
doc({
  id: 'WAL-009',
  method: 'get',
  path: '/api/v1/console/members/{memberId}/statement',
  summary: "A member's statement (the campus wallet unless `walletId` names another)",
  auth: 'members.view',
  responses: { 200: { description: 'Statement', schema: statementSchema } },
});

/** Mounted under /api/v1. */
export function walletsRoutes(deps: { wallets: WalletsService; loggers: Loggers }): Router {
  const router = Router();
  const L = deps.loggers;
  const w = deps.wallets;
  const member = requireSurface(L, 'member');
  const con = [requireSurface(L, 'console'), requireTenant(L), authorize('members.view', L)];
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
  const param = (req: Request, n: string) => String(req.params[n]);
  const json = (fn: (req: Request) => Promise<unknown>): RequestHandler =>
    wrap(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.json(await fn(req));
    });
  const statementQuery = (req: Request) => {
    const q = statementQuerySchema.parse(req.query);
    return {
      ...(q.from ? { from: q.from } : {}),
      ...(q.to ? { to: q.to } : {}),
      ...(q.walletId ? { walletId: q.walletId } : {}),
      ...(q.cursor ? { cursor: q.cursor } : {}),
      ...(q.limit ? { limit: q.limit } : {}),
    };
  };

  router.get(
    '/me/wallets',
    member,
    json((r) => w.myWallets(principal(r), forQuerySchema.parse(r.query).for)),
  );
  router.get(
    '/me/wallets/:walletId/statement',
    member,
    json((r) => w.statement(principal(r), param(r, 'walletId'), statementQuery(r))),
  );
  router.get(
    '/me/wallets/:walletId/virtual-account',
    member,
    json((r) => w.virtualAccount(principal(r), param(r, 'walletId'))),
  );
  router.get(
    '/me/transactions/:reference',
    member,
    json((r) => w.transaction(principal(r), param(r, 'reference'))),
  );
  router.get(
    '/me/transactions/:reference/receipt.pdf',
    member,
    wrap(async (req, res) => {
      const out = await w.receiptPdf(principal(req), param(req, 'reference'));
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${out.fileName}"`);
      res.send(out.pdf);
    }),
  );
  router.get(
    '/me/home',
    member,
    json((r) => w.home(principal(r), forQuerySchema.parse(r.query).for)),
  );
  router.get(
    '/console/members/:memberId/wallets',
    ...con,
    json((r) => w.memberWallets(principal(r), param(r, 'memberId'))),
  );
  router.get(
    '/console/members/:memberId/statement',
    ...con,
    json((r) => w.memberStatement(principal(r), param(r, 'memberId'), statementQuery(r))),
  );
  return router;
}
