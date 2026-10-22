/**
 * Worker entrypoint (ADR-0002): scheduled jobs, queues and the outbox relay run here, never in the
 * API process. The worker starts its health endpoints, builds the services its jobs use and starts
 * the scheduler once the schema is ready; the outbox relay and queues are added with their modules.
 */
import express from 'express';
import { internalOnly } from './middlewares/internal-only.middleware';
import { createEmailSender } from './integrations/email.provider';
import { createSmsSender } from './integrations/sms.provider';
import { AnnouncementsService } from './services/announcements.service';
import { loggedSender } from './services/comm-log.service';
import { FeeNoticesService } from './services/fee-notices.service';
import { CommReportService } from './services/comm-report.service';
import { HealthService } from './services/health.service';
import { BillingService } from './services/billing.service';
import { SettingsService } from './services/settings.service';
import { SubscriptionService } from './services/subscription.service';
import { buildJobs } from './schedulers';
import { JobRunner } from './schedulers/runner';
import { startScheduler } from './schedulers/scheduler';
import { AllowancesService } from './services/allowances.service';
import { CardsService } from './services/cards.service';
import { CouponsService } from './services/coupons.service';
import { EventsService } from './services/events.service';
import { PassesService } from './services/passes.service';
import { FeeRecordsService } from './services/fee-records.service';
import { PaymentEngine } from './services/payment-engine.service';
import type { PaymentSecurityService } from './services/payment-security.service';
import { BankCreditsService } from './services/bank-credits.service';
import { LedgerService } from './services/ledger.service';
import { SettlementService } from './services/settlement.service';
import { AccountingService } from './services/accounting.service';
import { AttendanceService } from './services/attendance.service';
import { AttendanceAdminService } from './services/attendance-admin.service';
import { TripsService } from './services/trips.service';
import { createAccountingPackage } from './integrations/accounting.provider';
import { storeGeneratedFile } from './services/file.service';
import { createStorage } from './integrations/storage.provider';
import {
  createRuntime,
  installShutdown,
  loadConfigOrExit,
  waitForSchema,
} from './config/bootstrap';

function main(): void {
  const config = loadConfigOrExit();
  const runtime = createRuntime(config, 'worker');
  const { loggers } = runtime;
  const db = runtime.database.db;

  const health = new HealthService(runtime.dependencyChecks, {
    timeoutMs: config.health.timeoutMs,
    version: config.version,
    commit: config.commit,
  });

  // Minimal health surface for the orchestrator (no public API in the worker).
  const app = express();
  app.disable('x-powered-by');
  app.get('/health/live', (_req, res) => void res.json({ status: 'ok' }));
  app.get('/health/ready', async (_req, res) => {
    const report = await health.readiness();
    res.status(report.status === 'ok' ? 200 : 503).json(report);
  });
  // Job and communication metrics are recorded in this process (internal network only).
  app.get('/metrics', internalOnly(config.http.internalAllowlist), async (_req, res) => {
    res.type(runtime.metrics.registry.contentType).send(await runtime.metrics.registry.metrics());
  });
  const server = app.listen(config.http.workerHealthPort, config.http.host, () => {
    loggers.app.info('worker health listening', { port: config.http.workerHealthPort });
  });

  // The services the jobs use (the same classes as the API).
  const settings = new SettingsService(db);
  const email = loggedSender(
    createEmailSender(config.notify.email, loggers, {
      echo: config.notify.otpDevEcho,
      smtp: config.notify.smtp,
    }),
    db,
  );
  const billing = new BillingService({ db, loggers, settings, email });
  const subscriptions = new SubscriptionService({ db, loggers, settings, email, billing });
  const ledger = new LedgerService();
  // A released held credit tries the student's pending fee collections at once (Q14 M9).
  const late: { feeRecords?: FeeRecordsService } = {};
  const bankCredits = new BankCreditsService({
    db,
    ledger,
    afterCredit: async (institutionId, profileId) =>
      late.feeRecords?.retryForStudent(institutionId, profileId),
  });
  const allowances = new AllowancesService({ db, ledger, settings });
  const coupons = new CouponsService({ db, cards: new CardsService({ db, settings }), settings });
  const events = new EventsService({ db });
  const passes = new PassesService({ db, settings });
  // The worker collects fees with system authority only (no PIN, no spending cap: 13.15), so the
  // payment engine gets a payment-security stand-in that refuses if it is ever asked.
  const noMemberAuth = {
    verifyPin: () => Promise.reject(new Error('The worker never takes a PIN')),
    checkCap: () => Promise.reject(new Error('The worker never applies a member cap')),
  } as unknown as PaymentSecurityService;
  const engine = new PaymentEngine({ db, ledger, paymentSecurity: noMemberAuth, settings });
  const feeRecords = new FeeRecordsService({ db, engine, settings });
  late.feeRecords = feeRecords;
  // The nightly settlement writes its statements straight to storage (the worker signs no links).
  const storage = createStorage(config.files.storage, config.files.uploadDir);
  const settlement = new SettlementService({
    db,
    ledger,
    store: {
      store: (i) =>
        storeGeneratedFile(
          db,
          storage,
          {
            institutionId: i.institutionId,
            purpose: 'statement',
            name: i.name,
            mimeType: 'text/csv',
            data: i.data,
            createdBy: null,
          },
          new Date(),
        ),
    },
    settings,
  });
  const accounting = new AccountingService({
    db,
    package: createAccountingPackage(config.accountingMode),
    settings,
  });
  const attendance = new AttendanceAdminService({
    db,
    attendance: new AttendanceService({ db, cards: new CardsService({ db, settings }), settings }),
  });
  const jobs = buildJobs({
    settlement,
    accounting,
    attendance,
    trips: new TripsService({ db, settings }),
    announcements: new AnnouncementsService({
      db,
      sms: loggedSender(
        createSmsSender(config.notify.sms, loggers, { echo: config.notify.otpDevEcho }),
        db,
      ),
      email,
      settings,
    }),
    commReport: new CommReportService({ db, settings }),
    feeNotices: new FeeNoticesService({ db, settings }),
    subscriptions,
    bankCredits,
    allowances,
    coupons,
    events,
    passes,
    feeRecords,
  });
  const runner = new JobRunner({ db, loggers });
  let stopScheduler: (() => void) | null = null;

  const stopSchemaWatch = waitForSchema(runtime, () => {
    health.markStarted();
    loggers.job.info('job registry loaded', { jobs: jobs.map((j) => j.id), count: jobs.length });
    stopScheduler = startScheduler({ db, jobs, runner, loggers });
  });

  installShutdown(runtime, async () => {
    stopSchemaWatch();
    stopScheduler?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
}

main();
