/**
 * Express application in the reference middleware order (docs/00 §2.3), testable without
 * listening: correlation id → request/response loggers → security headers → CORS → body →
 * cookies → rate limiter → health → well-known keys → API (authenticate → CSRF → routes) → 404 →
 * error handler.
 */
import express, { type Express, type RequestHandler, type Router } from 'express';
import cookieParser from 'cookie-parser';
import type { Store } from 'express-rate-limit';
import type { Config } from './config/config';
import type { Loggers } from './controllers/logger';
import type { Metrics } from './utils/metrics';
import { useSecureCookies } from './utils/cookies';
import type { HealthService } from './services/health.service';
import type { JSONWebKeySet } from 'jose';
import type { TokenVerifier } from './utils/token-verifier';
import type { SessionRevocations } from './utils/session-revocations';
import type { FieldCipher } from './utils/fieldEncryption';
import type { LimitValuesSource } from './services/platform.service';
import { healthRoutes } from './routes/health.routes';
import { platformRoutes } from './routes/platform.routes';
import { wellKnownRoutes } from './routes/wellknown.routes';
import { platformService } from './services/platform.service';
import { defineRoute } from './config/openapi-registry';
import { correlationId } from './middlewares/correlation-id.middleware';
import { requestLogger } from './middlewares/request-logger.middleware';
import type { RequestLogStore } from './utils/request-log';
import { securityHeaders } from './middlewares/security-headers.middleware';
import { corsPolicy } from './middlewares/cors.middleware';
import { jsonBody, requireJsonBody } from './middlewares/body.middleware';
import { AXIS_BANK_PREFIXES } from './routes/axis-bank.routes';
import { webAppRoutes } from './middlewares/web-app.middleware';
import { createRateLimiter } from './middlewares/rate-limit.middleware';
import { authenticate } from './middlewares/auth.middleware';
import { csrfProtection } from './middlewares/csrf.middleware';
import { internalOnly } from './middlewares/internal-only.middleware';
import { errorHandler, notFound } from './middlewares/error-handler.middleware';

defineRoute({
  id: 'PLT-005',
  method: 'get',
  path: '/metrics',
  summary: 'Prometheus metrics (internal network only)',
  tags: ['Health'],
  auth: 'internal',
  responses: { 200: { description: 'Prometheus text exposition', contentType: 'text/plain' } },
});

export interface AppDependencies {
  readonly config: Config;
  readonly loggers: Loggers;
  readonly metrics: Metrics;
  readonly health: HealthService;
  readonly tokenVerifier?: TokenVerifier;
  /** Ended sessions whose access tokens must stop at once (sign-out, reuse, deactivation). */
  readonly revocations?: SessionRevocations;
  /** Field cipher: also derives the CSRF secret for cookie sessions. */
  readonly cipher?: FieldCipher;
  /** Public signing keys served at /.well-known/jwks.json (PLT-006). */
  readonly publicJwks?: JSONWebKeySet;
  /** Limit values in force (platform settings) for PLT-008. */
  readonly settings?: LimitValuesSource;
  readonly rateLimitStore?: Store;
  /** A separate store for the per-session limiter (a store serves one limiter). */
  readonly sessionRateLimitStore?: Store;
  /** The log analyser's request log (IDN-075); absent in most tests. */
  readonly requestLog?: RequestLogStore;
  /**
   * Routers that check their own credentials and answer in a partner's own format (the Axis Bank),
   * mounted before the /api/v1 router and its authentication.
   */
  readonly partnerRouters?: readonly Router[];
  /** Extra routers mounted under /api/v1 after the platform routes (modules; tests). */
  readonly apiRouters?: readonly Router[];
}

export function createApp(deps: AppDependencies): Express {
  const { config, loggers, metrics, health } = deps;
  const app = express();
  app.disable('x-powered-by');
  app.set('etag', false);
  app.set('trust proxy', config.http.trustProxy);

  app.use(correlationId({ trustInbound: config.http.trustInboundCorrelationId }));
  app.use(requestLogger(loggers, metrics, deps.requestLog));
  // The built web application on the same address (WEB_ROOT), with its own page headers.
  if (config.http.webRoot) {
    app.use(
      webAppRoutes({ root: config.http.webRoot, production: config.nodeEnv === 'production' }),
    );
  }
  app.use(securityHeaders({ production: config.nodeEnv === 'production' }));
  app.use(corsPolicy(config.http.corsOrigins));
  const body = {
    jsonLimitBytes: config.http.jsonBodyLimitBytes,
    multipartPrefixes: [
      '/api/v1/files',
      '/api/v1/console/members/uploads',
      '/api/v1/console/fee-records/uploads',
      '/api/v1/ops/recon/statement-uploads',
      '/api/v1/ops/quiz/staging-uploads',
      '/api/v1/console/calendar-events/uploads',
      '/api/v1/console/classes/uploads',
      '/api/v1/console/teacher-assignments/uploads',
      '/api/v1/console/timetables/uploads',
      '/api/v1/console/applications',
      '/api/v1/public/admissions/applications/',
    ],
    formPrefixes: AXIS_BANK_PREFIXES,
  };
  app.use(requireJsonBody(body));
  app.use(jsonBody(body));
  useSecureCookies(config.http.secureCookies);
  app.use(cookieParser());
  app.use(
    createRateLimiter({
      name: 'global',
      windowMs: config.rateLimit.windowMs,
      limit: config.rateLimit.globalMax,
      exemptIps: [...config.rateLimit.exemptIps, ...config.http.internalAllowlist],
      ...(deps.rateLimitStore ? { store: deps.rateLimitStore } : {}),
    }),
  );

  app.use(healthRoutes(health, config.http.internalAllowlist));
  const metricsHandler: RequestHandler = async (_req, res) => {
    res.type(metrics.registry.contentType).send(await metrics.registry.metrics());
  };
  app.get('/metrics', internalOnly(config.http.internalAllowlist), metricsHandler);

  if (deps.publicJwks) app.use(wellKnownRoutes(deps.publicJwks));

  for (const r of deps.partnerRouters ?? []) app.use(r);

  const api = express.Router();
  api.use(authenticate(deps.tokenVerifier, loggers, deps.revocations));
  // Signed-in requests are counted per session as well, so one school's shared address isn't the
  // only measure (S-05); anonymous requests are counted per address above.
  api.use(
    createRateLimiter({
      name: 'session',
      windowMs: config.rateLimit.windowMs,
      limit: config.rateLimit.sessionMax,
      exemptIps: [...config.rateLimit.exemptIps, ...config.http.internalAllowlist],
      keyGenerator: (req) => `${req.principal?.surface}:${req.principal?.subject}`,
      skip: (req) => !req.principal,
      ...(deps.sessionRateLimitStore ? { store: deps.sessionRateLimitStore } : {}),
    }),
  );
  if (deps.cipher) api.use(csrfProtection(deps.cipher, loggers));
  api.use(platformRoutes(platformService(deps.settings)));
  for (const r of deps.apiRouters ?? []) api.use(r);
  app.use('/api/v1', api);

  app.use(notFound());
  app.use(errorHandler(loggers));
  return app;
}
