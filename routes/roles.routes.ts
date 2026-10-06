import { Router } from 'express';
import type { Kysely } from 'kysely';
import { defineRoute } from '../config/openapi-registry';
import type { Loggers } from '../controllers/logger';
import { rolesController } from '../controllers/roles.controller';
import { authorize, requireSurface } from '../middlewares/auth.middleware';
import { idempotency } from '../middlewares/idempotency.middleware';
import type { Database } from '../models/ringpe_models';
import {
  accountChangeSchema,
  accountSavedSchema,
  assignSchema,
  operatorAccountsSchema,
  roleChangeSchema,
  roleChangesSchema,
  roleCreatedSchema,
  roleCreateSchema,
  rolesSchema,
  tasksSchema,
  unlockSchema,
  versionSchema,
} from '../schemas/roles.schema';
import type { RolesService } from '../services/roles.service';

const tags = ['Roles & tasks'];
defineRoute({
  id: 'IDN-063',
  method: 'get',
  path: '/api/v1/ops/tasks',
  summary: 'Task → sub-task catalogue for institution and operator scopes (?scope=)',
  tags,
  auth: 'task.platform',
  responses: { 200: { description: 'Catalogue', schema: tasksSchema } },
});
defineRoute({
  id: 'IDN-064',
  method: 'get',
  path: '/api/v1/ops/roles',
  summary:
    'Operator roles and the default institution roles, with assigned tasks, granted sub-tasks and holders (?scope=)',
  tags,
  auth: 'task.platform',
  responses: { 200: { description: 'Roles', schema: rolesSchema } },
});
defineRoute({
  id: 'IDN-065',
  method: 'post',
  path: '/api/v1/ops/roles',
  summary: 'New operator role (starts with the Home task); name unique across all roles',
  tags,
  auth: 'roles.edit',
  request: roleCreateSchema,
  responses: { 201: { description: 'Created', schema: roleCreatedSchema } },
});
defineRoute({
  id: 'IDN-066',
  method: 'patch',
  path: '/api/v1/ops/roles/{roleId}',
  summary:
    'One change to an operator role with its reason (assign / remove a task, grant / revoke a sub-task, enable / disable); If-Match',
  tags,
  auth: 'roles.edit',
  request: roleChangeSchema,
  responses: { 200: { description: 'Changed', schema: versionSchema } },
});
defineRoute({
  id: 'IDN-067',
  method: 'get',
  path: '/api/v1/ops/accounts',
  summary: 'Operator accounts: role, last sign-in, status, sign-in lock',
  tags,
  auth: 'task.platform',
  responses: { 200: { description: 'Accounts', schema: operatorAccountsSchema } },
});
defineRoute({
  id: 'IDN-068',
  method: 'post',
  path: '/api/v1/ops/accounts',
  summary:
    'Assign an operator role to an existing RingPe account by e-mail (never an institution account, OI-GOV-01)',
  tags,
  auth: 'roles.edit',
  request: assignSchema,
  responses: { 201: { description: 'Assigned', schema: accountSavedSchema } },
});
defineRoute({
  id: 'IDN-069',
  method: 'patch',
  path: '/api/v1/ops/accounts/{id}',
  summary: "Change an operator account's role, or disable / enable it, with a reason; If-Match",
  tags,
  auth: 'roles.edit',
  request: accountChangeSchema,
  responses: { 200: { description: 'Changed', schema: accountSavedSchema } },
});
defineRoute({
  id: 'IDN-039',
  method: 'post',
  path: '/api/v1/ops/accounts/{accountId}/unlock',
  summary:
    'Platform administrator releases a locked staff account (operator or console) with a reason (CR-05)',
  tags,
  auth: 'roles.edit',
  request: unlockSchema,
  responses: { 204: { description: 'Released' } },
});
defineRoute({
  id: 'IDN-081',
  method: 'get',
  path: '/api/v1/ops/role-changes',
  summary: 'The change record of roles and operator accounts (who, what, why), newest first',
  tags,
  auth: 'task.platform',
  responses: { 200: { description: 'Changes', schema: roleChangesSchema } },
});

/** Mounted under /api/v1. Back-office sessions only; reads need the Platform task, writes roles.edit. */
export function rolesRoutes(deps: {
  db: Kysely<Database>;
  service: RolesService;
  loggers: Loggers;
}): Router {
  const c = rolesController(deps.service);
  const router = Router();
  const ops = requireSurface(deps.loggers, 'ops');
  const read = authorize('task.platform', deps.loggers);
  const edit = authorize('roles.edit', deps.loggers);
  const once = idempotency({ db: deps.db, mode: 'required' });
  router.get('/ops/tasks', ops, read, c.tasks);
  router.get('/ops/roles', ops, read, c.roles);
  router.post('/ops/roles', ops, edit, once, c.createRole);
  router.patch('/ops/roles/:roleId', ops, edit, c.changeRole);
  router.get('/ops/accounts', ops, read, c.accounts);
  router.post('/ops/accounts', ops, edit, once, c.assign);
  router.patch('/ops/accounts/:id', ops, edit, c.changeAccount);
  router.post('/ops/accounts/:accountId/unlock', ops, edit, c.unlock);
  router.get('/ops/role-changes', ops, read, c.changes);
  return router;
}
