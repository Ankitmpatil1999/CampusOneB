/**
 * Member sign-up, sign-in and recovery DTOs (IDN-001…012, IDN-077, IDN-078). Shape and presence
 * are checked here; the SRS field rules (PAN, names, age, e-mail, password, answer) are checked in
 * the service so each refusal carries its 27.5 message.
 */
import { z } from 'zod';

const req = (max: number) =>
  z
    .string({ message: 'VALIDATION.REQUIRED' })
    .min(1, { message: 'VALIDATION.REQUIRED' })
    .max(max, { message: 'VALIDATION.FORMAT' });
const opt = (max: number) => z.string().max(max, { message: 'VALIDATION.FORMAT' }).optional();

export const deviceSchema = z
  .strictObject({
    installId: req(100).describe('Stable install identifier of the app (not a hardware id)'),
    model: opt(80),
    os: opt(40),
    appVersion: opt(20),
  })
  .meta({ id: 'DeviceInfo' });

export const challengeSchema = z
  .object({
    challengeId: z.uuid(),
    expiresAt: z.iso.datetime(),
    resendAfterSeconds: z.number().int(),
    sentTo: z.string().describe('Masked destination'),
    alreadySent: z.boolean().optional().describe('An earlier, still valid code was kept'),
    testCode: z.string().optional().describe('Test environments only (never in production)'),
  })
  .meta({ id: 'CodeChallenge' });

export const signupReferenceSchema = z
  .object({
    consent: z
      .object({ version: z.string(), title: z.string(), text: z.string(), draft: z.boolean() })
      .nullable(),
    terms: z
      .object({ version: z.string(), title: z.string(), text: z.string(), draft: z.boolean() })
      .nullable(),
    securityQuestions: z.array(
      z.object({ code: z.string(), labelKey: z.string(), text: z.string() }),
    ),
    idDocumentTypes: z.array(z.object({ code: z.string(), labelKey: z.string() })),
    genders: z.array(z.object({ code: z.string(), labelKey: z.string(), text: z.string() })),
    password: z.object({ minLength: z.number(), maxLength: z.number() }),
    minAgeYears: z.number(),
  })
  .meta({ id: 'SignupReference' });

export const signupStartSchema = z
  .strictObject({ mobile: req(10), consentVersion: req(20) })
  .meta({ id: 'SignupStart' });

export const codeVerifySchema = z
  .strictObject({ challengeId: z.uuid({ message: 'AUTH.OTP_INVALID' }), otp: req(6) })
  .meta({ id: 'CodeVerify' });

export const signupTokenSchema = z
  .object({ signupToken: z.string(), expiresAt: z.iso.datetime() })
  .meta({ id: 'SignupToken' });

export const signupCompleteSchema = z
  .strictObject({
    signupToken: req(2000),
    socialTicket: opt(2000).describe(
      'From IDN-005 when signing up with a provider; PAN and password become optional',
    ),
    mobile: req(10),
    consentVersion: req(20),
    termsVersion: req(20),
    termsAccepted: z.boolean({ message: 'IDN.TERMS_REQUIRED' }),
    pan: opt(10).describe('Required unless signing up with a provider'),
    firstName: req(60),
    middleName: opt(60),
    lastName: opt(60),
    gender: req(10),
    dob: req(10).describe('YYYY-MM-DD'),
    idDocType: req(24),
    idDocNumber: req(30),
    email: req(254),
    password: opt(128).describe('Required unless signing up with a provider'),
    securityQuestion: req(24),
    securityAnswer: req(60),
    device: deviceSchema,
  })
  .meta({ id: 'SignupComplete' });

export const accountSummarySchema = z
  .object({
    accountId: z.uuid(),
    firstName: z.string(),
    lastName: z.string().nullable(),
    preferredLang: z.string(),
  })
  .meta({ id: 'AccountSummary' });

export const memberSessionSchema = z
  .object({
    sessionId: z.uuid(),
    accessToken: z.string(),
    accessTokenExpiresAt: z.iso.datetime(),
    refreshToken: z.string(),
    refreshTokenExpiresAt: z.iso.datetime(),
    account: accountSummarySchema,
  })
  .meta({ id: 'MemberSession' });

export const signInSchema = z
  .strictObject({ mobile: req(10), password: req(128), device: deviceSchema })
  .meta({ id: 'MemberSignIn' });

/** IDN-091 (client 2026-10-23): an account the school made — its own password, and what it lacks. */
export const firstSignInSchema = z
  .strictObject({
    resetToken: req(2000),
    newPassword: req(128),
    pan: z.string().trim().max(20).nullish(),
    aadhaar: z.string().trim().max(20).nullish(),
    securityQuestion: z.string().max(24).nullish().describe('When needs.securityQuestion'),
    securityAnswer: z.string().max(60).nullish().describe('When needs.securityQuestion'),
  })
  .meta({ id: 'MemberFirstSignIn' });

export const deviceChallengeSchema = z
  .object({ deviceChallenge: challengeSchema })
  .meta({ id: 'DeviceChallenge' });

export const deviceVerifySchema = z
  .strictObject({
    deviceChallengeId: z.uuid({ message: 'AUTH.OTP_INVALID' }),
    otp: req(6),
    device: deviceSchema,
  })
  .meta({ id: 'DeviceVerify' });

export const resendSchema = z
  .strictObject({
    challengeId: z.uuid({ message: 'AUTH.OTP_INVALID' }),
    mobile: z.string().max(10).optional().describe('Sign-up only: the mobile the code went to'),
  })
  .meta({ id: 'CodeResend' });

export const recoveryStartSchema = z
  .strictObject({ mobile: req(10) })
  .meta({ id: 'RecoveryStart' });

export const recoveryStartedSchema = z
  .object({
    recoveryId: z.uuid(),
    challenge: challengeSchema,
  })
  .meta({ id: 'RecoveryStarted' });

export const recoveryVerifySchema = z
  .strictObject({
    recoveryId: z.uuid({ message: 'IDN.RECOVERY_SESSION_ENDED' }),
    securityAnswer: z
      .string()
      .max(60)
      .optional()
      .describe('Ignored (client 2026-10-23: the code alone); older apps still send it'),
    otp: req(6),
  })
  .meta({ id: 'RecoveryVerify' });

export const resetTokenSchema = z
  .object({ resetToken: z.string(), expiresAt: z.iso.datetime() })
  .meta({ id: 'ResetToken' });

export const passwordResetSchema = z
  .strictObject({ resetToken: req(2000), newPassword: req(128) })
  .meta({ id: 'PasswordReset' });

export const socialStartSchema = z
  .strictObject({
    redirectUri: req(500).describe('Where the provider returns (the app link)'),
    codeChallenge: req(128).describe('PKCE S256 challenge'),
  })
  .meta({ id: 'SocialStart' });

export const socialStartedSchema = z
  .object({
    mode: z
      .enum(['test', 'live'])
      .describe('test = the in-app test provider (never in production)'),
    authorizationUrl: z.string(),
    state: z.string(),
    expiresAt: z.iso.datetime(),
  })
  .meta({ id: 'SocialStarted' });

export const socialCallbackSchema = z
  .strictObject({
    code: req(4000),
    state: req(2000),
    codeVerifier: req(128),
    device: deviceSchema,
  })
  .meta({ id: 'SocialCallback' });

export const socialSignupSchema = z
  .object({
    signupTicket: z.string(),
    expiresAt: z.iso.datetime(),
    prefill: z.object({
      provider: z.string(),
      email: z.string(),
      firstName: z.string(),
      lastName: z.string(),
    }),
  })
  .meta({ id: 'SocialSignupTicket' });

export const meSchema = z
  .object({
    account: z.object({
      accountId: z.uuid(),
      mobile: z.string(),
      email: z.string().nullable(),
      emailVerified: z.boolean(),
      firstName: z.string(),
      middleName: z.string().nullable(),
      lastName: z.string().nullable(),
      gender: z.string().nullable(),
      dob: z.string().nullable(),
      pan: z.string().nullable().describe('Masked'),
      idDocument: z.object({ type: z.string(), number: z.string().nullable() }).nullable(),
      kycLevel: z.string(),
      preferredLang: z.string(),
      lastSignInAt: z.iso.datetime().nullable(),
    }),
    profiles: z
      .array(
        z.object({
          id: z.uuid(),
          memberNo: z.string(),
          name: z.string(),
          institution: z.object({ id: z.uuid(), name: z.string(), shortName: z.string() }),
          userType: z.string(),
          kind: z.enum(['STUDENTS', 'PARENTS', 'STAFF', 'MERCHANTS']),
          category: z
            .enum([
              'STUDENT',
              'PARENT',
              'TEACHER',
              'STAFF',
              'MERCHANT',
              'PRINCIPAL',
              'MANAGEMENT',
              'CREW',
              'OTHER',
            ])
            .describe(
              'The user type category: the app picks the role home (teacher, principal, crew …) from it',
            ),
          grade: z.string().nullable().describe('Grade and section this year (students)'),
          status: z.enum(['ACTIVE', 'INACTIVE', 'SUSPENDED']),
          office: z
            .object({ roles: z.array(z.string()) })
            .nullable()
            .describe(
              'Office work this profile’s console roles open in the staff app — fees, admissions, leave, attendance, announcements (client 2026-10-23: Accounts, Co-ordinator, Counsellor); the roles by name. Null: none',
            ),
        }),
      )
      .describe(
        'Institution profiles held by this account (CR-04: a parent and the children under the number)',
      ),
    activeProfileId: z.uuid().nullable(),
    menu: z.array(z.unknown()),
    features: z.record(z.string(), z.boolean()),
  })
  .meta({ id: 'Me' });

export const passwordChangeSchema = z
  .strictObject({ currentPassword: req(128), newPassword: req(128) })
  .meta({ id: 'PasswordChange' });

export const emailChangeSchema = z.strictObject({ email: req(254) }).meta({ id: 'EmailChange' });

export const emailChangeStartedSchema = z
  .object({
    challenge: challengeSchema,
    changeToken: z.string().describe('Send back with the code (IDN-019)'),
  })
  .meta({ id: 'EmailChangeStarted' });

export const emailConfirmSchema = z
  .strictObject({
    changeToken: req(2000),
    challengeId: z.uuid({ message: 'AUTH.OTP_INVALID' }),
    otp: req(6),
  })
  .meta({ id: 'EmailConfirm' });

export const devicesSchema = z
  .object({
    device: z
      .object({
        deviceId: z.uuid(),
        model: z.string().nullable(),
        os: z.string().nullable(),
        appVersion: z.string().nullable(),
        boundAt: z.iso.datetime().nullable(),
      })
      .nullable(),
  })
  .meta({ id: 'Devices' });

export const languageSchema = z.strictObject({ lang: req(8) }).meta({ id: 'LanguageChoice' });
