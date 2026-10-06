import type { RequestHandler } from 'express';
import type { I18nService } from '../services/i18n.service';
import { NotFoundError } from '../utils/CustomAPIError';

export function i18nController(service: I18nService) {
  const bundle: RequestHandler = async (req, res, next) => {
    try {
      const lang = String(req.params['lang'] ?? '');
      const found = /^[a-z]{2,3}(-[A-Z]{2})?$/.test(lang) ? await service.bundle(lang) : undefined;
      if (!found) throw new NotFoundError();
      res.setHeader('ETag', found.etag);
      res.setHeader('Cache-Control', 'public, max-age=300, must-revalidate');
      if (req.get('if-none-match') === found.etag) {
        res.status(304).end();
        return;
      }
      res.type('application/json').send(found.body);
    } catch (e) {
      next(e);
    }
  };
  const languages: RequestHandler = async (_req, res, next) => {
    try {
      res.setHeader('Cache-Control', 'public, max-age=300');
      res.json({ items: await service.languages() });
    } catch (e) {
      next(e);
    }
  };

  return { bundle, languages };
}
