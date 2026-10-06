import { HealthService } from '../services/health.service';

const opts = { timeoutMs: 50, version: '1.0.0', commit: 'abc' };

describe('HealthService', () => {
  it('is ready when started and every required dependency is up', async () => {
    const h = new HealthService(
      [
        { name: 'mysql', required: true, check: async () => undefined },
        { name: 'kms', required: false },
      ],
      opts,
    );
    h.markStarted();
    const r = await h.readiness();
    expect(r.status).toBe('ok');
    expect(r.checks.map((c) => [c.name, c.status])).toEqual([
      ['mysql', 'up'],
      ['kms', 'not_configured'],
    ]);
  });

  it('is unavailable before start-up completes', async () => {
    const h = new HealthService([], opts);
    expect((await h.readiness()).status).toBe('unavailable');
  });

  it('is unavailable when a required dependency fails or times out', async () => {
    const h = new HealthService(
      [
        { name: 'mysql', required: true, check: () => new Promise(() => undefined) },
        { name: 'redis', required: true, check: async () => Promise.reject(new Error('down')) },
      ],
      opts,
    );
    h.markStarted();
    const r = await h.readiness();
    expect(r.status).toBe('unavailable');
    expect(r.checks.every((c) => c.status === 'down')).toBe(true);
  });

  it('ignores an optional dependency that is down', async () => {
    const h = new HealthService(
      [
        {
          name: 'objectStorage',
          required: false,
          check: async () => Promise.reject(new Error('x')),
        },
      ],
      opts,
    );
    h.markStarted();
    expect((await h.readiness()).status).toBe('ok');
  });

  it('reports version, commit and uptime in the details', async () => {
    const h = new HealthService([], opts);
    h.markStarted();
    const d = await h.details();
    expect(d).toMatchObject({ status: 'ok', version: '1.0.0', commit: 'abc' });
    expect(d.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });
});
