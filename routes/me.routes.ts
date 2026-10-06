import { Router } from 'express';
import { defineRoute } from '../config/openapi-registry';
import type { Loggers } from '../controllers/logger';
import { meController } from '../controllers/me.controller';
import { requireSurface } from '../middlewares/auth.middleware';
import {
  devicesSchema,
  emailChangeSchema,
  emailChangeStartedSchema,
  emailConfirmSchema,
  languageSchema,
  meSchema,
  passwordChangeSchema,
} from '../schemas/member-auth.schema';
import type { MeService } from '../services/me.service';

const tags = ['Me'];
defineRoute({
  id: 'IDN-013',
  method: 'get',
  path: '/api/v1/me',
  summary:
    'The signed-in account (identity masked), its institution profiles and active profile, menu and features',
  tags,
  auth: 'member',
  responses: { 200: { description: 'Account', schema: meSchema } },
});
defineRoute({
  id: 'IDN-024',
  method: 'post',
  path: '/api/v1/me/password',
  summary: 'Change password (current required; must differ); every other session ends',
  tags,
  auth: 'member | console | ops | portal',
  request: passwordChangeSchema,
  responses: { 204: { description: 'Password changed' } },
});
defineRoute({
  id: 'IDN-029',
  method: 'get',
  path: '/api/v1/me/devices',
  summary: 'The one bound device (6.15)',
  tags,
  auth: 'member',
  responses: { 200: { description: 'Device', schema: devicesSchema } },
});
defineRoute({
  id: 'IDN-030',
  method: 'put',
  path: '/api/v1/me/language',
  summary: 'Preferred language (re-selecting the current one is a no-op)',
  tags,
  auth: 'member | console | ops',
  request: languageSchema,
  responses: { 200: { description: 'Saved' } },
});

defineRoute({
  id: 'IDN-018',
  method: 'put',
  path: '/api/v1/me/contact/email',
  summary:
    'Change the e-mail: unique, takes effect only after the code sent to the new address is confirmed (IDN-019)',
  tags,
  auth: 'member',
  request: emailChangeSchema,
  responses: {
    202: { description: 'Code sent to the new address', schema: emailChangeStartedSchema },
  },
});
defineRoute({
  id: 'IDN-019',
  method: 'post',
  path: '/api/v1/me/contact/email/verify',
  summary: 'Confirm the new e-mail with the code it received; it becomes the verified e-mail',
  tags,
  auth: 'member',
  request: emailConfirmSchema,
  responses: { 200: { description: 'E-mail changed' } },
});

/** Mounted under /api/v1. */
export function meRoutes(service: MeService, loggers: Loggers): Router {
  const c = meController(service);
  const r = Router();
  r.get('/me', requireSurface(loggers, 'member'), c.me);
  r.post(
    '/me/password',
    requireSurface(loggers, 'member', 'console', 'ops', 'portal'),
    c.changePassword,
  );
  r.get('/me/devices', requireSurface(loggers, 'member'), c.devices);
  r.put('/me/language', requireSurface(loggers, 'member', 'console', 'ops'), c.language);
  r.put('/me/contact/email', requireSurface(loggers, 'member'), c.startEmailChange);
  r.post('/me/contact/email/verify', requireSurface(loggers, 'member'), c.confirmEmailChange);
  return r;
}
