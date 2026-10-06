import type { RequestHandler } from 'express';
import { jobRunRequestSchema } from '../schemas/jobs.schema';
import type { JobsService } from '../services/jobs.service';
import { AuthenticationError } from '../utils/CustomAPIError';

export function jobsController(service: JobsService) {
  const wrap =
    (fn: RequestHandler): RequestHandler =>
    async (req, res, next) => {
      try {
        await fn(req, res, next);
      } catch (e) {
        next(e);
      }
    };
  return {
    catalogue: wrap(async (_req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.json(await service.catalogue());
    }),
    runs: wrap(async (req, res) => {
      res.json(await service.runs(String(req.params['jobId'])));
    }),
    runLog: wrap(async (req, res) => {
      res.json(await service.runLog(String(req.params['runId'])));
    }),
    runNow: wrap(async (req, res) => {
      const body = jobRunRequestSchema.parse(req.body ?? {});
      res.status(202).json(await service.runNow(String(req.params['jobId']), body, req.principal));
    }),
    institutionRun: wrap(async (req, res) => {
      if (!req.principal) throw new AuthenticationError();
      const body = jobRunRequestSchema.parse(req.body ?? {});
      res
        .status(202)
        .json(await service.institutionRun(req.principal, String(req.params['jobId']), body));
    }),
  };
}
