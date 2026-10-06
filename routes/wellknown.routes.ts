import { Router } from 'express';
import type { JSONWebKeySet } from 'jose';
import { defineRoute } from '../config/openapi-registry';
import { jwksSchema } from '../schemas/auth.schema';

defineRoute({
  id: 'PLT-006',
  method: 'get',
  path: '/.well-known/jwks.json',
  summary:
    'Public ES256 keys that verify RingPe access tokens (kid rotation; FR-INT-05). Back-office keys are not published.',
  tags: ['Platform'],
  auth: 'public',
  responses: { 200: { description: 'JSON Web Key Set', schema: jwksSchema } },
});

/** Mounted at the root (outside /api/v1). */
export function wellKnownRoutes(publicJwks: JSONWebKeySet): Router {
  const router = Router();
  const body = JSON.stringify(publicJwks);
  router.get('/.well-known/jwks.json', (_req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.type('application/json').send(body);
  });
  return router;
}
