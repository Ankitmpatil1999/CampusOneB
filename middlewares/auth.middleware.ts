/**
 * Authentication and authorisation (golden rules): server-side on every route, role → task →
 * sub-task, deny by default; the tenant comes from the session only.
 */
import type { Request, RequestHandler } from 'express';
import type { Loggers } from '../controllers/logger';
import { updateContext } from '../utils/request-context';
import { InvalidTokenError, type TokenVerifier } from '../utils/token-verifier';
import { AuthenticationError, AuthorizationError } from '../utils/CustomAPIError';
import { cookieNames, cookieSurfaceOf, readCookie } from '../utils/cookies';
import type { SessionRevocations } from '../utils/session-revocations';
import type { Surface } from '../utils/principal';

interface PresentedToken {
  readonly token: string;
  readonly via: 'bearer' | 'cookie';
  /** For cookies: the surface whose cookie carried the token. */
  readonly surface?: string;
}

function tokenFrom(req: Request): PresentedToken | undefined {
  const header = req.get('authorization');
  if (header) {
    const m = /^Bearer ([A-Za-z0-9._~+/=-]+)$/.exec(header);
    return m?.[1] ? { token: m[1], via: 'bearer' } : undefined;
  }
  const surface = cookieSurfaceOf(req);
  if (!surface) return undefined;
  const token = readCookie(req, cookieNames(surface).access);
  return token ? { token, via: 'cookie', surface } : undefined;
}

/**
 * Verifies a presented token and attaches the principal. A missing token leaves the request
 * anonymous (routes then decide); an invalid, ended or misplaced token is refused outright.
 */
export function authenticate(
  verifier: TokenVerifier | undefined,
  loggers: Loggers,
  revocations?: SessionRevocations,
): RequestHandler {
  return async (req, _res, next) => {
    const presented = tokenFrom(req);
    if (!presented) return next();
    if (!verifier) {
      loggers.security.warn('auth.token_unverifiable', { reason: 'no verifier configured' });
      return next(new AuthenticationError());
    }
    try {
      const principal = await verifier.verify(presented.token);
      if (presented.via === 'cookie' && principal.surface !== presented.surface) {
        throw new InvalidTokenError('cookie_surface_mismatch');
      }
      if (revocations && (await revocations.isRevoked(principal.sessionId))) {
        throw new InvalidTokenError('session_ended');
      }
      req.principal = principal;
      req.authVia = presented.via;
      updateContext({
        actorId: principal.subject,
        actorType: principal.surface,
        ...(principal.institutionId ? { institutionId: principal.institutionId } : {}),
      });
      next();
    } catch (e) {
      loggers.security.warn('auth.token_rejected', {
        reason: e instanceof InvalidTokenError ? e.message : 'error',
        path: req.path,
        ip: req.ip,
      });
      next(new AuthenticationError());
    }
  };
}

export function requireAuth(): RequestHandler {
  return (req, _res, next) => next(req.principal ? undefined : new AuthenticationError());
}

/** Allows the request only when the principal holds the sub-task (`task.subtask`). */
export function authorize(subTask: string, loggers: Loggers): RequestHandler {
  if (!/^[a-z0-9-]+\.[a-z0-9-]+$/.test(subTask)) {
    throw new Error(`Invalid sub-task name ${subTask}`);
  }
  return (req, _res, next) => {
    const p = req.principal;
    if (!p) return next(new AuthenticationError());
    if (p.subTasks.includes(subTask)) return next();
    loggers.security.warn('authz.denied', { subTask, surface: p.surface, path: req.path });
    next(new AuthorizationError());
  };
}

/**
 * Allows the request when the principal holds any of the sub-tasks — for read-only look-ups another
 * module's screens need (e.g. the counsellor's admissions screens read classes and user types).
 * Documented as `a.view,b.view` (the role matrix checks every alternative).
 */
export function authorizeAny(subTasks: readonly string[], loggers: Loggers): RequestHandler {
  for (const s of subTasks) {
    if (!/^[a-z0-9-]+\.[a-z0-9-]+$/.test(s)) throw new Error(`Invalid sub-task name ${s}`);
  }
  return (req, _res, next) => {
    const p = req.principal;
    if (!p) return next(new AuthenticationError());
    if (subTasks.some((s) => p.subTasks.includes(s))) return next();
    loggers.security.warn('authz.denied', {
      subTask: subTasks.join(','),
      surface: p.surface,
      path: req.path,
    });
    next(new AuthorizationError());
  };
}

/**
 * A teacher's routes (`/api/v1/teacher/…`): the app's member session, or a console session holding
 * the route's `teaching.*` sub-task (teachers on the web, Phase 10). Either way the route finds the
 * teacher from the session's own profile and checks their assignments.
 */
export function teacherAccess(subTask: string, loggers: Loggers): RequestHandler {
  if (!/^teaching\.[a-z]+$/.test(subTask)) throw new Error(`Invalid teaching sub-task ${subTask}`);
  return memberOrConsole([subTask], loggers);
}

/**
 * A route of the app that the web opens too (teachers, Phase 10; the principal, merchants and vendor
 * merchants, client 2026-10-13): the app's member session, or a console session holding any of the
 * sub-tasks. Either way the route finds the person from the session's own profile. Documented as
 * `member|a.view,b.view`.
 */
export function memberOrConsole(subTasks: readonly string[], loggers: Loggers): RequestHandler {
  for (const s of subTasks) {
    if (!/^[a-z0-9-]+\.[a-z0-9-]+$/.test(s)) throw new Error(`Invalid sub-task name ${s}`);
  }
  return (req, _res, next) => {
    const p = req.principal;
    if (!p) return next(new AuthenticationError());
    if (p.surface === 'member') return next();
    if (p.surface === 'console' && p.institutionId && subTasks.some((s) => p.subTasks.includes(s)))
      return next();
    loggers.security.warn('authz.denied', {
      subTask: subTasks.join(','),
      surface: p.surface,
      path: req.path,
    });
    next(new AuthorizationError());
  };
}

/** Tenant-scoped routes: the session must carry an institution; nothing is read from the request. */
export function requireTenant(loggers: Loggers): RequestHandler {
  return (req, _res, next) => {
    const p = req.principal;
    if (!p) return next(new AuthenticationError());
    if (!p.institutionId) {
      loggers.security.warn('tenant.missing', { surface: p.surface, path: req.path });
      return next(new AuthorizationError());
    }
    next();
  };
}

/** Only sessions of the given surfaces (e.g. back-office routes accept `ops` sessions only). */
export function requireSurface(loggers: Loggers, ...surfaces: Surface[]): RequestHandler {
  return (req, _res, next) => {
    const p = req.principal;
    if (!p) return next(new AuthenticationError());
    if (surfaces.includes(p.surface)) return next();
    loggers.security.warn('authz.wrong_surface', { surface: p.surface, path: req.path });
    next(new AuthorizationError());
  };
}
