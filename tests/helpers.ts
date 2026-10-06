import { Writable } from 'node:stream';
import winston from 'winston';
import { SignJWT, exportJWK, generateKeyPair, type JWK } from 'jose';
import { loadConfig, type Config } from '../config/config';
import { createLoggers, type Loggers } from '../controllers/logger';
import { createMetrics } from '../utils/metrics';
import { HealthService, type DependencyCheck } from '../services/health.service';
import { createApp, type AppDependencies } from '../app';
import { createTokenVerifier } from '../utils/token-verifier';

export const BASE_ENV = {
  NODE_ENV: 'test',
  APP_ENV: 'ci',
  DATABASE_URL: 'mysql://ringpe_app:secret-value@127.0.0.1:3306/ringpe_test',
  CORS_ORIGINS: 'https://console.ringpe.test',
  LOG_LEVEL: 'debug',
} as const;

export function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({ ...BASE_ENV, ...overrides });
}

export interface CapturedLoggers {
  readonly loggers: Loggers;
  readonly lines: Record<string, unknown>[];
}

/** Loggers that write nothing to the console and capture every JSON line for assertions. */
export function capturingLoggers(): CapturedLoggers {
  const lines: Record<string, unknown>[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _enc, cb) {
      for (const l of chunk.toString('utf8').split('\n').filter(Boolean)) {
        lines.push(JSON.parse(l) as Record<string, unknown>);
      }
      cb();
    },
  });
  const loggers = createLoggers({
    level: 'debug',
    retentionDays: 1,
    transport: new winston.transports.Stream({ stream: sink }),
  });
  for (const l of Object.values(loggers)) {
    for (const t of l.transports) if (t instanceof winston.transports.Console) t.silent = true;
  }
  return { loggers, lines };
}

/** Waits (bounded) for a captured log line: winston writes asynchronously after the response. */
export async function waitForLine(
  lines: readonly Record<string, unknown>[],
  predicate: (line: Record<string, unknown>) => boolean,
  timeoutMs = 3000,
): Promise<Record<string, unknown>> {
  return vi.waitFor(
    () => {
      const line = lines.find(predicate);
      if (!line) throw new Error('log line not written yet');
      return line;
    },
    { timeout: timeoutMs, interval: 20 },
  );
}

export function healthWith(checks: DependencyCheck[], started = true): HealthService {
  const h = new HealthService(checks, { timeoutMs: 200, version: '1.2.3', commit: 'abc123' });
  if (started) h.markStarted();
  return h;
}

export interface TestKeys {
  readonly publicJwk: JWK;
  sign(
    claims: Record<string, unknown>,
    opts?: { audience?: string; issuer?: string; expiresIn?: string | number },
  ): Promise<string>;
}

export async function testKeys(): Promise<TestKeys> {
  const { publicKey, privateKey } = await generateKeyPair('ES256');
  const publicJwk = { ...(await exportJWK(publicKey)), kid: 'test-1', alg: 'ES256', use: 'sig' };
  return {
    publicJwk,
    sign: (claims, opts = {}) =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: 'ES256', kid: 'test-1' })
        .setIssuer(opts.issuer ?? 'ringpe')
        .setAudience(opts.audience ?? 'console')
        .setSubject(String(claims['sub'] ?? '0199a8b2-7c3e-7d40-8a1b-3f2e4d5c6b7a'))
        .setIssuedAt()
        .setExpirationTime(opts.expiresIn ?? '15m')
        .sign(privateKey),
  };
}

export async function buildTestApp(
  partial: Partial<AppDependencies> & { keys?: TestKeys; env?: Record<string, string> } = {},
) {
  const captured = capturingLoggers();
  const config = partial.config ?? testConfig(partial.env);
  const app = createApp({
    config,
    loggers: partial.loggers ?? captured.loggers,
    metrics: partial.metrics ?? createMetrics({ defaultMetrics: false }),
    health:
      partial.health ??
      healthWith([{ name: 'mysql', required: true, check: async () => undefined }]),
    ...(partial.keys
      ? {
          tokenVerifier: createTokenVerifier({
            issuer: config.auth.issuer,
            jwks: { keys: [partial.keys.publicJwk] },
          }),
        }
      : {}),
    ...(partial.apiRouters ? { apiRouters: partial.apiRouters } : {}),
  });
  return { app, config, ...captured };
}

/** Security building blocks with in-memory keys (signing, field cipher, revocations). */
export async function testSecurity(issuer = 'ringpe') {
  const { assembleSecurity } = await import('../config/security');
  const { generateKeyFile, keySetFromFile } = await import('../utils/signing-keys');
  const { FieldCipher, generateFieldKeyFile } = await import('../utils/fieldEncryption');
  const { memoryRevocations } = await import('../utils/session-revocations');
  return assembleSecurity({
    issuer,
    keys: await keySetFromFile(await generateKeyFile('test')),
    opsKeys: await keySetFromFile(await generateKeyFile('test-ops')),
    cipher: new FieldCipher(generateFieldKeyFile('ktest')),
    revocations: memoryRevocations(),
  });
}
