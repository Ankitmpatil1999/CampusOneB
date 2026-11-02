/**
 * Module routers mounted under /api/v1 (after authentication and CSRF). The reference mounts each
 * routes file in server.js; here one function builds them from the services so the API and the
 * tests assemble the same thing.
 */
import type { RequestHandler, Router } from 'express';
import type { Loggers } from '../controllers/logger';
import type { FileService } from '../services/file.service';
import type { I18nService } from '../services/i18n.service';
import type { SessionService } from '../services/session.service';
import type { SettingsService } from '../services/settings.service';
import type { MemberAuthService } from '../services/member-auth.service';
import type { SocialAuthService } from '../services/social-auth.service';
import type { MeService } from '../services/me.service';
import type { PersonalDetailsService } from '../services/personal-details.service';
import type { OtpService } from '../services/otp.service';
import type { StaffAuthService } from '../services/staff-auth.service';
import type { RolesService } from '../services/roles.service';
import type { JobsService } from '../services/jobs.service';
import type { Kysely } from 'kysely';
import type { Database } from '../models/campusone_models';
import type { FieldCipher } from '../utils/fieldEncryption';
import { authRoutes } from './auth.routes';
import { fileRoutes } from './file.routes';
import { i18nRoutes } from './i18n.routes';
import { settingsRoutes } from './settings.routes';
import { memberAuthRoutes } from './member-auth.routes';
import { meRoutes } from './me.routes';
import { personalRoutes } from './personal.routes';
import { staffAuthRoutes } from './staff-auth.routes';
import { rolesRoutes } from './roles.routes';
import { jobsRoutes } from './jobs.routes';
import { institutionsRoutes } from './institutions.routes';
import { institutionSetupRoutes } from './institution-setup.routes';
import { plansRoutes } from './plans.routes';
import { billingRoutes } from './billing.routes';
import { subscriptionRoutes } from './subscription.routes';
import { membersRoutes } from './members.routes';
import { approvalsRoutes } from './approvals.routes';
import { portalRoutes } from './portal.routes';
import { staffAccountsRoutes } from './staff-accounts.routes';
import { walletsRoutes } from './wallets.routes';
import { paymentSecurityRoutes } from './payment-security.routes';
import { paymentsRoutes } from './payments.routes';
import { partnersRoutes } from './partners.routes';
import './realtime.routes';
import { terminalsRoutes } from './terminals.routes';
import { assetsRoutes } from './assets.routes';
import { allowancesRoutes } from './allowances.routes';
import { couponsRoutes } from './coupons.routes';
import { eventsRoutes } from './events.routes';
import { posRoutes } from './pos.routes';
import { feesRoutes } from './fees.routes';
import { pushRoutes } from './push.routes';
import { feeDuesRoutes } from './fee-dues.routes';
// FINANCING-OFF (client 2026-10-22): the fee financing partner is commented out in the whole application; uncomment to bring it back.
// import { financingRoutes } from './financing.routes';
import { admissionsRoutes } from './admissions.routes';
import { paymentGatewaysRoutes } from './payment-gateways.routes';
import { corporateCodesRoutes } from './corporate-codes.routes';
import { commEventsRoutes } from './comm-events.routes';
import type { CorporateCodesService } from '../services/corporate-codes.service';
import type { PaymentGatewaysService } from '../services/payment-gateways.service';
import { settlementRoutes } from './settlement.routes';
import { reconRoutes } from './recon.routes';
import { grievancesRoutes } from './grievances.routes';
import { accountingRoutes } from './accounting.routes';
import { classroomRoutes } from './classroom.routes';
import { examsRoutes } from './exams.routes';
import { leaveRoutes } from './leave.routes';
import { attendanceRoutes } from './attendance.routes';
import { transportRoutes } from './transport.routes';
import { platformToolsRoutes } from './platform-tools.routes';
import { announcementsRoutes } from './announcements.routes';
import { messagingRoutes } from './messaging.routes';
import { commReportRoutes } from './comm-report.routes';
import { crossInstitutionRoutes } from './cross-institution.routes';
import { reportsRoutes } from './reports.routes';
import { quizRoutes } from './quiz.routes';
import { structureRoutes } from './structure.routes';
import type { PaymentSecurityService } from '../services/payment-security.service';
import type { LedgerService } from '../services/ledger.service';
import type { WalletsService } from '../services/wallets.service';
import type { ConsoleStaffService } from '../services/console-staff.service';
import type { OpsHomeService } from '../services/ops-home.service';
import type { PortalDataService } from '../services/portal-data.service';
import type { PortalService } from '../services/portal.service';
import type { ApprovalsService } from '../services/approvals.service';
import type { AuditEventsService } from '../services/audit-events.service';
import type { NotificationsService } from '../services/notifications.service';
import type { CommEventsService } from '../services/comm-events.service';
import type { EmailRelay } from '../services/email-relay.service';
import type { PushRelay } from '../services/push-relay.service';
import type { PushTokensService } from '../services/push.service';
import type { MembersService } from '../services/members.service';
import type { MemberUploadsService } from '../services/member-uploads.service';
import type { AcademicsService } from '../services/academics.service';
import type { SubscriptionService } from '../services/subscription.service';
import type { BillingService } from '../services/billing.service';
import type { PlansService } from '../services/plans.service';
import type { InstitutionSetupService } from '../services/institution-setup.service';
import type { InstitutionsService } from '../services/institutions.service';
import type { MerchantsService } from '../services/merchants.service';
import type { PaymentsService } from '../services/payments.service';
import type { TransfersService } from '../services/transfers.service';
import type { BankCreditsService } from '../services/bank-credits.service';
import type { PartnersService } from '../services/partners.service';
import type { AxisBankService } from '../services/axis-bank.service';
import type { SessionRevocations } from '../utils/session-revocations';
import type { TokenVerifier } from '../utils/token-verifier';
import { axisBankRoutes } from './axis-bank.routes';
import type { ReconService } from '../services/recon.service';
import type { ReconReportsService } from '../services/recon-reports.service';
import type { ReconciliationService } from '../services/reconciliation.service';
import type { RefundsService } from '../services/refunds.service';
import type { GrievancesService } from '../services/grievances.service';
import type { AccountingService } from '../services/accounting.service';
import type { CalendarService } from '../services/calendar.service';
import type { CurriculumService } from '../services/curriculum.service';
import type { TeachingService } from '../services/teaching.service';
import type { TeachingUploadsService } from '../services/teaching-uploads.service';
import type { EnrolmentsService } from '../services/enrolments.service';
import type { ExamsService } from '../services/exams.service';
import type { ClassroomService } from '../services/classroom.service';
import type { HomeworkService } from '../services/homework.service';
import type { LeaveService } from '../services/leave.service';
import type { AttendanceService } from '../services/attendance.service';
import type { AttendanceAdminService } from '../services/attendance-admin.service';
import type { TransportService } from '../services/transport.service';
import type { TripsService } from '../services/trips.service';
import type { TransportFeesService } from '../services/transport-fees.service';
import type { TransportLiveService } from '../services/transport-live.service';
import type { PlatformToolsService } from '../services/platform-tools.service';
import type { AnnouncementsService } from '../services/announcements.service';
import type { MessagingService } from '../services/messaging.service';
import type { CommReportService } from '../services/comm-report.service';
import type { ReportExportsService } from '../services/report-exports.service';
import type { CrossInstitutionService } from '../services/cross-institution.service';
import type { ReportsService } from '../services/reports.service';
import type { QuizService } from '../services/quiz.service';
import type { PrincipalService } from '../services/principal.service';
import type { CardsService } from '../services/cards.service';
import type { TerminalsService } from '../services/terminals.service';
import type { AssetsService } from '../services/assets.service';
import type { AllowancesService } from '../services/allowances.service';
import type { CouponsService } from '../services/coupons.service';
import type { EventsService } from '../services/events.service';
import type { PosService } from '../services/pos.service';
import type { FeesService } from '../services/fees.service';
import type { FeeRecordsService } from '../services/fee-records.service';
import type { FeeUploadsService } from '../services/fee-uploads.service';
import type { FeeDuesService } from '../services/fee-dues.service';
import type { FeePaymentsService } from '../services/fee-payments.service';
import type { FinancingService } from '../services/financing.service';
import type { AdmissionsService } from '../services/admissions.service';
import type { AdmissionLinksService } from '../services/admission-links.service';
import type { SettlementService } from '../services/settlement.service';
import type { PassesService } from '../services/passes.service';

export interface ApiServices {
  readonly db: Kysely<Database>;
  readonly otp: OtpService;
  readonly memberAuth: MemberAuthService;
  readonly staffAuth: StaffAuthService;
  readonly roles: RolesService;
  readonly jobs: JobsService;
  readonly social: SocialAuthService;
  readonly me: MeService;
  readonly personal: PersonalDetailsService;
  readonly loggers: Loggers;
  readonly cipher: FieldCipher;
  readonly sessions: SessionService;
  readonly i18n: I18nService;
  readonly files: FileService;
  readonly institutions: InstitutionsService;
  readonly institutionSetup: InstitutionSetupService;
  readonly plans: PlansService;
  readonly billing: BillingService;
  readonly subscriptions: SubscriptionService;
  readonly members: MembersService;
  readonly memberUploads: MemberUploadsService;
  readonly academics: AcademicsService;
  readonly approvals: ApprovalsService;
  readonly notifications: NotificationsService;
  readonly commEvents: CommEventsService;
  readonly emailRelay: EmailRelay;
  readonly pushTokens: PushTokensService;
  readonly pushRelay: PushRelay;
  readonly auditEvents: AuditEventsService;
  readonly portal: PortalService;
  readonly portalData: PortalDataService;
  readonly consoleStaff: ConsoleStaffService;
  readonly opsHome: OpsHomeService;
  readonly ledger: LedgerService;
  readonly wallets: WalletsService;
  readonly paymentSecurity: PaymentSecurityService;
  readonly merchants: MerchantsService;
  readonly payments: PaymentsService;
  readonly transfers: TransfersService;
  readonly bankCredits: BankCreditsService;
  readonly partners: PartnersService;
  readonly axisBank: AxisBankService;
  readonly recon: ReconService;
  readonly refunds: RefundsService;
  readonly grievances: GrievancesService;
  readonly accounting: AccountingService;
  readonly calendar: CalendarService;
  readonly curriculum: CurriculumService;
  readonly teaching: TeachingService;
  readonly teachingUploads: TeachingUploadsService;
  readonly enrolments: EnrolmentsService;
  readonly exams: ExamsService;
  readonly classroom: ClassroomService;
  readonly homework: HomeworkService;
  readonly leave: LeaveService;
  readonly principal: PrincipalService;
  readonly attendance: AttendanceService;
  readonly attendanceAdmin: AttendanceAdminService;
  readonly transport: TransportService;
  readonly trips: TripsService;
  readonly transportLive: TransportLiveService;
  readonly transportFees: TransportFeesService;
  readonly platformTools: PlatformToolsService;
  readonly announcements: AnnouncementsService;
  readonly messaging: MessagingService;
  readonly commReport: CommReportService;
  readonly reportExports: ReportExportsService;
  readonly xi: CrossInstitutionService;
  readonly reports: ReportsService;
  readonly quiz: QuizService;
  readonly reconciliation: ReconciliationService;
  readonly reconReports: ReconReportsService;
  readonly cards: CardsService;
  readonly terminals: TerminalsService;
  readonly assets: AssetsService;
  readonly allowances: AllowancesService;
  readonly coupons: CouponsService;
  readonly events: EventsService;
  readonly passes: PassesService;
  readonly pos: PosService;
  readonly fees: FeesService;
  readonly feeRecords: FeeRecordsService;
  readonly feeUploads: FeeUploadsService;
  readonly feeDues: FeeDuesService;
  /** Collect Fee: cash, a QR code or a payment link (client 2026-10-19). */
  readonly feePayments: FeePaymentsService;
  readonly financing: FinancingService;
  readonly admissions: AdmissionsService;
  readonly admissionLinks: AdmissionLinksService;
  readonly paymentGateways: PaymentGatewaysService;
  readonly corporateCodes: CorporateCodesService;
  readonly settlement: SettlementService;
  readonly settings: SettingsService;
  /** Stricter rate limit for sign-in, code and refresh routes (RATE_LIMIT_AUTH_MAX). */
  readonly authLimiter: RequestHandler;
}

/**
 * Routers mounted before /api/v1 that check their own credentials and answer in a partner's own
 * format: the Axis Bank Power E-coll calls (BNK-001…003).
 */
export function partnerRouters(
  s: ApiServices,
  security: { readonly verifier?: TokenVerifier; readonly revocations?: SessionRevocations },
): Router[] {
  return [
    axisBankRoutes({
      axis: s.axisBank,
      partners: s.partners,
      verifier: security.verifier,
      revocations: security.revocations,
      loggers: s.loggers,
    }),
  ];
}

export function apiRouters(s: ApiServices): Router[] {
  return [
    authRoutes({
      sessions: s.sessions,
      cipher: s.cipher,
      loggers: s.loggers,
      authLimiter: s.authLimiter,
    }),
    i18nRoutes(s.i18n),
    fileRoutes(s.files),
    settingsRoutes(s.settings, s.loggers),
    memberAuthRoutes({
      db: s.db,
      service: s.memberAuth,
      otp: s.otp,
      social: s.social,
      authLimiter: s.authLimiter,
    }),
    staffAuthRoutes({
      service: s.staffAuth,
      cipher: s.cipher,
      loggers: s.loggers,
      authLimiter: s.authLimiter,
    }),
    rolesRoutes({ db: s.db, service: s.roles, loggers: s.loggers }),
    jobsRoutes({ db: s.db, service: s.jobs, loggers: s.loggers }),
    meRoutes(s.me, s.loggers),
    personalRoutes({ db: s.db, service: s.personal, loggers: s.loggers }),
    institutionsRoutes({ db: s.db, service: s.institutions, loggers: s.loggers }),
    institutionSetupRoutes({ db: s.db, service: s.institutionSetup, loggers: s.loggers }),
    plansRoutes({ db: s.db, service: s.plans, loggers: s.loggers }),
    billingRoutes({ db: s.db, service: s.billing, loggers: s.loggers }),
    subscriptionRoutes({ db: s.db, service: s.subscriptions, loggers: s.loggers }),
    membersRoutes({
      db: s.db,
      members: s.members,
      uploads: s.memberUploads,
      academics: s.academics,
      loggers: s.loggers,
    }),
    approvalsRoutes({
      db: s.db,
      approvals: s.approvals,
      notifications: s.notifications,
      audit: s.auditEvents,
      loggers: s.loggers,
    }),
    portalRoutes({
      db: s.db,
      portal: s.portal,
      data: s.portalData,
      cipher: s.cipher,
      loggers: s.loggers,
      authLimiter: s.authLimiter,
    }),
    staffAccountsRoutes({
      staff: s.consoleStaff,
      me: s.me,
      home: s.opsHome,
      loggers: s.loggers,
    }),
    walletsRoutes({ wallets: s.wallets, loggers: s.loggers }),
    paymentSecurityRoutes({
      service: s.paymentSecurity,
      loggers: s.loggers,
      authLimiter: s.authLimiter,
    }),
    grievancesRoutes({ db: s.db, grievances: s.grievances, loggers: s.loggers }),
    accountingRoutes({ db: s.db, accounting: s.accounting, loggers: s.loggers }),
    structureRoutes({
      db: s.db,
      calendar: s.calendar,
      curriculum: s.curriculum,
      teaching: s.teaching,
      teachingUploads: s.teachingUploads,
      enrolments: s.enrolments,
      loggers: s.loggers,
    }),
    examsRoutes({ db: s.db, exams: s.exams, loggers: s.loggers }),
    classroomRoutes({
      db: s.db,
      classroom: s.classroom,
      homework: s.homework,
      calendar: s.calendar,
      loggers: s.loggers,
    }),
    leaveRoutes({ db: s.db, leave: s.leave, principal: s.principal, loggers: s.loggers }),
    attendanceRoutes({
      db: s.db,
      attendance: s.attendance,
      admin: s.attendanceAdmin,
      terminals: s.terminals,
      loggers: s.loggers,
    }),
    transportRoutes({
      db: s.db,
      transport: s.transport,
      trips: s.trips,
      live: s.transportLive,
      fees: s.transportFees,
      loggers: s.loggers,
    }),
    platformToolsRoutes({ db: s.db, tools: s.platformTools, loggers: s.loggers }),
    announcementsRoutes({ db: s.db, announcements: s.announcements, loggers: s.loggers }),
    messagingRoutes({ db: s.db, messaging: s.messaging, loggers: s.loggers }),
    commReportRoutes({
      db: s.db,
      commReport: s.commReport,
      exports: s.reportExports,
      loggers: s.loggers,
    }),
    crossInstitutionRoutes({ db: s.db, xi: s.xi, exports: s.reportExports, loggers: s.loggers }),
    reportsRoutes({ db: s.db, reports: s.reports, exports: s.reportExports, loggers: s.loggers }),
    quizRoutes({ db: s.db, quiz: s.quiz, xi: s.xi, loggers: s.loggers }),
    reconRoutes({
      db: s.db,
      reconciliation: s.reconciliation,
      refunds: s.refunds,
      reports: s.reconReports,
      loggers: s.loggers,
    }),
    paymentsRoutes({
      db: s.db,
      payments: s.payments,
      merchants: s.merchants,
      transfers: s.transfers,
      loggers: s.loggers,
    }),
    assetsRoutes({ db: s.db, assets: s.assets, loggers: s.loggers }),
    allowancesRoutes({ db: s.db, allowances: s.allowances, loggers: s.loggers }),
    couponsRoutes({ db: s.db, coupons: s.coupons, terminals: s.terminals, loggers: s.loggers }),
    eventsRoutes({ db: s.db, events: s.events, passes: s.passes, loggers: s.loggers }),
    feesRoutes({
      db: s.db,
      fees: s.fees,
      records: s.feeRecords,
      uploads: s.feeUploads,
      payments: s.feePayments,
      loggers: s.loggers,
    }),
    feeDuesRoutes({ db: s.db, dues: s.feeDues, loggers: s.loggers }),
    // FINANCING-OFF (client 2026-10-22): the fee financing partner is commented out in the whole application; uncomment to bring it back.
    // financingRoutes({
    //   db: s.db,
    //   financing: s.financing,
    //   partners: s.partners,
    //   loggers: s.loggers,
    // }),
    admissionsRoutes({
      db: s.db,
      admissions: s.admissions,
      links: s.admissionLinks,
      loggers: s.loggers,
      authLimiter: s.authLimiter,
    }),
    paymentGatewaysRoutes({ db: s.db, gateways: s.paymentGateways, loggers: s.loggers }),
    corporateCodesRoutes({ db: s.db, corporateCodes: s.corporateCodes, loggers: s.loggers }),
    commEventsRoutes({ commEvents: s.commEvents, loggers: s.loggers }),
    pushRoutes({ pushTokens: s.pushTokens, loggers: s.loggers }),
    settlementRoutes({ db: s.db, settlement: s.settlement, loggers: s.loggers }),
    posRoutes({
      db: s.db,
      pos: s.pos,
      terminals: s.terminals,
      partners: s.partners,
      loggers: s.loggers,
    }),
    terminalsRoutes({
      db: s.db,
      terminals: s.terminals,
      cards: s.cards,
      loggers: s.loggers,
      authLimiter: s.authLimiter,
    }),
    partnersRoutes({
      db: s.db,
      partners: s.partners,
      bankCredits: s.bankCredits,
      recon: s.recon,
      loggers: s.loggers,
    }),
  ];
}
