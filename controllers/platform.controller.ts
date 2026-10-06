import type { RequestHandler } from 'express';
import type { CachedDocument, PlatformService } from '../services/platform.service';

/** Sends a cacheable JSON document with a strong ETag; answers 304 on a matching If-None-Match. */
function sendCached(load: () => Promise<CachedDocument>): RequestHandler {
  return async (req, res, next) => {
    try {
      const doc = await load();
      res.setHeader('ETag', doc.etag);
      res.setHeader('Cache-Control', 'public, max-age=300, must-revalidate');
      if (req.get('if-none-match') === doc.etag) {
        res.status(304).end();
        return;
      }
      res.type('application/json').send(doc.body);
    } catch (e) {
      next(e);
    }
  };
}

export function platformController(service: PlatformService) {
  return {
    registers: sendCached(service.registers),
    limits: sendCached(service.limits),
  };
}
