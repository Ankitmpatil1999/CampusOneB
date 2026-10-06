import { Router, type Request, type RequestHandler } from 'express';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { defineRoute } from '../config/openapi-registry';
import { singleFileUpload, uploadErrors } from '../controllers/file.controller';
import type { Loggers } from '../controllers/logger';
import {
  authorize,
  requireAuth,
  requireSurface,
  requireTenant,
} from '../middlewares/auth.middleware';
import { idempotency } from '../middlewares/idempotency.middleware';
import type { Database } from '../models/ringpe_models';
import type { CrossInstitutionService } from '../services/cross-institution.service';
import type { QuizService } from '../services/quiz.service';
import { AuthenticationError, ValidationError } from '../utils/CustomAPIError';
import { expectedVersion, setEtag } from '../utils/etag';

const uuid = z.string().max(40);
const forQuery = z.object({ for: uuid.optional() });
export const startSchema = z.strictObject({ topicId: uuid }).meta({ id: 'QuizAttemptStart' });
export const answerSchema = z
  .strictObject({ questionId: uuid, optionId: uuid })
  .meta({ id: 'QuizAnswer' });
const historyQuery = forQuery.extend({ cursor: z.string().max(40).optional() });
const boardQuery = forQuery.extend({
  period: z.enum(['all', 'year']).optional(),
  full: z.enum(['true', 'false']).optional(),
});
const participationQuery = z.object({
  from: z.string().max(10).optional(),
  to: z.string().max(10).optional(),
  classSection: uuid.optional(),
});
export const topicSchema = z
  .strictObject({
    name: z.string({ message: 'FIN.TOPIC_NAME' }).max(60, { message: 'FIN.TOPIC_NAME' }),
    description: z.string().max(200).nullable().optional(),
    icon: z.string().max(30).nullable().optional(),
  })
  .meta({ id: 'QuizTopicInput' });
export const topicEditSchema = topicSchema
  .partial()
  .extend({ status: z.enum(['ACTIVE', 'WITHDRAWN']).optional() })
  .meta({ id: 'QuizTopicEdit' });
const question = {
  text: z
    .string({ message: 'FIN.QUESTION_MALFORMED' })
    .max(500, { message: 'FIN.QUESTION_MALFORMED' }),
  options: z
    .array(z.string().max(200, { message: 'FIN.QUESTION_MALFORMED' }))
    .length(4, { message: 'FIN.QUESTION_MALFORMED' }),
  correct: z.number({ message: 'FIN.QUESTION_MALFORMED' }).int().min(0).max(3),
  explanation: z.string().max(500).nullable().optional(),
};
export const questionSchema = z
  .strictObject({ topicId: uuid, ...question })
  .meta({ id: 'QuizQuestionInput' });
export const questionEditSchema = z
  .strictObject({
    text: question.text.optional(),
    options: question.options.optional(),
    correct: question.correct.optional(),
    explanation: question.explanation,
    removed: z.boolean().optional(),
  })
  .meta({ id: 'QuizQuestionEdit' });
const stagingQuery = z.object({ topicId: uuid.optional(), cursor: z.string().max(40).optional() });
export const publicationSchema = z
  .strictObject({ topicIds: z.array(uuid).min(1).max(100) })
  .meta({ id: 'QuizPublication' });
const platformBoardQuery = z.object({
  period: z.enum(['all', 'year']).optional(),
  reason: z.string().max(300).optional(),
});

const doc = (d: Omit<Parameters<typeof defineRoute>[0], 'tags'>) =>
  defineRoute({ ...d, tags: ['Financial literacy'] });
doc({
  id: 'FIN-001',
  method: 'get',
  path: '/api/v1/me/quiz/topics',
  summary:
    'Topics with published questions, the member’s best score and attempts left today, and their own summary (best, rank, attempts); the school’s switch',
  auth: 'member',
  query: forQuery,
  responses: { 200: { description: 'Topics' } },
});
doc({
  id: 'FIN-002',
  method: 'post',
  path: '/api/v1/me/quiz/attempts',
  summary:
    'Start an attempt: up to 10 questions in a random order with shuffled options, never the answers; 120 seconds each on the server’s clock; 3 attempts per topic a day (settings)',
  auth: 'member',
  query: forQuery,
  request: startSchema,
  idempotent: 'required',
  responses: { 201: { description: 'Attempt' } },
});
doc({
  id: 'FIN-003',
  method: 'post',
  path: '/api/v1/me/quiz/attempts/{attemptId}/answers',
  summary:
    'Answer the open question, in order and in time — a late answer counts as timed out; never says whether it was right',
  auth: 'member',
  query: forQuery,
  request: answerSchema,
  idempotent: 'required',
  responses: { 200: { description: 'Answer recorded' } },
});
doc({
  id: 'FIN-004',
  method: 'post',
  path: '/api/v1/me/quiz/attempts/{attemptId}/completion',
  summary:
    'Finish (or the last question timed out): scored on the server — correct ÷ served, with the institution rank before and after',
  auth: 'member',
  query: forQuery,
  idempotent: 'required',
  responses: { 200: { description: 'Result' } },
});
doc({
  id: 'FIN-005',
  method: 'get',
  path: '/api/v1/me/quiz/attempts',
  summary: 'The member’s attempts, newest first, with their average and best',
  auth: 'member',
  query: historyQuery,
  responses: { 200: { description: 'History' } },
});
doc({
  id: 'FIN-018',
  method: 'get',
  path: '/api/v1/me/quiz/attempts/{attemptId}',
  summary:
    'An attempt still running, to carry on after the app reloads: the questions as served with their options (never the answers), which are answered or timed out, and the open question with its deadline — the clock never stops',
  auth: 'member',
  query: forQuery,
  responses: { 200: { description: 'Attempt in progress' } },
});
doc({
  id: 'FIN-006',
  method: 'get',
  path: '/api/v1/me/quiz/attempts/{attemptId}/review',
  summary: 'Every answer with the correct one and the explanation, once the attempt is finished',
  auth: 'member',
  query: forQuery,
  responses: { 200: { description: 'Review' } },
});
doc({
  id: 'FIN-007',
  method: 'get',
  path: '/api/v1/me/quiz/leaderboard',
  summary:
    'The school’s student ranking (average of correct ÷ served across attempts; a tie goes to whoever reached it first), all time or this year, with the member’s own rank; full=true for everyone ranked',
  auth: 'member',
  query: boardQuery,
  responses: { 200: { description: 'Leaderboard' } },
});
doc({
  id: 'FIN-008',
  method: 'get',
  path: '/api/v1/console/quiz/participation',
  summary:
    'Who took part, how often and how well — students of the year, by class-section and date range',
  auth: 'reports.view',
  query: participationQuery,
  responses: { 200: { description: 'Participation' } },
});
doc({
  id: 'FIN-009',
  method: 'get',
  path: '/api/v1/ops/quiz/topics',
  summary: 'Topics with their staging, published and attempt counts',
  auth: 'quiz.edit',
  responses: { 200: { description: 'Topics' } },
});
doc({
  id: 'FIN-010',
  method: 'post',
  path: '/api/v1/ops/quiz/topics',
  summary: 'Add a topic (a unique name of 3 to 60 characters)',
  auth: 'quiz.edit',
  request: topicSchema,
  idempotent: 'required',
  responses: { 201: { description: 'Topic' } },
});
doc({
  id: 'FIN-011',
  method: 'patch',
  path: '/api/v1/ops/quiz/topics/{topicId}',
  summary: 'Rename, describe, withdraw or restore a topic; If-Match',
  auth: 'quiz.edit',
  request: topicEditSchema,
  responses: { 200: { description: 'Topic' } },
});
doc({
  id: 'FIN-012',
  method: 'get',
  path: '/api/v1/ops/quiz/staging-questions',
  summary: 'The staging bank (a topic’s or all), with each question’s published state',
  auth: 'quiz.edit',
  query: stagingQuery,
  responses: { 200: { description: 'Staging questions' } },
});
doc({
  id: 'FIN-013',
  method: 'post',
  path: '/api/v1/ops/quiz/staging-questions',
  summary: 'Add a staging question: four different answers, exactly one correct',
  auth: 'quiz.edit',
  request: questionSchema,
  idempotent: 'required',
  responses: { 201: { description: 'Question' } },
});
doc({
  id: 'FIN-014',
  method: 'patch',
  path: '/api/v1/ops/quiz/staging-questions/{questionId}',
  summary: 'Edit a staging question or remove it (removed: true); If-Match',
  auth: 'quiz.edit',
  request: questionEditSchema,
  responses: { 200: { description: 'Question' } },
});
doc({
  id: 'FIN-015',
  method: 'post',
  path: '/api/v1/ops/quiz/staging-uploads',
  summary:
    'Load a topic’s questions from a sheet saved as CSV (≤2 MB): six-row blocks in the first column — question, four answers (the right one ends “(Correct)”), a blank row; good blocks go in together, duplicates are skipped, the rest reported by row',
  auth: 'quiz.edit',
  idempotent: 'required',
  responses: { 201: { description: 'Upload report' } },
});
doc({
  id: 'FIN-016',
  method: 'post',
  path: '/api/v1/ops/quiz/publications',
  summary:
    'Publish the topics’ staging banks in one transaction; published questions staging no longer holds are withdrawn',
  auth: 'quiz.edit',
  request: publicationSchema,
  idempotent: 'required',
  responses: { 200: { description: 'Published' } },
});
doc({
  id: 'FIN-017',
  method: 'get',
  path: '/api/v1/ops/quiz/leaderboard',
  summary:
    'The platform-wide student ranking across schools (first names and school only), for operators with xi.aggregate; every look recorded with its reason, refusals included (CR-01)',
  auth: 'xi.aggregate',
  query: platformBoardQuery,
  responses: { 200: { description: 'Leaderboard' } },
});

export function quizRoutes(deps: {
  db: Kysely<Database>;
  quiz: QuizService;
  xi: CrossInstitutionService;
  loggers: Loggers;
}): Router {
  const router = Router();
  const L = deps.loggers;
  const once = idempotency({ db: deps.db, mode: 'required' });
  const member = requireSurface(L, 'member');
  const edit = [requireSurface(L, 'ops'), authorize('quiz.edit', L)];
  const Q = deps.quiz;
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
  const json = (fn: (req: Request) => Promise<unknown>, code = 200): RequestHandler =>
    wrap(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      const out = await fn(req);
      const v = (out as { version?: unknown } | null)?.version;
      if (typeof v === 'number') setEtag(res, v);
      res.status(code).json(out);
    });
  const attemptId = (req: Request) => String(req.params['attemptId']);

  // --- members --------------------------------------------------------------------------------
  router.get(
    '/me/quiz/topics',
    member,
    json((req) => Q.topics(principal(req), forQuery.parse(req.query))),
  );
  router.post(
    '/me/quiz/attempts',
    member,
    once,
    json(
      (req) =>
        Q.start(principal(req), {
          ...startSchema.parse(req.body ?? {}),
          ...forQuery.parse(req.query),
        }),
      201,
    ),
  );
  router.post(
    '/me/quiz/attempts/:attemptId/answers',
    member,
    once,
    json(async (req) => {
      const q = forQuery.parse(req.query);
      await Q.lookupAttempt(principal(req), attemptId(req), q.for);
      return Q.answer(principal(req), attemptId(req), {
        ...answerSchema.parse(req.body ?? {}),
        ...q,
      });
    }),
  );
  router.post(
    '/me/quiz/attempts/:attemptId/completion',
    member,
    once,
    json((req) => Q.complete(principal(req), attemptId(req), forQuery.parse(req.query))),
  );
  router.get(
    '/me/quiz/attempts',
    member,
    json((req) => Q.history(principal(req), historyQuery.parse(req.query))),
  );
  router.get(
    '/me/quiz/attempts/:attemptId',
    member,
    json((req) => Q.current(principal(req), attemptId(req), forQuery.parse(req.query))),
  );
  router.get(
    '/me/quiz/attempts/:attemptId/review',
    member,
    json((req) => Q.review(principal(req), attemptId(req), forQuery.parse(req.query))),
  );
  router.get(
    '/me/quiz/leaderboard',
    member,
    json((req) => {
      const q = boardQuery.parse(req.query);
      return Q.leaderboard(principal(req), { ...q, full: q.full === 'true' });
    }),
  );

  // --- the console ----------------------------------------------------------------------------
  router.get(
    '/console/quiz/participation',
    requireSurface(L, 'console'),
    requireTenant(L),
    authorize('reports.view', L),
    json((req) => Q.participation(principal(req), participationQuery.parse(req.query))),
  );

  // --- operators ------------------------------------------------------------------------------
  router.get(
    '/ops/quiz/topics',
    ...edit,
    json(() => Q.opsTopics()),
  );
  router.post(
    '/ops/quiz/topics',
    ...edit,
    once,
    json((req) => Q.createTopic(principal(req), topicSchema.parse(req.body ?? {})), 201),
  );
  router.patch(
    '/ops/quiz/topics/:topicId',
    ...edit,
    json(async (req) => {
      await Q.lookupTopic(String(req.params['topicId']));
      return Q.updateTopic(
        String(req.params['topicId']),
        expectedVersion(req),
        topicEditSchema.parse(req.body ?? {}),
      );
    }),
  );
  router.get(
    '/ops/quiz/staging-questions',
    ...edit,
    json((req) => Q.staging(stagingQuery.parse(req.query))),
  );
  router.post(
    '/ops/quiz/staging-questions',
    ...edit,
    once,
    json((req) => Q.addQuestion(principal(req), questionSchema.parse(req.body ?? {})), 201),
  );
  router.patch(
    '/ops/quiz/staging-questions/:questionId',
    ...edit,
    json((req) =>
      Q.updateQuestion(
        String(req.params['questionId']),
        expectedVersion(req),
        questionEditSchema.parse(req.body ?? {}),
      ),
    ),
  );
  router.post(
    '/ops/quiz/staging-uploads',
    ...edit,
    once,
    singleFileUpload,
    uploadErrors,
    json(async (req) => {
      if (!req.file) throw new ValidationError([{ field: 'file', code: 'UPL.FILE_REQUIRED' }]);
      const topicId = z.object({ topicId: uuid }).parse(req.body ?? {}).topicId;
      return Q.upload(principal(req), topicId, req.file.buffer.toString('utf8'));
    }, 201),
  );
  router.post(
    '/ops/quiz/publications',
    ...edit,
    once,
    json((req) => Q.publish(publicationSchema.parse(req.body ?? {}).topicIds)),
  );
  router.get(
    '/ops/quiz/leaderboard',
    requireAuth(),
    json(async (req) => {
      const q = platformBoardQuery.parse(req.query);
      const period = q.period ?? 'all';
      await deps.xi.leaderboardAccess(principal(req), { period, reason: q.reason ?? '' });
      return Q.platformBoard(period);
    }),
  );
  return router;
}
