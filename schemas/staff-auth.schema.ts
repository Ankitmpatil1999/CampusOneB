/**
 * Staff sign-in DTOs (IDN-031…037, IDN-079/080). Presence only; every credential refusal is the
 * single 6.4 message from the service (RNG-IDN-376).
 */
import { z } from 'zod';
import { challengeSchema } from './member-auth.schema';

const req = (max: number) =>
  z
    .string({ message: 'VALIDATION.REQUIRED' })
    .min(1, { message: 'VALIDATION.REQUIRED' })
    .max(max, { message: 'VALIDATION.FORMAT' });

export const staffSignInSchema = z
  .strictObject({
    email: req(254).describe('Work e-mail of the platform account'),
    password: req(128),
  })
  .meta({ id: 'StaffSignIn' });

export const staffForgotSchema = z
  .strictObject({ email: req(254).describe('Work e-mail of the platform account') })
  .meta({ id: 'StaffPasswordForgot' });

export const staffPasswordResetSchema = z
  .strictObject({
    resetToken: req(2000).describe('The token from the link in the e-mail'),
    newPassword: req(128),
  })
  .meta({ id: 'StaffPasswordReset' });

export const staffChallengeSchema = challengeSchema
  .extend({
    channel: z.enum(['SMS', 'EMAIL']),
    emailFallback: z
      .string()
      .nullable()
      .describe('Masked e-mail the code can be sent to instead (OI-IDN-38)'),
  })
  .meta({ id: 'StaffCodeChallenge' });

export const staffResendSchema = z
  .strictObject({
    challengeId: z.uuid({ message: 'AUTH.OTP_INVALID' }),
    channel: z
      .enum(['SMS', 'EMAIL'])
      .optional()
      .describe('EMAIL sends the code to the account e-mail instead (once; the SMS code stops)'),
  })
  .meta({ id: 'StaffCodeResend' });

export const staffVerifySchema = z
  .strictObject({ challengeId: z.uuid({ message: 'AUTH.OTP_INVALID' }), otp: req(6) })
  .meta({ id: 'StaffCodeVerify' });

export const staffSignedInSchema = z
  .object({
    sessionId: z.uuid(),
    name: z.string(),
    csrfToken: z.string().describe('Echo in X-CSRF-Token on every state-changing request'),
    accessTokenExpiresAt: z.iso.datetime(),
    refreshTokenExpiresAt: z.iso.datetime(),
  })
  .meta({ id: 'StaffSignedIn' });

/** A temporary password must be changed first (OI-IDN-20): the token opens the reset step (IDN-083). */
export const staffPasswordChangeSchema = z
  .object({
    passwordChangeRequired: z.literal(true),
    resetToken: z.string(),
    name: z.string(),
  })
  .meta({ id: 'StaffPasswordChangeRequired' });

export const consoleSessionSchema = z
  .object({
    name: z.string(),
    email: z.string().nullable(),
    institution: z.object({
      id: z.uuid(),
      name: z.string(),
      shortName: z.string(),
      city: z.string(),
    }),
    roles: z.array(
      z.object({ code: z.string().nullable(), name: z.string(), readOnly: z.boolean() }),
    ),
    subTasks: z.array(z.string()).describe('Granted sub-tasks (task.subtask); menus follow them'),
    preferredLang: z.string(),
  })
  .meta({ id: 'ConsoleSession' });

export const opsSessionSchema = z
  .object({
    name: z.string(),
    email: z.string().nullable(),
    role: z.object({ code: z.string().nullable(), name: z.string() }),
    subTasks: z.array(z.string()),
    preferredLang: z.string(),
  })
  .meta({ id: 'OpsSession' });

export const portalSessionSchema = z
  .object({
    name: z.string(),
    email: z.string().nullable(),
    mobile: z.string(),
    institution: z.object({
      id: z.uuid(),
      name: z.string(),
      shortName: z.string(),
      city: z.string(),
      identifier: z.string(),
      status: z.enum(['PENDING_ACTIVATION', 'ACTIVE', 'SUSPENDED', 'CANCELLED']),
    }),
    preferredLang: z.string(),
  })
  .meta({ id: 'PortalSession' });
