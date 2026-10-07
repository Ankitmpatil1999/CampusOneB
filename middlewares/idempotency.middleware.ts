/**
 * `Idempotency-Key` on money and create requests (brief §7.4, RNG-GOV-015). The key is scoped to
 * the tenant and the caller. The first request runs; a repeat with the same body replays the stored
 * response (`Idempotent-Replayed: true`); a repeat with a different body is refused (422); a
 * repeat while the first is still running is refused (409). 5xx responses are not stored, so the
 * client can retry. Records expire after 24 hours (limits register).
 */
import { createHash } from 'node:crypto';
import type { RequestHandler } from 'express';
import type { Kysely } from 'kysely';
import { LIMITS } from '../config/registers';
import type { Database } from '../models/ringpe_models';
import {
  idempotencyRepository,
  type IdempotencyKeyRef,
} from '../repositories/idempotency.repository';
import { ConflictError, CustomAPIError } from '../utils/CustomAPIError';
import { NIL_UUID_BIN, isUuid, uuidToBin } from '../utils/idGenerator';

export const IDEMPOTENCY_HEADER = 'Idempotency-Key';
const KEY_PATTERN = /^[A-Za-z0-9_.:-]{8,100}$/;

/** Canonical JSON (sorted keys) so key order does not change the request hash. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export interface IdempotencyOptions {
  readonly db: Kysely<Database>;
  /** `required`: refuse without the header (428); `optional`: protect only when it is sent. */
  readonly mode: 'required' | 'optional';
  readonly now?: () => Date;
}

export function idempotency(opts: IdempotencyOptions): RequestHandler {
  const now = opts.now ?? (() => new Date());
  return async (req, res, next) => {
    try {
      const key = req.get(IDEMPOTENCY_HEADER);
      if (key === undefined) {
        if (opts.mode === 'required') throw new CustomAPIError(428, 'GEN.IDEMPOTENCY_KEY_REQUIRED');
        return next();
      }
      if (!KEY_PATTERN.test(key)) {
        throw new CustomAPIError(400, 'GEN.BAD_REQUEST', {
          errors: [{ field: IDEMPOTENCY_HEADER, code: 'VALIDATION.FORMAT' }],
        });
      }
      const p = req.principal;
      const ipHash = createHash('sha256')
        .update(req.ip ?? '')
        .digest('hex')
        .slice(0, 32);
      const ref: IdempotencyKeyRef = {
        scopeKey: p ? (p.institutionId ?? `platform:${p.surface}`) : `public:${ipHash}`,
        principalRef: p && isUuid(p.subject) ? uuidToBin(p.subject) : NIL_UUID_BIN,
        key,
      };
      const route = `${req.baseUrl}${req.route?.path ?? req.path}`;
      const requestHash = createHash('sha256')
        .update(`${req.method}\n${route}\n${canonicalJson(req.body)}`)
        .digest('hex');
      const t = now();
      const first = await idempotencyRepository.claim(opts.db, ref, {
        method: req.method,
        route,
        requestHash,
        expiresAt: new Date(t.getTime() + LIMITS.idempotencyTtlHours.value * 3_600_000),
        now: t,
      });
      if (!first) {
        const existing = await idempotencyRepository.find(opts.db, ref);
        if (!existing || existing.request_hash !== requestHash || existing.method !== req.method) {
          throw new CustomAPIError(422, 'GEN.IDEMPOTENCY_KEY_REUSED');
        }
        if (existing.status !== 'COMPLETED' || existing.response_status === null) {
          throw new ConflictError('GEN.IDEMPOTENCY_IN_PROGRESS');
        }
        res.setHeader('Idempotent-Replayed', 'true');
        const body = existing.response_body;
        if (body === null || body === undefined) {
          res.status(existing.response_status).end();
        } else {
          res
            .status(existing.response_status)
            .type('application/json')
            .send(typeof body === 'string' ? body : JSON.stringify(body));
        }
        return;
      }

      // Capture the response this request produces and store it for replays.
      const send = res.send.bind(res);
      let stored = false;
      res.send = (payload?: unknown) => {
        if (!stored) {
          stored = true;
          const status = res.statusCode;
          const text =
            payload === undefined || payload === null
              ? null
              : Buffer.isBuffer(payload)
                ? payload.toString('utf8')
                : typeof payload === 'string'
                  ? payload
                  : JSON.stringify(payload);
          const done =
            status >= 500
              ? idempotencyRepository.release(opts.db, ref)
              : idempotencyRepository.complete(opts.db, ref, {
                  status,
                  body:
                    text !== null && isJson(text)
                      ? omit(text, res.locals['idempotencyOmit'] as unknown)
                      : null,
                });
          done.catch(() => undefined);
        }
        return send(payload);
      };
      res.on('close', () => {
        if (!stored) idempotencyRepository.release(opts.db, ref).catch(() => undefined);
      });
      next();
    } catch (e) {
      next(e);
    }
  };
}

/**
 * Leaves one-time values (a temporary password shown once) out of the stored copy: the handler
 * names them as dot paths in `res.locals.idempotencyOmit`.
 */
export function omit(text: string, paths: unknown): string {
  if (!Array.isArray(paths) || !paths.length) return text;
  const body = JSON.parse(text) as unknown;
  for (const path of paths) {
    if (typeof path !== 'string') continue;
    const keys = path.split('.');
    let at: unknown = body;
    for (const k of keys.slice(0, -1)) {
      at = at && typeof at === 'object' ? (at as Record<string, unknown>)[k] : undefined;
    }
    if (at && typeof at === 'object') delete (at as Record<string, unknown>)[keys.at(-1)!];
  }
  return JSON.stringify(body);
}

const isJson = (s: string) => {
  try {
    JSON.parse(s);
    return true;
  } catch {
    return false;
  }
};
