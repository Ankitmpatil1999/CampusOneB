/**
 * The one global error handler (brief §7.1, reference errorHandler): every failure becomes RFC 9457
 * problem+json with the correlation id. Stack traces, SQL and library messages are logged
 * server-side only (fixes the legacy defect at 5.7 / OI-GAS-10).
 */
import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { toFieldErrors } from '../utils/validators';
import type { Loggers } from '../controllers/logger';
import { PROBLEM_CONTENT_TYPE, buildProblem } from '../utils/apiResponse';
import {
  BadRequestError,
  CustomAPIError,
  InternalError,
  NotFoundError,
  PayloadTooLargeError,
  UnsupportedMediaTypeError,
  ValidationError,
} from '../utils/CustomAPIError';

interface HttpLibraryError {
  type?: string;
  status?: number;
  statusCode?: number;
  expose?: boolean;
}

/** Maps any thrown value to a typed API error. */
export function toApiError(err: unknown): CustomAPIError {
  if (err instanceof CustomAPIError) return err;
  if (err instanceof ZodError) return new ValidationError(toFieldErrors(err));
  const lib = (typeof err === 'object' && err !== null ? err : {}) as HttpLibraryError;
  switch (lib.type) {
    case 'entity.too.large':
      return new PayloadTooLargeError();
    case 'entity.parse.failed':
    case 'request.aborted':
    case 'request.size.invalid':
      return new BadRequestError();
    case 'encoding.unsupported':
    case 'charset.unsupported':
      return new UnsupportedMediaTypeError();
    default:
      break;
  }
  const status = lib.status ?? lib.statusCode;
  if (status === 400 && lib.expose) return new BadRequestError();
  return new InternalError(err);
}

export function notFound(): RequestHandler {
  return (_req, _res, next) => next(new NotFoundError('GEN.ROUTE_NOT_FOUND'));
}

export function errorHandler(loggers: Loggers): ErrorRequestHandler {
  return (err, req, res, next) => {
    const apiError = toApiError(err);
    if (apiError.statusCode >= 500) {
      loggers.app.error('unhandled error', {
        error:
          err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : err,
        method: req.method,
        path: req.path,
      });
    } else if (apiError.statusCode === 401 || apiError.statusCode === 403) {
      loggers.security.info('access.refused', {
        status: apiError.statusCode,
        code: apiError.code,
        method: req.method,
        path: req.path,
        ip: req.ip,
      });
    }
    res.locals['problemCode'] = apiError.code;
    if (res.headersSent) {
      next(err);
      return;
    }
    const problem = buildProblem({
      status: apiError.statusCode,
      code: apiError.code,
      correlationId: req.correlationId,
      params: apiError.params,
      errors: apiError.errors,
      instance: req.originalUrl.split('?')[0],
      extensions: apiError.extensions,
    });
    for (const [k, v] of Object.entries(apiError.headers)) res.setHeader(k, v);
    res.status(apiError.statusCode).type(PROBLEM_CONTENT_TYPE).send(JSON.stringify(problem));
  };
}
