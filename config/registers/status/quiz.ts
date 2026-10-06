/**
 * The financial literacy quiz (SRS 28, CR-01): register change RC-39 — the as-built module has no
 * status lifecycle (a topic can't be withdrawn, an attempt isn't recorded); CR-01 needs both.
 */
import { NEW, type StatusDomain } from './types';

export const QUIZ_TOPIC: StatusDomain<'ACTIVE' | 'WITHDRAWN'> = {
  domain: 'quiz_topic',
  srsDomain: null,
  rc: 'RC-39',
  values: [
    {
      code: 'ACTIVE',
      registerValue: 'ACTIVE',
      labelKey: 'status.quizTopic.active',
      label: 'Active',
      tone: 'ok',
      terminal: false,
    },
    {
      code: 'WITHDRAWN',
      registerValue: 'WITHDRAWN',
      labelKey: 'status.quizTopic.withdrawn',
      label: 'Withdrawn',
      tone: 'neutral',
      terminal: false,
    },
  ],
  transitions: [
    { from: NEW, to: 'ACTIVE', operation: 'an operator adds the topic (FIN-010)' },
    {
      from: 'ACTIVE',
      to: 'WITHDRAWN',
      operation: 'an operator withdraws it (FIN-011); members no longer see it',
    },
    { from: 'WITHDRAWN', to: 'ACTIVE', operation: 'an operator restores it (FIN-011)' },
  ],
};

export const QUIZ_ATTEMPT: StatusDomain<'IN_PROGRESS' | 'COMPLETED' | 'EXPIRED'> = {
  domain: 'quiz_attempt',
  srsDomain: null,
  rc: 'RC-39',
  values: [
    {
      code: 'IN_PROGRESS',
      registerValue: 'IN_PROGRESS',
      labelKey: 'status.quizAttempt.inProgress',
      label: 'In progress',
      tone: 'info',
      terminal: false,
    },
    {
      code: 'COMPLETED',
      registerValue: 'COMPLETED',
      labelKey: 'status.quizAttempt.completed',
      label: 'Completed',
      tone: 'ok',
      terminal: true,
    },
    {
      code: 'EXPIRED',
      registerValue: 'EXPIRED',
      labelKey: 'status.quizAttempt.expired',
      label: 'Not finished',
      tone: 'neutral',
      terminal: true,
    },
  ],
  transitions: [
    { from: NEW, to: 'IN_PROGRESS', operation: 'the member starts a quiz (FIN-002)' },
    {
      from: 'IN_PROGRESS',
      to: 'COMPLETED',
      operation:
        'the member finishes, or the last question times out and the app finishes it (FIN-004); scored on the server',
    },
    {
      from: 'IN_PROGRESS',
      to: 'EXPIRED',
      operation: 'left unfinished past its last deadline (OI-FIN-26); not counted',
    },
  ],
};

export const QUIZ_DOMAINS = [QUIZ_TOPIC, QUIZ_ATTEMPT] as const;
