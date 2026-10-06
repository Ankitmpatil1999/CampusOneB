import { Router } from 'express';
import type { Kysely } from 'kysely';
import { defineRoute } from '../config/openapi-registry';
import type { Loggers } from '../controllers/logger';
import { personalController } from '../controllers/personal.controller';
import { requireSurface } from '../middlewares/auth.middleware';
import { idempotency } from '../middlewares/idempotency.middleware';
import type { Database } from '../models/ringpe_models';
import {
  addressSchema,
  bankAccountSchema,
  correctionCreatedSchema,
  correctionSchema,
  correctionsSchema,
  incomeSchema,
  nomineeSchema,
  personalDetailsSchema,
  savedSchema,
} from '../schemas/personal.schema';
import type { PersonalDetailsService } from '../services/personal-details.service';

const tags = ['Personal details'];
const saved = { 200: { description: 'Saved; ETag carries the new version', schema: savedSchema } };

defineRoute({
  id: 'IDN-015',
  method: 'get',
  path: '/api/v1/me/personal-details',
  summary:
    'Identity (display-only, masked; CR-06), contact, address, bank account, nominee, income, pending corrections and the lists to choose from',
  tags,
  auth: 'member',
  responses: { 200: { description: 'Personal details', schema: personalDetailsSchema } },
});
defineRoute({
  id: 'IDN-016',
  method: 'post',
  path: '/api/v1/me/pii-corrections',
  summary:
    'Request a correction of a display-only field with the corrected value, a reason and evidence; it waits for a checker (CR-06, section 17)',
  tags,
  auth: 'member',
  idempotent: 'required',
  request: correctionSchema,
  responses: { 201: { description: 'Correction requested', schema: correctionCreatedSchema } },
});
defineRoute({
  id: 'IDN-017',
  method: 'get',
  path: '/api/v1/me/pii-corrections',
  summary: 'My correction requests and their outcome',
  tags,
  auth: 'member',
  responses: { 200: { description: 'Correction requests', schema: correctionsSchema } },
});
defineRoute({
  id: 'IDN-020',
  method: 'put',
  path: '/api/v1/me/address',
  summary:
    'Address and its proof (one per account; If-Match with the version read, "v0" the first time)',
  tags,
  auth: 'member',
  request: addressSchema,
  responses: saved,
});
defineRoute({
  id: 'IDN-021',
  method: 'put',
  path: '/api/v1/me/bank-account',
  summary:
    'Link or replace the personal-wallet bank account; checked with ₹1 before use (test provider until one is chosen); number encrypted, masked on read',
  tags,
  auth: 'member',
  idempotent: 'required',
  request: bankAccountSchema,
  responses: saved,
});
defineRoute({
  id: 'IDN-022',
  method: 'put',
  path: '/api/v1/me/nominee',
  summary: 'Nominee: name, relation, date of birth and share (one per account)',
  tags,
  auth: 'member',
  request: nomineeSchema,
  responses: saved,
});
defineRoute({
  id: 'IDN-023',
  method: 'put',
  path: '/api/v1/me/income',
  summary: 'Occupation and annual income band',
  tags,
  auth: 'member',
  request: incomeSchema,
  responses: saved,
});

/** Mounted under /api/v1; member surface only. */
export function personalRoutes(deps: {
  db: Kysely<Database>;
  service: PersonalDetailsService;
  loggers: Loggers;
}): Router {
  const c = personalController(deps.service);
  const member = requireSurface(deps.loggers, 'member');
  const once = idempotency({ db: deps.db, mode: 'required' });
  const r = Router();
  r.get('/me/personal-details', member, c.view);
  r.post('/me/pii-corrections', member, once, c.requestCorrection);
  r.get('/me/pii-corrections', member, c.corrections);
  r.put('/me/address', member, c.address);
  r.put('/me/bank-account', member, once, c.bankAccount);
  r.put('/me/nominee', member, c.nominee);
  r.put('/me/income', member, c.income);
  return r;
}
