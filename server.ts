/**
 * API entrypoint (reference server.js shape): configuration → runtime → security → services →
 * app → listen → start-up gate → graceful shutdown.
 */
import { RequestLogStore } from './utils/request-log';
import { RedisStore, type RedisReply } from 'rate-limit-redis';
import type { Redis } from 'ioredis';
import { createApp } from './app';
import { HealthService } from './services/health.service';
import { apiRouters, partnerRouters } from './routes';
import { createRateLimiter } from './middlewares/rate-limit.middleware';
import { createSecurity } from './config/security';
import { buildApiServices } from './config/services';
import { startRealtime } from './services/realtime.service';
import {
  createRuntime,
  installShutdown,
  loadConfigOrExit,
  waitForSchema,
} from './config/bootstrap';

const redisStore = (redis: Redis | undefined, prefix: string) =>
  redis
    ? new RedisStore({
        prefix,
        sendCommand: (command: string, ...args: string[]) =>
          redis.call(command, ...args) as Promise<RedisReply>,
      })
    : undefined;

async function main(): Promise<void> {
  const config = loadConfigOrExit();
  const runtime = createRuntime(config, 'api');
  const { loggers } = runtime;

  const security = await createSecurity(config, loggers, runtime.redis);
  if (config.notify.otpTestShowCode) {
    loggers.app.warn(
      'OTP_TEST_SHOW_CODE is on — one-time codes are returned to the apps (test mode)',
    );
    if (config.nodeEnv === 'production') {
      // Confirmed by OTP_TEST_SHOW_CODE_IN_PRODUCTION (client 2026-10-06): codes protect nothing.
      loggers.security.warn('otp.test_codes_in_production', {
        detail: 'one-time codes are shown on the sign-in screens of a production-mode server',
      });
    }
  }

  const health = new HealthService(runtime.dependencyChecks, {
    timeoutMs: config.health.timeoutMs,
    version: config.version,
    commit: config.commit,
  });

  const authStore = redisStore(runtime.redis, 'rl:auth:');
  const services = buildApiServices({
    db: runtime.database.db,
    config,
    security,
    loggers,
    authLimiter: createRateLimiter({
      name: 'auth',
      windowMs: config.rateLimit.windowMs,
      limit: config.rateLimit.authMax,
      exemptIps: config.rateLimit.exemptIps,
      ...(authStore ? { store: authStore } : {}),
    }),
  });

  const rateLimitStore = redisStore(runtime.redis, 'rl:');
  const sessionRateLimitStore = redisStore(runtime.redis, 'rl:session:');
  const requestLog = new RequestLogStore({ db: runtime.database.db, loggers });
  const app = createApp({
    config,
    loggers,
    metrics: runtime.metrics,
    health,
    tokenVerifier: security.verifier,
    revocations: security.revocations,
    cipher: security.cipher,
    publicJwks: security.publicJwks,
    settings: services.settings,
    ...(rateLimitStore ? { rateLimitStore } : {}),
    ...(sessionRateLimitStore ? { sessionRateLimitStore } : {}),
    apiRouters: apiRouters(services),
    partnerRouters: partnerRouters(services, security),
    requestLog,
  });

  const server = app.listen(config.http.port, config.http.host, () => {
    loggers.app.info('api listening', {
      host: config.http.host,
      port: config.http.port,
      env: config.appEnv,
      version: config.version,
    });
  });
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  // COM-025: socket.io on /realtime, and the outbox relay that feeds it.
  const realtime = startRealtime({
    server,
    db: runtime.database.db,
    verifier: security.verifier,
    revocations: security.revocations,
    loggers,
    corsOrigins: config.http.corsOrigins,
  });

  const stopSchemaWatch = waitForSchema(runtime, () => health.markStarted());

  installShutdown(runtime, async () => {
    stopSchemaWatch();
    await realtime.close();
    await requestLog.close();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeIdleConnections();
    });
  });
}

main().catch((e: unknown) => {
  process.stderr.write(`fatal start-up error: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
