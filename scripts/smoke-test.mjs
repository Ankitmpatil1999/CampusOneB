// Smoke test of the built API bundle (Phase 1): start dist/server.js, probe the health
// endpoints, then stop it with SIGTERM and check it exits cleanly. Exits non-zero on any mismatch.
// Usage: npm run test:smoke [-- true]   (true = expect "ready", i.e. MySQL reachable)
import { spawn } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';

const port = 3999;
const expectReady = process.argv[2] === 'true';
const env = {
  ...process.env,
  NODE_ENV: 'development',
  APP_ENV: 'local',
  HTTP_PORT: String(port),
  HTTP_HOST: '127.0.0.1',
  LOG_LEVEL: 'warn',
  DATABASE_URL: process.env.DATABASE_URL ?? 'mysql://smoke:smoke@127.0.0.1:3306/campusone_smoke',
  HEALTH_CHECK_TIMEOUT_MS: '1500',
};
const child = spawn(process.execPath, ['dist/server.js'], {
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
child.stdout.on('data', (d) => (output += d));
child.stderr.on('data', (d) => (output += d));

const get = async (path) => {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: res.status, body: await res.text(), headers: res.headers };
};

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
};

try {
  let live;
  for (let i = 0; i < 50; i++) {
    try {
      live = await get('/health/live');
      break;
    } catch {
      await wait(200);
    }
  }
  check('GET /health/live → 200', live?.status === 200, live?.body);
  check('correlation id header present', Boolean(live?.headers.get('x-correlation-id')));
  const ready = await get('/health/ready');
  check(
    `GET /health/ready → ${expectReady ? 200 : 503}`,
    ready.status === (expectReady ? 200 : 503),
    ready.body,
  );
  const startup = await get('/health/startup');
  check(
    `GET /health/startup → ${expectReady ? 200 : 503}`,
    startup.status === (expectReady ? 200 : 503),
    startup.body,
  );
  const registers = await get('/api/v1/registers');
  check('GET /api/v1/registers → 200', registers.status === 200);
  const jwks = await get('/.well-known/jwks.json');
  const keys = jwks.status === 200 ? JSON.parse(jwks.body).keys : [];
  check(
    'GET /.well-known/jwks.json → public keys only',
    keys.length > 0 && keys.every((k) => !('d' in k)),
  );
  if (expectReady) {
    const bundle = await get('/api/v1/i18n/en');
    check('GET /api/v1/i18n/en → 200', bundle.status === 200);
    const anonymous = await get('/api/v1/files/0199a8b2-7c3e-7d40-8a1b-3f2e4d5c6b7a/url');
    check('signed file link without a session → 401', anonymous.status === 401);
    const reference = await get('/api/v1/auth/member/signup/reference');
    const ref = reference.status === 200 ? JSON.parse(reference.body) : {};
    check(
      'GET /api/v1/auth/member/signup/reference → consent, terms, questions',
      Boolean(ref.consent && ref.terms && ref.securityQuestions?.length),
    );
  }
  if (expectReady) {
    // From the internal network (127.0.0.1 here): the operational metrics, including the gauges
    // read from the database (Phase 9.5).
    const metrics = await get('/metrics');
    check(
      'GET /metrics → request, payment-refusal and outbox metrics',
      metrics.status === 200 &&
        metrics.body.includes('campusone_http_request_duration_seconds') &&
        metrics.body.includes('campusone_payment_refusals_total') &&
        /campusone_outbox_oldest_pending_seconds \d/.test(metrics.body),
    );
  }
  const missing = await get('/api/v1/nothing-here');
  check(
    'unknown route → 404 problem+json',
    missing.status === 404 &&
      missing.headers.get('content-type')?.includes('application/problem+json'),
  );
} finally {
  const exited = new Promise((resolve) =>
    child.once('exit', (code, signal) => resolve({ code, signal })),
  );
  child.kill('SIGTERM');
  const result = await Promise.race([exited, wait(25_000).then(() => 'timeout')]);
  if (result === 'timeout') {
    child.kill('SIGKILL');
    check('graceful shutdown on SIGTERM', false, 'timed out');
  } else {
    // On Windows, SIGTERM from Node terminates the process without running handlers.
    check('process stopped after SIGTERM', true, JSON.stringify(result));
  }
}
if (failures) {
  console.log('--- server output ---\n' + output.slice(-4000));
  process.exit(1);
}
