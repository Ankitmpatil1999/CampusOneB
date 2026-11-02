import { Router, type Request, type RequestHandler } from 'express';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { defineRoute } from '../config/openapi-registry';
import type { Loggers } from '../controllers/logger';
import { memberOrConsole, requireSurface, teacherAccess } from '../middlewares/auth.middleware';
import { idempotency } from '../middlewares/idempotency.middleware';
import type { Database } from '../models/campusone_models';
import type { CalendarService } from '../services/calendar.service';
import type { ClassroomService } from '../services/classroom.service';
import type { HomeworkService } from '../services/homework.service';
import { AuthenticationError } from '../utils/CustomAPIError';
import { expectedVersion, setEtag } from '../utils/etag';

const date = z.iso.date({ message: 'VALIDATION.DATE' });
const uuid = z.string().max(40);

export const homeworkSchema = z
  .strictObject({
    classSectionId: uuid,
    subjectId: uuid,
    type: z.enum(['HOMEWORK', 'CLASSWORK'], { message: 'VALIDATION.FORMAT' }),
    title: z.string({ message: 'ACA.HW_TITLE' }).max(80, { message: 'ACA.HW_TITLE' }),
    instructions: z
      .string({ message: 'ACA.HW_INSTRUCTIONS' })
      .max(600, { message: 'ACA.HW_INSTRUCTIONS' }),
    dueDate: date,
    studentIds: z.array(uuid).max(200).optional(),
    fileId: uuid.nullable().optional(),
    link: z.string().max(300, { message: 'ACA.HW_LINK' }).nullable().optional(),
  })
  .meta({ id: 'HomeworkInput' });
export const reviewSchema = z
  .strictObject({
    grade: z.string({ message: 'ACA.GRADE' }).max(10, { message: 'ACA.GRADE' }),
    feedback: z.string().max(300, { message: 'ACA.FEEDBACK' }).nullable().optional(),
  })
  .meta({ id: 'SubmissionReview' });
export const submissionSchema = z
  .strictObject({
    fileId: uuid.nullable().optional(),
    link: z.string().max(300, { message: 'ACA.HW_LINK' }).nullable().optional(),
    note: z.string().max(300).nullable().optional(),
  })
  .meta({ id: 'HomeworkSubmission' });

const yearQuery = z.object({ yearId: uuid.optional() });
const timetableQuery = yearQuery.extend({ classSectionId: uuid.optional() });
const teacherHomeworkQuery = yearQuery.extend({
  classSectionId: uuid.optional(),
  filter: z.enum(['all', 'review', 'HOMEWORK', 'CLASSWORK']).optional(),
});
const forQuery = yearQuery.extend({ for: uuid.optional() });
const calendarQuery = forQuery.extend({ from: date.optional(), to: date.optional() });
const myHomeworkQuery = forQuery.extend({
  status: z.enum(['PENDING', 'SUBMITTED', 'REVIEWED']).optional(),
});

const doc = (d: Omit<Parameters<typeof defineRoute>[0], 'tags'>) =>
  defineRoute({ ...d, tags: ['Academics'] });
doc({
  id: 'ACA-044',
  method: 'get',
  path: '/api/v1/teacher/today',
  summary:
    'The teacher’s day built from their assignments (CR-02): class-teacher sections, subject sections, today’s periods (done, now, later) and submissions to review; not-assigned when there are none',
  auth: 'member|teaching.view',
  responses: { 200: { description: 'Today' } },
});
doc({
  id: 'ACA-045',
  method: 'get',
  path: '/api/v1/teacher/classes',
  summary: 'The sections the teacher teaches in the year: class teacher or subjects, and students',
  auth: 'member|teaching.view',
  query: yearQuery,
  responses: { 200: { description: 'Classes' } },
});
doc({
  id: 'ACA-046',
  method: 'get',
  path: '/api/v1/teacher/classes/{classSectionId}/students',
  summary:
    'The section’s roster for the year (CR-09: name, admission number, class, section); only for a teacher assigned to it',
  auth: 'member|teaching.view',
  query: yearQuery,
  responses: { 200: { description: 'Roster' } },
});
doc({
  id: 'ACA-047',
  method: 'get',
  path: '/api/v1/teacher/timetable',
  summary: 'The teacher’s week and, with classSectionId, the week of a section they teach',
  auth: 'member|teaching.view',
  query: timetableQuery,
  responses: { 200: { description: 'Timetable' } },
});
doc({
  id: 'ACA-048',
  method: 'get',
  path: '/api/v1/teacher/homework',
  summary:
    'Homework and classwork the teacher set in the year with submission counts (filter: all, review, HOMEWORK, CLASSWORK), and the sections and subjects they may set it for',
  auth: 'member|teaching.homework',
  query: teacherHomeworkQuery,
  responses: { 200: { description: 'Homework' } },
});
doc({
  id: 'ACA-049',
  method: 'post',
  path: '/api/v1/teacher/homework',
  summary:
    'Set homework (due after today) or classwork (today or later), due 11:59 PM on the date inside the year, for a section the teacher teaches (class teacher, or subject teacher of the subject) — the whole class or chosen enrolled students; a file (≤ 2 MB, uploaded) or a link; students and families told',
  auth: 'member|teaching.homework',
  request: homeworkSchema,
  idempotent: 'required',
  responses: { 201: { description: 'Homework' } },
});
doc({
  id: 'ACA-050',
  method: 'get',
  path: '/api/v1/teacher/homework/{homeworkId}/submissions',
  summary:
    'The homework with each student it went to, their record and submission (file link, late)',
  auth: 'member|teaching.homework',
  responses: { 200: { description: 'Submissions' } },
});
doc({
  id: 'ACA-051',
  method: 'patch',
  path: '/api/v1/teacher/submissions/{submissionId}',
  summary:
    'Review a submission with a grade and feedback (again if needed); the student and family told; If-Match',
  auth: 'member|teaching.homework',
  request: reviewSchema,
  responses: { 200: { description: 'Row' } },
});
doc({
  id: 'ACA-075',
  method: 'post',
  path: '/api/v1/teacher/homework/{homeworkId}/reminders',
  summary: 'Remind the students who haven’t submitted, and their families, until the due time',
  auth: 'member|teaching.homework',
  idempotent: 'required',
  responses: { 200: { description: 'Sent' } },
});
doc({
  id: 'ACA-065',
  method: 'get',
  path: '/api/v1/me/timetable',
  summary: 'The student’s week for the year (for: a child on the account)',
  auth: 'member',
  query: forQuery,
  responses: { 200: { description: 'Timetable' } },
});
doc({
  id: 'ACA-066',
  method: 'get',
  path: '/api/v1/me/calendar',
  summary:
    'The member’s calendar: entries for everyone, for the student’s class or section that year, or for the member, with occurrences in the range (for: a child on the account)',
  auth: 'member|teaching.view,principal.view',
  query: calendarQuery,
  responses: { 200: { description: 'Calendar' } },
});
doc({
  id: 'ACA-067',
  method: 'get',
  path: '/api/v1/me/homework',
  summary:
    'The student’s homework by state — pending (overdue once due), submitted, reviewed — with counts (for: a child on the account)',
  auth: 'member',
  query: myHomeworkQuery,
  responses: { 200: { description: 'Homework' } },
});
doc({
  id: 'ACA-068',
  method: 'get',
  path: '/api/v1/me/homework/{homeworkId}',
  summary: 'One homework with the teacher’s file link, the submission and the review',
  auth: 'member',
  query: forQuery,
  responses: { 200: { description: 'Homework' } },
});
doc({
  id: 'ACA-069',
  method: 'post',
  path: '/api/v1/me/homework/{homeworkId}/submissions',
  summary:
    'The student submits once: an uploaded file (≤ 2 MB) or a link, with a note; late after the due time; the teacher is told',
  auth: 'member',
  request: submissionSchema,
  idempotent: 'required',
  responses: { 201: { description: 'Homework' } },
});

export function classroomRoutes(deps: {
  db: Kysely<Database>;
  classroom: ClassroomService;
  homework: HomeworkService;
  calendar: CalendarService;
  loggers: Loggers;
}): Router {
  const router = Router();
  // The app's member, or the web console with one of the sub-tasks (teachers, Phase 10; the
  // principal, client 2026-10-13).
  const either = (...subTasks: string[]) => memberOrConsole(subTasks, deps.loggers);
  const member = requireSurface(deps.loggers, 'member');
  const teaching = (sub: string) => teacherAccess(`teaching.${sub}`, deps.loggers);
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
  const json = (fn: (req: Request) => Promise<unknown>): RequestHandler =>
    wrap(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.json(await fn(req));
    });

  // the teacher
  router.get(
    '/teacher/today',
    teaching('view'),
    json((req) => deps.classroom.today(principal(req))),
  );
  router.get(
    '/teacher/classes',
    teaching('view'),
    json((req) => deps.classroom.classes(principal(req), yearQuery.parse(req.query))),
  );
  router.get(
    '/teacher/classes/:classSectionId/students',
    teaching('view'),
    json((req) =>
      deps.classroom.roster(
        principal(req),
        param(req, 'classSectionId'),
        yearQuery.parse(req.query),
      ),
    ),
  );
  router.get(
    '/teacher/timetable',
    teaching('view'),
    json((req) => {
      const q = timetableQuery.parse(req.query);
      return deps.classroom.teacherTimetable(principal(req), {
        yearId: q.yearId,
        sectionId: q.classSectionId,
      });
    }),
  );
  router.get(
    '/teacher/homework',
    teaching('homework'),
    json(async (req) => {
      const q = teacherHomeworkQuery.parse(req.query);
      const p = principal(req);
      const [list, choices] = await Promise.all([
        deps.homework.teacherList(p, {
          yearId: q.yearId,
          sectionId: q.classSectionId,
          filter: q.filter,
        }),
        deps.homework.choices(p, { yearId: q.yearId }),
      ]);
      return { ...list, choices: choices.items };
    }),
  );
  router.post(
    '/teacher/homework',
    teaching('homework'),
    once,
    wrap(async (req, res) => {
      const b = homeworkSchema.parse(req.body ?? {});
      const out = await deps.homework.create(principal(req), {
        sectionId: b.classSectionId,
        subjectId: b.subjectId,
        kind: b.type,
        title: b.title,
        instructions: b.instructions,
        dueDate: b.dueDate,
        studentIds: b.studentIds,
        fileId: b.fileId,
        link: b.link,
      });
      setEtag(res, out.version);
      res.status(201).json(out);
    }),
  );
  router.get(
    '/teacher/homework/:homeworkId/submissions',
    teaching('homework'),
    json((req) => deps.homework.submissions(principal(req), param(req, 'homeworkId'))),
  );
  router.post(
    '/teacher/homework/:homeworkId/reminders',
    teaching('homework'),
    once,
    json((req) => deps.homework.remind(principal(req), param(req, 'homeworkId'))),
  );
  router.patch(
    '/teacher/submissions/:submissionId',
    teaching('homework'),
    wrap(async (req, res) => {
      const p = principal(req);
      await deps.homework.submissionLookup(p, param(req, 'submissionId'));
      const out = await deps.homework.review(
        p,
        param(req, 'submissionId'),
        expectedVersion(req),
        reviewSchema.parse(req.body ?? {}),
      );
      if (out.submission?.version) setEtag(res, out.submission.version);
      res.setHeader('Cache-Control', 'no-store');
      res.json(out);
    }),
  );

  // the student and family
  router.get(
    '/me/timetable',
    member,
    json((req) => deps.classroom.myTimetable(principal(req), forQuery.parse(req.query))),
  );
  router.get(
    '/me/calendar',
    either('teaching.view', 'principal.view'),
    json((req) => deps.calendar.mine(principal(req), calendarQuery.parse(req.query))),
  );
  router.get(
    '/me/homework',
    member,
    json((req) => deps.homework.mine(principal(req), myHomeworkQuery.parse(req.query))),
  );
  router.get(
    '/me/homework/:homeworkId',
    member,
    json((req) =>
      deps.homework.mineDetail(principal(req), param(req, 'homeworkId'), forQuery.parse(req.query)),
    ),
  );
  router.post(
    '/me/homework/:homeworkId/submissions',
    member,
    once,
    wrap(async (req, res) => {
      const p = principal(req);
      await deps.homework.mineDetail(p, param(req, 'homeworkId'), {});
      const out = await deps.homework.submit(
        p,
        param(req, 'homeworkId'),
        submissionSchema.parse(req.body ?? {}),
      );
      res.setHeader('Cache-Control', 'no-store');
      res.status(201).json(out);
    }),
  );
  return router;
}
