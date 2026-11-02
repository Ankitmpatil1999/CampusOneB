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
import type { ExamsService } from '../services/exams.service';
import { AuthenticationError } from '../utils/CustomAPIError';
import { expectedVersion, setEtag } from '../utils/etag';

const date = z.iso.date({ message: 'VALIDATION.DATE' });
const uuid = z.string().max(40);
const time = z.string().max(5);
const marks = z
  .number({ message: 'ACA.EXAM_MARKS_RANGE' })
  .int({ message: 'ACA.EXAM_MARKS_RANGE' });

export const examNameSchema = z
  .strictObject({
    name: z.string({ message: 'ACA.EXAM_NAME' }).max(40, { message: 'ACA.EXAM_NAME' }),
  })
  .meta({ id: 'ExamNameInput' });
export const examsCreateSchema = z
  .strictObject({
    yearId: uuid.optional(),
    examNameId: uuid,
    sectionIds: z.array(uuid).min(1).max(60),
    items: z
      .array(
        z.strictObject({
          subjectId: uuid,
          date: date.nullable().optional(),
          startTime: time.nullable().optional(),
          endTime: time.nullable().optional(),
          maxMarks: marks,
          passMarks: marks,
        }),
      )
      .min(1)
      .max(30),
  })
  .meta({ id: 'ExamsInput' });
export const examEditSchema = z
  .strictObject({
    date: date.nullable().optional(),
    startTime: time.nullable().optional(),
    endTime: time.nullable().optional(),
    maxMarks: marks.optional(),
    passMarks: marks.optional(),
    withdraw: z.boolean().optional(),
  })
  .meta({ id: 'ExamEdit' });
export const marksGridSchema = z
  .strictObject({
    marks: z
      .array(
        z.strictObject({
          studentId: uuid,
          marks: z.number({ message: 'ACA.MARK_RANGE' }).nullable().optional(),
          absent: z.boolean().optional(),
        }),
      )
      .max(200),
  })
  .meta({ id: 'MarksGrid' });

const yearQuery = z.object({ yearId: uuid.optional() });
const examsQuery = yearQuery.extend({
  examNameId: uuid.optional(),
  sectionId: uuid.optional(),
  subjectId: uuid.optional(),
  withdrawn: z.enum(['true', 'false']).optional(),
});
const statusQuery = yearQuery.extend({ scope: z.enum(['due', 'all']).optional() });
const reportQuery = yearQuery.extend({
  examNameId: uuid.optional(),
  sectionId: uuid.optional(),
  includePending: z.enum(['true', 'false']).optional(),
});
const teacherQuery = yearQuery.extend({ examId: uuid.optional() });
const meQuery = yearQuery.extend({ for: uuid.optional() });

const doc = (d: Omit<Parameters<typeof defineRoute>[0], 'tags'>) =>
  defineRoute({ ...d, tags: ['Academics'] });
doc({
  id: 'ACA-034',
  method: 'get',
  path: '/api/v1/console/exams',
  summary:
    'The year’s exams (default the current year): name, class and section, subject, date and time, maximum and pass marks, schedule (Scheduled, Upcoming, Today, Completed) and marks progress; withdrawn exams on request',
  auth: 'academics.view',
  query: examsQuery,
  responses: { 200: { description: 'Exams' } },
});
doc({
  id: 'ACA-035',
  method: 'post',
  path: '/api/v1/console/exams',
  summary:
    'Create an exam name’s exams for sections × subjects, all or none: each subject mapped to the class, dates inside the year, pass marks no higher than the maximum, one exam per name, section and subject in a year; a closed year refuses',
  auth: 'academics.edit',
  request: examsCreateSchema,
  idempotent: 'required',
  responses: { 201: { description: 'Created exams' } },
});
doc({
  id: 'ACA-036',
  method: 'patch',
  path: '/api/v1/console/exams/{examId}',
  summary:
    'Change the date, time or marks, or withdraw ({"withdraw": true}); marks and withdrawal are fixed once marks exist; If-Match',
  auth: 'academics.edit',
  request: examEditSchema,
  responses: { 200: { description: 'Exam' } },
});
doc({
  id: 'ACA-077',
  method: 'get',
  path: '/api/v1/console/exams/{examId}/marks',
  summary: 'The exam with each enrolled student’s mark (or absent) and its status, and the summary',
  auth: 'academics.view',
  responses: { 200: { description: 'Exam and marks' } },
});
doc({
  id: 'ACA-037',
  method: 'get',
  path: '/api/v1/console/exam-names',
  summary: 'Exam names with their exams this year and in all years',
  auth: 'academics.view',
  query: yearQuery,
  responses: { 200: { description: 'Exam names' } },
});
doc({
  id: 'ACA-038',
  method: 'post',
  path: '/api/v1/console/exam-names',
  summary: 'Add an exam name (3–40 characters, unique)',
  auth: 'academics.edit',
  request: examNameSchema,
  idempotent: 'required',
  responses: { 201: { description: 'Exam name' } },
});
doc({
  id: 'ACA-039',
  method: 'get',
  path: '/api/v1/console/marks-status',
  summary:
    'Marks progress by exam name and section: exams due, uploaded, awaiting validation, validated and missing (scope=due, the default, lists groups with an exam held)',
  auth: 'academics.view',
  query: statusQuery,
  responses: { 200: { description: 'Marks status' } },
});
doc({
  id: 'ACA-040',
  method: 'post',
  path: '/api/v1/console/exams/{examId}/marks-validation',
  summary: 'Validate the exam’s saved marks (Created → Valid, RC-37)',
  auth: 'academics.edit',
  idempotent: 'required',
  responses: { 200: { description: 'Exam' } },
});
doc({
  id: 'ACA-041',
  method: 'get',
  path: '/api/v1/console/academic-reports',
  summary:
    'Server-computed analytics for one year from validated marks (pending ones on request): per subject the highest, lowest and average percentage, passes and failures against each exam’s own pass marks and the top student; the class average and student standings',
  auth: 'academics.view',
  query: reportQuery,
  responses: { 200: { description: 'Report' } },
});
doc({
  id: 'ACA-052',
  method: 'get',
  path: '/api/v1/teacher/exams',
  summary:
    'The teacher’s exams (their subjects, or every subject of a class they teach as class teacher) with marks progress; with examId, that exam’s grid of enrolled students and marks',
  auth: 'member|teaching.marks',
  query: teacherQuery,
  responses: { 200: { description: 'Exams' } },
});
doc({
  id: 'ACA-053',
  method: 'put',
  path: '/api/v1/teacher/exams/{examId}/marks',
  summary:
    'Save the marks grid in one transaction once the exam has been held: 0 to the maximum in whole or half marks, or absent, each student enrolled in the section that year; a changed validated mark returns to Created; If-Match',
  auth: 'member|teaching.marks',
  request: marksGridSchema,
  responses: { 200: { description: 'Grid' } },
});
doc({
  id: 'ACA-054',
  method: 'post',
  path: '/api/v1/teacher/exams/{examId}/marks-publication',
  summary:
    'Validate and publish the exam’s marks when every enrolled student has a mark or absent; students and their families are told',
  auth: 'member|teaching.marks',
  idempotent: 'required',
  responses: { 200: { description: 'Exam and grid' } },
});
doc({
  id: 'ACA-063',
  method: 'get',
  path: '/api/v1/principal/academics',
  summary:
    'The principal’s academics: each section’s average, pass rate and standing (Top Performer, Average, Needs Support), exams in the next 14 days and weekly lessons per section',
  auth: 'member|principal.view',
  query: yearQuery,
  responses: { 200: { description: 'Academics' } },
});
doc({
  id: 'ACA-070',
  method: 'get',
  path: '/api/v1/me/exams',
  summary: 'The student’s exam schedule for the year (for: a child on the account)',
  auth: 'member',
  query: meQuery,
  responses: { 200: { description: 'Exams' } },
});
doc({
  id: 'ACA-071',
  method: 'get',
  path: '/api/v1/me/results',
  summary:
    'Published results by exam for the year (labelled with it): marks or absent per subject, Passed or Failed against the exam’s pass marks, and the percentage (for: a child on the account)',
  auth: 'member',
  query: meQuery,
  responses: { 200: { description: 'Results' } },
});

export function examsRoutes(deps: {
  db: Kysely<Database>;
  exams: ExamsService;
  loggers: Loggers;
}): Router {
  const router = Router();
  const L = deps.loggers;
  // The app's member, or the web console with one of the sub-tasks (the principal; client 2026-10-13).
  const either = (...subTasks: string[]) => memberOrConsole(subTasks, L);
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
  const member = requireSurface(L, 'member');
  const teaching = (sub: string) => teacherAccess(`teaching.${sub}`, L);
  const view = authorize('academics.view', L);
  const edit = authorize('academics.edit', L);
  const noStore = (res: Parameters<RequestHandler>[1]) =>
    res.setHeader('Cache-Control', 'no-store');

  // console: exam names and exams
  router.get(
    '/console/exam-names',
    ...console,
    view,
    wrap(async (req, res) => {
      res.json(await deps.exams.names(principal(req), yearQuery.parse(req.query)));
    }),
  );
  router.post(
    '/console/exam-names',
    ...console,
    edit,
    once,
    wrap(async (req, res) => {
      res
        .status(201)
        .json(await deps.exams.createName(principal(req), examNameSchema.parse(req.body ?? {})));
    }),
  );
  router.get(
    '/console/exams',
    ...console,
    view,
    wrap(async (req, res) => {
      const q = examsQuery.parse(req.query);
      res.json(await deps.exams.list(principal(req), { ...q, withdrawn: q.withdrawn === 'true' }));
    }),
  );
  router.post(
    '/console/exams',
    ...console,
    edit,
    once,
    wrap(async (req, res) => {
      res
        .status(201)
        .json(await deps.exams.create(principal(req), examsCreateSchema.parse(req.body ?? {})));
    }),
  );
  router.patch(
    '/console/exams/:examId',
    ...console,
    edit,
    wrap(async (req, res) => {
      const p = principal(req);
      await deps.exams.exam(p, param(req, 'examId'));
      const out = await deps.exams.update(
        p,
        param(req, 'examId'),
        expectedVersion(req),
        examEditSchema.parse(req.body ?? {}),
      );
      setEtag(res, out.version);
      res.json(out);
    }),
  );
  router.get(
    '/console/exams/:examId/marks',
    ...console,
    view,
    wrap(async (req, res) => {
      res.json(await deps.exams.examMarks(principal(req), param(req, 'examId')));
    }),
  );
  router.get(
    '/console/marks-status',
    ...console,
    view,
    wrap(async (req, res) => {
      res.json(await deps.exams.marksStatus(principal(req), statusQuery.parse(req.query)));
    }),
  );
  router.post(
    '/console/exams/:examId/marks-validation',
    ...console,
    edit,
    once,
    wrap(async (req, res) => {
      const out = await deps.exams.validate(principal(req), param(req, 'examId'));
      setEtag(res, out.version);
      res.json(out);
    }),
  );
  router.get(
    '/console/academic-reports',
    ...console,
    view,
    wrap(async (req, res) => {
      const q = reportQuery.parse(req.query);
      res.json(
        await deps.exams.report(principal(req), {
          ...q,
          includePending: q.includePending === 'true',
        }),
      );
    }),
  );

  // the teacher, the principal and the student
  router.get(
    '/teacher/exams',
    teaching('marks'),
    wrap(async (req, res) => {
      noStore(res);
      const out = await deps.exams.teacherExams(principal(req), teacherQuery.parse(req.query));
      if (out.grid) setEtag(res, out.grid.version);
      res.json(out);
    }),
  );
  router.put(
    '/teacher/exams/:examId/marks',
    teaching('marks'),
    wrap(async (req, res) => {
      const p = principal(req);
      await deps.exams.teacherLookup(p, param(req, 'examId'));
      const version = expectedVersion(req);
      const out = await deps.exams.saveMarks(
        p,
        param(req, 'examId'),
        version,
        marksGridSchema.parse(req.body ?? {}).marks,
      );
      noStore(res);
      if (out) setEtag(res, out.version);
      res.json(out);
    }),
  );
  router.post(
    '/teacher/exams/:examId/marks-publication',
    teaching('marks'),
    once,
    wrap(async (req, res) => {
      noStore(res);
      res.json(await deps.exams.publish(principal(req), param(req, 'examId')));
    }),
  );
  router.get(
    '/principal/academics',
    either('principal.view'),
    wrap(async (req, res) => {
      noStore(res);
      res.json(await deps.exams.principalAcademics(principal(req), yearQuery.parse(req.query)));
    }),
  );
  router.get(
    '/me/exams',
    member,
    wrap(async (req, res) => {
      noStore(res);
      res.json(await deps.exams.myExams(principal(req), meQuery.parse(req.query)));
    }),
  );
  router.get(
    '/me/results',
    member,
    wrap(async (req, res) => {
      noStore(res);
      res.json(await deps.exams.myResults(principal(req), meQuery.parse(req.query)));
    }),
  );
  return router;
}
