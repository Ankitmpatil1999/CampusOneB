import { Router } from 'express';
import { internalOnly } from '../middlewares/internal-only.middleware';
import { defineRoute } from '../config/openapi-registry';
import { healthController } from '../controllers/health.controller';
import type { HealthService } from '../services/health.service';
import {
  detailedResponseSchema,
  liveResponseSchema,
  readyResponseSchema,
  startupResponseSchema,
} from '../schemas/health.schema';

defineRoute({
  id: 'PLT-001',
  method: 'get',
  path: '/health/live',
  summary: 'Liveness — the process is up (no dependency checks)',
  tags: ['Health'],
  auth: 'public',
  responses: { 200: { description: 'Alive', schema: liveResponseSchema } },
});
defineRoute({
  id: 'PLT-002',
  method: 'get',
  path: '/health/ready',
  summary: 'Readiness — MySQL, Redis, object storage and KMS when configured',
  tags: ['Health'],
  auth: 'public',
  responses: {
    200: { description: 'Ready', schema: readyResponseSchema },
    503: { description: 'A required dependency is down', schema: readyResponseSchema },
  },
});
defineRoute({
  id: 'PLT-003',
  method: 'get',
  path: '/health/startup',
  summary: 'Startup — initialisation finished',
  tags: ['Health'],
  auth: 'public',
  responses: {
    200: { description: 'Started', schema: startupResponseSchema },
    503: { description: 'Still starting', schema: startupResponseSchema },
  },
});
defineRoute({
  id: 'PLT-004',
  method: 'get',
  path: '/health',
  summary: 'Detailed health — version, commit, uptime, dependencies (internal network only)',
  tags: ['Health'],
  auth: 'internal',
  responses: {
    200: { description: 'Healthy', schema: detailedResponseSchema },
    503: { description: 'Unhealthy', schema: detailedResponseSchema },
  },
});

export function healthRoutes(health: HealthService, internalAllowlist: readonly string[]): Router {
  const c = healthController(health);
  const router = Router();
  router.get('/health/live', c.live);
  router.get('/health/ready', c.ready);
  router.get('/health/startup', c.startup);
  router.get('/health', internalOnly(internalAllowlist), c.detailed);
  return router;
}
