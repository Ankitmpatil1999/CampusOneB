import { Router } from 'express';
import { z } from 'zod';
import { defineRoute } from '../config/openapi-registry';
import type { I18nService } from '../services/i18n.service';
import { i18nController } from '../controllers/i18n.controller';

const bundleSchema = z
  .object({
    lang: z.string(),
    fallback: z.string().describe('Language used for keys without a translation'),
    complete: z.boolean().describe('False while some keys fall back to the default language'),
    machineDraft: z
      .boolean()
      .describe('True while some texts are machine drafts awaiting review (client 2026-10-02)'),
    messages: z.record(z.string(), z.string()),
  })
  .meta({ id: 'TranslationBundle' });

defineRoute({
  id: 'PLT-009',
  method: 'get',
  path: '/api/v1/i18n/:lang',
  summary: 'Translation bundle for an enabled language, with default-language fallback (ETag)',
  tags: ['Platform'],
  auth: 'public',
  responses: {
    200: { description: 'Bundle', schema: bundleSchema },
    304: { description: 'Not modified' },
  },
});

const languagesSchema = z
  .object({
    items: z.array(
      z.object({
        code: z.string(),
        name: z.string(),
        nativeName: z.string(),
        isDefault: z.boolean(),
      }),
    ),
  })
  .meta({ id: 'LanguageList' });

defineRoute({
  id: 'PLT-015',
  method: 'get',
  path: '/api/v1/languages',
  summary: 'Enabled languages in picker order (Kannada next to English; client, Q18)',
  tags: ['Platform'],
  auth: 'public',
  responses: { 200: { description: 'Languages', schema: languagesSchema } },
});

/** Mounted under /api/v1. */
export function i18nRoutes(service: I18nService): Router {
  const c = i18nController(service);
  const router = Router();
  router.get('/languages', c.languages);
  router.get('/i18n/:lang', c.bundle);
  return router;
}
