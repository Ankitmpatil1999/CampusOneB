import { Router, type Request, type RequestHandler } from 'express';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { defineRoute } from '../config/openapi-registry';
import type { Loggers } from '../controllers/logger';
import { authorize, requireSurface } from '../middlewares/auth.middleware';
import { idempotency } from '../middlewares/idempotency.middleware';
import type { Database } from '../models/campusone_models';
import type { PlatformToolsService } from '../services/platform-tools.service';
import { AuthenticationError } from '../utils/CustomAPIError';
import { expectedVersion, setEtag } from '../utils/etag';

export const languageSchema = z
  .strictObject({
    code: z.string({ message: 'I18N.LANGUAGE_CODE' }).max(12, { message: 'I18N.LANGUAGE_CODE' }),
    name: z.string({ message: 'I18N.LANGUAGE_CODE' }).max(40, { message: 'I18N.LANGUAGE_CODE' }),
    native: z.string({ message: 'I18N.LANGUAGE_CODE' }).max(40, { message: 'I18N.LANGUAGE_CODE' }),
  })
  .meta({ id: 'LanguageInput' });
export const languageEditSchema = z
  .strictObject({ enabled: z.boolean().optional(), isDefault: z.boolean().optional() })
  .meta({ id: 'LanguageEdit' });
export const translationSchema = z
  .strictObject({
    texts: z.record(z.string().max(12), z.string().max(2000, { message: 'I18N.TEXT_LENGTH' })),
    versions: z
      .record(z.string().max(12), z.int().min(0).nullable())
      .describe(
        'Optimistic locking per language: the version read for each edited language (null where it had no text)',
      ),
  })
  .meta({ id: 'TranslationTexts' });
export const channelSchema = z
  .strictObject({ enabled: z.boolean(), templateSet: z.string().max(40).optional() })
  .meta({ id: 'MessagingChannelInput' });

const translationsQuery = z.object({
  screen: z.string().max(40).optional(),
  missingIn: z.string().max(12).optional(),
  q: z.string().max(80).optional(),
  cursor: z.string().max(120).optional(),
});
const logsQuery = z.object({
  user: z.string().max(40).optional(),
  institutionId: z.string().max(40).optional(),
  from: z.string().max(40).optional(),
  to: z.string().max(40).optional(),
  endpoint: z.string().max(120).optional(),
  status: z.string().max(3).optional(),
  correlationId: z.string().max(64).optional(),
  cursor: z.string().max(20).optional(),
});

const doc = (d: Omit<Parameters<typeof defineRoute>[0], 'tags'>) =>
  defineRoute({ ...d, tags: ['Platform'] });
doc({
  id: 'IDN-070',
  method: 'get',
  path: '/api/v1/ops/languages',
  summary:
    'Languages with how many register texts each has reviewed, as machine drafts and missing',
  auth: 'lang.edit',
  responses: { 200: { description: 'Languages' } },
});
doc({
  id: 'IDN-071',
  method: 'post',
  path: '/api/v1/ops/languages',
  summary: 'Add a language (switched off until ready)',
  auth: 'lang.edit',
  request: languageSchema,
  idempotent: 'required',
  responses: { 201: { description: 'Language' } },
});
doc({
  id: 'IDN-072',
  method: 'patch',
  path: '/api/v1/ops/languages/{code}',
  summary:
    'Switch a language on or off, or make it the default (the default stays on); If-Match with the version read',
  auth: 'lang.edit',
  request: languageEditSchema,
  responses: { 200: { description: 'Language' } },
});
doc({
  id: 'IDN-073',
  method: 'get',
  path: '/api/v1/ops/translations',
  summary:
    'Register texts with English and each language’s text (machine draft or reviewed), by screen (key prefix), text, or what a language lacks',
  auth: 'lang.edit',
  query: translationsQuery,
  responses: { 200: { description: 'Translations' } },
});
doc({
  id: 'IDN-074',
  method: 'put',
  path: '/api/v1/ops/translations/{key}',
  summary:
    'Edit a key’s texts per language (marked reviewed) with the version read for each (412 when someone else changed one first); the placeholders must match the English text',
  auth: 'lang.edit',
  request: translationSchema,
  responses: { 200: { description: 'Translation' } },
});
doc({
  id: 'IDN-075',
  method: 'get',
  path: '/api/v1/ops/logs',
  summary:
    'The request log by user, institution, time (up to 31 days), endpoint, status (or 4xx/5xx) and correlation id — never bodies or query values',
  auth: 'logs.query',
  query: logsQuery,
  responses: { 200: { description: 'Log entries' } },
});
doc({
  id: 'IDN-076',
  method: 'get',
  path: '/api/v1/ops/logs/{logId}',
  summary:
    'One request with its query parameter names, problem code and the audit events of the same request',
  auth: 'logs.query',
  responses: { 200: { description: 'Log entry' } },
});
doc({
  id: 'INT-009',
  method: 'get',
  path: '/api/v1/ops/messaging-providers',
  summary:
    'Channels (in-app, SMS, e-mail, WhatsApp, push): the configured provider, test mode, the platform switch and template set',
  auth: 'partners.edit',
  responses: { 200: { description: 'Channels' } },
});
doc({
  id: 'INT-010',
  method: 'put',
  path: '/api/v1/ops/messaging-providers/{channel}',
  summary:
    'Switch a channel on or off and choose its template set; a channel without an integrated provider can’t be switched on; If-Match',
  auth: 'partners.edit',
  request: channelSchema,
  responses: { 200: { description: 'Channel' } },
});

export function platformToolsRoutes(deps: {
  db: Kysely<Database>;
  tools: PlatformToolsService;
  loggers: Loggers;
}): Router {
  const router = Router();
  const L = deps.loggers;
  const ops = requireSurface(L, 'ops');
  const once = idempotency({ db: deps.db, mode: 'required' });
  const lang = authorize('lang.edit', L);
  const logs = authorize('logs.query', L);
  const partners = authorize('partners.edit', L);
  const T = deps.tools;
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
  const param = (req: Request, k: string) => String(req.params[k]);
  const json = (fn: (req: Request) => Promise<unknown>, code = 200): RequestHandler =>
    wrap(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.status(code).json(await fn(req));
    });

  router.get(
    '/ops/languages',
    ops,
    lang,
    json(() => T.languages()),
  );
  router.post(
    '/ops/languages',
    ops,
    lang,
    once,
    json((req) => T.addLanguage(principal(req), languageSchema.parse(req.body ?? {})), 201),
  );
  router.patch(
    '/ops/languages/:code',
    ops,
    lang,
    wrap(async (req, res) => {
      const expected = expectedVersion(req);
      const out = await T.updateLanguage(
        principal(req),
        param(req, 'code'),
        languageEditSchema.parse(req.body ?? {}),
        expected,
      );
      setEtag(res, out.version);
      res.setHeader('Cache-Control', 'no-store');
      res.json(out);
    }),
  );
  router.get(
    '/ops/translations',
    ops,
    lang,
    json((req) => T.translations(translationsQuery.parse(req.query))),
  );
  router.put(
    '/ops/translations/:key',
    ops,
    lang,
    json((req) =>
      T.setTranslation(principal(req), param(req, 'key'), translationSchema.parse(req.body ?? {})),
    ),
  );
  router.get(
    '/ops/logs',
    ops,
    logs,
    json((req) => T.logs(logsQuery.parse(req.query))),
  );
  router.get(
    '/ops/logs/:logId',
    ops,
    logs,
    json((req) => T.log(param(req, 'logId'))),
  );
  router.get(
    '/ops/messaging-providers',
    ops,
    partners,
    json(() => T.channels()),
  );
  router.put(
    '/ops/messaging-providers/:channel',
    ops,
    partners,
    wrap(async (req, res) => {
      const out = await T.setChannel(
        principal(req),
        param(req, 'channel'),
        expectedVersion(req),
        channelSchema.parse(req.body ?? {}),
      );
      setEtag(res, out.version);
      res.json(out);
    }),
  );
  return router;
}
