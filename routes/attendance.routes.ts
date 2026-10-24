import { Router, type Request, type RequestHandler } from 'express';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { defineRoute } from '../config/openapi-registry';
import type { Loggers } from '../controllers/logger';
import {
  authorize,
  memberOrConsole,
  requireSurface,
  requireTenant,
  teacherAccess,
} from '../middlewares/auth.middleware';
import { idempotency } from '../middlewares/idempotency.middleware';
import type { Database } from '../models/ringpe_models';
import type { AttendanceAdminService } from '../services/attendance-admin.service';
import type { AttendanceService } from '../services/attendance.service';
import type { TerminalsService } from '../services/terminals.service';
import { AuthenticationError } from '../utils/CustomAPIError';
import { expectedVersion, setEtag } from '../utils/etag';

const date = z.iso.date({ message: 'VALIDATION.DATE' });
const uuid = z.string().max(40);
const status = z.enum(['PRESENT', 'LATE', 'HALF_DAY', 'ABSENT'], { message: 'VALIDATION.FORMAT' });

export const tapSchema = z
  .strictObject({
    cardToken: z.string({ message: 'ATT.CARD_NOT_ACTIVE' }).max(128),
    tapId: z.string().max(64).optional(),
    tappedAt: z.string().max(40).optional(),
  })
  .meta({ id: 'ReaderTap' });
/** ATT-028: a card on the teacher's own reader, for the daily register or a running period. */
export const teacherTapSchema = z
  .strictObject({
    cardToken: z.string({ message: 'ATT.CARD_NOT_ACTIVE' }).max(128),
    mode: z.enum(['DAILY', 'PERIOD'], { message: 'VALIDATION.FORMAT' }),
    classSectionId: uuid
      .optional()
      .describe('DAILY: the class teacher’s section (default: the first)'),
    slotId: z
      .string()
      .max(80)
      .optional()
      .describe('PERIOD: "<section id>.<period id>" from ATT-021'),
  })
  .meta({ id: 'TeacherCardTap' });
export const dailySchema = z
  .strictObject({
    date,
    entries: z
      .array(
        z.strictObject({
          memberId: uuid,
          status,
          remark: z.string().max(200, { message: 'ATT.REMARK' }).nullable().optional(),
        }),
      )
      .min(1)
      .max(500),
  })
  .meta({ id: 'DailyAttendance' });
export const registerSchema = z
  .strictObject({
    classSectionId: uuid,
    date,
    entries: z
      .array(
        z.strictObject({
          studentId: uuid,
          status,
          remark: z.string().max(200, { message: 'ATT.REMARK' }).nullable().optional(),
        }),
      )
      .min(1)
      .max(200),
  })
  .meta({ id: 'AttendanceRegister' });
export const periodMarksSchema = z
  .strictObject({
    date,
    entries: z
      .array(
        z.strictObject({
          studentId: uuid,
          status: z.enum(['PRESENT', 'LATE', 'ABSENT'], { message: 'VALIDATION.FORMAT' }),
        }),
      )
      .min(1)
      .max(200),
  })
  .meta({ id: 'PeriodAttendance' });
export const autoAbsentSchema = z
  .strictObject({
    enabled: z.boolean(),
    cutoff: z.string({ message: 'ATT.CUTOFF' }).max(5, { message: 'ATT.CUTOFF' }),
    appliesTo: z.array(z.enum(['STUDENTS', 'STAFF'])).max(2),
  })
  .meta({ id: 'AutoAbsentSettings' });
/** Client 2026-10-23: the staff timings by role on the Auto-absent page. */
const hhmm = z
  .string({ message: 'VALIDATION.REQUIRED' })
  .max(5, { message: 'VALIDATION.FORMAT' })
  .describe('"HH:MM", IST');
export const staffTimingSchema = z
  .strictObject({
    name: z.string({ message: 'ATT.TIMING_NAME' }).max(60, { message: 'ATT.TIMING_NAME' }),
    roleIds: z
      .array(uuid, { message: 'ATT.TIMING_ROLES' })
      .max(50)
      .describe('The roles it is for (from ATT-033); a role is in one timing only'),
    loginTime: hhmm,
    logoutTime: hhmm,
    lateLoginTime: hhmm.describe('A login after it is Late'),
    earlyLogoutTime: hhmm.describe('A logout before it makes the day a Half day'),
    halfDayTime: hhmm.describe('A login after it is a Half day'),
    absentTime: hhmm.describe('A login after it is Absent; no login by then is marked Absent'),
  })
  .meta({ id: 'StaffTimingInput' });
export const attendanceTypeSchema = z
  .strictObject({
    name: z.string({ message: 'ATT.TYPE_NAME' }).max(40, { message: 'ATT.TYPE_NAME' }),
    cooldownSeconds: z.number().int().min(10).max(3600).optional(),
  })
  .meta({ id: 'AttendanceTypeInput' });
export const visitorSchema = z
  .strictObject({
    name: z.string({ message: 'ATT.VISITOR_DETAILS' }).max(80, { message: 'ATT.VISITOR_DETAILS' }),
    mobile: z
      .string({ message: 'ATT.VISITOR_DETAILS' })
      .max(15, { message: 'ATT.VISITOR_DETAILS' }),
    purpose: z
      .string({ message: 'ATT.VISITOR_DETAILS' })
      .max(120, { message: 'ATT.VISITOR_DETAILS' }),
    toMeet: z.string().max(80).nullable().optional(),
  })
  .meta({ id: 'VisitorInput' });
export const locationCaptureSchema = z
  .strictObject({ attendanceTypeId: uuid, memberId: uuid })
  .meta({ id: 'LocationCapture' });

const overviewQuery = z.object({ date: date.optional(), yearId: uuid.optional() });
const reportQuery = z.object({
  from: date.optional(),
  to: date.optional(),
  type: z.enum(['STUDENT', 'TEACHER', 'STAFF', 'ALL']).optional(),
  classSection: uuid.optional(),
  cursor: z.string().max(40).optional(),
});
const dateQuery = z.object({ date: date.optional() });
// Staff attendance at the front desk (client 2026-10-22).
const staffQuery = z.object({
  date: date.optional(),
  type: z.enum(['ALL', 'TEACHERS', 'STAFF']).optional(),
});
// Payroll from attendance (client 2026-10-22): a month, YYYY-MM.
const payrollQuery = z.object({
  month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'VALIDATION.FORMAT' })
    .optional(),
  type: z.enum(['ALL', 'TEACHERS', 'STAFF']).optional(),
});
export const deskTapSchema = z
  .strictObject({ cardToken: z.string({ message: 'ATT.CARD_NOT_ACTIVE' }).max(128) })
  .meta({ id: 'StaffCardTap' });
export const deskCheckSchema = z
  .strictObject({
    memberId: uuid,
    action: z.enum(['IN', 'OUT'], { message: 'VALIDATION.FORMAT' }),
    remark: z.string().max(200, { message: 'ATT.REMARK' }).nullable().optional(),
  })
  .meta({ id: 'StaffCheck' });
const registerQuery = z.object({ classSectionId: uuid.optional(), date: date.optional() });
const monthQuery = z.object({ for: uuid.optional(), month: z.string().max(7).optional() });
const principalQuery = z.object({
  date: date.optional(),
  type: z.enum(['STUDENTS', 'TEACHERS', 'STAFF']).optional(),
});

const doc = (d: Omit<Parameters<typeof defineRoute>[0], 'tags'>) =>
  defineRoute({ ...d, tags: ['Attendance'] });
doc({
  id: 'ATT-002',
  method: 'post',
  path: '/api/v1/terminal/reader/taps',
  summary:
    'A card tap at a gate, period or location reader: the card matched within the reader’s institution, one double-tap interval; gate — check-in (Present, or Late after the cut-off for non-students) and a non-student’s check-out (Present, or Half day before the threshold); period — Present by the start, Late after; location — a check-in after the type’s cooling-off',
  auth: 'terminal',
  request: tapSchema,
  idempotent: 'required',
  responses: { 200: { description: 'Member, result and status' } },
});
doc({
  id: 'ATT-008',
  method: 'get',
  path: '/api/v1/console/attendance/overview',
  summary:
    'The day by class-section (present, late, half day, absent, not marked, percentage) and teachers and staff, with the holiday of the day',
  auth: 'attendance.view',
  query: overviewQuery,
  responses: { 200: { description: 'Overview' } },
});
doc({
  id: 'ATT-009',
  method: 'get',
  path: '/api/v1/console/attendance/reports',
  summary:
    'Each member’s attendance over a date range (up to att.report.maxDays): present, late, half day, absent, not marked and percentage of school days, by member type and class-section',
  auth: 'attendance.view',
  query: reportQuery,
  responses: { 200: { description: 'Report' } },
});
doc({
  id: 'ATT-010',
  method: 'put',
  path: '/api/v1/console/attendance/daily',
  summary:
    'Mark members for a date (today or earlier, in an open year): creates or overrides each record, keeping old → new and who changed it; every Absent tells the family',
  auth: 'attendance.mark',
  request: dailySchema,
  responses: { 200: { description: 'Saved and overridden' } },
});
doc({
  id: 'ATT-011',
  method: 'get',
  path: '/api/v1/console/attendance/auto-absent',
  summary: 'The auto-absent setting (off until set, OQ-14) and its recent runs',
  auth: 'attendance.view',
  responses: { 200: { description: 'Setting and runs' } },
});
doc({
  id: 'ATT-012',
  method: 'put',
  path: '/api/v1/console/attendance/auto-absent',
  summary:
    'Turn auto-absent on or off, its cut-off time (07:00–18:00) and whom it applies to; If-Match (v0 when never set)',
  auth: 'attendance.config',
  request: autoAbsentSchema,
  responses: { 200: { description: 'Setting' } },
});
doc({
  id: 'ATT-013',
  method: 'get',
  path: '/api/v1/console/attendance-types',
  summary: 'Attendance types (places) with their cooling-off interval, readers and check-ins today',
  auth: 'attendance.view',
  responses: { 200: { description: 'Types' } },
});
doc({
  id: 'ATT-014',
  method: 'post',
  path: '/api/v1/console/attendance-types',
  summary: 'Add an attendance type (2–40 characters, unique) with its cooling-off interval',
  auth: 'attendance.config',
  request: attendanceTypeSchema,
  idempotent: 'required',
  responses: { 201: { description: 'Type' } },
});
doc({
  id: 'ATT-015',
  method: 'get',
  path: '/api/v1/console/visitors',
  summary: 'The visitor log of a day (mobile masked), with who is still inside',
  auth: 'frontdesk.view',
  query: dateQuery,
  responses: { 200: { description: 'Visitors' } },
});
doc({
  id: 'ATT-016',
  method: 'post',
  path: '/api/v1/console/visitors',
  summary: 'Record a visitor: name, mobile (kept encrypted), purpose and whom they meet',
  auth: 'frontdesk.edit',
  request: visitorSchema,
  idempotent: 'required',
  responses: { 201: { description: 'Visitor' } },
});
doc({
  id: 'ATT-017',
  method: 'post',
  path: '/api/v1/console/visitors/{visitorId}/checkout',
  summary: 'Check a visitor out',
  auth: 'frontdesk.edit',
  responses: { 200: { description: 'Visitor' } },
});
doc({
  id: 'ATT-018',
  method: 'post',
  path: '/api/v1/console/location-attendance',
  summary:
    'The front desk records a member at an attendance type (MANUAL, RC-38), after its cooling-off interval',
  auth: 'frontdesk.edit',
  request: locationCaptureSchema,
  idempotent: 'required',
  responses: { 201: { description: 'Check-in' } },
});
doc({
  id: 'ATT-019',
  method: 'get',
  path: '/api/v1/teacher/attendance/register',
  summary:
    'The class teacher’s daily register for a date: each student’s status, approved leave, counts and the holiday of the day',
  auth: 'member|teaching.attendance',
  query: registerQuery,
  responses: { 200: { description: 'Register' } },
});
doc({
  id: 'ATT-020',
  method: 'put',
  path: '/api/v1/teacher/attendance/register',
  summary:
    'Save the register (today or earlier, in an open year); overrides keep old → new; every Absent tells the family',
  auth: 'member|teaching.attendance',
  request: registerSchema,
  responses: { 200: { description: 'Saved and overridden' } },
});
doc({
  id: 'ATT-021',
  method: 'get',
  path: '/api/v1/teacher/attendance/periods',
  summary:
    'The teacher’s periods on a date with how many students were captured (slotId = "<section id>.<period id>")',
  auth: 'member|teaching.attendance',
  query: dateQuery,
  responses: { 200: { description: 'Periods' } },
});
doc({
  id: 'ATT-022',
  method: 'put',
  path: '/api/v1/teacher/attendance/periods/{slotId}',
  summary:
    'The period’s teacher marks students Present or Late; Absent removes a manual mark (a card tap stays)',
  auth: 'member|teaching.attendance',
  request: periodMarksSchema,
  responses: { 200: { description: 'Saved' } },
});
doc({
  id: 'ATT-028',
  method: 'post',
  path: '/api/v1/teacher/attendance/card-taps',
  summary:
    'A student taps their card on the teacher’s own USB reader (web console, RingPe Card Reader): today, any time; DAILY — a student who missed the gate, in a class the teacher teaches (class or subject teacher; default the class teacher’s section), recorded Present for the day (a recorded Absent becomes Present); PERIOD — a student of the teacher’s period running now, Present or Late; already recorded is answered ALREADY',
  auth: 'member|teaching.attendance',
  idempotent: 'required',
  request: teacherTapSchema,
  responses: { 200: { description: 'MARKED or ALREADY, with the student and status' } },
});
doc({
  id: 'ATT-023',
  method: 'get',
  path: '/api/v1/me/attendance',
  summary:
    'A month of the member’s attendance (for: a child on the account): each day, holidays, approved leave and the summary',
  auth: 'member|teaching.view,principal.view',
  query: monthQuery,
  responses: { 200: { description: 'Month' } },
});
doc({
  id: 'ATT-026',
  method: 'get',
  path: '/api/v1/principal/attendance',
  summary:
    'The principal’s day: students by class-section, or teachers or staff by name with approved leave',
  auth: 'member|principal.view',
  query: principalQuery,
  responses: { 200: { description: 'Attendance' } },
});

doc({
  id: 'ATT-029',
  method: 'get',
  path: '/api/v1/console/attendance/staff',
  summary:
    'Teachers, the principal and non-teaching staff on a date (default today; type ALL, TEACHERS or STAFF): each one’s status, check-in and check-out times, how it was recorded, approved leave and whether they hold a card, with counts (client 2026-10-22)',
  auth: 'attendance.view',
  query: staffQuery,
  responses: { 200: { description: 'Staff' } },
});
doc({
  id: 'ATT-030',
  method: 'post',
  path: '/api/v1/console/attendance/staff/card-taps',
  summary:
    'A staff member taps their card on the front desk’s USB reader (RingPe Card Reader): the first tap of the day checks them in (Present up to the late cut-off, Late after), the next checks them out (Present after the half-day time, Half day before); a later tap answers COMPLETE. A day marked Absent without a check-in is checked in. Students are refused (ATT.NOT_STAFF)',
  auth: 'attendance.mark',
  idempotent: 'required',
  request: deskTapSchema,
  responses: {
    200: { description: 'CHECKED_IN, CHECKED_OUT or COMPLETE, with the member and status' },
  },
});
doc({
  id: 'ATT-031',
  method: 'post',
  path: '/api/v1/console/attendance/staff/checks',
  summary:
    'The front desk checks a staff member in or out by name, now (no card with them); the reason is kept. Back-dated changes use ATT-010',
  auth: 'attendance.mark',
  idempotent: 'required',
  request: deskCheckSchema,
  responses: { 200: { description: 'CHECKED_IN or CHECKED_OUT, with the member and status' } },
});
doc({
  id: 'ATT-032',
  method: 'get',
  path: '/api/v1/console/attendance/payroll',
  summary:
    'Payroll from attendance (client 2026-10-22): each teacher’s and staff member’s month (default this month; type ALL, TEACHERS or STAFF) — working days, present, late, half day, approved leave by type, absent and not marked, loss-of-pay days (an absent day without approved leave, half of a half day) and payable days (the month less loss of pay and days before joining or after leaving), with each day to check',
  auth: 'attendance.view',
  query: payrollQuery,
  responses: { 200: { description: 'Payroll month' } },
});

doc({
  id: 'ATT-033',
  method: 'get',
  path: '/api/v1/console/attendance/staff-timings',
  summary:
    'Staff timings by role (client 2026-10-23): login and logout time, late login, early logout, half-day and absent times, the roles each is for and how many staff follow it (first made first: it applies when a person’s roles are in two); with the roles to choose from',
  auth: 'attendance.view',
  responses: { 200: { description: 'Timings and roles' } },
});
doc({
  id: 'ATT-034',
  method: 'post',
  path: '/api/v1/console/attendance/staff-timings',
  summary:
    'Add a staff timing: a unique name, one or more roles not in another timing, and the times in the day’s order — login, late login, half day, absent, logout; early logout between login and logout',
  auth: 'attendance.config',
  request: staffTimingSchema,
  idempotent: 'required',
  responses: { 201: { description: 'Timing' } },
});
doc({
  id: 'ATT-035',
  method: 'put',
  path: '/api/v1/console/attendance/staff-timings/{timingId}',
  summary: 'Change a staff timing (If-Match); the same rules as ATT-034',
  auth: 'attendance.config',
  request: staffTimingSchema,
  responses: { 200: { description: 'Timing' } },
});
doc({
  id: 'ATT-036',
  method: 'delete',
  path: '/api/v1/console/attendance/staff-timings/{timingId}',
  summary: 'Remove a staff timing: its staff keep the school’s rules from then on',
  auth: 'attendance.config',
  responses: { 204: { description: 'Removed' } },
});

export function attendanceRoutes(deps: {
  db: Kysely<Database>;
  attendance: AttendanceService;
  admin: AttendanceAdminService;
  terminals: TerminalsService;
  loggers: Loggers;
}): Router {
  const router = Router();
  const L = deps.loggers;
  const once = idempotency({ db: deps.db, mode: 'required' });
  // The app's member, or the web console with one of the sub-tasks (teachers, Phase 10; the
  // principal, client 2026-10-13).
  const either = (...subTasks: string[]) => memberOrConsole(subTasks, L);
  const teaching = (sub: string) => teacherAccess(`teaching.${sub}`, L);
  const terminal = requireSurface(L, 'terminal');
  const console = [requireSurface(L, 'console'), requireTenant(L)];
  const wrap =
    (fn: RequestHandler): RequestHandler =>
    async (req, res, next) => {
      try {
        await fn(req, res, next);
      } catch (e) {
        next(e);
      }
    };
  const principal = (req: Request) => {
    if (!req.principal) throw new AuthenticationError();
    return req.principal;
  };
  const param = (req: Request, k: string) => String(req.params[k]);
  const json = (fn: (req: Request) => Promise<unknown>, code = 200): RequestHandler =>
    wrap(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.status(code).json(await fn(req));
    });

  // the reader
  router.post(
    '/terminal/reader/taps',
    terminal,
    once,
    json(async (req) => {
      const t = await deps.terminals.caller(req, ['ATTENDANCE', 'PERIOD_ATTENDANCE', 'LOCATION']);
      return deps.attendance.tap(t, tapSchema.parse(req.body ?? {}));
    }),
  );

  // the console
  router.get(
    '/console/attendance/overview',
    ...console,
    authorize('attendance.view', L),
    json((req) => deps.attendance.overview(principal(req), overviewQuery.parse(req.query))),
  );
  router.get(
    '/console/attendance/reports',
    ...console,
    authorize('attendance.view', L),
    json((req) => {
      const q = reportQuery.parse(req.query);
      return deps.attendance.report(principal(req), { ...q, sectionId: q.classSection });
    }),
  );
  router.put(
    '/console/attendance/daily',
    ...console,
    authorize('attendance.mark', L),
    json((req) => deps.attendance.markDaily(principal(req), dailySchema.parse(req.body ?? {}))),
  );
  // staff attendance at the front desk (client 2026-10-22)
  router.get(
    '/console/attendance/staff',
    ...console,
    authorize('attendance.view', L),
    json((req) => deps.attendance.staffRoster(principal(req), staffQuery.parse(req.query))),
  );
  router.get(
    '/console/attendance/payroll',
    ...console,
    authorize('attendance.view', L),
    json((req) => deps.attendance.payroll(principal(req), payrollQuery.parse(req.query))),
  );
  router.post(
    '/console/attendance/staff/card-taps',
    ...console,
    authorize('attendance.mark', L),
    once,
    json((req) => deps.attendance.deskTap(principal(req), deskTapSchema.parse(req.body ?? {}))),
  );
  router.post(
    '/console/attendance/staff/checks',
    ...console,
    authorize('attendance.mark', L),
    once,
    json((req) => deps.attendance.deskCheck(principal(req), deskCheckSchema.parse(req.body ?? {}))),
  );
  router.get(
    '/console/attendance/auto-absent',
    ...console,
    authorize('attendance.view', L),
    wrap(async (req, res) => {
      const out = await deps.admin.autoAbsent(principal(req));
      setEtag(res, out.version);
      res.json(out);
    }),
  );
  router.put(
    '/console/attendance/auto-absent',
    ...console,
    authorize('attendance.config', L),
    wrap(async (req, res) => {
      const out = await deps.admin.setAutoAbsent(
        principal(req),
        expectedVersion(req),
        autoAbsentSchema.parse(req.body ?? {}),
      );
      setEtag(res, out.version);
      res.json(out);
    }),
  );
  // the staff timings by role (client 2026-10-23)
  router.get(
    '/console/attendance/staff-timings',
    ...console,
    authorize('attendance.view', L),
    json((req) => deps.admin.staffTimings(principal(req))),
  );
  router.post(
    '/console/attendance/staff-timings',
    ...console,
    authorize('attendance.config', L),
    once,
    json(
      (req) =>
        deps.admin.createStaffTiming(principal(req), staffTimingSchema.parse(req.body ?? {})),
      201,
    ),
  );
  router.put(
    '/console/attendance/staff-timings/:timingId',
    ...console,
    authorize('attendance.config', L),
    wrap(async (req, res) => {
      const out = await deps.admin.updateStaffTiming(
        principal(req),
        param(req, 'timingId'),
        expectedVersion(req),
        staffTimingSchema.parse(req.body ?? {}),
      );
      setEtag(res, out.version);
      res.json(out);
    }),
  );
  router.delete(
    '/console/attendance/staff-timings/:timingId',
    ...console,
    authorize('attendance.config', L),
    wrap(async (req, res) => {
      await deps.admin.deleteStaffTiming(principal(req), param(req, 'timingId'));
      res.status(204).end();
    }),
  );
  router.get(
    '/console/attendance-types',
    ...console,
    authorize('attendance.view', L),
    json((req) => deps.admin.types(principal(req))),
  );
  router.post(
    '/console/attendance-types',
    ...console,
    authorize('attendance.config', L),
    once,
    json(
      (req) => deps.admin.createType(principal(req), attendanceTypeSchema.parse(req.body ?? {})),
      201,
    ),
  );
  router.get(
    '/console/visitors',
    ...console,
    authorize('frontdesk.view', L),
    json((req) => deps.admin.visitors(principal(req), dateQuery.parse(req.query))),
  );
  router.post(
    '/console/visitors',
    ...console,
    authorize('frontdesk.edit', L),
    once,
    json(
      (req) => deps.admin.recordVisitor(principal(req), visitorSchema.parse(req.body ?? {})),
      201,
    ),
  );
  router.post(
    '/console/visitors/:visitorId/checkout',
    ...console,
    authorize('frontdesk.edit', L),
    json((req) => deps.admin.checkOut(principal(req), param(req, 'visitorId'))),
  );
  router.post(
    '/console/location-attendance',
    ...console,
    authorize('frontdesk.edit', L),
    once,
    json(
      (req) =>
        deps.admin.captureLocation(principal(req), locationCaptureSchema.parse(req.body ?? {})),
      201,
    ),
  );

  // the teacher
  router.get(
    '/teacher/attendance/register',
    teaching('attendance'),
    json((req) => {
      const q = registerQuery.parse(req.query);
      return deps.attendance.register(principal(req), {
        sectionId: q.classSectionId,
        date: q.date,
      });
    }),
  );
  router.put(
    '/teacher/attendance/register',
    teaching('attendance'),
    json((req) => {
      const b = registerSchema.parse(req.body ?? {});
      return deps.attendance.saveRegister(principal(req), {
        sectionId: b.classSectionId,
        date: b.date,
        entries: b.entries,
      });
    }),
  );
  router.post(
    '/teacher/attendance/card-taps',
    teaching('attendance'),
    once,
    json((req) =>
      deps.attendance.teacherTap(principal(req), teacherTapSchema.parse(req.body ?? {})),
    ),
  );
  router.get(
    '/teacher/attendance/periods',
    teaching('attendance'),
    json((req) => deps.attendance.myPeriods(principal(req), dateQuery.parse(req.query))),
  );
  router.put(
    '/teacher/attendance/periods/:slotId',
    teaching('attendance'),
    json((req) =>
      deps.attendance.markPeriod(
        principal(req),
        param(req, 'slotId'),
        periodMarksSchema.parse(req.body ?? {}),
      ),
    ),
  );

  // the member and the principal
  router.get(
    '/me/attendance',
    either('teaching.view', 'principal.view'),
    json((req) => deps.attendance.myMonth(principal(req), monthQuery.parse(req.query))),
  );
  router.get(
    '/principal/attendance',
    either('principal.view'),
    json((req) => deps.attendance.principalDay(principal(req), principalQuery.parse(req.query))),
  );
  return router;
}
