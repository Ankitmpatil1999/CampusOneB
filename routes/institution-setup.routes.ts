import { Router } from 'express';
import type { Kysely } from 'kysely';
import { defineRoute } from '../config/openapi-registry';
import type { Loggers } from '../controllers/logger';
import { institutionSetupController } from '../controllers/institution-setup.controller';
import {
  authorize,
  authorizeAny,
  requireSurface,
  requireTenant,
} from '../middlewares/auth.middleware';
import { idempotency } from '../middlewares/idempotency.middleware';
import type { Database } from '../models/campusone_models';
import {
  customFieldChangeSchema,
  customFieldCreateSchema,
  customFieldSchema,
  customFieldsSchema,
  userTypeChangeSchema,
  userTypeCreateSchema,
  userTypesSchema,
} from '../schemas/institution-setup.schema';
import type { InstitutionSetupService } from '../services/institution-setup.service';

const tags = ['Institution set-up'];

defineRoute({
  id: 'INS-014',
  method: 'get',
  path: '/api/v1/console/user-types',
  summary: 'User types (with category) and their departments, with member counts',
  tags,
  auth: 'config.view,admissions.view',
  responses: { 200: { description: 'User types', schema: userTypesSchema } },
});
defineRoute({
  id: 'INS-015',
  method: 'post',
  path: '/api/v1/console/user-types',
  summary: 'New user type with at least one department; the name is unique in the institution',
  tags,
  auth: 'config.edit',
  request: userTypeCreateSchema,
  responses: { 201: { description: 'User types', schema: userTypesSchema } },
});
defineRoute({
  id: 'INS-016',
  method: 'patch',
  path: '/api/v1/console/user-types/{userTypeId}',
  summary:
    'Rename (while no members) and add or remove departments (refused while members are in them); If-Match',
  tags,
  auth: 'config.edit',
  request: userTypeChangeSchema,
  responses: { 200: { description: 'User types', schema: userTypesSchema } },
});
defineRoute({
  id: 'INS-017',
  method: 'get',
  path: '/api/v1/console/custom-fields',
  summary: 'Institution-defined fields per entity (?entity) and the active-field limit',
  tags,
  auth: 'config.view,admissions.view',
  responses: { 200: { description: 'Fields', schema: customFieldsSchema } },
});
defineRoute({
  id: 'INS-018',
  method: 'post',
  path: '/api/v1/console/custom-fields',
  summary:
    'Define a field (nine types; required, unique, list column, filter, active) with the identity-document acknowledgement',
  tags,
  auth: 'config.edit',
  request: customFieldCreateSchema,
  responses: { 201: { description: 'Field', schema: customFieldSchema } },
});
defineRoute({
  id: 'INS-019',
  method: 'patch',
  path: '/api/v1/console/custom-fields/{fieldId}',
  summary:
    'Edit label, options and rules; deactivate or reactivate (never delete); type and entity fixed once values exist; If-Match',
  tags,
  auth: 'config.edit',
  request: customFieldChangeSchema,
  responses: { 200: { description: 'Field', schema: customFieldSchema } },
});

/** Mounted under /api/v1. Console sessions; the institution comes from the session. */
export function institutionSetupRoutes(deps: {
  db: Kysely<Database>;
  service: InstitutionSetupService;
  loggers: Loggers;
}): Router {
  const c = institutionSetupController(deps.service);
  const router = Router();
  const L = deps.loggers;
  const con = [requireSurface(L, 'console'), requireTenant(L)];
  const edit = authorize('config.edit', L);
  const once = idempotency({ db: deps.db, mode: 'required' });
  // The counsellor's admissions screens read user types and fields too (approval places the student).
  const lookup = authorizeAny(['config.view', 'admissions.view'], L);
  router.get('/console/user-types', ...con, lookup, c.userTypes);
  router.post('/console/user-types', ...con, edit, once, c.createUserType);
  router.patch('/console/user-types/:userTypeId', ...con, edit, c.changeUserType);
  router.get('/console/custom-fields', ...con, lookup, c.fields);
  router.post('/console/custom-fields', ...con, edit, once, c.createField);
  router.patch('/console/custom-fields/:fieldId', ...con, edit, c.changeField);
  return router;
}
