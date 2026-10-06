import { Router } from 'express';
import { defineRoute } from '../config/openapi-registry';
import type { Loggers } from '../controllers/logger';
import { settingsController } from '../controllers/settings.controller';
import { authorize, requireSurface } from '../middlewares/auth.middleware';
import {
  settingChangeSchema,
  settingHistorySchema,
  settingListSchema,
  settingSchema,
} from '../schemas/settings.schema';
import type { SettingsService } from '../services/settings.service';

defineRoute({
  id: 'PLT-012',
  method: 'get',
  path: '/api/v1/ops/settings',
  summary:
    'Platform settings: every limit with its register default, the value in force, the allowed range and the last change',
  tags: ['Platform'],
  auth: 'settings.view',
  responses: { 200: { description: 'Settings', schema: settingListSchema } },
});
defineRoute({
  id: 'PLT-013',
  method: 'put',
  path: '/api/v1/ops/settings/:key',
  summary:
    'Change a setting within its range, or reset it (value null), with a reason; If-Match required; recorded in history and the audit log',
  tags: ['Platform'],
  auth: 'settings.edit',
  request: settingChangeSchema,
  responses: { 200: { description: 'Setting after the change', schema: settingSchema } },
});
defineRoute({
  id: 'PLT-014',
  method: 'get',
  path: '/api/v1/ops/settings/:key/history',
  summary: 'Who changed a setting, when, from what to what, and why',
  tags: ['Platform'],
  auth: 'settings.view',
  responses: { 200: { description: 'Change history', schema: settingHistorySchema } },
});

/** Mounted under /api/v1. Back-office sessions only. */
export function settingsRoutes(service: SettingsService, loggers: Loggers): Router {
  const c = settingsController(service);
  const router = Router();
  const ops = requireSurface(loggers, 'ops');
  router.get('/ops/settings', ops, authorize('settings.view', loggers), c.list);
  router.put('/ops/settings/:key', ops, authorize('settings.edit', loggers), c.change);
  router.get('/ops/settings/:key/history', ops, authorize('settings.view', loggers), c.history);
  return router;
}
