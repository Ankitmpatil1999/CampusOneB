import { z } from 'zod';
import { Router, type RequestHandler } from 'express';
import { defineRoute } from '../config/openapi-registry';
import type { Loggers } from '../controllers/logger';
import { staffAuthController } from '../controllers/staff-auth.controller';
import { requireSurface, requireTenant } from '../middlewares/auth.middleware';
import {
  consoleSessionSchema,
  opsSessionSchema,
  portalSessionSchema,
  staffChallengeSchema,
  staffForgotSchema,
  staffPasswordResetSchema,
  staffResendSchema,
  staffAppRefreshSchema,
  staffAppTokensSchema,
  staffPasswordChangeSchema,
  staffSignedInSchema,
  staffSignInSchema,
  staffVerifySchema,
} from '../schemas/staff-auth.schema';
import type { StaffAuthService } from '../services/staff-auth.service';
import type { FieldCipher } from '../utils/fieldEncryption';

const tags = ['Staff auth'];
const signInDoc = (id: string, path: string, who: string) =>
  defineRoute({
    id,
    method: 'post',
    path,
    summary: `${who} step 1: work e-mail + password → 4-digit code by SMS (e-mail fallback). Every refusal is the one 6.4 message; no code is issued then (CR-05, RNG-IDN-376)`,
    tags,
    auth: 'public',
    request: staffSignInSchema,
    responses: { 202: { description: 'Code sent', schema: staffChallengeSchema } },
  });
const resendDoc = (id: string, path: string) =>
  defineRoute({
    id,
    method: 'post',
    path,
    summary:
      'One resend after the countdown, or the code by e-mail instead of SMS (the SMS code stops)',
    tags,
    auth: 'public',
    request: staffResendSchema,
    responses: { 202: { description: 'Code sent', schema: staffChallengeSchema } },
  });
const verifyDoc = (id: string, path: string, who: string) =>
  defineRoute({
    id,
    method: 'post',
    path,
    summary: `${who} step 2: the code opens the session in __Host- cookies (24 h, idle 15 min); wrong codes end the attempt after the limit; abandoned attempts lock the account (RNG-IDN-380)`,
    tags,
    auth: 'public',
    request: staffVerifySchema,
    responses: {
      200: {
        description: 'Signed in, or a temporary password to change first',
        schema: z.union([staffSignedInSchema, staffPasswordChangeSchema]),
      },
    },
  });

signInDoc('IDN-031', '/api/v1/auth/console/signin', 'Institution console');
resendDoc('IDN-032', '/api/v1/auth/console/otp/resend');
verifyDoc('IDN-033', '/api/v1/auth/console/otp/verify', 'Institution console');
defineRoute({
  id: 'IDN-088',
  method: 'post',
  path: '/api/v1/auth/staff-app/otp/verify',
  summary:
    'Staff app step 2 (client 2026-10-19; step 1 and the resend are IDN-031/032): the code opens a console session of the app, beside the web console’s — signing in on the phone ends only the account’s earlier phone session. Tokens in the body, sent as Bearer (auth.session.staffAppDays, idle auth.idle.staffAppDays)',
  tags,
  auth: 'public',
  request: staffVerifySchema,
  responses: {
    200: {
      description: 'Signed in, or a temporary password to change first',
      schema: z.union([
        staffAppTokensSchema.extend({ name: z.string() }),
        staffPasswordChangeSchema,
      ]),
    },
  },
});
defineRoute({
  id: 'IDN-089',
  method: 'post',
  path: '/api/v1/auth/staff-app/token/refresh',
  summary:
    'The staff app renews its console session: the refresh token in the body is rotated (a web console session’s token is refused here)',
  tags,
  auth: 'public',
  request: staffAppRefreshSchema,
  responses: { 200: { description: 'New tokens', schema: staffAppTokensSchema } },
});
signInDoc('IDN-035', '/api/v1/ops/auth/signin', 'Back office');
verifyDoc('IDN-036', '/api/v1/ops/auth/otp/verify', 'Back office');
resendDoc('IDN-037', '/api/v1/ops/auth/otp/resend');
const forgotDoc = (id: string, path: string, who: string) =>
  defineRoute({
    id,
    method: 'post',
    path,
    summary: `${who} "Forgot password?": a one-time link to choose a new password goes to the account's e-mail when the account may sign in here. The answer is the same whether or not the account exists`,
    tags,
    auth: 'public',
    request: staffForgotSchema,
    responses: { 202: { description: 'Accepted (a link is sent when the account exists)' } },
  });
forgotDoc('IDN-034', '/api/v1/auth/console/password/forgot', 'Institution console');
forgotDoc('IDN-082', '/api/v1/ops/auth/password/forgot', 'Back office');
signInDoc(
  'SAS-005',
  '/api/v1/portal/auth/signin',
  'Customer portal (Institution Administrators; open while pending, on trial or suspended)',
);
verifyDoc('SAS-006', '/api/v1/portal/auth/otp/verify', 'Customer portal');
resendDoc('SAS-045', '/api/v1/portal/auth/otp/resend');
forgotDoc('SAS-046', '/api/v1/portal/auth/password/forgot', 'Customer portal');
defineRoute({
  id: 'SAS-044',
  method: 'get',
  path: '/api/v1/portal/session',
  summary:
    'Who is signed in to the customer portal: name, contact and the institution with its status',
  tags,
  auth: 'session (portal)',
  responses: { 200: { description: 'Portal session', schema: portalSessionSchema } },
});
defineRoute({
  id: 'IDN-083',
  method: 'post',
  path: '/api/v1/auth/staff/password/reset',
  summary:
    'Set the new password from the e-mailed link (works once, within the setting idn.staffPasswordReset.linkMinutes); every session of the account ends',
  tags,
  auth: 'public',
  request: staffPasswordResetSchema,
  responses: { 204: { description: 'Password changed' } },
});
defineRoute({
  id: 'IDN-079',
  method: 'get',
  path: '/api/v1/console/session',
  summary:
    'Who is signed in to the console: name, institution, roles and granted sub-tasks (the menu follows them)',
  tags,
  auth: 'session (console)',
  responses: { 200: { description: 'Console session', schema: consoleSessionSchema } },
});
defineRoute({
  id: 'IDN-080',
  method: 'get',
  path: '/api/v1/ops/session',
  summary: 'Who is signed in to the back office: name, operator role and granted sub-tasks',
  tags,
  auth: 'session (ops)',
  responses: { 200: { description: 'Back-office session', schema: opsSessionSchema } },
});

/** Mounted under /api/v1. */
export function staffAuthRoutes(deps: {
  service: StaffAuthService;
  cipher: FieldCipher;
  loggers: Loggers;
  authLimiter: RequestHandler;
}): Router {
  const c = staffAuthController(deps.service, deps.cipher);
  const router = Router();
  const limit = deps.authLimiter;
  router.post('/auth/console/signin', limit, c.signIn('console'));
  router.post('/auth/console/otp/resend', limit, c.resend('console'));
  router.post('/auth/console/otp/verify', limit, c.verify('console'));
  // The staff app (client 2026-10-19): step 1 and the resend are the console's; step 2 and the
  // renewal answer with tokens.
  router.post('/auth/staff-app/otp/verify', limit, c.appVerify);
  router.post('/auth/staff-app/token/refresh', limit, c.appRefresh);
  router.post('/ops/auth/signin', limit, c.signIn('ops'));
  router.post('/ops/auth/otp/resend', limit, c.resend('ops'));
  router.post('/ops/auth/otp/verify', limit, c.verify('ops'));
  router.post('/auth/console/password/forgot', limit, c.forgot('console'));
  router.post('/ops/auth/password/forgot', limit, c.forgot('ops'));
  router.post('/portal/auth/signin', limit, c.signIn('portal'));
  router.post('/portal/auth/otp/resend', limit, c.resend('portal'));
  router.post('/portal/auth/otp/verify', limit, c.verify('portal'));
  router.post('/portal/auth/password/forgot', limit, c.forgot('portal'));
  router.post('/auth/staff/password/reset', limit, c.passwordReset);
  router.get(
    '/console/session',
    requireSurface(deps.loggers, 'console'),
    requireTenant(deps.loggers),
    c.consoleSession,
  );
  router.get('/ops/session', requireSurface(deps.loggers, 'ops'), c.opsSession);
  router.get(
    '/portal/session',
    requireSurface(deps.loggers, 'portal'),
    requireTenant(deps.loggers),
    c.portalSession,
  );
  return router;
}
