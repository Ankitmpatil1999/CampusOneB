import type { RequestHandler } from 'express';
import type { HealthService } from '../services/health.service';

export function healthController(health: HealthService) {
  const live: RequestHandler = (_req, res) => {
    res.json({ status: 'ok' });
  };

  const ready: RequestHandler = async (_req, res) => {
    const report = await health.readiness();
    res.status(report.status === 'ok' ? 200 : 503).json(report);
  };

  const startup: RequestHandler = (_req, res) => {
    res
      .status(health.isStarted ? 200 : 503)
      .json({ status: health.isStarted ? 'started' : 'starting' });
  };

  const detailed: RequestHandler = async (_req, res) => {
    const report = await health.details();
    res.status(report.status === 'ok' ? 200 : 503).json(report);
  };

  return { live, ready, startup, detailed };
}
