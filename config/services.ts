/**
 * Builds the API services from the runtime pieces. The server and the HTTP tests use the same
 * assembly; tests replace only what talks to the outside (storage, scanner, SMS/e-mail, clock).
 */
import type { RequestHandler } from 'express';
import type { Kysely } from 'kysely';
import type { Config } from './config';
import type { Security } from './security';
import type { Loggers } from '../controllers/logger';
import type { Database } from '../models/ringpe_models';
import type { ApiServices } from '../routes';
import { createScanner, type AntivirusScanner } from '../integrations/antivirus.provider';
import { createEmailSender } from '../integrations/email.provider';
import { createPushSender, type PushSender } from '../integrations/push.provider';
import { createMapsRouter, type MapsRouter } from '../integrations/maps.provider';
import { createSmsSender, type MessageSender } from '../integrations/sms.provider';
import { createStorage, type StorageProvider } from '../integrations/storage.provider';
import { FileService } from '../services/file.service';
import { I18nService } from '../services/i18n.service';
import { MeService } from '../services/me.service';
import { MemberAuthService } from '../services/member-auth.service';
import { SocialAuthService } from '../services/social-auth.service';
import { PersonalDetailsService } from '../services/personal-details.service';
import { createBankVerifier, type BankVerifier } from '../integrations/bank-verify.provider';
import { OtpService } from '../services/otp.service';
import { SessionService } from '../services/session.service';
import { SettingsService } from '../services/settings.service';
import { StaffAuthService } from '../services/staff-auth.service';
import { RolesService } from '../services/roles.service';
import { JobsService } from '../services/jobs.service';
import { InstitutionsService } from '../services/institutions.service';
import { InstitutionSetupService } from '../services/institution-setup.service';
import { PlansService } from '../services/plans.service';
import { BillingService } from '../services/billing.service';
import { SubscriptionService } from '../services/subscription.service';
import { MembersService } from '../services/members.service';
import { MemberUploadsService } from '../services/member-uploads.service';
import { AcademicsService } from '../services/academics.service';
import { ApprovalsService } from '../services/approvals.service';
import { AuditEventsService } from '../services/audit-events.service';
import { NotificationsService } from '../services/notifications.service';
import { PortalDataService } from '../services/portal-data.service';
import { PortalService } from '../services/portal.service';
import { ConsoleStaffService } from '../services/console-staff.service';
import { OpsHomeService } from '../services/ops-home.service';
import { LedgerService } from '../services/ledger.service';
import { MerchantsService } from '../services/merchants.service';
import { PaymentEngine } from '../services/payment-engine.service';
import { PaymentsService } from '../services/payments.service';
import { TransfersService } from '../services/transfers.service';
import { BankCreditsService } from '../services/bank-credits.service';
import { PartnersService } from '../services/partners.service';
import { AxisBankService } from '../services/axis-bank.service';
import { CorporateCodesService } from '../services/corporate-codes.service';
import { ReconService } from '../services/recon.service';
import { ReconReportsService } from '../services/recon-reports.service';
import { ReconciliationService } from '../services/reconciliation.service';
import { RefundsService } from '../services/refunds.service';
import { GrievancesService } from '../services/grievances.service';
import { AccountingService } from '../services/accounting.service';
import { CalendarService } from '../services/calendar.service';
import { CurriculumService } from '../services/curriculum.service';
import { TeachingUploadsService } from '../services/teaching-uploads.service';
import { TeachingService } from '../services/teaching.service';
import { EnrolmentsService } from '../services/enrolments.service';
import { ExamsService } from '../services/exams.service';
import { ClassroomService } from '../services/classroom.service';
import { HomeworkService } from '../services/homework.service';
import { LeaveService } from '../services/leave.service';
import { AttendanceService } from '../services/attendance.service';
import { AttendanceAdminService } from '../services/attendance-admin.service';
import { TransportService } from '../services/transport.service';
import { TripsService } from '../services/trips.service';
import { TransportFeesService } from '../services/transport-fees.service';
import { TransportLiveService } from '../services/transport-live.service';
import { PlatformToolsService } from '../services/platform-tools.service';
import { AnnouncementsService } from '../services/announcements.service';
import { MessagingService } from '../services/messaging.service';
import { loggedSender } from '../services/comm-log.service';
import { CommEventsService } from '../services/comm-events.service';
import { EmailRelay } from '../services/email-relay.service';
import { PushRelay } from '../services/push-relay.service';
import { PushTokensService } from '../services/push.service';
import { FeeNoticesService } from '../services/fee-notices.service';
import {
  CommReportService,
  commReportCsvRow,
  commReportHeader,
  type CommReportFilters,
} from '../services/comm-report.service';
import { ReportExportsService } from '../services/report-exports.service';
import { CrossInstitutionService } from '../services/cross-institution.service';
import { ReportsService } from '../services/reports.service';
import { QuizService } from '../services/quiz.service';
import { PrincipalService } from '../services/principal.service';
import { createAccountingPackage } from '../integrations/accounting.provider';
import { CardsService } from '../services/cards.service';
import { TerminalsService } from '../services/terminals.service';
import { AssetsService } from '../services/assets.service';
import { AllowancesService } from '../services/allowances.service';
import { CouponsService } from '../services/coupons.service';
import { EventsService } from '../services/events.service';
import { PassesService } from '../services/passes.service';
import { PosService } from '../services/pos.service';
import { FeesService } from '../services/fees.service';
import { FeeRecordsService } from '../services/fee-records.service';
import { FeeUploadsService } from '../services/fee-uploads.service';
import { FeeDuesService } from '../services/fee-dues.service';
import { FinancingService } from '../services/financing.service';
import { createFinancingPartner } from '../integrations/financing.provider';
import {
  createPaymentGateway,
  type PaymentGateway,
} from '../integrations/payment-gateway.provider';
import {
  PaymentGatewaysService,
  type SchoolGatewayFactory,
} from '../services/payment-gateways.service';
import { FeePaymentsService } from '../services/fee-payments.service';
import { AdmissionsService } from '../services/admissions.service';
import { AdmissionLinksService } from '../services/admission-links.service';
import { SettlementService } from '../services/settlement.service';
import { WalletsService } from '../services/wallets.service';
import { PaymentSecurityService } from '../services/payment-security.service';
import { buildJobs } from '../schedulers';
import { JobRunner } from '../schedulers/runner';
import { createFlowTokens } from '../utils/flow-tokens';

export interface ServiceOverrides {
  readonly bankVerifier?: BankVerifier;
  /** Tests: a gateway answering like Razorpay without the network. */
  readonly gateway?: PaymentGateway;
  /** Tests: builds a school's gateway from its keys without the network. */
  readonly schoolGateway?: SchoolGatewayFactory;
  readonly storage?: StorageProvider;
  readonly scanner?: AntivirusScanner;
  readonly sms?: MessageSender;
  readonly email?: MessageSender;
  /** Tests: a push sender without Firebase (null: none configured). */
  readonly push?: PushSender | null;
  /** Tests: a map service without Google (null: maps off). */
  readonly maps?: MapsRouter | null;
  readonly settings?: SettingsService;
  readonly now?: () => Date;
}

export function buildApiServices(args: {
  db: Kysely<Database>;
  config: Config;
  security: Security;
  loggers: Loggers;
  authLimiter: RequestHandler;
  overrides?: ServiceOverrides;
}): ApiServices {
  const { db, config, security, loggers } = args;
  const o = args.overrides ?? {};
  const now = o.now;
  const echo = { echo: config.notify.otpDevEcho };
  const settings = o.settings ?? new SettingsService(db);
  // Staff grants ride in the access token; the staff service is built below (late-bound).
  const late: { staffAuth?: StaffAuthService } = {};
  const sessions = new SessionService({
    db,
    signer: security.signer,
    revocations: security.revocations,
    loggers,
    settings,
    grants: async (s) => (late.staffAuth ? late.staffAuth.grants(s) : []),
    ...(now ? { now } : {}),
  });
  const emailSender = loggedSender(
    o.email ??
      createEmailSender(config.notify.email, loggers, { ...echo, smtp: config.notify.smtp }),
    db,
    now,
  );
  // Phone pushes (client 2026-10-19): Firebase, the app log, or none (PUSH_PROVIDER).
  const pushSender =
    o.push !== undefined
      ? o.push
      : createPushSender(config.notify.push, loggers, {
          serviceAccountFile: config.notify.pushServiceAccountFile,
        });
  const smsSender = loggedSender(
    o.sms ?? createSmsSender(config.notify.sms, loggers, echo),
    db,
    now,
  );
  const otp = new OtpService({
    db,
    cipher: security.cipher,
    sms: smsSender,
    email: emailSender,
    settings,
    showCodeInTestMode: config.notify.otpTestShowCode,
    ...(now ? { now } : {}),
  });
  const flows = createFlowTokens(security.cipher, now);
  const memberAuth = new MemberAuthService({
    db,
    cipher: security.cipher,
    otp,
    sessions,
    flows,
    loggers,
    settings,
    ...(now ? { now } : {}),
  });
  const staffAuth = new StaffAuthService({
    db,
    otp,
    sessions,
    loggers,
    settings,
    flows,
    email: emailSender,
    webUrl: config.publicWebUrl,
    ...(now ? { now } : {}),
  });
  late.staffAuth = staffAuth;
  const files = new FileService({
    db,
    storage: o.storage ?? createStorage(config.files.storage, config.files.uploadDir),
    scanner: o.scanner ?? createScanner(config.files.scanMode),
    cipher: security.cipher,
    loggers,
    urlTtlSeconds: config.files.urlTtlSeconds,
    ...(now ? { now } : {}),
  });
  const billing = new BillingService({
    db,
    loggers,
    settings,
    email: emailSender,
    ...(now ? { now } : {}),
  });
  const subscriptions = new SubscriptionService({
    db,
    loggers,
    settings,
    email: emailSender,
    billing,
    ...(now ? { now } : {}),
  });
  const ledger = new LedgerService({ ...(now ? { now } : {}) });
  // A bank credit tries the student's pending fee collections at once (Q14 M9; late-bound).
  const afterCredit: { retry?: (institutionId: string, profileId: string) => Promise<unknown> } =
    {};
  const bankCredits = new BankCreditsService({
    db,
    ledger,
    afterCredit: async (institutionId, profileId) => afterCredit.retry?.(institutionId, profileId),
    ...(now ? { now } : {}),
  });
  const refunds = new RefundsService({ db, ledger, settings, ...(now ? { now } : {}) });
  const allowances = new AllowancesService({ db, ledger, settings, ...(now ? { now } : {}) });
  const cards = new CardsService({ db, settings, ...(now ? { now } : {}) });
  const coupons = new CouponsService({ db, cards, settings, ...(now ? { now } : {}) });
  const events = new EventsService({ db, ...(now ? { now } : {}) });
  const passes = new PassesService({ db, settings, ...(now ? { now } : {}) });
  const members = new MembersService({
    db,
    loggers,
    sessions,
    settings,
    email: emailSender,
    webUrl: config.publicWebUrl,
    ...(now ? { now } : {}),
  });
  const grievances = new GrievancesService({
    db,
    refunds,
    members,
    files,
    settings,
    ...(now ? { now } : {}),
  });
  const enrolments = new EnrolmentsService({ db, members, ...(now ? { now } : {}) });
  const exams = new ExamsService({ db, ...(now ? { now } : {}) });
  const classroom = new ClassroomService({ db, ...(now ? { now } : {}) });
  const homework = new HomeworkService({ db, files, ...(now ? { now } : {}) });
  const leave = new LeaveService({ db, settings, ...(now ? { now } : {}) });
  const principal = new PrincipalService({ db, exams, leave, ...(now ? { now } : {}) });
  const plans = new PlansService({ db });
  const fees = new FeesService({ db, members, settings, ...(now ? { now } : {}) });
  const academics = new AcademicsService({ db, settings });
  const institutionSetup = new InstitutionSetupService({ db, settings, ...(now ? { now } : {}) });
  const institutions = new InstitutionsService({
    db,
    cipher: security.cipher,
    sessions,
    loggers,
    settings,
    email: emailSender,
    webUrl: config.publicWebUrl,
    files,
    billing,
    subscriptions,
    ...(now ? { now } : {}),
  });
  const paymentSecurity = new PaymentSecurityService({
    db,
    otp,
    settings,
    ...(now ? { now } : {}),
  });
  const engine = new PaymentEngine({
    db,
    ledger,
    paymentSecurity,
    settings,
    ...(now ? { now } : {}),
  });
  const feeRecords = new FeeRecordsService({
    db,
    engine,
    members,
    settings,
    ...(now ? { now } : {}),
  });
  afterCredit.retry = (institutionId, profileId) =>
    feeRecords.retryForStudent(institutionId, profileId);
  const settlement = new SettlementService({
    db,
    ledger,
    store: {
      store: (i) =>
        files.storeGenerated({
          institutionId: i.institutionId,
          purpose: 'statement',
          name: i.name,
          mimeType: 'text/csv',
          data: i.data,
          createdBy: null,
        }),
    },
    links: files,
    settings,
    ...(now ? { now } : {}),
  });
  // Manual runs from the back office (GOV-004) take the same lock as the worker's schedule.
  const accounting = new AccountingService({
    db,
    package: createAccountingPackage(config.accountingMode),
    settings,
    ...(now ? { now } : {}),
  });
  const attendance = new AttendanceService({ db, cards, settings, ...(now ? { now } : {}) });
  const attendanceAdmin = new AttendanceAdminService({
    db,
    attendance,
    cipher: security.cipher,
    ...(now ? { now } : {}),
  });
  const transport = new TransportService({ db, ...(now ? { now } : {}) });
  const i18n = new I18nService(db);
  const announcements = new AnnouncementsService({
    db,
    settings,
    sms: smsSender,
    email: emailSender,
    onError: (e) =>
      loggers.app.error('announcement dispatch failed', {
        error: e instanceof Error ? e.message : String(e),
      }),
    ...(now ? { now } : {}),
  });
  const trips = new TripsService({ db, settings, ...(now ? { now } : {}) });
  // Google Maps for transport (client 2026-10-21): road distances; the live view needs no map call.
  const transportLive = new TransportLiveService({
    db,
    settings,
    maps:
      o.maps !== undefined
        ? o.maps
        : createMapsRouter(config.maps.provider, { serverKey: config.maps.serverKey }),
    mapsConfig: {
      provider: o.maps === undefined ? config.maps.provider : (o.maps?.provider ?? 'off'),
      browserKey: config.maps.browserKey,
    },
    ...(now ? { now } : {}),
  });
  const transportFees = new TransportFeesService({ db, ...(now ? { now } : {}) });
  const commReport = new CommReportService({ db, settings, ...(now ? { now } : {}) });
  const reportExports = new ReportExportsService({
    db,
    files,
    settings,
    onError: (e) =>
      loggers.app.error('report export failed', {
        error: e instanceof Error ? e.message : String(e),
      }),
    ...(now ? { now } : {}),
  });
  const xi = new CrossInstitutionService({ db, settings, ...(now ? { now } : {}) });
  const reports = new ReportsService({ db, commReport, ...(now ? { now } : {}) });
  reportExports.register('console-report', {
    header: (params) => reports.header(String(params['report'])),
    async *rows(institutionId, params, max) {
      if (!institutionId) return;
      yield* reports.exportRows(institutionId, params, max);
    },
    fileName: (params) => reports.fileName(params),
  });
  reportExports.register('access-record', {
    header: [
      'Access',
      'Kind',
      'Of',
      'Time',
      'Actor',
      'Role',
      'Selection',
      'Institutions',
      'Figures',
      'From',
      'To',
      'Outcome',
      'Reason',
      'Note',
    ],
    async *rows(_institutionId, params, max) {
      let cursor: string | undefined;
      let n = 0;
      while (n < max) {
        const page = await xi.recordRows({ ...params, cursor }, Math.min(500, max - n));
        if (!page.length) return;
        for (const r of page) {
          yield [
            r.accessNo,
            r.kind,
            r.parentAccessNo,
            r.at,
            r.actor.name ?? r.actor.id,
            r.actor.role,
            r.selection,
            r.institutions.join('; '),
            r.figures.join(', '),
            r.period.from,
            r.period.to,
            r.outcome,
            r.reason,
            r.note,
          ];
        }
        n += page.length;
        cursor = Buffer.from(`a:${page.at(-1)!.rowId}`, 'utf8').toString('base64url');
      }
    },
    fileName: (params) =>
      `access-record_${String(params['from'] ?? 'all')}_${String(params['to'] ?? 'today')}.csv`,
  });
  reportExports.register('communication-log', {
    header: commReportHeader,
    async *rows(institutionId, params, max) {
      if (!institutionId) return;
      for await (const r of commReport.exportRows(
        institutionId,
        params as CommReportFilters,
        max,
      )) {
        yield commReportCsvRow(r);
      }
    },
    fileName: (params) =>
      `communication-report_${String(params['from'] ?? 'last-30-days')}_${String(params['to'] ?? 'today')}.csv`,
  });
  const jobs = buildJobs({
    feeNotices: new FeeNoticesService({ db, settings, ...(now ? { now } : {}) }),
    commReport,
    settlement,
    accounting,
    attendance: attendanceAdmin,
    trips,
    announcements,
    subscriptions,
    bankCredits,
    allowances,
    coupons,
    events,
    passes,
    feeRecords,
  });
  const terminals = new TerminalsService({
    db,
    cipher: security.cipher,
    signer: security.signer,
    settings,
    ...(now ? { now } : {}),
  });
  const merchants = new MerchantsService({
    db,
    cipher: security.cipher,
    members,
    email: emailSender,
    ...(now ? { now } : {}),
  });
  const paymentGateways = new PaymentGatewaysService({
    db,
    cipher: security.cipher,
    loggers,
    production: config.nodeEnv === 'production',
    webUrl: config.publicWebUrl,
    platformLive: config.paymentGatewayMode === 'live' && config.razorpay !== null,
    settings,
    ...(o.schoolGateway ? { factory: o.schoolGateway } : {}),
    ...(now ? { now } : {}),
  });
  const admissionLinks = new AdmissionLinksService({
    db,
    email: emailSender,
    files,
    webUrl: config.publicWebUrl,
    settings,
    ...(now ? { now } : {}),
  });
  const partners = new PartnersService({
    db,
    cipher: security.cipher,
    signer: security.signer,
    revocations: security.revocations,
    settings,
    ...(now ? { now } : {}),
  });
  const gateway =
    o.gateway ??
    createPaymentGateway(
      config.paymentGatewayMode,
      security.cipher.secret('payment_gateway_test'),
      config.razorpay,
    );
  // Collect Fee: an instalment in cash, or by a payment link or QR code (client 2026-10-19).
  const feePayments = new FeePaymentsService({
    db,
    files,
    flows,
    gateway,
    gateways: paymentGateways,
    webUrl: config.publicWebUrl,
    sms: smsSender,
    email: emailSender,
    settings,
    ...(now ? { now } : {}),
  });
  const admissions = new AdmissionsService({
    db,
    cipher: security.cipher,
    files,
    members,
    otp,
    flows,
    links: admissionLinks,
    gateway,
    gateways: paymentGateways,
    feeOrders: feePayments,
    webUrl: config.publicWebUrl,
    sms: smsSender,
    email: emailSender,
    settings,
    ...(now ? { now } : {}),
  });
  return {
    db,
    loggers,
    cipher: security.cipher,
    admissionLinks,
    paymentGateways,
    corporateCodes: new CorporateCodesService({ db, settings, ...(now ? { now } : {}) }),
    settlement,
    admissions,
    feePayments,
    settings,
    sessions,
    otp,
    memberAuth,
    staffAuth,
    roles: new RolesService({ db, sessions, loggers }),
    jobs: new JobsService(db, { jobs, runner: new JobRunner({ db, loggers }) }),
    social: new SocialAuthService({
      db,
      cipher: security.cipher,
      flows,
      memberAuth,
      config: config.social,
      settings,
    }),
    me: new MeService({ db, sessions, settings, otp, flows }),
    personal: new PersonalDetailsService({
      db,
      cipher: security.cipher,
      bankVerifier: o.bankVerifier ?? createBankVerifier(config.bankVerifyMode),
      ...(now ? { now } : {}),
    }),
    i18n,
    platformTools: new PlatformToolsService({
      db,
      i18n,
      providers: {
        sms: config.notify.sms,
        email: config.notify.email,
        push: pushSender?.provider ?? 'off',
      },
      ...(now ? { now } : {}),
    }),
    files,
    plans,
    billing,
    subscriptions,
    members,
    memberUploads: new MemberUploadsService({
      db,
      members,
      admissions,
      cipher: security.cipher,
      settings,
      ...(now ? { now } : {}),
    }),
    academics,
    approvals: new ApprovalsService({
      db,
      members,
      sessions,
      cipher: security.cipher,
      files,
      bankCredits,
      fees: {
        applyApproved: (trx, payload, at) => fees.applyApproved(trx, payload, at),
        applyReturned: (trx, payload, remarks, at) => fees.applyReturned(trx, payload, remarks, at),
        changes: (db, payload) => fees.approvalChanges(db, payload),
      },
      feeRecords: {
        applyChange: (trx, payload, at) => feeRecords.applyChange(trx, payload, at),
        changes: (db, payload) => feeRecords.changeRows(db, payload),
      },
      grievances: {
        applyUpdate: (trx, payload, at, who) => grievances.applyUpdate(trx, payload, at, who),
        changes: (db, payload) => grievances.changeRows(db, payload),
      },
      enrolments: {
        applyCorrection: (trx, payload, at, approvalId, checker) =>
          enrolments.applyCorrection(trx, payload, at, approvalId, checker),
        changes: (db, payload) => enrolments.changeRows(db, payload),
      },
      settings,
      ...(now ? { now } : {}),
    }),
    fees,
    feeRecords,
    feeUploads: new FeeUploadsService({ db, settings, ...(now ? { now } : {}) }),
    feeDues: new FeeDuesService({
      db,
      records: feeRecords,
      payments: feePayments,
      settings,
      ...(now ? { now } : {}),
    }),
    financing: new FinancingService({
      db,
      partner: createFinancingPartner(config.financing.mode, config.financing.partnerName),
      settings,
      ...(now ? { now } : {}),
    }),
    notifications: new NotificationsService({ db, ...(now ? { now } : {}) }),
    commEvents: new CommEventsService({ db, ...(now ? { now } : {}) }),
    emailRelay: new EmailRelay({
      db,
      email: emailSender,
      files,
      loggers,
      settings,
      ...(now ? { now } : {}),
    }),
    pushTokens: new PushTokensService({ db, ...(now ? { now } : {}) }),
    pushRelay: new PushRelay({ db, push: pushSender, loggers, ...(now ? { now } : {}) }),
    auditEvents: new AuditEventsService({ db }),
    institutionSetup,
    institutions,
    portal: new PortalService({
      db,
      loggers,
      otp,
      flows,
      sessions,
      institutions,
      setup: institutionSetup,
      academics,
      subscriptions,
      billing,
      plans,
      settings,
      ...(now ? { now } : {}),
    }),
    portalData: new PortalDataService({ db, files, settings, ...(now ? { now } : {}) }),
    consoleStaff: new ConsoleStaffService({ db, sessions, loggers, ...(now ? { now } : {}) }),
    opsHome: new OpsHomeService({ db, ...(now ? { now } : {}) }),
    ledger,
    wallets: new WalletsService({ db, vaBank: config.vaBank, ...(now ? { now } : {}) }),
    paymentSecurity,
    merchants,
    payments: new PaymentsService({
      db,
      engine,
      merchants,
      cards,
      events,
      loggers,
      settings,
      ...(now ? { now } : {}),
    }),
    transfers: new TransfersService({ db, engine, ...(now ? { now } : {}) }),
    cards,
    assets: new AssetsService({ db, merchants, ...(now ? { now } : {}) }),
    allowances,
    coupons,
    events,
    passes,
    terminals,
    pos: new PosService({
      db,
      engine,
      cards,
      coupons,
      terminals,
      settings,
      loggers,
      ...(now ? { now } : {}),
    }),
    bankCredits,
    recon: new ReconService({ db, ...(now ? { now } : {}) }),
    refunds,
    grievances,
    accounting,
    calendar: new CalendarService({ db, ...(now ? { now } : {}) }),
    curriculum: new CurriculumService({ db, ...(now ? { now } : {}) }),
    teaching: new TeachingService({ db, ...(now ? { now } : {}) }),
    teachingUploads: new TeachingUploadsService({ db, ...(now ? { now } : {}) }),
    enrolments,
    exams,
    classroom,
    homework,
    leave,
    principal,
    attendance,
    attendanceAdmin,
    transport,
    trips,
    transportLive,
    transportFees,
    announcements,
    messaging: new MessagingService({ db, settings, ...(now ? { now } : {}) }),
    commReport,
    reportExports,
    xi,
    reports,
    quiz: new QuizService({ db, settings, ...(now ? { now } : {}) }),
    reconciliation: new ReconciliationService({
      db,
      refunds,
      settings,
      ...(now ? { now } : {}),
    }),
    reconReports: new ReconReportsService({ db, ...(now ? { now } : {}) }),
    partners,
    axisBank: new AxisBankService({ db, partners, bankCredits, settings }),
    authLimiter: args.authLimiter,
  };
}
