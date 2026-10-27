import { Router, type Request, type RequestHandler } from 'express';
import { defineRoute } from '../config/openapi-registry';
import type { Loggers } from '../controllers/logger';
import { authorize, requireSurface, requireTenant } from '../middlewares/auth.middleware';
import { institutionChoiceSchema, institutionsSchema } from '../schemas/member-auth.schema';
import {
  activeProfileResultSchema,
  activeProfileSchema,
  consoleRolesSchema,
  memberInstitutionSetSchema,
  opsHomeSchema,
  opsSearchSchema,
  setRolesSchema,
  staffAccountSchema,
  staffAccountsSchema,
  unlockSchema,
} from '../schemas/staff-accounts.schema';
import type { ConsoleStaffService } from '../services/console-staff.service';
import type { MeService } from '../services/me.service';
import type { OpsHomeService } from '../services/ops-home.service';
import { AuthenticationError } from '../utils/CustomAPIError';

const doc = (d: Parameters<typeof defineRoute>[0]) => defineRoute(d);

doc({
  id: 'IDN-062',
  method: 'get',
  path: '/api/v1/console/roles',
  summary:
    "Institution roles with their tasks and sub-tasks; the operator keeps the catalogue, and the Institution Administrator role is RingPe's to give",
  tags: ['Console accounts'],
  auth: 'members.roles',
  responses: { 200: { description: 'Roles', schema: consoleRolesSchema } },
});
doc({
  id: 'IDN-060',
  method: 'get',
  path: '/api/v1/console/staff-accounts',
  summary: 'Staff with a RingPe account: institution roles, last sign-in and sign-in lock',
  tags: ['Console accounts'],
  auth: 'members.roles',
  responses: { 200: { description: 'Staff accounts', schema: staffAccountsSchema } },
});
doc({
  id: 'IDN-061',
  method: 'put',
  path: '/api/v1/console/staff-accounts/{profileId}/roles',
  summary:
    "Set a staff member's institution roles (not the administrator role; never students); a role taken away ends the console sessions",
  tags: ['Console accounts'],
  auth: 'members.roles',
  request: setRolesSchema,
  responses: { 200: { description: 'Staff account', schema: staffAccountSchema } },
});
doc({
  id: 'IDN-038',
  method: 'post',
  path: '/api/v1/console/staff-accounts/{profileId}/unlock',
  summary: "Release a staff member's sign-in lock (abandoned codes or wrong passwords), recorded",
  tags: ['Console accounts'],
  auth: 'members.unlock',
  request: unlockSchema,
  responses: { 204: { description: 'Released' } },
});
doc({
  id: 'IDN-014',
  method: 'put',
  path: '/api/v1/me/active-profile',
  summary:
    'The profile the app works for (a parent switches to a child, CR-04); the next token refresh carries it',
  tags: ['Member account'],
  auth: 'member',
  request: activeProfileSchema,
  responses: { 200: { description: 'Active profile', schema: activeProfileResultSchema } },
});
doc({
  id: 'IDN-092',
  method: 'get',
  path: '/api/v1/me/institutions',
  summary:
    "The institutions of the account's profiles, in the order of IDN-013's profiles, and the session's (client 2026-10-27: a person may belong to several)",
  tags: ['Member account'],
  auth: 'member',
  responses: { 200: { description: 'Institutions', schema: institutionsSchema } },
});
doc({
  id: 'IDN-093',
  method: 'put',
  path: '/api/v1/me/institution',
  summary:
    "Open another of the account's institutions: the session works for the account's best profile there (its own first, else a child's or a student's own); the next token refresh carries it. 404 IDN.INSTITUTION_NOT_LINKED otherwise",
  tags: ['Member account'],
  auth: 'member',
  request: institutionChoiceSchema,
  responses: { 200: { description: 'Institution opened', schema: memberInstitutionSetSchema } },
});
doc({
  id: 'RPT-007',
  method: 'get',
  path: '/api/v1/ops/home',
  summary:
    'Back-office home: tenants by status, open and overdue invoices, platform requests, job health and alerts (no institution records)',
  tags: ['Back office'],
  auth: 'home.view',
  responses: { 200: { description: 'Home', schema: opsHomeSchema } },
});
doc({
  id: 'RPT-008',
  method: 'get',
  path: '/api/v1/ops/search',
  summary: 'Search institutions and invoices (no personal records); recorded in the activity log',
  tags: ['Back office'],
  auth: 'home.view',
  responses: { 200: { description: 'Results', schema: opsSearchSchema } },
});

/** Mounted under /api/v1. */
export function staffAccountsRoutes(deps: {
  staff: ConsoleStaffService;
  me: MeService;
  home: OpsHomeService;
  loggers: Loggers;
}): Router {
  const router = Router();
  const L = deps.loggers;
  const con = [requireSurface(L, 'console'), requireTenant(L)];
  const can = (s: string) => authorize(s, L);
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
  const json = (fn: (req: Request) => Promise<unknown>): RequestHandler =>
    wrap(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.json(await fn(req));
    });

  router.get(
    '/console/roles',
    ...con,
    can('members.roles'),
    json((r) => deps.staff.roles(principal(r))),
  );
  router.get(
    '/console/staff-accounts',
    ...con,
    can('members.roles'),
    json((r) => deps.staff.accounts(principal(r))),
  );
  router.put(
    '/console/staff-accounts/:profileId/roles',
    ...con,
    can('members.roles'),
    json((r) =>
      deps.staff.setRoles(principal(r), param(r, 'profileId'), setRolesSchema.parse(r.body ?? {})),
    ),
  );
  router.post(
    '/console/staff-accounts/:profileId/unlock',
    ...con,
    can('members.unlock'),
    wrap(async (req, res) => {
      await deps.staff.unlock(
        principal(req),
        param(req, 'profileId'),
        unlockSchema.parse(req.body ?? {}),
      );
      res.status(204).end();
    }),
  );
  router.put(
    '/me/active-profile',
    requireSurface(L, 'member'),
    json((r) => deps.me.setActiveProfile(principal(r), activeProfileSchema.parse(r.body ?? {}))),
  );
  // One person, several institutions (client 2026-10-27).
  router.get(
    '/me/institutions',
    requireSurface(L, 'member'),
    json((r) => deps.me.institutions(principal(r))),
  );
  router.put(
    '/me/institution',
    requireSurface(L, 'member'),
    json((r) => deps.me.setInstitution(principal(r), institutionChoiceSchema.parse(r.body ?? {}))),
  );
  router.get(
    '/ops/home',
    requireSurface(L, 'ops'),
    can('home.view'),
    json((r) => deps.home.home(principal(r))),
  );
  router.get(
    '/ops/search',
    requireSurface(L, 'ops'),
    can('home.view'),
    json((r) => deps.home.search(principal(r), String(r.query['q'] ?? '').slice(0, 80))),
  );
  return router;
}
