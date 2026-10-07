import type { Request, RequestHandler } from 'express';
import {
  cancellationRequestSchema,
  contactsSchema,
  declineSchema,
  detailsChangeSchema,
  exportRequestSchema,
  goLiveSchema,
  portalPaymentSchema,
  portalPlanChangeSchema,
  signupAccountSchema,
  signupEmailCodeSchema,
  signupEmailVerifySchema,
  signupOtpSchema,
  signupSchema,
  signupVerifySchema,
  stepBodySchema,
} from '../schemas/portal.schema';
import type { PortalDataService } from '../services/portal-data.service';
import type { PortalService, PortalStepInput } from '../services/portal.service';
import { AuthenticationError, NotFoundError, ValidationError } from '../utils/CustomAPIError';
import { csrfTokenFor, setSessionCookies } from '../utils/cookies';
import { expectedVersion, setEtag } from '../utils/etag';
import type { FieldCipher } from '../utils/fieldEncryption';

const STEP_KEYS = ['toggles', 'usertypes', 'year', 'feeacct', 'branding', 'firstusers'] as const;

export function portalController(
  portal: PortalService,
  data: PortalDataService,
  cipher: FieldCipher,
) {
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
  const fresh = (res: Parameters<RequestHandler>[1]) => res.setHeader('Cache-Control', 'no-store');
  const json = (fn: (req: Request) => Promise<unknown>): RequestHandler =>
    wrap(async (req, res) => {
      fresh(res);
      res.json(await fn(req));
    });

  /** The body of a checklist step, typed by its key. */
  const stepInput = (key: string, body: Record<string, unknown>): PortalStepInput => {
    if (!(STEP_KEYS as readonly string[]).includes(key)) throw new NotFoundError();
    const b = stepBodySchema.parse(body);
    switch (key as (typeof STEP_KEYS)[number]) {
      case 'toggles':
        return { key: 'toggles', features: b.features ?? {} };
      case 'usertypes':
        return { key: 'usertypes', userTypes: b.userTypes ?? [] };
      case 'year':
        return {
          key: 'year',
          ...(b.label ? { label: b.label } : {}),
          ...(b.startsOn ? { startsOn: b.startsOn } : {}),
          ...(b.endsOn ? { endsOn: b.endsOn } : {}),
        };
      case 'feeacct': {
        const missing = (['name', 'bank', 'ifsc', 'accountNo'] as const).filter((k) => !b[k]);
        if (missing.length) {
          throw new ValidationError(
            missing.map((field) => ({ field, code: 'VALIDATION.REQUIRED' })),
          );
        }
        return {
          key: 'feeacct',
          name: b.name!,
          bank: b.bank!,
          ifsc: b.ifsc!,
          accountNo: b.accountNo!,
        };
      }
      case 'branding':
        return { key: 'branding', logoFileId: b.logoFileId };
      case 'firstusers':
        return { key: 'firstusers' };
      default:
        throw new NotFoundError();
    }
  };

  return {
    // --- public ---------------------------------------------------------------------------------------
    plans: json(() => portal.plans()),
    signupOtp: wrap(async (req, res) => {
      const out = await portal.signupOtp(signupOtpSchema.parse(req.body ?? {}));
      fresh(res);
      res.status(202).json({ ...out, expiresAt: out.expiresAt.toISOString() });
    }),
    signupVerify: json((req) => portal.signupVerify(signupVerifySchema.parse(req.body ?? {}))),
    // A RingPe account made on the customer site, and its e-mail confirmed (client 2026-10-06).
    signupAccount: wrap(async (req, res) => {
      const out = await portal.createAccount(signupAccountSchema.parse(req.body ?? {}));
      fresh(res);
      res.status(201).json(out);
    }),
    signupEmailCode: wrap(async (req, res) => {
      const out = await portal.emailCode(signupEmailCodeSchema.parse(req.body ?? {}));
      fresh(res);
      res.status(202).json({ ...out, expiresAt: out.expiresAt.toISOString() });
    }),
    signupEmailVerify: json((req) =>
      portal.emailVerify(signupEmailVerifySchema.parse(req.body ?? {})),
    ),
    signup: wrap(async (req, res) => {
      const out = await portal.signup(signupSchema.parse(req.body ?? {}), {
        ip: req.ip,
        userAgent: req.get('user-agent'),
      });
      const csrfToken = csrfTokenFor(cipher, out.tokens.sessionId);
      setSessionCookies(res, 'portal', { ...out.tokens, csrfToken });
      fresh(res);
      res.status(201).json({
        institutionId: out.institutionId,
        identifier: out.identifier,
        name: out.name,
        sessionId: out.tokens.sessionId,
        csrfToken,
      });
    }),

    // --- signed in --------------------------------------------------------------------------------------
    account: json((req) => portal.account(principal(req))),
    onboarding: json((req) => portal.onboarding(principal(req))),
    step: json((req) =>
      portal.completeStep(
        principal(req),
        stepInput(param(req, 'stepKey'), (req.body ?? {}) as Record<string, unknown>),
      ),
    ),
    goLive: json((req) => portal.goLive(principal(req), goLiveSchema.parse(req.body ?? {}))),
    subscription: json((req) => portal.subscription(principal(req))),
    changePlan: json((req) =>
      portal.changePlan(principal(req), portalPlanChangeSchema.parse(req.body ?? {})),
    ),
    cancelScheduled: wrap(async (req, res) => {
      await portal.cancelScheduled(principal(req));
      res.status(204).end();
    }),
    invoices: json((req) => portal.invoices(principal(req))),
    invoice: json((req) => portal.invoice(principal(req), param(req, 'invoiceId'))),
    invoicePdf: wrap(async (req, res) => {
      const out = await portal.invoicePdf(principal(req), param(req, 'invoiceId'));
      fresh(res);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${out.fileName}"`);
      res.send(out.pdf);
    }),
    pay: json((req) =>
      portal.pay(
        principal(req),
        param(req, 'invoiceId'),
        portalPaymentSchema.parse(req.body ?? {}),
      ),
    ),
    notices: json((req) => portal.notices(principal(req))),
    details: wrap(async (req, res) => {
      const out = await portal.details(principal(req));
      fresh(res);
      setEtag(res, out.version);
      res.json(out);
    }),
    contacts: wrap(async (req, res) => {
      const out = await portal.saveContacts(
        principal(req),
        expectedVersion(req),
        contactsSchema.parse(req.body ?? {}),
      );
      setEtag(res, out.version);
      res.json(out);
    }),
    detailsChange: wrap(async (req, res) => {
      const out = await portal.requestDetailsChange(
        principal(req),
        detailsChangeSchema.parse(req.body ?? {}),
      );
      res.status(202).json(out);
    }),

    // --- data and cancellation --------------------------------------------------------------------------
    exports: json((req) => data.exports(principal(req))),
    exportStatus: json((req) => data.exportStatus(principal(req), param(req, 'exportId'))),
    requestExport: wrap(async (req, res) => {
      const out = await data.requestExport(
        principal(req),
        exportRequestSchema.parse(req.body ?? {}),
      );
      res.status(201).json(out);
    }),
    cancellation: json((req) => data.cancellation(principal(req))),
    requestCancellation: wrap(async (req, res) => {
      const out = await data.requestCancellation(
        principal(req),
        cancellationRequestSchema.parse(req.body ?? {}),
      );
      res.status(202).json(out);
    }),
    withdrawCancellation: wrap(async (req, res) => {
      await data.withdrawCancellation(principal(req), param(req, 'requestId'));
      res.status(204).end();
    }),
    declineCancellation: wrap(async (req, res) => {
      await data.declineCancellation(
        principal(req),
        param(req, 'institutionId'),
        declineSchema.parse(req.body ?? {}).reason,
      );
      res.status(204).end();
    }),
  };
}
