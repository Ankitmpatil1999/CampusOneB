import type { RequestHandler } from 'express';
import {
  accountChangeSchema,
  assignSchema,
  roleChangeSchema,
  roleCreateSchema,
  scopeQuerySchema,
  unlockSchema,
} from '../schemas/roles.schema';
import type { RolesService } from '../services/roles.service';
import { AuthenticationError } from '../utils/CustomAPIError';
import { expectedVersion, setEtag } from '../utils/etag';

export function rolesController(service: RolesService) {
  const wrap =
    (fn: RequestHandler): RequestHandler =>
    async (req, res, next) => {
      try {
        await fn(req, res, next);
      } catch (e) {
        next(e);
      }
    };
  const principal = (req: Parameters<RequestHandler>[0]) => {
    if (!req.principal) throw new AuthenticationError();
    return req.principal;
  };

  return {
    tasks: wrap(async (req, res) => {
      const { scope } = scopeQuerySchema.parse(req.query);
      res.json(await service.tasks(scope));
    }),
    roles: wrap(async (req, res) => {
      const { scope } = scopeQuerySchema.parse(req.query);
      res.setHeader('Cache-Control', 'no-store');
      res.json(await service.roles(scope));
    }),
    createRole: wrap(async (req, res) => {
      const body = roleCreateSchema.parse(req.body ?? {});
      res.status(201).json(await service.createRole(principal(req), body));
    }),
    changeRole: wrap(async (req, res) => {
      const body = roleChangeSchema.parse(req.body ?? {});
      const out = await service.changeRole(
        principal(req),
        String(req.params['roleId']),
        expectedVersion(req),
        body,
      );
      setEtag(res, out.version);
      res.json(out);
    }),
    accounts: wrap(async (_req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.json(await service.accounts());
    }),
    assign: wrap(async (req, res) => {
      const body = assignSchema.parse(req.body ?? {});
      res.status(201).json(await service.assign(principal(req), body));
    }),
    changeAccount: wrap(async (req, res) => {
      const body = accountChangeSchema.parse(req.body ?? {});
      const out = await service.changeAccount(
        principal(req),
        String(req.params['id']),
        expectedVersion(req),
        body,
      );
      setEtag(res, out.version);
      res.json(out);
    }),
    unlock: wrap(async (req, res) => {
      const body = unlockSchema.parse(req.body ?? {});
      await service.unlock(principal(req), String(req.params['accountId']), body);
      res.status(204).end();
    }),
    changes: wrap(async (_req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.json(await service.changes());
    }),
  };
}
