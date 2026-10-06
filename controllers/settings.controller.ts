import type { RequestHandler } from 'express';
import { settingChangeSchema } from '../schemas/settings.schema';
import type { SettingsService } from '../services/settings.service';
import { AuthenticationError } from '../utils/CustomAPIError';
import { expectedVersion, setEtag } from '../utils/etag';

export function settingsController(service: SettingsService) {
  const list: RequestHandler = async (_req, res, next) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      res.json({ items: await service.list() });
    } catch (e) {
      next(e);
    }
  };

  const change: RequestHandler = async (req, res, next) => {
    try {
      const p = req.principal;
      if (!p) throw new AuthenticationError();
      const body = settingChangeSchema.parse(req.body);
      const view = await service.change(
        String(req.params['key']),
        body.value,
        body.reason,
        p.subject,
        expectedVersion(req),
      );
      setEtag(res, view.version);
      res.json(view);
    } catch (e) {
      next(e);
    }
  };

  const history: RequestHandler = async (req, res, next) => {
    try {
      res.json({ items: await service.history(String(req.params['key'])) });
    } catch (e) {
      next(e);
    }
  };

  return { list, change, history };
}
