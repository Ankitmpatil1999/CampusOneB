/**
 * The worker's clock: fires each job when its cron expression matches the IST minute, and on start
 * catches up a job whose time has passed today without a completed run (RNG-GOV-024). The runner's
 * lock keeps two worker instances from running the same job at once.
 */
import type { Kysely } from 'kysely';
import type { Loggers } from '../controllers/logger';
import type { Database } from '../models/campusone_models';
import { istBusinessDate } from '../utils/format';
import { cronMatches, firedToday, type JobDefinition } from './index';
import type { JobRunner } from './runner';

export function startScheduler(o: {
  db: Kysely<Database>;
  jobs: readonly JobDefinition[];
  runner: JobRunner;
  loggers: Loggers;
  tickMs?: number;
}): () => void {
  const fired = new Map<string, string>();
  const fire = (job: JobDefinition, trigger: 'SCHEDULE' | 'CATCH_UP', at: Date) => {
    void o.runner
      .run(job, { trigger, periodKey: istBusinessDate(at) })
      .then((r) => {
        if (!r) o.loggers.job.info('job already running elsewhere', { job: job.id, trigger });
      })
      .catch((e: unknown) =>
        o.loggers.job.error('job run could not start', { job: job.id, error: String(e) }),
      );
  };

  const catchUp = async () => {
    const at = new Date();
    const period = istBusinessDate(at);
    for (const job of o.jobs) {
      if (!firedToday(job.cron, at)) continue;
      const done = await o.db
        .selectFrom('job_runs')
        .select('id')
        .where('job_id', '=', job.id)
        .where('period_key', '=', period)
        .where('status', 'in', ['SUCCESS', 'PARTIAL_FAILURE'])
        .executeTakeFirst();
      if (!done) fire(job, 'CATCH_UP', at);
    }
  };

  const tick = () => {
    const at = new Date();
    const minute = new Date(at.getTime() - (at.getTime() % 60_000)).toISOString();
    for (const job of o.jobs) {
      if (fired.get(job.id) === minute || !cronMatches(job.cron, at)) continue;
      fired.set(job.id, minute);
      fire(job, 'SCHEDULE', at);
    }
  };

  void catchUp().catch((e: unknown) =>
    o.loggers.job.error('job catch-up failed', { error: String(e) }),
  );
  const timer = setInterval(tick, o.tickMs ?? 20_000);
  timer.unref();
  return () => clearInterval(timer);
}
