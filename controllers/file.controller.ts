import type { ErrorRequestHandler, RequestHandler } from 'express';
import multer from 'multer';
import { LIMITS } from '../config/registers';
import { purposeSchema } from '../schemas/file.schema';
import { formatSize, type FileService } from '../services/file.service';
import {
  AuthenticationError,
  BadRequestError,
  CustomAPIError,
  ValidationError,
} from '../utils/CustomAPIError';

const MAX_BYTES = LIMITS.fileMaxBytes.value;

/** Multipart parser: one file, 2 MB, kept in memory only until it is checked and stored. */
export const singleFileUpload: RequestHandler = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: 1, fields: 4, fieldSize: 1024 },
}).single('file');

/** Maps multer's errors to registered messages (the size refusal names the CR-07 limit). */
export const uploadErrors: ErrorRequestHandler = (err, req, _res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return next(
        new CustomAPIError(413, 'FILE.TOO_LARGE', { params: { limit: formatSize(MAX_BYTES) } }),
      );
    }
    return next(new BadRequestError());
  }
  next(err);
};

export function fileController(service: FileService) {
  const upload: RequestHandler = async (req, res, next) => {
    try {
      const p = req.principal;
      if (!p) throw new AuthenticationError();
      const purpose = purposeSchema.safeParse(
        (req.body as Record<string, unknown> | undefined)?.['purpose'],
      );
      if (!purpose.success) {
        throw new ValidationError([{ field: 'purpose', code: 'VALIDATION.FORMAT' }]);
      }
      if (!req.file) throw new ValidationError([{ field: 'file', code: 'VALIDATION.REQUIRED' }]);
      const stored = await service.upload({
        principal: p,
        purpose: purpose.data,
        originalName: req.file.originalname,
        data: req.file.buffer,
      });
      res.status(201).json(stored);
    } catch (e) {
      next(e);
    }
  };

  const signedUrl: RequestHandler = async (req, res, next) => {
    try {
      const p = req.principal;
      if (!p) throw new AuthenticationError();
      res.setHeader('Cache-Control', 'no-store');
      res.json(await service.signedUrl(p, String(req.params['fileId'])));
    } catch (e) {
      next(e);
    }
  };

  const content: RequestHandler = async (req, res, next) => {
    try {
      const q = req.query as Record<string, unknown>;
      const f = await service.open(
        String(req.params['fileId']),
        typeof q['exp'] === 'string' ? q['exp'] : undefined,
        typeof q['sig'] === 'string' ? q['sig'] : undefined,
      );
      res.setHeader('Content-Type', f.mimeType);
      res.setHeader('Content-Length', String(f.size));
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`,
      );
      f.stream.on('error', next).pipe(res);
    } catch (e) {
      next(e);
    }
  };

  return { upload, signedUrl, content };
}
