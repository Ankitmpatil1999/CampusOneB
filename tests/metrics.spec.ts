/**
 * Operational metrics (Phase 9.5): payment refusals by check, job runs, messages by outcome and
 * rate-limit refusals reach the process's registry, which `/metrics` serves to the internal network.
 */
import request from 'supertest';
import { createMetrics, opsMetrics, setProcessMetrics } from '../utils/metrics';
import { buildTestApp } from './helpers';

describe('operational metrics', () => {
  afterEach(() => setProcessMetrics(null));

  it('records refusals, job runs and messages once the process metrics are set', async () => {
    opsMetrics.paymentRefused('P1', 'PRE'); // before start-up: a no-op
    const m = createMetrics({ defaultMetrics: false });
    setProcessMetrics(m);
    opsMetrics.paymentRefused('V13', 'VALIDATION');
    opsMetrics.paymentRefused('V13', 'VALIDATION');
    opsMetrics.jobRun('settlement-run', 'FAILED', 2.5);
    opsMetrics.commSent('ANNOUNCEMENT', 'SMS', 'SKIPPED');
    const text = await m.registry.metrics();
    expect(text).toContain('ringpe_payment_refusals_total{check="V13",stage="VALIDATION"} 2');
    expect(text).not.toContain('check="P1"');
    expect(text).toContain('ringpe_job_runs_total{job="settlement-run",status="FAILED"} 1');
    expect(text).toContain(
      'ringpe_comm_messages_total{kind="ANNOUNCEMENT",channel="SMS",outcome="SKIPPED"} 1',
    );
  });

  it('counts rate-limit refusals by limiter', async () => {
    const { app } = await buildTestApp({
      env: { RATE_LIMIT_GLOBAL_MAX: '1' },
    });
    const m = createMetrics({ defaultMetrics: false });
    setProcessMetrics(m);
    await request(app).get('/health/live');
    expect((await request(app).get('/health/live')).status).toBe(429);
    expect(await m.registry.metrics()).toContain('ringpe_rate_limited_total{limiter="global"} 1');
  });
});
