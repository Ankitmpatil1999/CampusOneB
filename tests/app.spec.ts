import { Router } from 'express';
import request from 'supertest';
import { buildTestApp, healthWith, testKeys, waitForLine } from './helpers';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('health (PLT-001…004)', () => {
  it('live answers without dependency checks', async () => {
    const { app } = await buildTestApp({
      health: healthWith([
        { name: 'mysql', required: true, check: async () => Promise.reject(new Error('down')) },
      ]),
    });
    const res = await request(app).get('/health/live');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('ready is 200 when dependencies are up and 503 when a required one is down', async () => {
    const up = await buildTestApp();
    expect((await request(up.app).get('/health/ready')).status).toBe(200);
    const down = await buildTestApp({
      health: healthWith([
        { name: 'mysql', required: true, check: async () => Promise.reject(new Error('x')) },
      ]),
    });
    const res = await request(down.app).get('/health/ready');
    expect(res.status).toBe(503);
    expect(res.body.checks[0]).toMatchObject({ name: 'mysql', status: 'down', required: true });
  });

  it('startup is 503 until the schema gate passes', async () => {
    const { app } = await buildTestApp({ health: healthWith([], false) });
    const res = await request(app).get('/health/startup');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: 'starting' });
  });

  it('detailed health and metrics are internal-only (404 from outside)', async () => {
    const outside = await buildTestApp({ env: { INTERNAL_ALLOWLIST: '10.9.9.9' } });
    expect((await request(outside.app).get('/health')).status).toBe(404);
    expect((await request(outside.app).get('/metrics')).status).toBe(404);

    const inside = await buildTestApp({ env: { INTERNAL_ALLOWLIST: '127.0.0.1' } });
    const detail = await request(inside.app).get('/health');
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({ version: '1.2.3', commit: 'abc123' });
    const metrics = await request(inside.app).get('/metrics');
    expect(metrics.status).toBe(200);
    expect(metrics.text).toContain('ringpe_http_request_duration_seconds');
  });
});

describe('cross-cutting middleware', () => {
  it('generates a UUIDv7 correlation id and ignores an untrusted inbound one', async () => {
    const { app } = await buildTestApp();
    const res = await request(app)
      .get('/health/live')
      .set('X-Correlation-Id', '11111111-1111-4111-8111-111111111111');
    expect(res.headers['x-correlation-id']).toMatch(UUID);
  });

  it('accepts a valid inbound correlation id from trusted callers', async () => {
    const { app } = await buildTestApp({ env: { TRUST_INBOUND_CORRELATION_ID: 'true' } });
    const id = '0199a8b2-7c3e-7d40-8a1b-3f2e4d5c6b7a';
    const res = await request(app).get('/health/live').set('X-Correlation-Id', id);
    expect(res.headers['x-correlation-id']).toBe(id);
  });

  it('sets security headers and never caches API responses', async () => {
    const { app } = await buildTestApp();
    const res = await request(app).get('/health/live');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('allows listed CORS origins only', async () => {
    const { app } = await buildTestApp();
    const ok = await request(app).get('/health/live').set('Origin', 'https://console.ringpe.test');
    expect(ok.headers['access-control-allow-origin']).toBe('https://console.ringpe.test');
    expect(ok.headers['access-control-allow-credentials']).toBe('true');
    const bad = await request(app).get('/health/live').set('Origin', 'https://evil.example');
    expect(bad.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('errors as problem+json (RFC 9457)', () => {
  it('answers unknown routes with 404 and the correlation id', async () => {
    const { app } = await buildTestApp();
    const res = await request(app).get('/api/v1/agriculture/loans');
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body).toMatchObject({
      type: 'urn:ringpe:problem:gen.route_not_found',
      status: 404,
      code: 'GEN.ROUTE_NOT_FOUND',
      detail: 'This address does not exist.',
      instance: '/api/v1/agriculture/loans',
    });
    expect(res.body.correlationId).toBe(res.headers['x-correlation-id']);
  });

  it('refuses malformed JSON with 400 and never echoes parser internals', async () => {
    const { app } = await buildTestApp();
    const res = await request(app)
      .post('/api/v1/registers')
      .set('Content-Type', 'application/json')
      .send('{"broken":');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('GEN.BAD_REQUEST');
    expect(JSON.stringify(res.body)).not.toMatch(/SyntaxError|Unexpected|stack/i);
  });

  it('refuses a non-JSON body with 415', async () => {
    const { app } = await buildTestApp();
    const res = await request(app)
      .post('/api/v1/registers')
      .set('Content-Type', 'text/plain')
      .send('hello');
    expect(res.status).toBe(415);
    expect(res.body.code).toBe('GEN.UNSUPPORTED_MEDIA_TYPE');
  });

  it('refuses an oversized body with 413', async () => {
    const { app } = await buildTestApp({ env: { JSON_BODY_LIMIT_BYTES: '2048' } });
    const res = await request(app)
      .post('/api/v1/registers')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ blob: 'x'.repeat(5000) }));
    expect(res.status).toBe(413);
    expect(res.body.code).toBe('GEN.PAYLOAD_TOO_LARGE');
  });

  it('turns an unexpected error into a 500 without the stack, and logs the stack', async () => {
    const { Router } = await import('express');
    const boom = Router();
    boom.get('/boom', () => {
      throw new Error('SELECT * FROM secrets WHERE pan = ABCDE1234F');
    });
    const { app, lines } = await buildTestApp({ apiRouters: [boom] });
    const res = await request(app).get('/api/v1/boom');
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({
      code: 'GEN.INTERNAL',
      detail: 'Something went wrong. Please try again.',
    });
    expect(JSON.stringify(res.body)).not.toMatch(/SELECT|secrets|stack/);
    const logged = await waitForLine(lines, (l) => l['message'] === 'unhandled error');
    expect(logged?.['stream']).toBe('app');
    expect(JSON.stringify(logged)).toContain('[PAN]');
    expect(JSON.stringify(logged)).not.toContain('ABCDE1234F');
  });

  it('rate-limits with 429 and Retry-After', async () => {
    const { app } = await buildTestApp({
      env: {
        RATE_LIMIT_GLOBAL_MAX: '2',
        RATE_LIMIT_WINDOW_SECONDS: '30',
        INTERNAL_ALLOWLIST: '10.0.0.1',
      },
    });
    await request(app).get('/health/live');
    await request(app).get('/health/live');
    const res = await request(app).get('/health/live');
    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBe('30');
    expect(res.body.code).toBe('GEN.RATE_LIMITED');
  });

  it('counts signed-in requests per session, so one session cannot slow others on the same address (S-05)', async () => {
    const keys = await testKeys();
    const probe = Router();
    probe.get('/probe/me', (req, res) => {
      res.json({ subject: req.principal?.subject ?? null });
    });
    const { app } = await buildTestApp({
      keys,
      apiRouters: [probe],
      env: { RATE_LIMIT_GLOBAL_MAX: '100', RATE_LIMIT_SESSION_MAX: '2' },
    });
    const a = await keys.sign({ sub: '0199a8b2-0000-7000-8000-00000000000a', sid: 'sa' });
    const b = await keys.sign({ sub: '0199a8b2-0000-7000-8000-00000000000b', sid: 'sb' });
    const call = (token?: string) => {
      const r = request(app).get('/api/v1/probe/me');
      return token ? r.set('Authorization', `Bearer ${token}`) : r;
    };
    expect((await call(a)).status).toBe(200);
    expect((await call(a)).status).toBe(200);
    const third = await call(a);
    expect(third.status).toBe(429);
    expect(third.body.code).toBe('GEN.RATE_LIMITED');
    // Another session from the same address, and anonymous requests, are still served.
    expect((await call(b)).status).toBe(200);
    const anonymous = await call();
    expect(anonymous.status).toBe(200);
    expect(anonymous.body.subject).toBeNull();
  });
});

describe('platform registers and limits (PLT-007, PLT-008)', () => {
  it('serves the registers with a strong ETag and 304 on revalidation', async () => {
    const { app } = await buildTestApp();
    const res = await request(app).get('/api/v1/registers');
    expect(res.status).toBe(200);
    expect(res.headers['etag']).toMatch(/^"[A-Za-z0-9_-]+"$/);
    expect(res.headers['cache-control']).toContain('max-age=300');
    expect(res.body.statuses.map((d: { domain: string }) => d.domain)).toContain('institution');
    expect(res.body.messages.find((m: { key: string }) => m.key === 'GEN.INTERNAL')).toBeTruthy();
    const again = await request(app)
      .get('/api/v1/registers')
      .set('If-None-Match', String(res.headers['etag']));
    expect(again.status).toBe(304);
  });

  it('serves the limits register', async () => {
    const { app } = await buildTestApp();
    const res = await request(app).get('/api/v1/config/limits');
    expect(res.status).toBe(200);
    expect(res.body.limits['file.maxBytes']).toEqual({ value: 2097152, unit: 'bytes' });
    expect(res.body.limits['idn.otp.digits']).toEqual({ value: 4, unit: 'digits' });
  });
});

describe('logging', () => {
  it('writes request and response lines with the correlation id and no query values', async () => {
    const { app, lines } = await buildTestApp();
    const res = await request(app).get('/health/live?mobile=9876543210');
    const id = res.headers['x-correlation-id'];
    // winston writes asynchronously after the response has finished; wait for both lines.
    const { req, resp } = await vi.waitFor(
      () => {
        const found = {
          req: lines.find((l) => l['stream'] === 'request' && l['correlationId'] === id),
          resp: lines.find((l) => l['stream'] === 'response' && l['correlationId'] === id),
        };
        if (!found.req || !found.resp) throw new Error('log lines not written yet');
        return found;
      },
      { timeout: 3000, interval: 20 },
    );
    expect(req).toMatchObject({ method: 'GET', path: '/health/live', queryKeys: ['mobile'] });
    expect(JSON.stringify(req)).not.toContain('9876543210');
    expect(resp).toMatchObject({ status: 200, route: '/health/live' });
  });
});
