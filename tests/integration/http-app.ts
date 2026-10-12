/**
 * The full API on a throwaway database, assembled exactly as the server does (config/services.ts),
 * with in-memory storage, a no-op scanner and captured SMS / e-mail.
 */
import { Readable } from 'node:stream';
import { createApp } from '../../app';
import { apiRouters, partnerRouters } from '../../routes';
import { buildApiServices, type ServiceOverrides } from '../../config/services';
import { createRateLimiter } from '../../middlewares/rate-limit.middleware';
import type { MessageSender, OutboundMessage } from '../../integrations/sms.provider';
import type { StorageProvider } from '../../integrations/storage.provider';
import { createMetrics } from '../../utils/metrics';
import { capturingLoggers, healthWith, testConfig, testSecurity } from '../helpers';
import type { TestDatabase } from './db';

export function memoryStorage(): StorageProvider & { objects: Map<string, Buffer> } {
  const objects = new Map<string, Buffer>();
  return {
    objects,
    async put(k, d) {
      objects.set(k, d);
    },
    read(k) {
      return Readable.from(objects.get(k) ?? Buffer.alloc(0));
    },
    async remove(k) {
      objects.delete(k);
    },
  };
}

export function captureSender(
  channel: 'sms' | 'email',
): MessageSender & { sent: OutboundMessage[] } {
  const sent: OutboundMessage[] = [];
  return { channel, sent, send: async (m) => void sent.push(m) };
}

/** The code inside a captured SMS ("Your Verification code is 1234, valid for …"). */
export const codeOf = (m: OutboundMessage | undefined) =>
  /code is (\d{4,6}),/.exec(m?.text ?? '')?.[1] ?? '';

export async function buildHttpApp(
  t: TestDatabase,
  opts: {
    env?: Record<string, string>;
    overrides?: ServiceOverrides;
    /** Another app on the same keys (tokens from one are valid in the other). */
    security?: Awaited<ReturnType<typeof testSecurity>>;
  } = {},
) {
  const security = opts.security ?? (await testSecurity());
  const { loggers, lines } = capturingLoggers();
  const config = testConfig(opts.env);
  const storage = memoryStorage();
  const sms = captureSender('sms');
  const email = captureSender('email');
  const services = buildApiServices({
    db: t.db,
    config,
    security,
    loggers,
    authLimiter: createRateLimiter({ name: 'auth', windowMs: 60_000, limit: 1000 }),
    overrides: {
      storage,
      scanner: { mode: 'skip', scan: async () => 'CLEAN' },
      sms,
      email,
      // School gateways never reach the network in tests (a test that needs one passes its own).
      schoolGateway: () => ({
        mode: 'live',
        createOrder: async () => null,
        verify: () => false,
        checkCredentials: async () => ({ ok: false, note: 'Not checked in tests' }),
      }),
      ...opts.overrides,
    },
  });
  const app = createApp({
    config,
    loggers,
    metrics: createMetrics({ defaultMetrics: false }),
    health: healthWith([]),
    tokenVerifier: security.verifier,
    revocations: security.revocations,
    cipher: security.cipher,
    publicJwks: security.publicJwks,
    settings: services.settings,
    apiRouters: apiRouters(services),
    partnerRouters: partnerRouters(services, security),
  });
  return { app, security, services, storage, sms, email, lines, config };
}
