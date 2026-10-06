import { Router } from 'express';
import request from 'supertest';
import { authorize, requireTenant } from '../middlewares/auth.middleware';
import { getContext } from '../utils/request-context';
import { buildTestApp, capturingLoggers, testKeys, waitForLine } from './helpers';

const INSTITUTION = '0199a8b2-0000-7000-8000-000000000001';

/** A probe router standing in for module routes (role → task → sub-task, tenant from session). */
function probeRouter(loggers = capturingLoggers().loggers) {
  const r = Router();
  r.get(
    '/probe/members',
    authorize('members.view', loggers),
    requireTenant(loggers),
    (req, res) => {
      res.json({ institutionId: getContext()?.institutionId, principal: req.principal?.subject });
    },
  );
  return r;
}

describe('authentication and authorisation skeleton', () => {
  it('refuses an anonymous call to a protected route with 401', async () => {
    const keys = await testKeys();
    const { app } = await buildTestApp({ keys, apiRouters: [probeRouter()] });
    const res = await request(app).get('/api/v1/probe/members');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('AUTH.UNAUTHENTICATED');
  });

  it('allows a valid token holding the sub-task and scopes the tenant from the token', async () => {
    const keys = await testKeys();
    const { app } = await buildTestApp({ keys, apiRouters: [probeRouter()] });
    const token = await keys.sign({ sid: 's1', ins: INSTITUTION, st: ['members.view'] });
    const res = await request(app)
      .get('/api/v1/probe/members')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Institution-Id', '0199a8b2-9999-7999-8999-999999999999');
    expect(res.status).toBe(200);
    expect(res.body.institutionId).toBe(INSTITUTION);
  });

  it('denies by default: a token without the sub-task gets 403 and a security event', async () => {
    const keys = await testKeys();
    const captured = capturingLoggers();
    const { app } = await buildTestApp({
      keys,
      loggers: captured.loggers,
      apiRouters: [probeRouter(captured.loggers)],
    });
    const token = await keys.sign({ sid: 's1', ins: INSTITUTION, st: ['members.edit'] });
    const res = await request(app)
      .get('/api/v1/probe/members')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('AUTH.FORBIDDEN');
    await waitForLine(
      captured.lines,
      (l) => l['stream'] === 'security' && l['message'] === 'authz.denied',
    );
  });

  it('refuses a session without an institution on a tenant route', async () => {
    const keys = await testKeys();
    const { app } = await buildTestApp({ keys, apiRouters: [probeRouter()] });
    const token = await keys.sign({ sid: 's1', st: ['members.view'] });
    const res = await request(app)
      .get('/api/v1/probe/members')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it.each([
    [
      'a token signed by another key',
      async () => (await testKeys()).sign({ sid: 's1', ins: INSTITUTION, st: ['members.view'] }),
    ],
    [
      'an expired token',
      async (k: Awaited<ReturnType<typeof testKeys>>) =>
        k.sign(
          { sid: 's1', ins: INSTITUTION, st: ['members.view'] },
          { expiresIn: Math.floor(Date.now() / 1000) - 60 },
        ),
    ],
    [
      'a wrong issuer',
      async (k: Awaited<ReturnType<typeof testKeys>>) =>
        k.sign({ sid: 's1', ins: INSTITUTION, st: ['members.view'] }, { issuer: 'someone-else' }),
    ],
    [
      'an unknown audience',
      async (k: Awaited<ReturnType<typeof testKeys>>) =>
        k.sign({ sid: 's1', ins: INSTITUTION, st: ['members.view'] }, { audience: 'agriculture' }),
    ],
    [
      'a token without a session id',
      async (k: Awaited<ReturnType<typeof testKeys>>) =>
        k.sign({ ins: INSTITUTION, st: ['members.view'] }),
    ],
  ])('rejects %s with 401', async (_name, makeToken) => {
    const keys = await testKeys();
    const { app } = await buildTestApp({ keys, apiRouters: [probeRouter()] });
    const token = await makeToken(keys);
    const res = await request(app)
      .get('/api/v1/probe/members')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
  });

  it('accepts the web session cookie of the surface named by the request', async () => {
    const keys = await testKeys();
    const { app } = await buildTestApp({ keys, apiRouters: [probeRouter()] });
    const token = await keys.sign({ sid: 's1', ins: INSTITUTION, st: ['members.view'] });
    const res = await request(app)
      .get('/api/v1/probe/members')
      .set('X-RingPe-Surface', 'console')
      .set('Cookie', `__Host-rp_console_at=${token}`);
    expect(res.status).toBe(200);
  });

  it('ignores session cookies when the request names no surface (anonymous)', async () => {
    const keys = await testKeys();
    const { app } = await buildTestApp({ keys, apiRouters: [probeRouter()] });
    const token = await keys.sign({ sid: 's1', ins: INSTITUTION, st: ['members.view'] });
    const res = await request(app)
      .get('/api/v1/probe/members')
      .set('Cookie', `__Host-rp_console_at=${token}`);
    expect(res.status).toBe(401);
  });

  it("refuses one surface's cookie presented as another surface's", async () => {
    const keys = await testKeys();
    const { app } = await buildTestApp({ keys, apiRouters: [probeRouter()] });
    // A console token placed in the portal cookie slot.
    const token = await keys.sign({ sid: 's1', ins: INSTITUTION, st: ['members.view'] });
    const res = await request(app)
      .get('/api/v1/probe/members')
      .set('X-RingPe-Surface', 'portal')
      .set('Cookie', `__Host-rp_portal_at=${token}`);
    expect(res.status).toBe(401);
  });

  it('answers 401 when no verifier is configured but a token is presented', async () => {
    const { app } = await buildTestApp({ apiRouters: [probeRouter()] });
    const res = await request(app)
      .get('/api/v1/probe/members')
      .set('Authorization', 'Bearer abc.def.ghi');
    expect(res.status).toBe(401);
  });
});
