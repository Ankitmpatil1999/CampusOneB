/**
 * Scheduled-processing messages (GOV-001…004; SRS 26.6, RNG-GOV-021/024/025; prototype o.jobs).
 * No 27.5 wording exists for these (class N, client standing approval 2026-10-03).
 */
import type { MessageDefinition } from './types';

export const GOVERNANCE_MESSAGES = [
  {
    key: 'GOV.JOB_NOT_AVAILABLE',
    register: null,
    srsText: null,
    class: 'N',
    type: 'error',
    http: 409,
    en: "This process arrives with its module in Phase {phase}; it can't run yet.",
    placeholders: ['phase'],
    approval: 'approved',
    batch: 2,
    refs: ['26.6', 'RNG-GOV-024'],
  },
  {
    key: 'GOV.JOB_RUNNING',
    register: null,
    srsText: null,
    class: 'N',
    type: 'error',
    http: 409,
    en: 'This process is already running. Try again when the current run ends.',
    approval: 'approved',
    batch: 2,
    refs: ['26.6', 'RNG-GOV-024', 'client standing approval 2026-10-03'],
  },
] as const satisfies readonly MessageDefinition[];

export type GovernanceMessageKey = (typeof GOVERNANCE_MESSAGES)[number]['key'];
