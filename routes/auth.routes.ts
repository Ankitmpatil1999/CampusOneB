import { Router, type RequestHandler } from 'express';
import { defineRoute } from '../config/openapi-registry';
import { authController } from '../controllers/auth.controller';
import type { Loggers } from '../controllers/logger';
import { refreshRequestSchema, sessionTokensSchema } from '../schemas/auth.schema';
import type { SessionService } from '../services/session.service';
import type { FieldCipher } from '../utils/fieldEncryption';

defineRoute({
  id: 'IDN-008',
  method: 'post',
  path: '/api/v1/auth/token/refresh',
  summary:
    'Rotate the refresh token and issue a new access token. Member app: token in the body. Web: refresh cookie + X-RingPe-Surface + X-CSRF-Token. Reusing an old token ends the session.',
  tags: ['Auth'],
  auth: 'public',
  request: refreshRequestSchema,
  responses: { 200: { description: 'New tokens', schema: sessionTokensSchema } },
});
defineRoute({
  id: 'IDN-009',
  method: 'post',
  path: '/api/v1/auth/signout',
  summary: 'End the current session on this surface (cookies cleared for web sessions)',
  tags: ['Auth'],
  auth: 'session',
  responses: { 204: { description: 'Signed out' } },
});

/** Mounted under /api/v1. `authLimiter` is the stricter rate limit for authentication routes. */
export function authRoutes(deps: {
  sessions: SessionService;
  cipher: FieldCipher;
  loggers: Loggers;
  authLimiter: RequestHandler;
}): Router {
  const c = authController(deps);
  const router = Router();
  router.post('/auth/token/refresh', deps.authLimiter, c.refresh);
  router.post('/auth/signout', c.signout);
  return router;
}
