import { Router } from 'express';
import { defineRoute } from '../config/openapi-registry';
import { platformController } from '../controllers/platform.controller';
import { limitsResponseSchema, registersResponseSchema } from '../schemas/platform.schema';
import type { PlatformService } from '../services/platform.service';

defineRoute({
  id: 'PLT-007',
  method: 'get',
  path: '/api/v1/registers',
  summary: 'Status, transition and message registers for clients (cacheable, ETag)',
  tags: ['Platform'],
  auth: 'public',
  responses: {
    200: { description: 'Registers', schema: registersResponseSchema },
    304: { description: 'Not modified' },
  },
});
defineRoute({
  id: 'PLT-008',
  method: 'get',
  path: '/api/v1/config/limits',
  summary: 'Client-side validation limits (the server remains the authority)',
  tags: ['Platform'],
  auth: 'public',
  responses: {
    200: { description: 'Limits', schema: limitsResponseSchema },
    304: { description: 'Not modified' },
  },
});

/** Mounted under /api/v1. */
export function platformRoutes(service: PlatformService): Router {
  const c = platformController(service);
  const router = Router();
  router.get('/registers', c.registers);
  router.get('/config/limits', c.limits);
  return router;
}
