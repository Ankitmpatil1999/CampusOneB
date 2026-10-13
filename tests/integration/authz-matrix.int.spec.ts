/**
 * Role × endpoint matrix (RNG-GOV-001, golden rule "server-side authorisation on every route, deny
 * by default"): every operation in the committed OpenAPI document is called
 *
 * - with a token of its surface holding every grant except the one the route needs → 403;
 * - with a token holding only that grant → past the gate (never 401 / 403);
 * - with a token of another surface → refused (401 / 403).
 *
 * Path parameters are random ids, so nothing is found and nothing changes; the point is the gate.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import type { Express } from 'express';
import { parse } from 'yaml';
import { INSTITUTION_TASKS, OPERATOR_TASKS } from '../../config/registers';
import { adminUrl, createTestDatabase, type TestDatabase } from './db';
import { buildHttpApp } from './http-app';

type Surface = 'console' | 'ops' | 'portal' | 'member';

interface Operation {
  readonly method: 'get' | 'post' | 'put' | 'patch' | 'delete';
  readonly path: string;
  readonly id: string;
  readonly auth: string;
}

const doc = parse(
  readFileSync(join(import.meta.dirname, '..', '..', 'config', 'openapi.yaml'), 'utf8'),
) as { paths: Record<string, Record<string, { operationId: string; 'x-ringpe-auth': string }>> };

const operations: Operation[] = Object.entries(doc.paths).flatMap(([path, ops]) =>
  Object.entries(ops)
    .filter(([m]) => ['get', 'post', 'put', 'patch', 'delete'].includes(m))
    .map(([method, op]) => ({
      method: method as Operation['method'],
      path,
      id: op.operationId,
      auth: op['x-ringpe-auth'],
    })),
);

/** One sub-task, or alternatives (`a.view,b.view`: any one of them opens the route). */
const SUB_TASK = /^[a-z0-9-]+\.[a-z0-9-]+(,[a-z0-9-]+\.[a-z0-9-]+)*$/;
const alternatives = (auth: string) => auth.split(',');
const grantsOf = (tasks: typeof INSTITUTION_TASKS) => [
  ...tasks.flatMap((t) => t.subTasks.map((s) => s.code)),
  ...tasks.map((t) => `task.${t.code}`),
];
const ALL: Record<'console' | 'ops', string[]> = {
  console: grantsOf(INSTITUTION_TASKS),
  ops: grantsOf(OPERATOR_TASKS),
};

/** The surface a sub-task route belongs to, from its path. */
const surfaceOf = (path: string): 'console' | 'ops' => {
  if (path.startsWith('/api/v1/ops/')) return 'ops';
  if (path.startsWith('/api/v1/console/')) return 'console';
  throw new Error(`Sub-task route outside console/ops: ${path}`);
};

/** Surface-only routes: which surfaces may call them. */
const SURFACES: Record<string, readonly Surface[]> = {
  member: ['member'],
  console: ['console'],
  portal: ['portal'],
  'session (console)': ['console'],
  'session (ops)': ['ops'],
  'session (portal)': ['portal'],
};

const sample: Record<string, string> = {
  stepKey: 'toggles',
  step: 'toggles',
  kind: 'members',
  key: 'mkr.adminSelfApply',
  lang: 'kn',
  slug: 'tvps',
};
const urlOf = (path: string) =>
  path.replace(/\{(\w+)\}/g, (_m, name: string) => sample[name] ?? randomUUID());

const subTaskOps = operations.filter((o) => SUB_TASK.test(o.auth));
const surfaceOps = operations.filter((o) => SURFACES[o.auth]);

describe.skipIf(!adminUrl)('role × endpoint matrix (every documented route)', () => {
  let t: TestDatabase;
  let h: Awaited<ReturnType<typeof buildHttpApp>>;
  let app: Express;

  beforeAll(async () => {
    t = await createTestDatabase();
    h = await buildHttpApp(t, {
      env: { RATE_LIMIT_GLOBAL_MAX: '100000', RATE_LIMIT_SESSION_MAX: '100000' },
    });
    app = h.app;
  }, 120_000);
  afterAll(async () => {
    await t?.drop();
  });

  const token = async (surface: Surface, subTasks: readonly string[]) =>
    (
      await h.security.signer.sign({
        subject: randomUUID(),
        surface,
        sessionId: randomUUID(),
        ...(surface === 'console' || surface === 'portal'
          ? { institutionId: randomUUID(), profileId: randomUUID() }
          : {}),
        subTasks,
      })
    ).token;

  const call = (o: Operation, bearer: string) =>
    request(app)
      [o.method](urlOf(o.path))
      .set('Authorization', `Bearer ${bearer}`)
      .set('Idempotency-Key', randomUUID())
      .set('If-Match', '"v1"')
      .send({});

  it('covers every documented operation', () => {
    const covered = new Set([...subTaskOps, ...surfaceOps].map((o) => o.id));
    const rest = operations.filter((o) => !covered.has(o.id));
    // Only public, internal and signed partner routes (their own suite checks the signature), and
    // routes open to several surfaces, are left.
    expect(
      rest.filter(
        (o) =>
          !/^(public|internal|partner|terminal)/.test(o.auth) &&
          !o.auth.includes('|') &&
          o.auth !== 'session',
      ),
    ).toEqual([]);
    expect(subTaskOps.length).toBeGreaterThan(60);
  });

  it('refuses a token that lacks the route grant (403)', async () => {
    const leaks: string[] = [];
    for (const o of subTaskOps) {
      const surface = surfaceOf(o.path);
      const r = await call(
        o,
        await token(
          surface,
          ALL[surface].filter((g) => !alternatives(o.auth).includes(g)),
        ),
      );
      if (r.status !== 403) leaks.push(`${o.id} ${o.method.toUpperCase()} ${o.path} → ${r.status}`);
    }
    expect(leaks).toEqual([]);
  }, 300_000);

  it('lets a token with only the route grant past the gate', async () => {
    const blocked: string[] = [];
    for (const o of subTaskOps) {
      const surface = surfaceOf(o.path);
      for (const grant of alternatives(o.auth)) {
        const r = await call(o, await token(surface, [grant]));
        if (r.status === 401 || r.status === 403) {
          blocked.push(
            `${o.id} ${o.method.toUpperCase()} ${o.path} (${grant}) → ${r.status} ${r.body?.code ?? ''}`,
          );
        }
      }
    }
    expect(blocked).toEqual([]);
  }, 300_000);

  it('refuses tokens of another surface', async () => {
    const leaks: string[] = [];
    const surfaces: Surface[] = ['console', 'ops', 'portal', 'member'];
    for (const o of [...subTaskOps, ...surfaceOps]) {
      const allowed = SUB_TASK.test(o.auth) ? [surfaceOf(o.path)] : SURFACES[o.auth]!;
      for (const s of surfaces.filter((x) => !allowed.includes(x))) {
        const grants = s === 'console' || s === 'ops' ? ALL[s] : [];
        const r = await call(o, await token(s, grants));
        if (r.status !== 401 && r.status !== 403) {
          leaks.push(`${o.id} ${o.method.toUpperCase()} ${o.path} as ${s} → ${r.status}`);
        }
      }
    }
    expect(leaks).toEqual([]);
  }, 300_000);

  // Teachers on the web (Phase 10), and the principal, merchants and vendor merchants (client
  // 2026-10-13): such a route takes the app's member session, or a console session holding one of
  // the route's sub-tasks (`member|a.view,b.view`) — and nothing else.
  it('opens an app route to the app and to a console session with one of its grants only', async () => {
    const webOps = operations.filter((o) =>
      /^member\|[a-z0-9-]+\.[a-z0-9-]+(,[a-z0-9-]+\.[a-z0-9-]+)*$/.test(o.auth),
    );
    expect(webOps.length).toBeGreaterThanOrEqual(50);
    // The principal's and the merchant's routes are among them.
    expect(webOps.map((o) => o.id)).toEqual(
      expect.arrayContaining(['ACA-060', 'ACA-062', 'COM-024', 'PAY-007', 'PAY-009', 'PAY-015']),
    );
    const wrong: string[] = [];
    for (const o of webOps) {
      const grants = o.auth.split('|')[1]!.split(',');
      const tag = `${o.id} ${o.method.toUpperCase()} ${o.path}`;
      const without = await call(
        o,
        await token(
          'console',
          ALL.console.filter((g) => !grants.includes(g)),
        ),
      );
      if (without.status !== 403) {
        wrong.push(`${tag} console without ${grants.join(',')} → ${without.status}`);
      }
      for (const grant of grants) {
        const withGrant = await call(o, await token('console', [grant]));
        if ([401, 403].includes(withGrant.status)) {
          wrong.push(`${tag} console with ${grant} → ${withGrant.status}`);
        }
      }
      // The app's session passes the gate; the route itself may still refuse someone it is not
      // for (a member who is not a merchant: MER.NOT_MERCHANT), which is not the gate.
      const app = await call(o, await token('member', []));
      if (app.status === 401 || (app.status === 403 && app.body?.code === 'AUTH.FORBIDDEN')) {
        wrong.push(`${tag} member → ${app.status} ${app.body?.code ?? ''}`);
      }
      for (const s of ['ops', 'portal'] as const) {
        const r = await call(o, await token(s, s === 'ops' ? ALL.ops : []));
        if (r.status !== 401 && r.status !== 403) wrong.push(`${tag} as ${s} → ${r.status}`);
      }
    }
    expect(wrong).toEqual([]);
  }, 300_000);
});
