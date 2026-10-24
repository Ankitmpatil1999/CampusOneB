import { Router, type RequestHandler } from 'express';
import type { Kysely } from 'kysely';
import { defineRoute } from '../config/openapi-registry';
import { memberAuthController } from '../controllers/member-auth.controller';
import { idempotency } from '../middlewares/idempotency.middleware';
import type { Database } from '../models/ringpe_models';
import {
  challengeSchema,
  codeVerifySchema,
  deviceChallengeSchema,
  deviceVerifySchema,
  memberSessionSchema,
  passwordResetSchema,
  recoveryStartSchema,
  recoveryStartedSchema,
  recoveryVerifySchema,
  resendSchema,
  resetTokenSchema,
  signInSchema,
  firstSignInSchema,
  signupCompleteSchema,
  signupReferenceSchema,
  signupStartSchema,
  signupTokenSchema,
  socialCallbackSchema,
  socialSignupSchema,
  socialStartSchema,
  socialStartedSchema,
} from '../schemas/member-auth.schema';
import type { MemberAuthService } from '../services/member-auth.service';
import type { OtpService } from '../services/otp.service';
import type { SocialAuthService } from '../services/social-auth.service';

const tags = ['Member auth'];
defineRoute({
  id: 'IDN-077',
  method: 'get',
  path: '/api/v1/auth/member/signup/reference',
  summary:
    'Everything the sign-up wizard shows: consent and terms texts (versioned), security questions, identity documents, genders, password rule, minimum age',
  tags,
  auth: 'public',
  responses: { 200: { description: 'Reference data', schema: signupReferenceSchema } },
});
defineRoute({
  id: 'IDN-001',
  method: 'post',
  path: '/api/v1/auth/member/signup/otp',
  summary:
    'Sign-up step 1: consent + 10-digit mobile → 4-digit code by SMS. A live code is kept ("OTP Already Sent", 200) and the wizard continues',
  tags,
  auth: 'public',
  request: signupStartSchema,
  responses: {
    202: { description: 'Code sent', schema: challengeSchema },
    200: { description: 'A live code exists (no new SMS)', schema: challengeSchema },
  },
});
defineRoute({
  id: 'IDN-002',
  method: 'post',
  path: '/api/v1/auth/member/signup/otp/verify',
  summary: 'Sign-up step 2: verify the code → sign-up token for the registration session',
  tags,
  auth: 'public',
  request: codeVerifySchema,
  responses: { 200: { description: 'Code verified', schema: signupTokenSchema } },
});
defineRoute({
  id: 'IDN-003',
  method: 'post',
  path: '/api/v1/auth/member/signup',
  summary:
    'Sign-up steps 3–5: PAN, personal details (age ≥ 18), identity document, e-mail, password, security answer, terms → account, device bound, signed in',
  tags,
  auth: 'public',
  idempotent: 'required',
  request: signupCompleteSchema,
  responses: { 201: { description: 'Account created and signed in', schema: memberSessionSchema } },
});
defineRoute({
  id: 'IDN-078',
  method: 'post',
  path: '/api/v1/auth/otp/resend',
  summary:
    'Resend a code once, after the countdown (sign-up, new device, password recovery). Sign-up repeats the mobile',
  tags,
  auth: 'public',
  request: resendSchema,
  responses: { 200: { description: 'New code sent', schema: challengeSchema } },
});
defineRoute({
  id: 'IDN-006',
  method: 'post',
  path: '/api/v1/auth/member/signin',
  summary:
    'Mobile + password sign-in. The bound device gets a session; a new device gets a code to the account mobile first. Other sessions on the member surface end (BR-05)',
  tags,
  auth: 'public',
  request: signInSchema,
  responses: {
    200: { description: 'Signed in', schema: memberSessionSchema },
    202: { description: 'New device: confirm with the code', schema: deviceChallengeSchema },
  },
});
defineRoute({
  id: 'IDN-091',
  method: 'post',
  path: '/api/v1/auth/member/first-signin',
  summary:
    'An account the school made at admission (client 2026-10-23): after sign-in answers passwordChangeRequired, its own password in place of the one-time one, the PAN and Aadhaar number the account lacks and a security question (needs); then sign in again',
  tags,
  auth: 'public',
  request: firstSignInSchema,
  responses: { 204: { description: 'Password set' } },
});
defineRoute({
  id: 'IDN-007',
  method: 'post',
  path: '/api/v1/auth/member/device/verify',
  summary: 'Bind this device with the code sent to the account mobile; the session starts',
  tags,
  auth: 'public',
  request: deviceVerifySchema,
  responses: { 200: { description: 'Device bound and signed in', schema: memberSessionSchema } },
});
defineRoute({
  id: 'IDN-010',
  method: 'post',
  path: '/api/v1/auth/member/password/forgot',
  summary:
    'Password recovery: registered mobile → a code to it (client 2026-10-23: no security question)',
  tags,
  auth: 'public',
  request: recoveryStartSchema,
  responses: { 202: { description: 'Code sent', schema: recoveryStartedSchema } },
});
defineRoute({
  id: 'IDN-011',
  method: 'post',
  path: '/api/v1/auth/member/password/forgot/verify',
  summary: 'The code (client 2026-10-23: no security answer) → single-use reset token',
  tags,
  auth: 'public',
  request: recoveryVerifySchema,
  responses: { 200: { description: 'Verified', schema: resetTokenSchema } },
});
defineRoute({
  id: 'IDN-012',
  method: 'post',
  path: '/api/v1/auth/member/password/reset',
  summary: 'Set the new password; every session of the account ends',
  tags,
  auth: 'public',
  request: passwordResetSchema,
  responses: { 204: { description: 'Password changed' } },
});

defineRoute({
  id: 'IDN-004',
  method: 'post',
  path: '/api/v1/auth/member/social/:provider/start',
  summary:
    'Begin sign-in or sign-up with a provider (Google, Apple; CR-03) — PKCE. Test mode returns the in-app test provider',
  tags,
  auth: 'public',
  request: socialStartSchema,
  responses: { 200: { description: 'Where to send the member', schema: socialStartedSchema } },
});
defineRoute({
  id: 'IDN-005',
  method: 'post',
  path: '/api/v1/auth/member/social/:provider/callback',
  summary:
    'Exchange the provider code: a linked account signs in (a new phone gets a code first); otherwise a sign-up ticket that still collects mobile, consent, terms and details',
  tags,
  auth: 'public',
  request: socialCallbackSchema,
  responses: {
    200: {
      description: 'Signed in, or a sign-up ticket',
      schema: memberSessionSchema.or(socialSignupSchema),
    },
    202: { description: 'New device: confirm with the code', schema: deviceChallengeSchema },
  },
});

/** Mounted under /api/v1. Every route here is rate-limited as an authentication route. */
export function memberAuthRoutes(deps: {
  db: Kysely<Database>;
  service: MemberAuthService;
  otp: OtpService;
  social: SocialAuthService;
  authLimiter: RequestHandler;
}): Router {
  const c = memberAuthController(deps.service, deps.otp, deps.social);
  const limit = deps.authLimiter;
  const r = Router();
  r.get('/auth/member/signup/reference', c.reference);
  r.post('/auth/member/signup/otp', limit, c.signupStart);
  r.post('/auth/member/signup/otp/verify', limit, c.signupVerify);
  r.post(
    '/auth/member/signup',
    limit,
    idempotency({ db: deps.db, mode: 'required' }),
    c.signupComplete,
  );
  r.post('/auth/otp/resend', limit, c.resend);
  r.post('/auth/member/signin', limit, c.signIn);
  r.post('/auth/member/first-signin', limit, c.firstSignIn);
  r.post('/auth/member/device/verify', limit, c.deviceVerify);
  r.post('/auth/member/password/forgot', limit, c.recoveryStart);
  r.post('/auth/member/password/forgot/verify', limit, c.recoveryVerify);
  r.post('/auth/member/password/reset', limit, c.passwordReset);
  r.post('/auth/member/social/:provider/start', limit, c.socialStart);
  r.post('/auth/member/social/:provider/callback', limit, c.socialCallback);
  return r;
}
