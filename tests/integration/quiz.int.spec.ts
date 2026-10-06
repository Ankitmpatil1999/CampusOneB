/**
 * The financial literacy quiz on a real MySQL (Phase 8.6; SRS 28, CR-01; FIN-001…017; OI-FIN-01…27):
 * - the operators' bank: unique topics, four-option questions, a CSV sheet of six-row blocks with a
 *   row report, publication from staging in one go with withdrawals;
 * - an attempt never carries the answers; answers in order on the server's clock, late ones timed
 *   out; scored on the server; review after; three attempts a topic a day; unfinished ones expire;
 * - the school's student ranking with the member's own rank; participation for the console; the
 *   platform ranking for operators only, recorded.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import request from 'supertest';
import { uuidToBin } from '../../utils/idGenerator';
import { adminUrl } from './db';
import { schoolFixture, type Auth, type Payer } from './school';
import { newPublicIdPair } from '../../utils/idGenerator';

describe.skipIf(!adminUrl)('financial literacy quiz on real MySQL', () => {
  let f: Awaited<ReturnType<typeof schoolFixture>>;
  let asha: Payer;
  let bala: Payer;
  let ravi: Payer;
  let topicId: string;
  const post = (path: string, auth: Auth, body: object = {}) =>
    request(f.app).post(`/api/v1${path}`).set(auth).set('Idempotency-Key', randomUUID()).send(body);
  const get = (path: string, auth: Auth) => request(f.app).get(`/api/v1${path}`).set(auth);
  const ops = (path: string) => get(path, f.ops).set('X-RingPe-Surface', 'ops');
  const correctOf = async (questionId: string) =>
    (
      await f.t.db
        .selectFrom('quiz_options as o')
        .innerJoin('quiz_questions as q', 'q.id', 'o.question_id')
        .select(['o.public_id', 'o.is_correct'])
        .where('q.public_id', '=', uuidToBin(questionId))
        .execute()
    ).map((o) => ({
      id: Buffer.from(o.public_id).toString('hex'),
      correct: !!Number(o.is_correct),
    }));
  const hexToUuid = (h: string) =>
    `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  const rightOption = async (questionId: string) =>
    hexToUuid((await correctOf(questionId)).find((o) => o.correct)!.id);
  const wrongOption = async (questionId: string) =>
    hexToUuid((await correctOf(questionId)).find((o) => !o.correct)!.id);
  const play = async (who: Payer, right: number) => {
    const s = await post('/me/quiz/attempts', who.auth, { topicId });
    expect(s.status, JSON.stringify(s.body)).toBe(201);
    for (const [i, q] of (s.body.questions as { questionId: string }[]).entries()) {
      const optionId =
        i < right ? await rightOption(q.questionId) : await wrongOption(q.questionId);
      const a = await post(`/me/quiz/attempts/${s.body.attemptId}/answers`, who.auth, {
        questionId: q.questionId,
        optionId,
      });
      expect(a.status, JSON.stringify(a.body)).toBe(200);
    }
    const done = await post(`/me/quiz/attempts/${s.body.attemptId}/completion`, who.auth);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    return done.body;
  };

  beforeAll(async () => {
    f = await schoolFixture('Quiz School');
    asha = await f.student('Asha');
    bala = await f.student('Bala');
    ravi = await f.payer('Ravi', 0);
    // Registration leaves every feature off until the operator switches it on (RNG-ONB-036).
    await f.feature('quiz', true);
  }, 240_000);
  afterAll(async () => {
    await f?.t.drop();
  });

  it('keeps the operators’ bank: topics, questions, a sheet upload and publication', async () => {
    const t = await post('/ops/quiz/topics', f.ops, {
      name: 'Money basics',
      description: 'Needs and wants, budgeting your pocket money.',
      icon: 'wallet',
    });
    expect(t.status, JSON.stringify(t.body)).toBe(201);
    topicId = t.body.id;
    expect((await post('/ops/quiz/topics', f.ops, { name: 'Money basics' })).body.code).toBe(
      'FIN.TOPIC_TAKEN',
    );
    const q = (text: string, correct = 1) => ({
      topicId,
      text,
      options: ['A new video game', 'School shoes that fit', 'A second smartwatch', 'Stickers'],
      correct,
      explanation: 'Needs are things you must have.',
    });
    expect((await post('/ops/quiz/staging-questions', f.ops, q('Which is a need?'))).status).toBe(
      201,
    );
    expect(
      (
        await post('/ops/quiz/staging-questions', f.ops, {
          ...q('Bad one'),
          options: ['a', 'a', 'b', 'c'],
        })
      ).body.errors[0].code,
    ).toBe('FIN.QUESTION_MALFORMED');
    expect(
      (await post('/ops/quiz/staging-questions', f.ops, q('Which one is a want?', 2))).status,
    ).toBe(201);
    const sheet = [
      'What is a budget?',
      'Spending everything at once',
      'A plan for spending and saving (Correct)',
      'Borrowing from friends',
      'Never spending',
      '',
      'Saving ₹50 a week for 8 weeks gives…',
      '₹350',
      '₹400 (Correct)',
      '₹450',
      '₹500',
      '',
      'Two right answers?',
      'Yes (Correct)',
      'No (Correct)',
      'Maybe',
      'Never',
      '',
      'Which is a need?',
      'A new video game',
      'School shoes that fit (Correct)',
      'A second smartwatch',
      'Stickers',
    ].join('\r\n');
    const up = await request(f.app)
      .post('/api/v1/ops/quiz/staging-uploads')
      .set(f.ops)
      .set('Idempotency-Key', randomUUID())
      .field('topicId', topicId)
      .attach('file', Buffer.from(sheet, 'utf8'), {
        filename: 'quiz.csv',
        contentType: 'text/csv',
      });
    expect(up.status, JSON.stringify(up.body)).toBe(201);
    expect(up.body).toMatchObject({ accepted: 2, skipped: 1, rejected: [{ row: 13 }] });
    const pub = await post('/ops/quiz/publications', f.ops, { topicIds: [topicId] });
    expect(pub.body).toEqual({ published: 4, updated: 0, withdrawn: 0 });
    const staged = (await ops(`/ops/quiz/staging-questions?topicId=${topicId}`)).body.items as {
      id: string;
      text: string;
      version: number;
      published: boolean;
    }[];
    expect(staged).toHaveLength(4);
    expect(staged.every((x) => x.published)).toBe(true);
    const want = staged.find((x) => x.text === 'Which one is a want?')!;
    const removed = await request(f.app)
      .patch(`/api/v1/ops/quiz/staging-questions/${want.id}`)
      .set(f.ops)
      .set('If-Match', `"v${want.version}"`)
      .send({ removed: true });
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    const again = await post('/ops/quiz/publications', f.ops, { topicIds: [topicId] });
    expect(again.body).toEqual({ published: 0, updated: 0, withdrawn: 1 });
    const topics = (await ops('/ops/quiz/topics')).body.items;
    expect(topics[0]).toMatchObject({ name: 'Money basics', staging: 3, published: 3 });
  });

  it('serves no answers, keeps the clock, scores on the server and reviews after', async () => {
    const list = await get('/me/quiz/topics', asha.auth);
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(list.body.items[0]).toMatchObject({
      name: 'Money basics',
      questions: 3,
      attemptsLeftToday: 3,
    });
    const s = await post('/me/quiz/attempts', asha.auth, { topicId });
    expect(s.status, JSON.stringify(s.body)).toBe(201);
    expect(s.body).toMatchObject({ served: 3, perQuestionSec: 120, current: { seq: 1 } });
    expect(JSON.stringify(s.body)).not.toMatch(/correct|is_correct|Correct/);
    const [q1, q2, q3] = s.body.questions as { questionId: string }[];
    const id = s.body.attemptId as string;
    expect(
      (
        await post(`/me/quiz/attempts/${id}/answers`, asha.auth, {
          questionId: q2!.questionId,
          optionId: await rightOption(q2!.questionId),
        })
      ).body.code,
    ).toBe('FIN.NOT_CURRENT');
    expect((await get(`/me/quiz/attempts/${id}/review`, asha.auth)).body.code).toBe(
      'FIN.ATTEMPT_OPEN',
    );
    const a1 = await post(`/me/quiz/attempts/${id}/answers`, asha.auth, {
      questionId: q1!.questionId,
      optionId: await rightOption(q1!.questionId),
    });
    expect(a1.body).toMatchObject({ accepted: true, next: { seq: 2 } });
    expect(JSON.stringify(a1.body)).not.toMatch(/correct/i);
    // The app reloads: the topic points at the running attempt, which carries on where it was.
    const topics = await get('/me/quiz/topics', asha.auth);
    expect(topics.body.items[0].openAttemptId).toBe(id);
    const resumed = await get(`/me/quiz/attempts/${id}`, asha.auth);
    expect(resumed.status, JSON.stringify(resumed.body)).toBe(200);
    expect(resumed.body).toMatchObject({ served: 3, answered: 1, current: { seq: 2 } });
    expect(resumed.body.questions.map((x: { state: string }) => x.state)).toEqual([
      'ANSWERED',
      'OPEN',
      'OPEN',
    ]);
    expect(resumed.body.questions[1].options).toEqual(s.body.questions[1].options);
    expect(JSON.stringify(resumed.body)).not.toMatch(/correct/i);
    expect((await get(`/me/quiz/attempts/${id}`, bala.auth)).body.code).toBe(
      'FIN.ATTEMPT_NOT_FOUND',
    );
    await post(`/me/quiz/attempts/${id}/answers`, asha.auth, {
      questionId: q2!.questionId,
      optionId: await wrongOption(q2!.questionId),
    });
    // The third question's time runs out before the answer arrives.
    await f.t.db
      .updateTable('quiz_attempts')
      .set({ current_deadline_at: new Date(Date.now() - 1000) })
      .where('public_id', '=', uuidToBin(id))
      .execute();
    const late = await post(`/me/quiz/attempts/${id}/answers`, asha.auth, {
      questionId: q3!.questionId,
      optionId: await rightOption(q3!.questionId),
    });
    expect(late.body).toMatchObject({ accepted: false, timedOut: true, next: null });
    const done = await post(`/me/quiz/attempts/${id}/completion`, asha.auth);
    expect(done.body).toMatchObject({
      score: 1,
      served: 3,
      percentage: 33.3,
      wrong: 1,
      unanswered: 1,
      rank: 1,
    });
    expect((await post(`/me/quiz/attempts/${id}/completion`, asha.auth)).body.code).toBe(
      'FIN.ATTEMPT_CLOSED',
    );
    const review = await get(`/me/quiz/attempts/${id}/review`, asha.auth);
    expect(review.body.items.map((x: { outcome: string }) => x.outcome)).toEqual([
      'CORRECT',
      'WRONG',
      'UNANSWERED',
    ]);
    expect(review.body.items[2].timedOut).toBe(true);
    expect(
      review.body.items[0].options.filter((o: { correct: boolean }) => o.correct),
    ).toHaveLength(1);
  });

  it('allows three attempts a topic a day, expires unfinished ones and ranks students', async () => {
    await play(asha, 3);
    const open = await post('/me/quiz/attempts', asha.auth, { topicId });
    expect(open.status).toBe(201);
    expect((await post('/me/quiz/attempts', asha.auth, { topicId })).body).toMatchObject({
      code: 'FIN.ATTEMPT_LIMIT',
      params: { max: 3 },
    });
    // Left unfinished long ago: it expires and doesn't count.
    await f.t.db
      .updateTable('quiz_attempts')
      .set({ current_deadline_at: new Date(Date.now() - 3600_000) })
      .where('public_id', '=', uuidToBin(open.body.attemptId))
      .execute();
    const history = await get('/me/quiz/attempts', asha.auth);
    expect(history.body.items.map((x: { status: string }) => x.status)).toEqual([
      'EXPIRED',
      'COMPLETED',
      'COMPLETED',
    ]);
    expect(history.body.summary).toMatchObject({ attempts: 2, best: 100 });
    await play(bala, 3);
    await play(ravi, 3); // a teacher may play but isn't ranked
    const board = await get('/me/quiz/leaderboard', asha.auth);
    expect(board.status, JSON.stringify(board.body)).toBe(200);
    expect(
      board.body.items.map((x: { name: string; average: number }) => [x.name, x.average]),
    ).toEqual([
      ['Bala Rao', 100],
      ['Asha Rao', 66.7],
    ]);
    expect(board.body.me).toMatchObject({
      rank: 2,
      you: true,
      classSection: expect.stringMatching(/Grade/),
    });
  });

  it('reports participation to the console and is switched off by the school', async () => {
    const r = await get('/console/quiz/participation', f.school.con).set(
      'X-RingPe-Surface',
      'console',
    );
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.totals).toMatchObject({ students: 2, participants: 2, attempts: 4 });
    await f.feature('quiz', false);
    expect((await get('/me/quiz/topics', asha.auth)).body.code).toBe('FIN.QUIZ_DISABLED');
    await f.feature('quiz', true);
  });

  it('shows the platform ranking to entitled operators only, and records every look', async () => {
    expect((await ops('/ops/quiz/leaderboard?period=all')).body.errors[0].code).toBe(
      'RPT.XI_REASON',
    );
    const ok = await ops(
      '/ops/quiz/leaderboard?period=all&reason=Termly%20review%20of%20the%20quiz',
    );
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.items[0]).toMatchObject({ rank: 1, name: 'Bala', average: 100 });
    const acct = await f.account('SUNIL');
    const role = await f.t.db
      .selectFrom('roles')
      .select('id')
      .where('code', '=', 'SUPPORT_OFFICER')
      .executeTakeFirstOrThrow();
    await f.t.db
      .insertInto('operator_accounts')
      .values({ public_id: newPublicIdPair().bin, account_id: acct.id, role_id: String(role.id) })
      .execute();
    const support = await f.signedIn('ops', acct.email);
    const refused = await get('/ops/quiz/leaderboard?reason=Just%20looking%20around', support).set(
      'X-RingPe-Surface',
      'ops',
    );
    expect(refused.status).toBe(403);
    const looks = await f.t.db
      .selectFrom('cross_institution_access_record')
      .select(['kind', 'outcome'])
      .where('kind', '=', 'Leaderboard')
      .execute();
    expect(looks.map((x) => x.outcome).sort()).toEqual(['Refused', 'Returned']);
    expect(Number((await sql<{ n: number }>`SELECT 1 AS n`.execute(f.t.db)).rows[0]!.n)).toBe(1);
  });
});
