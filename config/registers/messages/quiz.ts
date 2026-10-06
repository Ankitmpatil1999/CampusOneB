/**
 * Financial literacy quiz messages (SRS 28, CR-01; FIN-001…017). The as-built texts are developer
 * strings (OI-FIN-14); these are new (class N) — client standing approval 2026-10-03.
 */
import type { MessageDefinition } from './types';

const n = (
  key: string,
  http: number,
  en: string,
  refs: readonly string[],
  placeholders?: readonly string[],
) =>
  ({
    key,
    register: null,
    srsText: null,
    class: 'N',
    type: 'error',
    http,
    en,
    ...(placeholders ? { placeholders } : {}),
    approval: 'approved',
    batch: 8,
    refs: [...refs, 'client standing approval 2026-10-03'],
  }) as const;

export const QUIZ_MESSAGES = [
  n('FIN.QUIZ_DISABLED', 409, 'The money quiz isn’t switched on for your school.', [
    '28.2',
    'OI-FIN-01',
  ]),
  n('FIN.TOPIC_NOT_FOUND', 404, 'Topic not found.', ['28.3']),
  n('FIN.NO_QUESTIONS', 409, 'This topic has no questions yet.', ['28.3']),
  n(
    'FIN.ATTEMPT_LIMIT',
    429,
    'You’ve used your {max} attempts on this topic today. Try again tomorrow.',
    ['28.4', 'OI-FIN-12'],
    ['max'],
  ),
  n('FIN.ATTEMPT_NOT_FOUND', 404, 'Attempt not found.', ['28.4']),
  n('FIN.ATTEMPT_CLOSED', 409, 'This attempt has ended.', ['28.4', 'OI-FIN-26']),
  n('FIN.ATTEMPT_OPEN', 409, 'Finish the quiz to review your answers.', ['28.5']),
  n('FIN.NOT_CURRENT', 409, 'Answer the questions in order.', ['28.4', 'OI-FIN-11']),
  n('FIN.OPTION_INVALID', 422, 'Choose one of the answers shown.', ['28.4']),
  n('FIN.QUESTION_NOT_FOUND', 404, 'Question not found.', ['28.9']),
  n('FIN.TOPIC_NAME', 422, 'Enter a topic name of 3 to 60 characters.', ['28.8', 'OI-FIN-15']),
  n('FIN.TOPIC_TAKEN', 409, 'A topic with this name already exists.', ['28.8', 'OI-FIN-15']),
  n(
    'FIN.QUESTION_MALFORMED',
    422,
    'A question needs its text, four different answers and exactly one correct answer.',
    ['28.9', 'OI-FIN-15'],
  ),
  n('FIN.QUESTION_DUPLICATE', 409, 'This topic already has a question with this text.', [
    '28.9',
    'RNG-FIN-113',
  ]),
  n(
    'FIN.BLOCK_MALFORMED',
    422,
    'No question in the file could be read. Each takes six rows: the question, four answers (end the right one with “(Correct)”) and a blank row.',
    ['28.10', 'OI-FIN-18'],
  ),
  n('FIN.UPLOAD_FORMAT', 422, 'Upload the sheet saved as a CSV file.', ['28.10', 'OI-FIN-18']),
] as const satisfies readonly MessageDefinition[];

export type QuizMessageKey = (typeof QUIZ_MESSAGES)[number]['key'];
