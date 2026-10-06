import { Router } from 'express';
import { defineRoute } from '../config/openapi-registry';
import { fileController, singleFileUpload, uploadErrors } from '../controllers/file.controller';
import { requireAuth } from '../middlewares/auth.middleware';
import { signedUrlSchema, storedFileSchema, uploadFormSchema } from '../schemas/file.schema';
import type { FileService } from '../services/file.service';

defineRoute({
  id: 'PLT-010',
  method: 'post',
  path: '/api/v1/files',
  summary:
    'Upload one file (multipart: purpose + file). 2 MB at most, type checked from the content, virus-scanned, private (CR-07).',
  tags: ['Files'],
  auth: 'session',
  request: uploadFormSchema,
  requestContentType: 'multipart/form-data',
  responses: { 201: { description: 'Stored', schema: storedFileSchema } },
});
defineRoute({
  id: 'PLT-011',
  method: 'get',
  path: '/api/v1/files/:fileId/url',
  summary:
    "Short-lived signed download link for a file of the caller's institution (or their own upload). Another tenant's file answers 404.",
  tags: ['Files'],
  auth: 'session',
  responses: { 200: { description: 'Signed link', schema: signedUrlSchema } },
});
defineRoute({
  id: 'PLT-011',
  method: 'get',
  path: '/api/v1/files/:fileId/content',
  summary: 'Download through a signed link (the link is the permission; it expires).',
  tags: ['Files'],
  auth: 'public',
  operationSuffix: 'content',
  responses: {
    200: { description: 'File content', contentType: 'application/octet-stream' },
  },
});

/** Mounted under /api/v1. */
export function fileRoutes(service: FileService): Router {
  const c = fileController(service);
  const router = Router();
  router.post('/files', requireAuth(), singleFileUpload, uploadErrors, c.upload);
  router.get('/files/:fileId/url', requireAuth(), c.signedUrl);
  router.get('/files/:fileId/content', c.content);
  return router;
}
