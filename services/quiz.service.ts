/**
 * The financial literacy quiz (SRS 28, CR-01; FIN-001…017; OI-FIN-01…27; prototype m.quiz, m.quiz.play,
 * m.quiz.result, m.quiz.review, m.quiz.board, m.quiz.history, o.quiz).
 *
 * - One platform bank kept by operators: topics, a staging bank (added one by one or from a sheet of
 *   six-row blocks) and a published bank written from staging in one transaction; a published question
 *   staging no longer holds is withdrawn (OI-FIN-04/16/17/18/19). Four options, exactly one correct.
 * - An institution switch turns the quiz on (`quiz`, on unless switched off: OI-FIN-01).
 * - An attempt serves up to 10 published questions in a random order with shuffled options and never
 *   their answers (OI-FIN-11). The server keeps the clock: the questions are answered in order, each
 *   within 120 seconds; a late answer counts as timed out. Finishing scores it on the server (score /
 *   served, OI-FIN-07/13); the last question's timeout finishes it (OI-FIN-08); left unfinished past its
 *   last deadline, it expires and doesn't count (OI-FIN-26). Three attempts per topic a day (OI-FIN-12).
 *   All of these are settings.
 * - The review shows every answer with the correct one and the explanation once the attempt is done.
 * - The school's leaderboard ranks students only, by the average of score ÷ questions served across all
 *   attempts (the prototype's rule; setting `fin.rank.method` 1 = best per topic, averaged); a tie goes
 *   to whoever reached it first (OI-FIN-05); all time or the academic year (OI-FIN-26); with the
 *   member's own rank (OI-FIN-27). The platform-wide leaderboard is for operators only, every look
 *   recorded (CR-01, OI-FIN-02).
 */
import { randomInt } from 'node:crypto';
import { sql, type Kysely, type Transaction } from 'kysely';
import { LIMITS, type LimitDefinition } from '../config/registers';
import type { Database } from '../models/campusone_models';
import { CustomAPIError, PreconditionFailedError, ValidationError } from '../utils/CustomAPIError';
import { parseCsv } from '../utils/csv';
import { istBusinessDate } from '../utils/format';
import { binToUuid, isUuid, newPublicIdPair, uuidToBin } from '../utils/idGenerator';
import type { Principal } from '../utils/principal';
import { institutionOf, yearFor } from './academic-year';
import { memberOf, type Member } from './member-roles';
import type { SettingsService } from './settings.service';

type Db = Kysely<Database> | Transaction<Database>;

/** Answers finishing an attempt this long after its last deadline still count (network delay). */
const GRACE_MS = 60_000;
const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);
const pct = (score: number, served: number) =>
  served ? Math.round((score * 1000) / served) / 10 : 0;
const shuffle = <T>(xs: readonly T[]) => {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(0, i + 1);
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
};

export interface QuestionInput {
  readonly text: string;
  readonly options: readonly string[];
  /** The correct option's position, 0–3. */
  readonly correct: number;
  readonly explanation?: string | null | undefined;
}

interface Ranked {
  readonly profileId: string;
  readonly name: string;
  readonly classSection: string | null;
  readonly value: number;
  readonly attempts: number;
  readonly best: number;
  readonly reachedAt: number;
  readonly rank: number;
  readonly institution?: string;
}

interface AttemptClock {
  served: number;
  current_seq: number;
  current_deadline_at: Date;
  seconds_per_question: number;
}

/**
 * The attempt's clock at `now`: every question whose time ran out counts as timed out and the next
 * one opens with a fresh deadline (served + 1 when all are done).
 */
function clockAt(a: AttemptClock, now: Date) {
  let seq = Number(a.current_seq);
  let deadline = new Date(a.current_deadline_at).getTime();
  const step = Number(a.seconds_per_question) * 1000;
  const timedOut: number[] = [];
  while (seq <= Number(a.served) && now.getTime() > deadline) {
    timedOut.push(seq);
    seq++;
    deadline += step;
  }
  return { seq, deadline: new Date(deadline), timedOut };
}

export class QuizService {
  constructor(
    private readonly deps: {
      readonly db: Kysely<Database>;
      readonly settings?: SettingsService;
      readonly now?: () => Date;
    },
  ) {}

  private now() {
    return this.deps.now?.() ?? new Date();
  }

  private async limit(l: LimitDefinition<number>) {
    return this.deps.settings ? this.deps.settings.get(l) : l.value;
  }

  private by(p: Principal) {
    return isUuid(p.subject) ? uuidToBin(p.subject) : null;
  }

  // --- the member's side --------------------------------------------------------------------------

  private async member(p: Principal, forProfile?: string) {
    const me = await memberOf(this.deps.db, p, forProfile);
    const on = await this.deps.db
      .selectFrom('feature_toggles')
      .select('enabled')
      .where('institution_id', '=', me.institutionId)
      .where('feature_key', '=', 'quiz')
      .executeTakeFirst();
    if (on && !Number(on.enabled)) throw new CustomAPIError(409, 'FIN.QUIZ_DISABLED');
    return me;
  }

  private topicByPublicId(db: Db, id: string) {
    if (!isUuid(id)) return Promise.resolve(undefined);
    return db
      .selectFrom('quiz_topics')
      .selectAll()
      .where('public_id', '=', uuidToBin(id))
      .executeTakeFirst();
  }

  /** FIN-001: the topics with published questions, the member's best and attempts left today. */
  async topics(p: Principal, q: { for?: string | undefined }) {
    const db = this.deps.db;
    const me = await this.member(p, q.for);
    await this.expireStale(me);
    const today = istBusinessDate(this.now());
    const [perDay, perAttempt] = await Promise.all([
      this.limit(LIMITS.quizAttemptsPerTopicPerDay),
      this.limit(LIMITS.quizQuestionsPerAttempt),
    ]);
    const topics = await db
      .selectFrom('quiz_topics as t')
      .select([
        't.id',
        't.public_id',
        't.name',
        't.description',
        't.icon',
        (eb) =>
          eb
            .selectFrom('quiz_questions as qq')
            .select(sql<number>`COUNT(*)`.as('n'))
            .whereRef('qq.topic_id', '=', 't.id')
            .where('qq.bank', '=', 'PUBLISHED')
            .where('qq.in_use', '=', 1)
            .as('questions'),
      ])
      .where('t.status', '=', 'ACTIVE')
      .orderBy('t.sort_order')
      .orderBy('t.name')
      .execute();
    const mine = await db
      .selectFrom('quiz_attempts')
      .select(['public_id', 'topic_id', 'status', 'score', 'served', 'started_on'])
      .where('institution_id', '=', me.institutionId)
      .where('profile_id', '=', me.rowId)
      .execute();
    const board = await this.board(me.institutionId, 'all');
    const myRank = board.find((r) => r.profileId === me.rowId);
    const done = mine.filter((a) => a.status === 'COMPLETED');
    const pcts = done.map((a) => pct(a.score ?? 0, a.served));
    return {
      perQuestionSec: await this.limit(LIMITS.quizSecondsPerQuestion),
      attemptsPerTopicPerDay: perDay,
      me: {
        attempts: done.length,
        best: pcts.length ? Math.max(...pcts) : null,
        average: pcts.length
          ? Math.round((pcts.reduce((s, v) => s + v, 0) / pcts.length) * 10) / 10
          : null,
        rank: myRank?.rank ?? null,
        ranked: board.length,
      },
      items: topics
        .filter((t) => Number(t.questions ?? 0) > 0)
        .map((t) => {
          const here = mine.filter((a) => String(a.topic_id) === String(t.id));
          const doneHere = here.filter((a) => a.status === 'COMPLETED');
          const usedToday = here.filter((a) => istDay(a.started_on) === today).length;
          const open = here.find((a) => a.status === 'IN_PROGRESS');
          return {
            id: binToUuid(t.public_id),
            name: t.name,
            description: t.description,
            icon: t.icon,
            questions: Math.min(Number(t.questions), perAttempt),
            best: doneHere.length
              ? Math.max(...doneHere.map((a) => pct(a.score ?? 0, a.served)))
              : null,
            attemptsLeftToday: Math.max(0, perDay - usedToday),
            // An attempt still running (the app reloaded): carry on with FIN-018.
            openAttemptId: open ? binToUuid(open.public_id) : null,
          };
        }),
    };
  }

  /** FIN-002: start an attempt — questions and shuffled options, never the answers. */
  async start(p: Principal, b: { topicId: string; for?: string | undefined }) {
    const me = await this.member(p, b.for);
    const db = this.deps.db;
    const topic = await this.topicByPublicId(db, b.topicId);
    if (!topic || topic.status !== 'ACTIVE') throw new CustomAPIError(404, 'FIN.TOPIC_NOT_FOUND');
    const [perDay, perAttempt, sec] = await Promise.all([
      this.limit(LIMITS.quizAttemptsPerTopicPerDay),
      this.limit(LIMITS.quizQuestionsPerAttempt),
      this.limit(LIMITS.quizSecondsPerQuestion),
    ]);
    const picked = await db
      .selectFrom('quiz_questions')
      .select(['id', 'public_id', 'text'])
      .where('topic_id', '=', String(topic.id))
      .where('bank', '=', 'PUBLISHED')
      .where('in_use', '=', 1)
      .orderBy(sql`RAND()`)
      .limit(perAttempt)
      .execute();
    if (!picked.length) throw new CustomAPIError(409, 'FIN.NO_QUESTIONS');
    const options = await db
      .selectFrom('quiz_options')
      .select(['id', 'public_id', 'question_id', 'text'])
      .where(
        'question_id',
        'in',
        picked.map((q) => String(q.id)),
      )
      .orderBy('seq')
      .execute();
    const at = this.now();
    const today = istBusinessDate(at);
    const attempt = newPublicIdPair();
    const questions = picked.map((q, i) => ({
      seq: i + 1,
      q,
      options: shuffle(options.filter((o) => String(o.question_id) === String(q.id))),
    }));
    await db.transaction().execute(async (trx) => {
      // The member's lock keeps the daily limit under concurrent starts.
      await trx
        .selectFrom('member_profiles')
        .select('id')
        .where('id', '=', me.rowId)
        .forUpdate()
        .execute();
      const used = await trx
        .selectFrom('quiz_attempts')
        .select(sql<number>`COUNT(*)`.as('n'))
        .where('institution_id', '=', me.institutionId)
        .where('profile_id', '=', me.rowId)
        .where('topic_id', '=', String(topic.id))
        .where('started_on', '=', today)
        .executeTakeFirst();
      if (Number(used?.n ?? 0) >= perDay) {
        throw new CustomAPIError(429, 'FIN.ATTEMPT_LIMIT', { params: { max: perDay } });
      }
      const ins = await trx
        .insertInto('quiz_attempts')
        .values({
          public_id: attempt.bin,
          institution_id: me.institutionId,
          profile_id: me.rowId,
          topic_id: String(topic.id),
          served: questions.length,
          seconds_per_question: sec,
          current_seq: 1,
          current_deadline_at: new Date(at.getTime() + sec * 1000),
          started_on: today,
          started_at: at,
        })
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('quiz_attempt_questions')
        .values(
          questions.map((x) => ({
            attempt_id: String(ins.insertId),
            seq: x.seq,
            question_id: String(x.q.id),
            option_order: x.options.map((o) => String(o.id)).join(','),
          })),
        )
        .execute();
    });
    return {
      attemptId: attempt.id,
      topic: { id: binToUuid(topic.public_id), name: topic.name },
      served: questions.length,
      perQuestionSec: sec,
      current: { seq: 1, deadlineAt: iso(new Date(at.getTime() + sec * 1000)) },
      questions: questions.map((x) => ({
        seq: x.seq,
        questionId: binToUuid(x.q.public_id),
        text: x.q.text,
        options: x.options.map((o) => ({ optionId: binToUuid(o.public_id), text: o.text })),
      })),
    };
  }

  /** The member's attempt, or 404 (another's answers the same). */
  private async attempt(db: Db, me: Member, id: string, lock = false) {
    if (!isUuid(id)) throw new CustomAPIError(404, 'FIN.ATTEMPT_NOT_FOUND');
    let q = db
      .selectFrom('quiz_attempts')
      .selectAll()
      .where('public_id', '=', uuidToBin(id))
      .where('institution_id', '=', me.institutionId)
      .where('profile_id', '=', me.rowId);
    if (lock) q = q.forUpdate();
    const a = await q.executeTakeFirst();
    if (!a) throw new CustomAPIError(404, 'FIN.ATTEMPT_NOT_FOUND');
    return a;
  }

  /**
   * Moves the attempt's clock to now: every question whose time ran out is timed out and the next one
   * opens with a fresh deadline. Returns the open question (served + 1 when all are done) and when it
   * closes.
   */
  private async catchUp(trx: Db, a: AttemptClock & { id: string }, now: Date) {
    const { seq, deadline, timedOut } = clockAt(a, now);
    if (timedOut.length) {
      await trx
        .updateTable('quiz_attempt_questions')
        .set({ timed_out: 1, correct: 0 })
        .where('attempt_id', '=', a.id)
        .where('seq', 'in', timedOut)
        .where('answered_at', 'is', null)
        .execute();
    }
    return { seq, deadline };
  }

  /**
   * FIN-018: an attempt still running, to carry on after the app reloads — the questions in the order
   * served with their options (never the answers), which are answered, and the open question with
   * its deadline (the clock never stops). Reading changes nothing.
   */
  async current(p: Principal, attemptId: string, q: { for?: string | undefined }) {
    const me = await this.member(p, q.for);
    await this.expireStale(me);
    const db = this.deps.db;
    const a = await this.attempt(db, me, attemptId);
    if (a.status !== 'IN_PROGRESS') throw new CustomAPIError(409, 'FIN.ATTEMPT_CLOSED');
    const clock = clockAt(a, this.now());
    const rows = await db
      .selectFrom('quiz_attempt_questions as aq')
      .innerJoin('quiz_questions as q', 'q.id', 'aq.question_id')
      .select(['aq.seq', 'aq.option_order', 'aq.answered_at', 'q.public_id', 'q.text'])
      .where('aq.attempt_id', '=', a.id)
      .orderBy('aq.seq')
      .execute();
    const ids = rows.flatMap((r) => r.option_order.split(','));
    const options = ids.length
      ? await db
          .selectFrom('quiz_options')
          .select(['id', 'public_id', 'text'])
          .where('id', 'in', ids)
          .execute()
      : [];
    const byId = new Map(options.map((o) => [String(o.id), o]));
    const topic = await db
      .selectFrom('quiz_topics')
      .select(['public_id', 'name'])
      .where('id', '=', a.topic_id)
      .executeTakeFirstOrThrow();
    const served = Number(a.served);
    return {
      attemptId: binToUuid(a.public_id),
      topic: { id: binToUuid(topic.public_id), name: topic.name },
      served,
      perQuestionSec: Number(a.seconds_per_question),
      current: clock.seq <= served ? { seq: clock.seq, deadlineAt: iso(clock.deadline) } : null,
      answered: rows.filter((r) => r.answered_at).length,
      questions: rows.map((r) => ({
        seq: Number(r.seq),
        questionId: binToUuid(r.public_id),
        text: r.text,
        options: r.option_order
          .split(',')
          .map((id) => byId.get(id))
          .filter((o) => o !== undefined)
          .map((o) => ({ optionId: binToUuid(o.public_id), text: o.text })),
        state: r.answered_at
          ? ('ANSWERED' as const)
          : Number(r.seq) < clock.seq
            ? ('TIMED_OUT' as const)
            : ('OPEN' as const),
      })),
    };
  }

  /** FIN-003: one answer, in order and in time; a late one counts as timed out. Never says if right. */
  async answer(
    p: Principal,
    attemptId: string,
    b: { questionId: string; optionId: string; for?: string | undefined },
  ) {
    const me = await this.member(p, b.for);
    return this.deps.db.transaction().execute(async (trx) => {
      const a = await this.attempt(trx, me, attemptId, true);
      if (a.status !== 'IN_PROGRESS') throw new CustomAPIError(409, 'FIN.ATTEMPT_CLOSED');
      const now = this.now();
      const clock = await this.catchUp(trx, a, now);
      const row =
        isUuid(b.questionId) &&
        (await trx
          .selectFrom('quiz_attempt_questions as aq')
          .innerJoin('quiz_questions as q', 'q.id', 'aq.question_id')
          .select(['aq.seq', 'aq.option_order', 'aq.answered_at'])
          .where('aq.attempt_id', '=', a.id)
          .where('q.public_id', '=', uuidToBin(b.questionId))
          .executeTakeFirst());
      if (!row) throw new CustomAPIError(404, 'FIN.QUESTION_NOT_FOUND');
      const seq = Number(row.seq);
      const next = (s: number, d: Date) =>
        s <= Number(a.served) ? { seq: s, deadlineAt: iso(d) } : null;
      if (seq < clock.seq || row.answered_at) {
        await trx
          .updateTable('quiz_attempts')
          .set({ current_seq: clock.seq, current_deadline_at: clock.deadline })
          .where('id', '=', a.id)
          .execute();
        return { accepted: false, timedOut: true, next: next(clock.seq, clock.deadline) };
      }
      if (seq > clock.seq) throw new CustomAPIError(409, 'FIN.NOT_CURRENT');
      const option = isUuid(b.optionId)
        ? await trx
            .selectFrom('quiz_options')
            .select(['id', 'is_correct'])
            .where('public_id', '=', uuidToBin(b.optionId))
            .executeTakeFirst()
        : undefined;
      if (!option || !row.option_order.split(',').includes(String(option.id))) {
        throw new ValidationError([{ field: 'optionId', code: 'FIN.OPTION_INVALID' }]);
      }
      await trx
        .updateTable('quiz_attempt_questions')
        .set({
          chosen_option_id: String(option.id),
          correct: Number(option.is_correct) ? 1 : 0,
          answered_at: now,
        })
        .where('attempt_id', '=', a.id)
        .where('seq', '=', seq)
        .execute();
      const deadline = new Date(now.getTime() + Number(a.seconds_per_question) * 1000);
      await trx
        .updateTable('quiz_attempts')
        .set({
          current_seq: seq + 1,
          current_deadline_at: deadline,
          row_version: sql<number>`row_version + 1`,
        })
        .where('id', '=', a.id)
        .execute();
      return { accepted: true, timedOut: false, next: next(seq + 1, deadline) };
    });
  }

  /** FIN-004: finish — scored on the server; the institution rank before and after. */
  async complete(p: Principal, attemptId: string, q: { for?: string | undefined }) {
    const me = await this.member(p, q.for);
    const before = (await this.board(me.institutionId, 'all')).find(
      (r) => r.profileId === me.rowId,
    );
    const out = await this.deps.db.transaction().execute(async (trx) => {
      const a = await this.attempt(trx, me, attemptId, true);
      if (a.status !== 'IN_PROGRESS') throw new CustomAPIError(409, 'FIN.ATTEMPT_CLOSED');
      const now = this.now();
      await this.catchUp(trx, a, now);
      // Questions not reached are counted as unanswered.
      await trx
        .updateTable('quiz_attempt_questions')
        .set({ correct: 0 })
        .where('attempt_id', '=', a.id)
        .where('answered_at', 'is', null)
        .execute();
      const counts = await trx
        .selectFrom('quiz_attempt_questions')
        .select([
          sql<number>`SUM(correct = 1)`.as('correct'),
          sql<number>`SUM(answered_at IS NULL)`.as('unanswered'),
        ])
        .where('attempt_id', '=', a.id)
        .executeTakeFirst();
      const score = Number(counts?.correct ?? 0);
      const unanswered = Number(counts?.unanswered ?? 0);
      const done = await trx
        .updateTable('quiz_attempts')
        .set({
          status: 'COMPLETED',
          score,
          completed_at: now,
          current_seq: Number(a.served) + 1,
          row_version: sql<number>`row_version + 1`,
        })
        .where('id', '=', a.id)
        .where('status', '=', 'IN_PROGRESS')
        .executeTakeFirst();
      if (Number(done.numUpdatedRows) !== 1) throw new CustomAPIError(409, 'FIN.ATTEMPT_CLOSED');
      return { a, score, unanswered, now };
    });
    const after = (await this.board(me.institutionId, 'all')).find((r) => r.profileId === me.rowId);
    const served = Number(out.a.served);
    return {
      attemptId,
      score: out.score,
      served,
      percentage: pct(out.score, served),
      correct: out.score,
      wrong: served - out.score - out.unanswered,
      unanswered: out.unanswered,
      completedAt: iso(out.now),
      rank: after?.rank ?? null,
      rankBefore: before?.rank ?? null,
    };
  }

  private async expire(db: Db, attemptId: string) {
    await db
      .updateTable('quiz_attempts')
      .set({ status: 'EXPIRED', row_version: sql<number>`row_version + 1` })
      .where('id', '=', attemptId)
      .where('status', '=', 'IN_PROGRESS')
      .execute();
  }

  /** Attempts left unfinished past their last deadline (and the grace) expire (OI-FIN-26). */
  private async expireStale(me: Member) {
    const db = this.deps.db;
    const open = await db
      .selectFrom('quiz_attempts')
      .select(['id', 'served', 'current_seq', 'current_deadline_at', 'seconds_per_question'])
      .where('institution_id', '=', me.institutionId)
      .where('profile_id', '=', me.rowId)
      .where('status', '=', 'IN_PROGRESS')
      .execute();
    const now = this.now().getTime();
    for (const a of open) {
      const remaining = Number(a.served) - Number(a.current_seq);
      const last =
        new Date(a.current_deadline_at).getTime() +
        Math.max(0, remaining) * Number(a.seconds_per_question) * 1000;
      if (now > last + GRACE_MS) await this.expire(db, String(a.id));
    }
  }

  /** FIN-005: the member's attempts, newest first. */
  async history(p: Principal, q: { for?: string | undefined; cursor?: string | undefined }) {
    const me = await this.member(p, q.for);
    await this.expireStale(me);
    const db = this.deps.db;
    let before: string | undefined;
    if (q.cursor) {
      const m = /^q:(\d{1,20})$/.exec(Buffer.from(q.cursor, 'base64url').toString('utf8'));
      if (!m?.[1]) throw new ValidationError([{ field: 'cursor', code: 'VALIDATION.FORMAT' }]);
      before = m[1];
    }
    let rows = db
      .selectFrom('quiz_attempts as a')
      .innerJoin('quiz_topics as t', 't.id', 'a.topic_id')
      .select([
        'a.id',
        'a.public_id',
        'a.status',
        'a.score',
        'a.served',
        'a.started_at',
        'a.completed_at',
        't.public_id as topic_public_id',
        't.name as topic_name',
        't.icon',
      ])
      .where('a.institution_id', '=', me.institutionId)
      .where('a.profile_id', '=', me.rowId);
    if (before) rows = rows.where('a.id', '<', before);
    const page = await rows.orderBy('a.id', 'desc').limit(51).execute();
    const shown = page.slice(0, 50);
    const done = await db
      .selectFrom('quiz_attempts')
      .select(['score', 'served'])
      .where('institution_id', '=', me.institutionId)
      .where('profile_id', '=', me.rowId)
      .where('status', '=', 'COMPLETED')
      .execute();
    const pcts = done.map((a) => pct(a.score ?? 0, a.served));
    return {
      summary: {
        attempts: done.length,
        average: pcts.length
          ? Math.round((pcts.reduce((s, v) => s + v, 0) / pcts.length) * 10) / 10
          : null,
        best: pcts.length ? Math.max(...pcts) : null,
      },
      items: shown.map((a) => ({
        attemptId: binToUuid(a.public_id),
        topic: { id: binToUuid(a.topic_public_id), name: a.topic_name, icon: a.icon },
        status: a.status,
        score: a.score,
        served: a.served,
        percentage: a.status === 'COMPLETED' ? pct(a.score ?? 0, a.served) : null,
        startedAt: iso(a.started_at),
        completedAt: iso(a.completed_at),
      })),
      nextCursor:
        page.length > 50
          ? Buffer.from(`q:${shown.at(-1)!.id}`, 'utf8').toString('base64url')
          : null,
    };
  }

  /** FIN-006: every answer with the correct one and the explanation, once the attempt is done. */
  async review(p: Principal, attemptId: string, q: { for?: string | undefined }) {
    const me = await this.member(p, q.for);
    const db = this.deps.db;
    const a = await this.attempt(db, me, attemptId);
    if (a.status !== 'COMPLETED') throw new CustomAPIError(409, 'FIN.ATTEMPT_OPEN');
    const topic = await db
      .selectFrom('quiz_topics')
      .select(['public_id', 'name'])
      .where('id', '=', String(a.topic_id))
      .executeTakeFirstOrThrow();
    const rows = await db
      .selectFrom('quiz_attempt_questions as aq')
      .innerJoin('quiz_questions as q', 'q.id', 'aq.question_id')
      .select([
        'aq.seq',
        'aq.option_order',
        'aq.chosen_option_id',
        'aq.correct',
        'aq.timed_out',
        'aq.answered_at',
        'q.text',
        'q.explanation',
      ])
      .where('aq.attempt_id', '=', a.id)
      .orderBy('aq.seq')
      .execute();
    const optionIds = rows.flatMap((r) => r.option_order.split(','));
    const options = optionIds.length
      ? await db
          .selectFrom('quiz_options')
          .select(['id', 'public_id', 'text', 'is_correct'])
          .where('id', 'in', optionIds)
          .execute()
      : [];
    const byId = new Map(options.map((o) => [String(o.id), o]));
    return {
      attemptId,
      topic: { id: binToUuid(topic.public_id), name: topic.name },
      score: a.score,
      served: a.served,
      percentage: pct(a.score ?? 0, a.served),
      completedAt: iso(a.completed_at),
      items: rows.map((r) => ({
        seq: r.seq,
        text: r.text,
        explanation: r.explanation,
        outcome: r.answered_at ? (Number(r.correct) ? 'CORRECT' : 'WRONG') : 'UNANSWERED',
        timedOut: Boolean(Number(r.timed_out)),
        options: r.option_order.split(',').map((id) => {
          const o = byId.get(id)!;
          return {
            optionId: binToUuid(o.public_id),
            text: o.text,
            correct: Boolean(Number(o.is_correct)),
            chosen: String(r.chosen_option_id ?? '') === id,
          };
        }),
      })),
    };
  }

  // --- leaderboards -------------------------------------------------------------------------------

  /**
   * The ranking of completed attempts (students only on an institution board): the average of score ÷
   * served across attempts (method 0) or the best per topic averaged (method 1); a tie goes to whoever
   * reached the value first.
   */
  private async board(
    institutionId: string | null,
    period: 'all' | 'year',
    yearRange?: { from: string; to: string },
  ): Promise<Ranked[]> {
    const db = this.deps.db;
    let q = db
      .selectFrom('quiz_attempts as a')
      .innerJoin('member_profiles as m', 'm.id', 'a.profile_id')
      .innerJoin('user_types as ut', 'ut.id', 'm.user_type_id')
      .innerJoin('institutions as i', 'i.id', 'a.institution_id')
      .select([
        'a.profile_id',
        'a.institution_id',
        'a.topic_id',
        'a.score',
        'a.served',
        'a.completed_at',
        'm.first_name',
        'm.last_name',
        'i.short_name',
        'i.name as institution_name',
      ])
      .where('a.status', '=', 'COMPLETED')
      .where('ut.category', '=', 'STUDENT')
      .where('m.status', '=', 'ACTIVE');
    if (institutionId) q = q.where('a.institution_id', '=', institutionId);
    if (period === 'year' && yearRange) {
      q = q
        .where('a.completed_at', '>=', new Date(`${yearRange.from}T00:00:00+05:30`))
        .where(
          'a.completed_at',
          '<',
          new Date(Date.parse(`${yearRange.to}T00:00:00+05:30`) + 86_400_000),
        );
    }
    const rows = await q.execute();
    const method = await this.limit(LIMITS.quizRankMethod);
    const byMember = new Map<string, typeof rows>();
    for (const r of rows) {
      const k = String(r.profile_id);
      byMember.set(k, [...(byMember.get(k) ?? []), r]);
    }
    const scored = [...byMember.entries()].map(([profileId, xs]) => {
      const sorted = [...xs].sort(
        (a, b) => new Date(a.completed_at!).getTime() - new Date(b.completed_at!).getTime(),
      );
      const ps = sorted.map((a) => pct(a.score ?? 0, a.served));
      let value: number;
      let reachedAt: number;
      if (method === 1) {
        const best = new Map<string, { v: number; at: number }>();
        sorted.forEach((a, i) => {
          const k = String(a.topic_id);
          const cur = best.get(k);
          if (!cur || ps[i]! > cur.v)
            best.set(k, { v: ps[i]!, at: new Date(a.completed_at!).getTime() });
        });
        const vs = [...best.values()];
        value = Math.round((vs.reduce((s, x) => s + x.v, 0) / vs.length) * 10) / 10;
        reachedAt = Math.max(...vs.map((x) => x.at));
      } else {
        value = Math.round((ps.reduce((s, v) => s + v, 0) / ps.length) * 10) / 10;
        reachedAt = new Date(sorted.at(-1)!.completed_at!).getTime();
      }
      const first = sorted[0]!;
      return {
        profileId,
        name: [first.first_name, first.last_name].filter(Boolean).join(' '),
        classSection: null as string | null,
        value,
        attempts: sorted.length,
        best: Math.max(...ps),
        reachedAt,
        institution: first.short_name ?? first.institution_name,
      };
    });
    scored.sort((a, b) => b.value - a.value || a.reachedAt - b.reachedAt);
    return scored.map((r, i) => ({ ...r, rank: i + 1 }));
  }

  /** Class-section labels for the year in context. */
  private async sections(institutionId: string, profileIds: readonly string[]) {
    const out = new Map<string, string>();
    if (!profileIds.length) return out;
    const year = await yearFor(this.deps.db, institutionId, null).catch(() => null);
    if (!year) return out;
    const rows = await this.deps.db
      .selectFrom('enrolments as en')
      .innerJoin('sections as s', 's.id', 'en.section_id')
      .innerJoin('classes as c', 'c.id', 's.class_id')
      .select(['en.student_profile_id', 'c.name as class_name', 's.name as section_name'])
      .where('en.institution_id', '=', institutionId)
      .where('en.year_id', '=', year.id)
      .where('en.student_profile_id', 'in', profileIds as string[])
      .execute();
    for (const r of rows)
      out.set(String(r.student_profile_id), `${r.class_name} ${r.section_name}`);
    return out;
  }

  /** FIN-007: the school's leaderboard with the member's own rank (OI-FIN-27). */
  async leaderboard(
    p: Principal,
    q: {
      period?: 'all' | 'year' | undefined;
      full?: boolean | undefined;
      for?: string | undefined;
    },
  ) {
    const me = await this.member(p, q.for);
    const period = q.period ?? 'all';
    const year = await yearFor(this.deps.db, me.institutionId, null).catch(() => null);
    const board = await this.board(
      me.institutionId,
      period,
      year ? { from: year.startsOn, to: year.endsOn } : undefined,
    );
    const top = await this.limit(LIMITS.quizLeaderboardSize);
    const shown = q.full ? board.slice(0, 500) : board.slice(0, top);
    const mine = board.find((r) => r.profileId === me.rowId) ?? null;
    const labels = await this.sections(me.institutionId, [
      ...shown.map((r) => r.profileId),
      ...(mine ? [mine.profileId] : []),
    ]);
    const view = (r: Ranked) => ({
      rank: r.rank,
      name: r.name,
      classSection: labels.get(r.profileId) ?? null,
      average: r.value,
      best: r.best,
      attempts: r.attempts,
      you: r.profileId === me.rowId,
    });
    return {
      period,
      year: year ? { id: year.publicId, label: year.label } : null,
      rule: (await this.limit(LIMITS.quizRankMethod)) === 1 ? 'BEST_PER_TOPIC' : 'AVERAGE_ALL',
      ranked: board.length,
      items: shown.map(view),
      me: mine ? view(mine) : null,
    };
  }

  /** FIN-008: who took part, how often and how well (students of the year, a class-section, a range). */
  async participation(
    p: Principal,
    q: { from?: string | undefined; to?: string | undefined; classSection?: string | undefined },
  ) {
    const db = this.deps.db;
    const inst = await institutionOf(db, p);
    const year = await yearFor(db, inst.id, null);
    const to = q.to ?? istBusinessDate(this.now());
    const from = q.from ?? year.startsOn;
    for (const [k, v] of [
      ['from', from],
      ['to', to],
    ] as const) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v))
        throw new ValidationError([{ field: k, code: 'VALIDATION.DATE' }]);
    }
    if (from > to) throw new ValidationError([{ field: 'to', code: 'COM.REPORT_RANGE' }]);
    let sectionRow: string | null = null;
    if (q.classSection) {
      const s = isUuid(q.classSection)
        ? await db
            .selectFrom('sections as s')
            .innerJoin('classes as c', 'c.id', 's.class_id')
            .select('s.id')
            .where('s.public_id', '=', uuidToBin(q.classSection))
            .where('c.institution_id', '=', inst.id)
            .executeTakeFirst()
        : undefined;
      if (!s) throw new ValidationError([{ field: 'classSection', code: 'VALIDATION.FORMAT' }]);
      sectionRow = String(s.id);
    }
    let students = db
      .selectFrom('enrolments as en')
      .innerJoin('member_profiles as m', 'm.id', 'en.student_profile_id')
      .innerJoin('sections as s', 's.id', 'en.section_id')
      .innerJoin('classes as c', 'c.id', 's.class_id')
      .select([
        'm.id',
        'm.first_name',
        'm.last_name',
        'm.admission_no',
        'c.name as class_name',
        'c.sort_order',
        's.name as section_name',
      ])
      .where('en.institution_id', '=', inst.id)
      .where('en.year_id', '=', year.id)
      .where('m.status', '=', 'ACTIVE');
    if (sectionRow) students = students.where('en.section_id', '=', sectionRow);
    const list = await students
      .orderBy('c.sort_order')
      .orderBy('s.name')
      .orderBy('m.first_name')
      .execute();
    const attempts = list.length
      ? await db
          .selectFrom('quiz_attempts')
          .select(['profile_id', 'status', 'score', 'served', 'started_at'])
          .where('institution_id', '=', inst.id)
          .where(
            'profile_id',
            'in',
            list.map((s) => String(s.id)),
          )
          .where('started_at', '>=', new Date(`${from}T00:00:00+05:30`))
          .where('started_at', '<', new Date(Date.parse(`${to}T00:00:00+05:30`) + 86_400_000))
          .execute()
      : [];
    const rows = list.map((s) => {
      const mine = attempts.filter((a) => String(a.profile_id) === String(s.id));
      const done = mine.filter((a) => a.status === 'COMPLETED');
      const ps = done.map((a) => pct(a.score ?? 0, a.served));
      const last = mine.map((a) => new Date(a.started_at).getTime()).sort((a, b) => b - a)[0];
      return {
        name: [s.first_name, s.last_name].filter(Boolean).join(' '),
        admissionNo: s.admission_no,
        classSection: `${s.class_name} ${s.section_name}`,
        attempts: mine.length,
        completed: done.length,
        average: ps.length
          ? Math.round((ps.reduce((x, v) => x + v, 0) / ps.length) * 10) / 10
          : null,
        best: ps.length ? Math.max(...ps) : null,
        lastAttemptAt: last ? new Date(last).toISOString() : null,
      };
    });
    const took = rows.filter((r) => r.attempts > 0);
    const all = rows.flatMap((r) => (r.average === null ? [] : [r.average]));
    return {
      year: { id: year.publicId, label: year.label },
      period: { from, to },
      totals: {
        students: rows.length,
        participants: took.length,
        participation: rows.length ? Math.round((took.length * 1000) / rows.length) / 10 : null,
        attempts: rows.reduce((s, r) => s + r.attempts, 0),
        average: all.length
          ? Math.round((all.reduce((s, v) => s + v, 0) / all.length) * 10) / 10
          : null,
      },
      items: rows,
    };
  }

  /** FIN-017: the platform-wide leaderboard (the caller records the access). */
  async platformBoard(period: 'all' | 'year') {
    const today = istBusinessDate(this.now());
    const board = await this.board(null, period, {
      from: `${Number(today.slice(0, 4)) - (Number(today.slice(5, 7)) < 6 ? 1 : 0)}-06-01`,
      to: today,
    });
    const top = await this.limit(LIMITS.quizLeaderboardSize);
    return {
      period,
      ranked: board.length,
      institutions: [...new Set(board.map((r) => r.institution))].length,
      items: board.slice(0, top).map((r) => ({
        rank: r.rank,
        name: r.name.split(' ')[0],
        institution: r.institution,
        average: r.value,
        attempts: r.attempts,
      })),
    };
  }

  // --- the operators' bank (FIN-009…016) --------------------------------------------------------

  /** FIN-009: topics with their staging and published counts. */
  async opsTopics() {
    const rows = await this.deps.db
      .selectFrom('quiz_topics as t')
      .select([
        't.public_id',
        't.name',
        't.description',
        't.icon',
        't.status',
        't.row_version',
        't.updated_at',
        (eb) =>
          eb
            .selectFrom('quiz_questions as q')
            .select(sql<number>`COUNT(*)`.as('n'))
            .whereRef('q.topic_id', '=', 't.id')
            .where('q.bank', '=', 'STAGING')
            .as('staging'),
        (eb) =>
          eb
            .selectFrom('quiz_questions as q')
            .select(sql<number>`COUNT(*)`.as('n'))
            .whereRef('q.topic_id', '=', 't.id')
            .where('q.bank', '=', 'PUBLISHED')
            .where('q.in_use', '=', 1)
            .as('published'),
        (eb) =>
          eb
            .selectFrom('quiz_attempts as a')
            .select(sql<number>`COUNT(*)`.as('n'))
            .whereRef('a.topic_id', '=', 't.id')
            .as('attempts'),
      ])
      .orderBy('t.sort_order')
      .orderBy('t.name')
      .execute();
    return {
      items: rows.map((t) => ({
        id: binToUuid(t.public_id),
        name: t.name,
        description: t.description,
        icon: t.icon,
        status: t.status,
        staging: Number(t.staging ?? 0),
        published: Number(t.published ?? 0),
        attempts: Number(t.attempts ?? 0),
        updatedAt: iso(t.updated_at),
        version: t.row_version,
      })),
    };
  }

  private topicFields(b: {
    name?: string | undefined;
    description?: string | null | undefined;
    icon?: string | null | undefined;
  }) {
    const out: { name?: string; description?: string | null; icon?: string | null } = {};
    if (b.name !== undefined) {
      const name = b.name.trim();
      if (name.length < 3 || name.length > 60) {
        throw new ValidationError([{ field: 'name', code: 'FIN.TOPIC_NAME' }]);
      }
      out.name = name;
    }
    if (b.description !== undefined) out.description = b.description?.trim().slice(0, 200) || null;
    if (b.icon !== undefined) out.icon = b.icon?.trim().slice(0, 30) || null;
    return out;
  }

  /** FIN-010: a topic with a unique name. */
  async createTopic(
    p: Principal,
    b: { name: string; description?: string | null; icon?: string | null },
  ) {
    const f = this.topicFields(b);
    const id = newPublicIdPair();
    const at = this.now();
    try {
      await this.deps.db
        .insertInto('quiz_topics')
        .values({
          public_id: id.bin,
          name: f.name!,
          description: f.description ?? null,
          icon: f.icon ?? null,
          created_by: this.by(p),
          created_at: at,
          updated_at: at,
        })
        .execute();
    } catch (e) {
      if ((e as { errno?: number }).errno === 1062)
        throw new CustomAPIError(409, 'FIN.TOPIC_TAKEN');
      throw e;
    }
    return (await this.opsTopics()).items.find((t) => t.id === id.id)!;
  }

  /** FIN-011: rename, describe, withdraw or restore a topic (If-Match). */
  async updateTopic(
    id: string,
    expected: number,
    b: {
      name?: string;
      description?: string | null;
      icon?: string | null;
      status?: 'ACTIVE' | 'WITHDRAWN';
    },
  ) {
    const t = await this.topicByPublicId(this.deps.db, id);
    if (!t) throw new CustomAPIError(404, 'FIN.TOPIC_NOT_FOUND');
    const f = this.topicFields(b);
    try {
      const r = await this.deps.db
        .updateTable('quiz_topics')
        .set({
          ...f,
          ...(b.status ? { status: b.status } : {}),
          updated_at: this.now(),
          row_version: sql<number>`row_version + 1`,
        })
        .where('id', '=', t.id)
        .where('row_version', '=', expected)
        .executeTakeFirst();
      if (Number(r.numUpdatedRows) !== 1) throw new PreconditionFailedError();
    } catch (e) {
      if ((e as { errno?: number }).errno === 1062)
        throw new CustomAPIError(409, 'FIN.TOPIC_TAKEN');
      throw e;
    }
    return (await this.opsTopics()).items.find((x) => x.id === id.toLowerCase())!;
  }

  /** Checks a question: text, four different options, one correct (28.9). */
  private checked(b: QuestionInput) {
    const text = b.text.trim();
    const options = b.options.map((o) => o.trim());
    const ok =
      text.length >= 5 &&
      text.length <= 500 &&
      options.length === 4 &&
      options.every((o) => o.length >= 1 && o.length <= 200) &&
      new Set(options.map((o) => o.toLowerCase())).size === 4 &&
      Number.isInteger(b.correct) &&
      b.correct >= 0 &&
      b.correct <= 3;
    if (!ok) throw new ValidationError([{ field: 'question', code: 'FIN.QUESTION_MALFORMED' }]);
    return {
      text,
      options,
      correct: b.correct,
      explanation: b.explanation?.trim().slice(0, 500) || null,
    };
  }

  private async writeOptions(
    trx: Db,
    questionId: string,
    options: readonly string[],
    correct: number,
  ) {
    await trx.deleteFrom('quiz_options').where('question_id', '=', questionId).execute();
    await trx
      .insertInto('quiz_options')
      .values(
        options.map((text, i) => ({
          public_id: newPublicIdPair().bin,
          question_id: questionId,
          seq: i + 1,
          text,
          is_correct: i === correct ? 1 : 0,
        })),
      )
      .execute();
  }

  /** FIN-012: the staging bank (a topic's, or all), with each question's published state. */
  async staging(q: { topicId?: string | undefined; cursor?: string | undefined }) {
    const db = this.deps.db;
    let topicRow: string | null = null;
    if (q.topicId) {
      const t = await this.topicByPublicId(db, q.topicId);
      if (!t) throw new CustomAPIError(404, 'FIN.TOPIC_NOT_FOUND');
      topicRow = String(t.id);
    }
    let before: string | undefined;
    if (q.cursor) {
      const m = /^s:(\d{1,20})$/.exec(Buffer.from(q.cursor, 'base64url').toString('utf8'));
      if (!m?.[1]) throw new ValidationError([{ field: 'cursor', code: 'VALIDATION.FORMAT' }]);
      before = m[1];
    }
    let rows = db
      .selectFrom('quiz_questions as q')
      .innerJoin('quiz_topics as t', 't.id', 'q.topic_id')
      .leftJoin('quiz_questions as pub', 'pub.staging_id', 'q.id')
      .select([
        'q.id',
        'q.public_id',
        'q.text',
        'q.explanation',
        'q.row_version',
        'q.updated_at',
        't.public_id as topic_public_id',
        't.name as topic_name',
        'pub.in_use as published_in_use',
        'pub.updated_at as published_at',
      ])
      .where('q.bank', '=', 'STAGING');
    if (topicRow) rows = rows.where('q.topic_id', '=', topicRow);
    if (before) rows = rows.where('q.id', '<', before);
    const page = await rows.orderBy('q.id', 'desc').limit(101).execute();
    const shown = page.slice(0, 100);
    const options = shown.length
      ? await db
          .selectFrom('quiz_options')
          .select(['question_id', 'seq', 'text', 'is_correct'])
          .where(
            'question_id',
            'in',
            shown.map((r) => String(r.id)),
          )
          .orderBy('seq')
          .execute()
      : [];
    return {
      items: shown.map((r) => {
        const opts = options.filter((o) => String(o.question_id) === String(r.id));
        return {
          id: binToUuid(r.public_id),
          topic: { id: binToUuid(r.topic_public_id), name: r.topic_name },
          text: r.text,
          options: opts.map((o) => o.text),
          correct: opts.findIndex((o) => Number(o.is_correct) === 1),
          explanation: r.explanation,
          published:
            r.published_in_use === null || r.published_in_use === undefined
              ? false
              : Boolean(Number(r.published_in_use)) &&
                new Date(r.published_at!).getTime() >= new Date(r.updated_at).getTime(),
          version: r.row_version,
        };
      }),
      nextCursor:
        page.length > 100
          ? Buffer.from(`s:${shown.at(-1)!.id}`, 'utf8').toString('base64url')
          : null,
    };
  }

  /** FIN-013: one staging question. */
  async addQuestion(p: Principal, b: QuestionInput & { topicId: string }) {
    const t = await this.topicByPublicId(this.deps.db, b.topicId);
    if (!t) throw new CustomAPIError(404, 'FIN.TOPIC_NOT_FOUND');
    const c = this.checked(b);
    const id = newPublicIdPair();
    const at = this.now();
    try {
      await this.deps.db.transaction().execute(async (trx) => {
        const ins = await trx
          .insertInto('quiz_questions')
          .values({
            public_id: id.bin,
            topic_id: String(t.id),
            bank: 'STAGING',
            text: c.text,
            explanation: c.explanation,
            in_use: 1,
            created_by: this.by(p),
            created_at: at,
            updated_at: at,
          })
          .executeTakeFirstOrThrow();
        await this.writeOptions(trx, String(ins.insertId), c.options, c.correct);
      });
    } catch (e) {
      if ((e as { errno?: number }).errno === 1062) {
        throw new CustomAPIError(409, 'FIN.QUESTION_DUPLICATE');
      }
      throw e;
    }
    return { id: id.id, topicId: binToUuid(t.public_id), ...c, version: 1 };
  }

  /** FIN-014: edit a staging question, or remove it (If-Match). */
  async updateQuestion(
    id: string,
    expected: number,
    b: Partial<QuestionInput> & { removed?: boolean | undefined },
  ) {
    const db = this.deps.db;
    const q = isUuid(id)
      ? await db
          .selectFrom('quiz_questions')
          .selectAll()
          .where('public_id', '=', uuidToBin(id))
          .where('bank', '=', 'STAGING')
          .executeTakeFirst()
      : undefined;
    if (!q) throw new CustomAPIError(404, 'FIN.QUESTION_NOT_FOUND');
    if (Number(q.row_version) !== expected) throw new PreconditionFailedError();
    if (b.removed) {
      await db.transaction().execute(async (trx) => {
        await trx.deleteFrom('quiz_options').where('question_id', '=', q.id).execute();
        await trx.deleteFrom('quiz_questions').where('id', '=', q.id).execute();
      });
      return { id, removed: true };
    }
    const current = await db
      .selectFrom('quiz_options')
      .select(['text', 'is_correct'])
      .where('question_id', '=', q.id)
      .orderBy('seq')
      .execute();
    const c = this.checked({
      text: b.text ?? q.text,
      options: b.options ?? current.map((o) => o.text),
      correct: b.correct ?? current.findIndex((o) => Number(o.is_correct) === 1),
      explanation: b.explanation === undefined ? q.explanation : b.explanation,
    });
    try {
      await db.transaction().execute(async (trx) => {
        const r = await trx
          .updateTable('quiz_questions')
          .set({
            text: c.text,
            explanation: c.explanation,
            updated_at: this.now(),
            row_version: sql<number>`row_version + 1`,
          })
          .where('id', '=', q.id)
          .where('row_version', '=', expected)
          .executeTakeFirst();
        if (Number(r.numUpdatedRows) !== 1) throw new PreconditionFailedError();
        await this.writeOptions(trx, String(q.id), c.options, c.correct);
      });
    } catch (e) {
      if ((e as { errno?: number }).errno === 1062) {
        throw new CustomAPIError(409, 'FIN.QUESTION_DUPLICATE');
      }
      throw e;
    }
    return { id, ...c, version: expected + 1 };
  }

  /**
   * FIN-015: a sheet (saved as CSV) of six-row blocks in the first column — the question, four options
   * (the correct one ending "(Correct)"), a blank row. Every block is checked; the good ones go in
   * together, duplicates are skipped and the rest reported by row (OI-FIN-17/18).
   */
  async upload(p: Principal, topicId: string, content: string) {
    const db = this.deps.db;
    const t = await this.topicByPublicId(db, topicId);
    if (!t) throw new CustomAPIError(404, 'FIN.TOPIC_NOT_FOUND');
    if (content.includes(String.fromCharCode(0))) {
      throw new ValidationError([{ field: 'file', code: 'FIN.UPLOAD_FORMAT' }]);
    }
    const lines = parseCsvKeepBlanks(content).map((r) => (r[0] ?? '').trim());
    const blocks: { row: number; input: QuestionInput }[] = [];
    const rejected: { row: number; reason: string }[] = [];
    for (let i = 0; i < lines.length;) {
      while (i < lines.length && !lines[i]) i++;
      if (i >= lines.length) break;
      const row = i + 1;
      const cells = lines.slice(i, i + 5);
      i += 6;
      const marked = cells.slice(1).map((o) => /\(Correct\)\s*$/i.test(o));
      const options = cells.slice(1).map((o) => o.replace(/\(Correct\)\s*$/i, '').trim());
      const correct = marked.indexOf(true);
      if (cells.length < 5 || options.some((o) => !o)) {
        rejected.push({ row, reason: 'A question needs four answers.' });
        continue;
      }
      if (marked.filter(Boolean).length !== 1) {
        rejected.push({ row, reason: 'Mark exactly one answer with (Correct).' });
        continue;
      }
      try {
        blocks.push({ row, input: this.checked({ text: cells[0]!, options, correct }) });
      } catch {
        rejected.push({
          row,
          reason: 'The question or its answers are too long, too short or repeated.',
        });
      }
    }
    if (!blocks.length && rejected.length === 0) {
      throw new ValidationError([{ field: 'file', code: 'FIN.BLOCK_MALFORMED' }]);
    }
    const at = this.now();
    let accepted = 0;
    let skipped = 0;
    await db.transaction().execute(async (trx) => {
      for (const b of blocks) {
        const exists = await trx
          .selectFrom('quiz_questions')
          .select('id')
          .where('topic_id', '=', String(t.id))
          .where('bank', '=', 'STAGING')
          .where('text', '=', b.input.text)
          .executeTakeFirst();
        if (exists) {
          skipped++;
          continue;
        }
        const ins = await trx
          .insertInto('quiz_questions')
          .values({
            public_id: newPublicIdPair().bin,
            topic_id: String(t.id),
            bank: 'STAGING',
            text: b.input.text,
            explanation: null,
            in_use: 1,
            created_by: this.by(p),
            created_at: at,
            updated_at: at,
          })
          .executeTakeFirstOrThrow();
        await this.writeOptions(trx, String(ins.insertId), b.input.options, b.input.correct);
        accepted++;
      }
    });
    return { accepted, skipped, rejected };
  }

  /**
   * FIN-016: publish the topics' staging banks in one transaction — new and changed questions copied
   * to the published bank, published questions staging no longer holds withdrawn (OI-FIN-16/19).
   */
  async publish(topicIds: readonly string[]) {
    const db = this.deps.db;
    const topics: { id: string }[] = [];
    for (const id of topicIds) {
      const t = await this.topicByPublicId(db, id);
      if (!t) throw new CustomAPIError(404, 'FIN.TOPIC_NOT_FOUND');
      topics.push(t);
    }
    if (!topics.length)
      throw new ValidationError([{ field: 'topicIds', code: 'FIN.TOPIC_NOT_FOUND' }]);
    const at = this.now();
    let published = 0;
    let updated = 0;
    let withdrawn = 0;
    await db.transaction().execute(async (trx) => {
      for (const t of topics) {
        const staged = await trx
          .selectFrom('quiz_questions')
          .select(['id', 'text', 'explanation'])
          .where('topic_id', '=', String(t.id))
          .where('bank', '=', 'STAGING')
          .execute();
        for (const s of staged) {
          const opts = await trx
            .selectFrom('quiz_options')
            .select(['text', 'is_correct'])
            .where('question_id', '=', s.id)
            .orderBy('seq')
            .execute();
          const pub = await trx
            .selectFrom('quiz_questions')
            .select(['id', 'text', 'explanation', 'in_use'])
            .where('staging_id', '=', s.id)
            .executeTakeFirst();
          if (!pub) {
            const ins = await trx
              .insertInto('quiz_questions')
              .values({
                public_id: newPublicIdPair().bin,
                topic_id: String(t.id),
                bank: 'PUBLISHED',
                staging_id: String(s.id),
                text: s.text,
                explanation: s.explanation,
                in_use: 1,
                created_at: at,
                updated_at: at,
              })
              .executeTakeFirstOrThrow();
            await this.writeOptions(
              trx,
              String(ins.insertId),
              opts.map((o) => o.text),
              opts.findIndex((o) => Number(o.is_correct) === 1),
            );
            published++;
            continue;
          }
          const pubOpts = await trx
            .selectFrom('quiz_options')
            .select(['text', 'is_correct'])
            .where('question_id', '=', pub.id)
            .orderBy('seq')
            .execute();
          const same =
            pub.text === s.text &&
            (pub.explanation ?? null) === (s.explanation ?? null) &&
            Number(pub.in_use) === 1 &&
            JSON.stringify(pubOpts.map((o) => [o.text, Number(o.is_correct)])) ===
              JSON.stringify(opts.map((o) => [o.text, Number(o.is_correct)]));
          if (same) continue;
          await trx
            .updateTable('quiz_questions')
            .set({
              text: s.text,
              explanation: s.explanation,
              in_use: 1,
              updated_at: at,
              row_version: sql<number>`row_version + 1`,
            })
            .where('id', '=', pub.id)
            .execute();
          // Options already served in attempts keep their rows: only their texts and flags change.
          for (const [i, o] of opts.entries()) {
            await trx
              .updateTable('quiz_options')
              .set({ text: o.text, is_correct: Number(o.is_correct) })
              .where('question_id', '=', pub.id)
              .where('seq', '=', i + 1)
              .execute();
          }
          updated++;
        }
        const gone = await trx
          .updateTable('quiz_questions')
          .set({ in_use: 0, updated_at: at, row_version: sql<number>`row_version + 1` })
          .where('topic_id', '=', String(t.id))
          .where('bank', '=', 'PUBLISHED')
          .where('in_use', '=', 1)
          .where((eb) =>
            eb.or([
              eb('staging_id', 'is', null),
              eb('staging_id', 'not in', staged.length ? staged.map((s) => String(s.id)) : ['0']),
            ]),
          )
          .executeTakeFirst();
        withdrawn += Number(gone.numUpdatedRows);
      }
    });
    return { published, updated, withdrawn };
  }

  /** Route guard for attempt ids before a body is read. */
  async lookupAttempt(p: Principal, attemptId: string, forProfile?: string) {
    const me = await memberOf(this.deps.db, p, forProfile);
    await this.attempt(this.deps.db, me, attemptId);
  }

  /** Route guard for topic and question ids (operators). */
  async lookupTopic(id: string) {
    if (!(await this.topicByPublicId(this.deps.db, id))) {
      throw new CustomAPIError(404, 'FIN.TOPIC_NOT_FOUND');
    }
  }
}

/** A DATE column as YYYY-MM-DD. */
function istDay(d: Date | string) {
  if (typeof d === 'string') return d.slice(0, 10);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** CSV rows keeping blank lines (the sheet's separators matter here). */
function parseCsvKeepBlanks(content: string) {
  const text = content
    .replace(new RegExp('^' + String.fromCharCode(0xfeff)), '')
    .replace(/\r\n?/g, '\n');
  return text.split('\n').map((line) => (line.trim() ? (parseCsv(line)[0] ?? ['']) : ['']));
}
