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
import type { Database } from '../models/campusone_models';
import type { LeaveService } from '../services/leave.service';
import type { PrincipalService } from '../services/principal.service';
import { AuthenticationError } from '../utils/CustomAPIError';
import { expectedVersion, setEtag } from '../utils/etag';

const date = z.iso.date({ message: 'VALIDATION.DATE' });
const uuid = z.string().max(40);
const decision = z.enum(['APPROVED', 'REJECTED'], { message: 'VALIDATION.FORMAT' });

export const studentLeaveSchema = z
  .strictObject({
    for: uuid.optional(),
    from: date,
    to: date,
    reason: z.string({ message: 'ACA.LEAVE_REASON' }).max(300, { message: 'ACA.LEAVE_REASON' }),
    fileId: uuid.nullable().optional(),
  })
  .meta({ id: 'StudentLeaveInput' });
export const staffLeaveSchema = z
  .strictObject({
    type: z.enum(['CASUAL', 'MEDICAL', 'EARNED'], { message: 'ACA.LEAVE_TYPE' }),
    from: date,
    to: date,
    reason: z.string({ message: 'ACA.LEAVE_REASON' }).max(250, { message: 'ACA.LEAVE_REASON' }),
  })
  .meta({ id: 'StaffLeaveInput' });
export const leaveDecisionSchema = z
  .strictObject({ decision, remarks: z.string().max(400).nullable().optional() })
  .meta({ id: 'LeaveDecision' });

const yearQuery = z.object({ yearId: uuid.optional() });
const forQuery = yearQuery.extend({ for: uuid.optional() });
const coordinatorQuery = yearQuery.extend({
  status: z.enum(['PENDING', 'REVIEWED', 'all']).optional(),
  q: z.string().max(60).optional(),
});
const classQuery = yearQuery.extend({
  status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'all']).optional(),
  classSectionId: uuid.optional(),
});
const principalQuery = yearQuery.extend({
  status: z.enum(['AWAITING', 'COORDINATOR', 'DECIDED']).optional(),
});
const peopleQuery = z.object({
  type: z.enum(['STUDENTS', 'TEACHERS', 'STAFF']).optional(),
  classSection: uuid.optional(),
  q: z.string().max(60).optional(),
  cursor: z.string().max(40).optional(),
});

const doc = (d: Omit<Parameters<typeof defineRoute>[0], 'tags'>) =>
  defineRoute({ ...d, tags: ['Academics'] });
doc({
  id: 'ACA-042',
  method: 'get',
  path: '/api/v1/console/teacher-leaves',
  summary:
    'Teacher leave for the coordinator’s first review — scoped to the classes the signed-in coordinator coordinates (OI-ACA-49) — with counts (waiting, with the principal, away this week, days requested)',
  auth: 'leave.view',
  query: coordinatorQuery,
  responses: { 200: { description: 'Leave' } },
});
doc({
  id: 'ACA-076',
  method: 'get',
  path: '/api/v1/console/teacher-leaves/{leaveId}',
  summary: 'One teacher leave request with the balance of its type and the periods it affects',
  auth: 'leave.view',
  responses: { 200: { description: 'Leave' } },
});
doc({
  id: 'ACA-043',
  method: 'post',
  path: '/api/v1/console/teacher-leaves/{leaveId}/coordinator-decision',
  summary:
    'The coordinator recommends (APPROVED) or rejects with feedback (5–400); never their own request; the teacher and, when recommended, the principal are told; If-Match',
  auth: 'leave.decide',
  request: leaveDecisionSchema,
  idempotent: 'required',
  responses: { 200: { description: 'Leave' } },
});
doc({
  id: 'ACA-055',
  method: 'get',
  path: '/api/v1/teacher/student-leaves',
  summary: 'Student leave requests for the sections the teacher is class teacher of, by status',
  auth: 'member|teaching.leave',
  query: classQuery,
  responses: { 200: { description: 'Requests' } },
});
doc({
  id: 'ACA-056',
  method: 'post',
  path: '/api/v1/teacher/student-leaves/{leaveId}/decision',
  summary:
    'The class teacher approves or rejects (remarks of 5–200 characters when rejecting); the family is told',
  auth: 'member|teaching.leave',
  request: leaveDecisionSchema,
  idempotent: 'required',
  responses: { 200: { description: 'Request' } },
});
doc({
  id: 'ACA-057',
  method: 'get',
  path: '/api/v1/me/staff-leaves',
  summary: 'My leave requests this year and my balances (casual, medical, earned)',
  auth: 'member|teaching.view,principal.view',
  query: yearQuery,
  responses: { 200: { description: 'Leave' } },
});
doc({
  id: 'ACA-058',
  method: 'post',
  path: '/api/v1/me/staff-leaves',
  summary:
    'Apply for leave from today inside the year: working days only, no overlap, within the balance; a teacher’s request goes to the coordinator, other staff to the principal',
  auth: 'member|teaching.view,principal.view',
  request: staffLeaveSchema,
  idempotent: 'required',
  responses: { 201: { description: 'Leave' } },
});
doc({
  id: 'ACA-059',
  method: 'post',
  path: '/api/v1/me/staff-leaves/{leaveId}/cancellation',
  summary: 'Cancel my request while no one has reviewed it',
  auth: 'member|teaching.view,principal.view',
  idempotent: 'required',
  responses: { 200: { description: 'Leave' } },
});
doc({
  id: 'ACA-060',
  method: 'get',
  path: '/api/v1/principal/overview',
  summary:
    'The principal’s day: people, teacher leave awaiting them or with the coordinator, student leave pending, staff on leave today, section standings and upcoming exams',
  auth: 'member|principal.view',
  responses: { 200: { description: 'Overview' } },
});
doc({
  id: 'ACA-061',
  method: 'get',
  path: '/api/v1/principal/teacher-leaves',
  summary:
    'Leave awaiting the principal (after the coordinator, or staff directly), with the coordinator, or decided — with balances and who else is away',
  auth: 'member|principal.view',
  query: principalQuery,
  responses: { 200: { description: 'Leave' } },
});
doc({
  id: 'ACA-062',
  method: 'post',
  path: '/api/v1/principal/teacher-leaves/{leaveId}/decision',
  summary:
    'The final decision, only after the coordinator recommended (OI-ACA-51); a reason when rejecting; never their own request; the staff member is told',
  auth: 'member|principal.leave',
  request: leaveDecisionSchema,
  idempotent: 'required',
  responses: { 200: { description: 'Leave' } },
});
doc({
  id: 'ACA-064',
  method: 'get',
  path: '/api/v1/principal/people',
  summary:
    'Students of the year (CR-09: name, admission number, class, section) or teachers and staff with their classes and subjects',
  auth: 'member|principal.view',
  query: peopleQuery,
  responses: { 200: { description: 'People' } },
});
doc({
  id: 'ACA-079',
  method: 'get',
  path: '/api/v1/principal/student-overview',
  summary:
    'Student Overview (SRS 20.32): every student — name, member number, class and section of the year, admission number, department, status and primary contact — for the screen to search and filter; read-only',
  auth: 'member|principal.view',
  responses: { 200: { description: 'Students' } },
});
doc({
  id: 'ACA-082',
  method: 'get',
  path: '/api/v1/principal/student-overview/{studentId}',
  summary:
    'One student in full (SRS 20.32 detail; client 2026-10-14): personal details, family and addresses, the admission, transport and the hostel, the year’s fees and their status, the campus wallet, attendance and leave; read-only',
  auth: 'member|principal.view',
  responses: { 200: { description: 'Student' } },
});
doc({
  id: 'ACA-080',
  method: 'get',
  path: '/api/v1/principal/teacher-overview',
  summary:
    'Teacher Overview (SRS 20.33): the teachers of the year’s class-teacher and subject-teacher mapping, each once — first assignment’s class-section, roles, number of assignments — and the classes for the filter',
  auth: 'member|principal.view',
  responses: { 200: { description: 'Teachers' } },
});
doc({
  id: 'ACA-081',
  method: 'get',
  path: '/api/v1/principal/teacher-overview/{teacherId}',
  summary:
    'One teacher (SRS 20.33): e-mail, mobile, the number of classes, sections and subjects, and the year’s academic assignments — with personal details, console roles, classes led or coordinated, the week’s timetable, attendance, leave and balances, homework, exams and marks entry, transport and the wallet (client 2026-10-14)',
  auth: 'member|principal.view',
  responses: { 200: { description: 'Teacher' } },
});
doc({
  id: 'ACA-072',
  method: 'get',
  path: '/api/v1/me/leaves',
  summary:
    'The student’s leave requests for the year and the class teacher who reviews them (for: a child on the account)',
  auth: 'member',
  query: forQuery,
  responses: { 200: { description: 'Requests' } },
});
doc({
  id: 'ACA-073',
  method: 'post',
  path: '/api/v1/me/leaves',
  summary:
    'Apply for a student’s leave from today inside the year: school days only, no overlap with a pending or approved request (BR-53), a reason, an optional document (≤ 2 MB, uploaded); the class teachers are told',
  auth: 'member',
  request: studentLeaveSchema,
  idempotent: 'required',
  responses: { 201: { description: 'Request' } },
});
doc({
  id: 'ACA-074',
  method: 'post',
  path: '/api/v1/me/leaves/{leaveId}/withdrawal',
  summary: 'Withdraw a pending request; the class teachers are told',
  auth: 'member',
  query: forQuery,
  idempotent: 'required',
  responses: { 200: { description: 'Request' } },
});

export function leaveRoutes(deps: {
  db: Kysely<Database>;
  leave: LeaveService;
  principal: PrincipalService;
  loggers: Loggers;
}): Router {
  const router = Router();
  const L = deps.loggers;
  const once = idempotency({ db: deps.db, mode: 'required' });
  const member = requireSurface(L, 'member');
  // The app's member, or the web console with one of the sub-tasks (teachers, Phase 10; the
  // principal, client 2026-10-13).
  const either = (...subTasks: string[]) => memberOrConsole(subTasks, L);
  const teaching = (sub: string) => teacherAccess(`teaching.${sub}`, L);
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
  const json = (fn: (req: Request) => Promise<unknown>, status = 200): RequestHandler =>
    wrap(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.status(status).json(await fn(req));
    });

  // the console coordinator
  router.get(
    '/console/teacher-leaves',
    ...console,
    authorize('leave.view', L),
    json((req) => deps.leave.coordinatorList(principal(req), coordinatorQuery.parse(req.query))),
  );
  router.get(
    '/console/teacher-leaves/:leaveId',
    ...console,
    authorize('leave.view', L),
    wrap(async (req, res) => {
      const out = await deps.leave.coordinatorDetail(principal(req), param(req, 'leaveId'));
      setEtag(res, out.version);
      res.json(out);
    }),
  );
  router.post(
    '/console/teacher-leaves/:leaveId/coordinator-decision',
    ...console,
    authorize('leave.decide', L),
    once,
    wrap(async (req, res) => {
      const p = principal(req);
      await deps.leave.staffLookup(p, param(req, 'leaveId'));
      const out = await deps.leave.coordinatorDecide(
        p,
        param(req, 'leaveId'),
        expectedVersion(req),
        leaveDecisionSchema.parse(req.body ?? {}),
      );
      setEtag(res, out.version);
      res.json(out);
    }),
  );

  // the teacher and staff
  router.get(
    '/teacher/student-leaves',
    teaching('leave'),
    json((req) => {
      const q = classQuery.parse(req.query);
      return deps.leave.classRequests(principal(req), {
        status: q.status,
        sectionId: q.classSectionId,
        yearId: q.yearId,
      });
    }),
  );
  router.post(
    '/teacher/student-leaves/:leaveId/decision',
    teaching('leave'),
    once,
    json(async (req) => {
      const p = principal(req);
      await deps.leave.studentLookup(p, param(req, 'leaveId'));
      return deps.leave.decideStudent(
        p,
        param(req, 'leaveId'),
        leaveDecisionSchema.parse(req.body ?? {}),
      );
    }),
  );
  router.get(
    '/me/staff-leaves',
    either('teaching.view', 'principal.view'),
    json((req) => deps.leave.staffMine(principal(req), yearQuery.parse(req.query))),
  );
  router.post(
    '/me/staff-leaves',
    either('teaching.view', 'principal.view'),
    once,
    json(
      (req) => deps.leave.applyStaff(principal(req), staffLeaveSchema.parse(req.body ?? {})),
      201,
    ),
  );
  router.post(
    '/me/staff-leaves/:leaveId/cancellation',
    either('teaching.view', 'principal.view'),
    once,
    json((req) => deps.leave.cancelStaff(principal(req), param(req, 'leaveId'))),
  );

  // the principal
  router.get(
    '/principal/overview',
    either('principal.view'),
    json((req) => deps.principal.overview(principal(req))),
  );
  router.get(
    '/principal/teacher-leaves',
    either('principal.view'),
    json((req) => deps.leave.principalList(principal(req), principalQuery.parse(req.query))),
  );
  router.post(
    '/principal/teacher-leaves/:leaveId/decision',
    either('principal.leave'),
    once,
    json(async (req) => {
      const p = principal(req);
      await deps.leave.staffLookup(p, param(req, 'leaveId'));
      return deps.leave.principalDecide(
        p,
        param(req, 'leaveId'),
        leaveDecisionSchema.parse(req.body ?? {}),
      );
    }),
  );
  router.get(
    '/principal/people',
    either('principal.view'),
    json((req) => {
      const q = peopleQuery.parse(req.query);
      return deps.principal.people(principal(req), {
        type: q.type,
        sectionId: q.classSection,
        q: q.q,
        cursor: q.cursor,
      });
    }),
  );

  // Student Overview and Teacher Overview (SRS 20.32, 20.33; client 2026-10-14)
  router.get(
    '/principal/student-overview',
    either('principal.view'),
    json((req) => deps.principal.studentOverview(principal(req))),
  );
  router.get(
    '/principal/student-overview/:studentId',
    either('principal.view'),
    json((req) => deps.principal.studentDetail(principal(req), param(req, 'studentId'))),
  );
  router.get(
    '/principal/teacher-overview',
    either('principal.view'),
    json((req) => deps.principal.teacherOverview(principal(req))),
  );
  router.get(
    '/principal/teacher-overview/:teacherId',
    either('principal.view'),
    json((req) => deps.principal.teacherDetail(principal(req), param(req, 'teacherId'))),
  );

  // the student and family
  router.get(
    '/me/leaves',
    member,
    json((req) => deps.leave.mine(principal(req), forQuery.parse(req.query))),
  );
  router.post(
    '/me/leaves',
    member,
    once,
    json((req) => deps.leave.apply(principal(req), studentLeaveSchema.parse(req.body ?? {})), 201),
  );
  router.post(
    '/me/leaves/:leaveId/withdrawal',
    member,
    once,
    json((req) =>
      deps.leave.withdraw(principal(req), param(req, 'leaveId'), forQuery.parse(req.query)),
    ),
  );
  return router;
}
