import { Router, type Request, type RequestHandler } from 'express';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { defineRoute } from '../config/openapi-registry';
import { singleFileUpload, uploadErrors } from '../controllers/file.controller';
import type { Loggers } from '../controllers/logger';
import { authorize, requireSurface, requireTenant } from '../middlewares/auth.middleware';
import { idempotency } from '../middlewares/idempotency.middleware';
import type { Database } from '../models/ringpe_models';
import type { CalendarService } from '../services/calendar.service';
import type { CurriculumService } from '../services/curriculum.service';
import type { EnrolmentsService } from '../services/enrolments.service';
import type { TeachingService } from '../services/teaching.service';
import { AuthenticationError, ValidationError } from '../utils/CustomAPIError';
import { expectedVersion, setEtag } from '../utils/etag';

const date = z.iso.date({ message: 'VALIDATION.DATE' });
const uuid = z.string().max(40);
const yearQuery = z.object({ yearId: uuid.optional() });

export const entrySchema = z
  .strictObject({
    yearId: uuid.nullable().optional(),
    type: z.string({ message: 'ACA.CAL_TYPE' }).max(20, { message: 'ACA.CAL_TYPE' }),
    holidayType: z.string().max(30).nullable().optional(),
    title: z.string({ message: 'ACA.CAL_TITLE' }).max(80, { message: 'ACA.CAL_TITLE' }),
    description: z.string().max(500).nullable().optional(),
    allDay: z.boolean(),
    startDate: date,
    endDate: date,
    startTime: z.string().max(5).nullable().optional(),
    endTime: z.string().max(5).nullable().optional(),
    location: z.string().max(100).nullable().optional(),
    audience: z.strictObject({
      kind: z.enum(['ALL', 'CLASS', 'SECTION', 'MEMBER'], { message: 'ACA.CAL_AUDIENCE' }),
      ids: z.array(uuid).max(200).optional(),
    }),
    recurrence: z
      .enum(['NONE', 'DAILY', 'WEEKLY', 'MONTHLY'], { message: 'VALIDATION.FORMAT' })
      .optional(),
    repeatUntil: date.nullable().optional(),
    colour: z.string().max(7).optional(),
    reminders: z
      .array(z.enum(['DAY_BEFORE', 'HOUR_BEFORE', 'MORNING_OF']))
      .max(3)
      .optional(),
  })
  .meta({ id: 'CalendarEntryInput' });
export const subjectSchema = z
  .strictObject({
    code: z.string({ message: 'ACA.SUBJECT_CODE' }).max(5, { message: 'ACA.SUBJECT_CODE' }),
    name: z.string({ message: 'ACA.SUBJECT_NAME' }).max(40, { message: 'ACA.SUBJECT_NAME' }),
    colour: z.string().max(7).optional(),
  })
  .meta({ id: 'SubjectInput' });
export const subjectEditSchema = subjectSchema.omit({ code: true }).meta({ id: 'SubjectEdit' });
export const classSubjectsSchema = z
  .strictObject({ subjectIds: z.array(uuid).max(60) })
  .meta({ id: 'ClassSubjects' });
export const periodsSchema = z
  .strictObject({
    periods: z
      .array(
        z.strictObject({
          id: uuid.optional(),
          name: z.string({ message: 'ACA.PERIOD_NAME' }).max(30, { message: 'ACA.PERIOD_NAME' }),
          startsAt: z.string().max(5),
          endsAt: z.string().max(5),
          isBreak: z.boolean(),
        }),
      )
      .max(20),
  })
  .meta({ id: 'BellSchedule' });
export const assignmentSchema = z
  .strictObject({
    yearId: uuid.optional(),
    kind: z.enum(['CLASS_TEACHER', 'SUBJECT_TEACHER', 'COORDINATOR'], {
      message: 'VALIDATION.FORMAT',
    }),
    teacherId: uuid.optional(),
    sectionIds: z.array(uuid).max(60).optional(),
    classIds: z.array(uuid).max(60).optional(),
    subjectId: uuid.optional(),
    replace: z.boolean().optional(),
    copyFromYearId: uuid.optional(),
  })
  .meta({ id: 'TeacherAssignmentInput' });
export const timetableSchema = z
  .strictObject({
    yearId: uuid.optional(),
    slots: z
      .array(
        z.strictObject({
          day: z.number().int().min(1).max(6),
          periodId: uuid,
          subjectId: uuid,
          teacherId: uuid,
        }),
      )
      .max(80),
  })
  .meta({ id: 'TimetableInput' });
export const enrolSchema = z
  .strictObject({
    yearId: uuid.optional(),
    studentId: uuid,
    sectionId: uuid,
    enrolledOn: date.optional(),
  })
  .meta({ id: 'EnrolInput' });
export const transferSchema = z
  .strictObject({ sectionId: uuid, effectiveOn: date, reason: z.string().max(200) })
  .meta({ id: 'EnrolmentTransfer' });
export const correctionSchema = z
  .strictObject({ enrolmentId: uuid, sectionId: uuid, reason: z.string().max(500) })
  .meta({ id: 'ClosedYearCorrection' });
export const amendSchema = z
  .strictObject({
    outcome: z.enum(['PROMOTED', 'REPEATED', 'LEFT'], { message: 'VALIDATION.FORMAT' }),
    sectionId: uuid.nullable().optional(),
  })
  .meta({ id: 'RolloverAmendment' });

const calendarQuery = yearQuery.extend({
  from: date.optional(),
  to: date.optional(),
  type: z.string().max(20).optional(),
  deleted: z.enum(['true', 'false']).optional(),
});
const assignmentsQuery = yearQuery.extend({
  kind: z.enum(['CLASS_TEACHER', 'SUBJECT_TEACHER', 'COORDINATOR']).optional(),
});
const clashesQuery = yearQuery.extend({ teacherId: uuid.optional() });
const enrolmentsQuery = yearQuery.extend({
  classId: uuid.optional(),
  sectionId: uuid.optional(),
  q: z.string().max(60).optional(),
  cursor: z.string().max(40).optional(),
});
const rolloverQuery = z.object({ fromYearId: uuid.optional() });

const doc = (d: Omit<Parameters<typeof defineRoute>[0], 'tags'>) =>
  defineRoute({ ...d, tags: ['Academics'] });
// --- calendar ---------------------------------------------------------------------------------------------
doc({
  id: 'ACA-004',
  method: 'get',
  path: '/api/v1/console/calendar-events',
  summary:
    'The year’s calendar (default the current year) with each entry’s occurrences in the range (repeats expanded), counts, and the types, holiday types and reminders offered; deleted entries on request',
  auth: 'academics.view',
  query: calendarQuery,
  responses: { 200: { description: 'Calendar' } },
});
doc({
  id: 'ACA-005',
  method: 'post',
  path: '/api/v1/console/calendar-events',
  summary:
    'Add an entry inside the year: type, title (3–80), all day or timed, audience (all, classes, sections, a member), repeat until a date in the year, colour, reminders; no duplicate type, title and start date; a closed year refuses',
  auth: 'academics.edit',
  request: entrySchema,
  idempotent: 'required',
  responses: { 201: { description: 'Entry' } },
});
doc({
  id: 'ACA-006',
  method: 'patch',
  path: '/api/v1/console/calendar-events/{eventId}',
  summary: 'Edit an entry, or restore a deleted one ({"restore": true}); If-Match',
  auth: 'academics.edit',
  request: entrySchema,
  responses: { 200: { description: 'Entry' } },
});
doc({
  id: 'ACA-007',
  method: 'delete',
  path: '/api/v1/console/calendar-events/{eventId}',
  summary: 'Delete an entry (kept as deleted; restorable)',
  auth: 'academics.edit',
  responses: { 200: { description: 'Entry' } },
});
doc({
  id: 'ACA-008',
  method: 'post',
  path: '/api/v1/console/calendar-events/uploads',
  summary:
    'Upload entries (CSV: type, title, start_date, end_date, all_day, colour) into the year: commit=false checks every row, commit=true imports the accepted rows',
  auth: 'academics.edit',
  requestContentType: 'multipart/form-data',
  idempotent: 'required',
  responses: { 200: { description: 'Row report' } },
});
// --- classes, subjects and periods ------------------------------------------------------------------------
doc({
  id: 'ACA-014',
  method: 'post',
  path: '/api/v1/console/classes/uploads',
  summary:
    'Upload classes (CSV: class_name, sections, order): existing classes gain new sections; commit=false checks, commit=true imports the accepted rows',
  auth: 'academics.edit',
  requestContentType: 'multipart/form-data',
  idempotent: 'required',
  responses: { 200: { description: 'Row report' } },
});
doc({
  id: 'ACA-015',
  method: 'get',
  path: '/api/v1/console/subjects',
  summary: 'Subjects with the classes they are mapped to, the year’s teachers and periods a week',
  auth: 'academics.view',
  query: yearQuery,
  responses: { 200: { description: 'Subjects' } },
});
doc({
  id: 'ACA-016',
  method: 'post',
  path: '/api/v1/console/subjects',
  summary: 'Add a subject: code (2–5 capitals or digits, fixed), name (2–40), colour; both unique',
  auth: 'academics.edit',
  request: subjectSchema,
  idempotent: 'required',
  responses: { 201: { description: 'Subject' } },
});
doc({
  id: 'ACA-017',
  method: 'patch',
  path: '/api/v1/console/subjects/{subjectId}',
  summary: 'Rename a subject or change its colour (the code stays); If-Match',
  auth: 'academics.edit',
  request: subjectEditSchema,
  responses: { 200: { description: 'Subject' } },
});
doc({
  id: 'ACA-018',
  method: 'put',
  path: '/api/v1/console/classes/{classId}/subjects',
  summary:
    'The subjects a class studies (timetables and exams offer only these); a subject still on the class’s timetable can’t be unmapped; If-Match (the class version)',
  auth: 'academics.edit',
  request: classSubjectsSchema,
  responses: { 200: { description: 'Mapping' } },
});
doc({
  id: 'ACA-019',
  method: 'get',
  path: '/api/v1/console/periods',
  summary: 'The bell schedule: periods and breaks in order, minutes, timetable use (ETag)',
  auth: 'academics.view',
  responses: { 200: { description: 'Periods' } },
});
doc({
  id: 'ACA-020',
  method: 'put',
  path: '/api/v1/console/periods',
  summary:
    'Replace the bell schedule: unique names, no overlaps, ends after starts; a period on a timetable can’t be removed or made a break; If-Match',
  auth: 'academics.edit',
  request: periodsSchema,
  responses: { 200: { description: 'Periods' } },
});
// --- teacher assignments and timetables -------------------------------------------------------------------
doc({
  id: 'ACA-021',
  method: 'get',
  path: '/api/v1/console/teacher-assignments',
  summary:
    'The year’s class teachers (every section, assigned or not), subject teachers and coordinators, with the combined-portal flag (CR-02)',
  auth: 'academics.view',
  query: assignmentsQuery,
  responses: { 200: { description: 'Assignments' } },
});
doc({
  id: 'ACA-022',
  method: 'post',
  path: '/api/v1/console/teacher-assignments',
  summary:
    'Assign a class teacher (one per section and year; replace=true keeps the old as history), a subject teacher to sections where the subject is mapped, or a coordinator to classes; or copy a kind from an earlier year (copyFromYearId)',
  auth: 'academics.edit',
  request: assignmentSchema,
  idempotent: 'required',
  responses: { 201: { description: 'Assignments' } },
});
doc({
  id: 'ACA-023',
  method: 'delete',
  path: '/api/v1/console/teacher-assignments/{assignmentId}',
  summary:
    'Withdraw an assignment (kept as history); a subject teacher still on the timetable can’t be withdrawn',
  auth: 'academics.edit',
  responses: { 200: { description: 'Assignments' } },
});
doc({
  id: 'ACA-024',
  method: 'get',
  path: '/api/v1/console/timetables/{classSectionId}',
  summary:
    'A section’s week for the year: days, periods, lessons, and the subjects with their assigned teachers to choose from (ETag)',
  auth: 'academics.view',
  query: yearQuery,
  responses: { 200: { description: 'Timetable' } },
});
doc({
  id: 'ACA-025',
  method: 'put',
  path: '/api/v1/console/timetables/{classSectionId}',
  summary:
    'Save the section’s week: a mapped subject with a teacher assigned to it there, never on a break, never a teacher in two places in one period of the year; If-Match',
  auth: 'academics.edit',
  request: timetableSchema,
  responses: { 200: { description: 'Timetable' } },
});
doc({
  id: 'ACA-026',
  method: 'get',
  path: '/api/v1/console/timetables/clashes',
  summary: 'Teacher clashes in the year, and one teacher’s week (teacherId)',
  auth: 'academics.view',
  query: clashesQuery,
  responses: { 200: { description: 'Clashes' } },
});
// --- enrolments, corrections and roll-over ----------------------------------------------------------------
doc({
  id: 'ACA-027',
  method: 'get',
  path: '/api/v1/console/enrolments',
  summary:
    'The year’s enrolments (CR-09: name, admission no., class, section), filters and search, with any pending correction',
  auth: 'academics.view',
  query: enrolmentsQuery,
  responses: { 200: { description: 'Enrolments' } },
});
doc({
  id: 'ACA-028',
  method: 'post',
  path: '/api/v1/console/enrolments',
  summary:
    'Enrol an active student in a section for the year (one per year, dated inside it); the family is told',
  auth: 'academics.edit',
  request: enrolSchema,
  idempotent: 'required',
  responses: { 201: { description: 'Enrolment' } },
});
doc({
  id: 'ACA-029',
  method: 'post',
  path: '/api/v1/console/enrolments/{enrolmentId}/transfers',
  summary:
    'Move to another section of the same class (date in the year, reason 4–200); history kept; family told',
  auth: 'academics.edit',
  request: transferSchema,
  idempotent: 'required',
  responses: { 200: { description: 'Enrolment' } },
});
doc({
  id: 'ACA-030',
  method: 'post',
  path: '/api/v1/console/closed-year-corrections',
  summary:
    'Ask to correct an enrolment of a closed year (reason 10–500): the administrator approves it; recorded as an adjustment, the year stays closed',
  auth: 'academics.edit',
  request: correctionSchema,
  idempotent: 'required',
  responses: { 202: { description: 'Sent for approval' } },
});
doc({
  id: 'ACA-031',
  method: 'get',
  path: '/api/v1/console/rollover-proposals',
  summary:
    'The roll-over from a year (default the current) into the next: drawn once from the class order, with counts and every student’s outcome (ETag)',
  auth: 'academics.year',
  query: rolloverQuery,
  responses: { 200: { description: 'Proposal' } },
});
doc({
  id: 'ACA-032',
  method: 'patch',
  path: '/api/v1/console/rollover-proposals/{proposalId}/items/{studentId}',
  summary:
    'Amend one student: promote into a section, repeat (a section of the same class) or leave; If-Match',
  auth: 'academics.year',
  request: amendSchema,
  responses: { 200: { description: 'Proposal' } },
});
doc({
  id: 'ACA-033',
  method: 'post',
  path: '/api/v1/console/rollover-proposals/{proposalId}/commit',
  summary:
    'Commit as a whole: enrolments in the next year (promoted or repeated), leavers recorded and kept; families told; If-Match',
  auth: 'academics.year',
  idempotent: 'required',
  responses: { 200: { description: 'Committed' } },
});

/** Mounted under /api/v1. */
export function structureRoutes(deps: {
  db: Kysely<Database>;
  calendar: CalendarService;
  curriculum: CurriculumService;
  teaching: TeachingService;
  enrolments: EnrolmentsService;
  loggers: Loggers;
}): Router {
  const router = Router();
  const L = deps.loggers;
  const once = idempotency({ db: deps.db, mode: 'required' });
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
  const console = [requireSurface(L, 'console'), requireTenant(L)];
  const view = authorize('academics.view', L);
  const edit = authorize('academics.edit', L);
  const year = authorize('academics.year', L);
  const etag = (res: Parameters<RequestHandler>[1], out: { version: number }) =>
    setEtag(res, out.version);
  const upload = (
    fn: (req: Request, content: string, commit: boolean) => Promise<unknown>,
  ): RequestHandler =>
    wrap(async (req, res) => {
      if (!req.file) throw new ValidationError([{ field: 'file', code: 'UPL.FILE_REQUIRED' }]);
      const body = (req.body ?? {}) as Record<string, unknown>;
      res.json(await fn(req, req.file.buffer.toString('utf8'), body['commit'] === 'true'));
    });

  // calendar
  router.get(
    '/console/calendar-events',
    ...console,
    view,
    wrap(async (req, res) => {
      const q = calendarQuery.parse(req.query);
      res.json(await deps.calendar.list(principal(req), { ...q, deleted: q.deleted === 'true' }));
    }),
  );
  router.post(
    '/console/calendar-events/uploads',
    ...console,
    edit,
    once,
    singleFileUpload,
    uploadErrors,
    upload((req, content, commit) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const yearId = typeof body['yearId'] === 'string' ? body['yearId'] : undefined;
      return deps.calendar.upload(principal(req), { yearId, content, commit });
    }),
  );
  router.post(
    '/console/calendar-events',
    ...console,
    edit,
    once,
    wrap(async (req, res) => {
      const out = await deps.calendar.create(principal(req), entrySchema.parse(req.body ?? {}));
      etag(res, out);
      res.status(201).json(out);
    }),
  );
  router.patch(
    '/console/calendar-events/:eventId',
    ...console,
    edit,
    wrap(async (req, res) => {
      const p = principal(req);
      const id = param(req, 'eventId');
      await deps.calendar.entry(p, id);
      const b = req.body as Record<string, unknown> | undefined;
      const input =
        b && b['restore'] === true ? ({ restore: true } as const) : entrySchema.parse(b ?? {});
      const out = await deps.calendar.update(p, id, expectedVersion(req), input);
      etag(res, out);
      res.json(out);
    }),
  );
  router.delete(
    '/console/calendar-events/:eventId',
    ...console,
    edit,
    wrap(async (req, res) => {
      res.json(await deps.calendar.remove(principal(req), param(req, 'eventId')));
    }),
  );

  // classes, subjects, periods
  router.post(
    '/console/classes/uploads',
    ...console,
    edit,
    once,
    singleFileUpload,
    uploadErrors,
    upload((req, content, commit) =>
      deps.curriculum.uploadClasses(principal(req), { content, commit }),
    ),
  );
  router.get(
    '/console/subjects',
    ...console,
    view,
    wrap(async (req, res) => {
      res.json(await deps.curriculum.subjects(principal(req), yearQuery.parse(req.query)));
    }),
  );
  router.post(
    '/console/subjects',
    ...console,
    edit,
    once,
    wrap(async (req, res) => {
      const out = await deps.curriculum.createSubject(
        principal(req),
        subjectSchema.parse(req.body ?? {}),
      );
      etag(res, out);
      res.status(201).json(out);
    }),
  );
  router.patch(
    '/console/subjects/:subjectId',
    ...console,
    edit,
    wrap(async (req, res) => {
      // The subject first: another institution's id is a 404 before the body is looked at.
      await deps.curriculum.subject(principal(req), param(req, 'subjectId'));
      const out = await deps.curriculum.updateSubject(
        principal(req),
        param(req, 'subjectId'),
        expectedVersion(req),
        subjectEditSchema.parse(req.body ?? {}),
      );
      etag(res, out);
      res.json(out);
    }),
  );
  router.get(
    '/console/classes/:classId/subjects',
    ...console,
    view,
    wrap(async (req, res) => {
      const out = await deps.curriculum.classSubjects(principal(req), param(req, 'classId'));
      etag(res, out);
      res.json(out);
    }),
  );
  router.put(
    '/console/classes/:classId/subjects',
    ...console,
    edit,
    wrap(async (req, res) => {
      const p = principal(req);
      await deps.curriculum.classSubjects(p, param(req, 'classId'));
      const out = await deps.curriculum.setClassSubjects(
        p,
        param(req, 'classId'),
        expectedVersion(req),
        classSubjectsSchema.parse(req.body ?? {}).subjectIds,
      );
      etag(res, out);
      res.json(out);
    }),
  );
  router.get(
    '/console/periods',
    ...console,
    view,
    wrap(async (req, res) => {
      const out = await deps.curriculum.periods(principal(req));
      etag(res, out);
      res.json(out);
    }),
  );
  router.put(
    '/console/periods',
    ...console,
    edit,
    wrap(async (req, res) => {
      const out = await deps.curriculum.setPeriods(
        principal(req),
        expectedVersion(req),
        periodsSchema.parse(req.body ?? {}).periods,
      );
      etag(res, out);
      res.json(out);
    }),
  );

  // teacher assignments and timetables
  router.get(
    '/console/teacher-assignments',
    ...console,
    view,
    wrap(async (req, res) => {
      res.json(await deps.teaching.assignments(principal(req), assignmentsQuery.parse(req.query)));
    }),
  );
  router.post(
    '/console/teacher-assignments',
    ...console,
    edit,
    once,
    wrap(async (req, res) => {
      res
        .status(201)
        .json(await deps.teaching.assign(principal(req), assignmentSchema.parse(req.body ?? {})));
    }),
  );
  router.delete(
    '/console/teacher-assignments/:assignmentId',
    ...console,
    edit,
    wrap(async (req, res) => {
      res.json(await deps.teaching.withdraw(principal(req), param(req, 'assignmentId')));
    }),
  );
  router.get(
    '/console/timetables/clashes',
    ...console,
    view,
    wrap(async (req, res) => {
      res.json(await deps.teaching.clashes(principal(req), clashesQuery.parse(req.query)));
    }),
  );
  router.get(
    '/console/timetables/:classSectionId',
    ...console,
    view,
    wrap(async (req, res) => {
      const out = await deps.teaching.timetable(
        principal(req),
        param(req, 'classSectionId'),
        yearQuery.parse(req.query),
      );
      etag(res, out);
      res.json(out);
    }),
  );
  router.put(
    '/console/timetables/:classSectionId',
    ...console,
    edit,
    wrap(async (req, res) => {
      const p = principal(req);
      await deps.teaching.sectionOf(p, param(req, 'classSectionId'));
      const b = timetableSchema.parse(req.body ?? {});
      const out = await deps.teaching.saveTimetable(
        p,
        param(req, 'classSectionId'),
        expectedVersion(req),
        b,
      );
      etag(res, out);
      res.json(out);
    }),
  );

  // enrolments, corrections, roll-over
  router.get(
    '/console/enrolments',
    ...console,
    view,
    wrap(async (req, res) => {
      res.json(await deps.enrolments.list(principal(req), enrolmentsQuery.parse(req.query)));
    }),
  );
  router.post(
    '/console/enrolments',
    ...console,
    edit,
    once,
    wrap(async (req, res) => {
      res
        .status(201)
        .json(await deps.enrolments.enrol(principal(req), enrolSchema.parse(req.body ?? {})));
    }),
  );
  router.post(
    '/console/enrolments/:enrolmentId/transfers',
    ...console,
    edit,
    once,
    wrap(async (req, res) => {
      const p = principal(req);
      await deps.enrolments.one(p, param(req, 'enrolmentId'));
      res.json(
        await deps.enrolments.transfer(
          p,
          param(req, 'enrolmentId'),
          transferSchema.parse(req.body ?? {}),
        ),
      );
    }),
  );
  router.post(
    '/console/closed-year-corrections',
    ...console,
    edit,
    once,
    wrap(async (req, res) => {
      const out = await deps.enrolments.requestCorrection(
        principal(req),
        correctionSchema.parse(req.body ?? {}),
      );
      res.status(out.appliedDirectly ? 200 : 202).json(out);
    }),
  );
  router.get(
    '/console/rollover-proposals',
    ...console,
    year,
    wrap(async (req, res) => {
      const out = await deps.enrolments.proposal(principal(req), rolloverQuery.parse(req.query));
      etag(res, out);
      res.json(out);
    }),
  );
  router.patch(
    '/console/rollover-proposals/:proposalId/items/:studentId',
    ...console,
    year,
    wrap(async (req, res) => {
      await deps.enrolments.itemOf(
        principal(req),
        param(req, 'proposalId'),
        param(req, 'studentId'),
      );
      const out = await deps.enrolments.amend(
        principal(req),
        param(req, 'proposalId'),
        param(req, 'studentId'),
        expectedVersion(req),
        amendSchema.parse(req.body ?? {}),
      );
      etag(res, out);
      res.json(out);
    }),
  );
  router.post(
    '/console/rollover-proposals/:proposalId/commit',
    ...console,
    year,
    once,
    wrap(async (req, res) => {
      const out = await deps.enrolments.commit(
        principal(req),
        param(req, 'proposalId'),
        expectedVersion(req),
      );
      etag(res, out);
      res.json(out);
    }),
  );
  return router;
}
