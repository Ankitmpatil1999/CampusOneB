/**
 * Maker-checker and notification messages (SRS 17; MKR-001…005, IDN-057, COM-009/010/014/015;
 * prototype c.approvals and the console bell). The old 27.5 wording is kept where it reads correctly
 * (class K, Q22); a technical one is reworded minimally (class R); the rest are the prototype's
 * texts (class N, client standing approval 2026-10-03). Notification titles are `info` messages
 * rendered in the reader's language.
 */
import type { MessageDefinition } from './types';

const k = (key: string, register: string, text: string, http: number, refs: readonly string[]) =>
  ({
    key,
    register,
    srsText: text,
    class: 'K',
    type: 'error',
    http,
    en: text,
    approval: 'register',
    batch: 2,
    refs,
  }) as const;

const n = (
  key: string,
  type: 'error' | 'info',
  http: number | null,
  en: string,
  refs: readonly string[],
  placeholders?: readonly string[],
) =>
  ({
    key,
    register: null,
    srsText: null,
    class: 'N',
    type,
    ...(http === null ? {} : { http }),
    en,
    ...(placeholders ? { placeholders } : {}),
    approval: 'approved',
    batch: 2,
    refs: [...refs, 'client standing approval 2026-10-03'],
  }) as const;

export const APPROVAL_MESSAGES = [
  k('MKR.ALREADY_DECIDED', 'MSG-MKR-15', 'Request not found or already processed', 409, ['17.2']),
  k('MKR.OWN_APPROVE', 'MSG-MKR-16', 'Cannot approve your own request', 403, ['17.2', 'FR-MKC-03']),
  k('MKR.OWN_REJECT', 'MSG-MKR-17', 'You cannot reject your own request', 403, [
    '17.2',
    'FR-MKC-03',
  ]),
  {
    key: 'MKR.EFFECT_FAILED',
    register: 'MSG-MKR-19',
    srsText: 'Handler failed: <error>',
    class: 'R',
    type: 'error',
    http: 409,
    en: "The change couldn't be applied: {reason} The request stays pending.",
    placeholders: ['reason'],
    approval: 'approved',
    batch: 2,
    refs: ['17.2', 'FR-MKC-03', 'client standing approval 2026-10-03'],
  },
  n(
    'MKR.REMARKS_TOO_SHORT',
    'error',
    422,
    'Write your remarks — at least {min} characters.',
    ['17.2', 'OI-MKR-03'],
    ['min'],
  ),
  n(
    'MKR.NOT_YOUR_MODULE',
    'error',
    403,
    "Your role can't decide these requests. An Institution Administrator decides them.",
    ['17.2', 'Q9'],
  ),
  n(
    'IDN.CORRECTION_SAME',
    'error',
    422,
    "That's the value already recorded. Enter the corrected value.",
    ['CR-06', '6.38.5'],
  ),
  // Notification titles (in-app; the body is the request's own text).
  n(
    'NTF.APPROVAL_RAISED',
    'info',
    null,
    '{no} is waiting for your decision',
    ['17.2', 'FR-MKC-01'],
    ['no'],
  ),
  n('NTF.APPROVAL_APPROVED', 'info', null, '{no} approved', ['17.2'], ['no']),
  n('NTF.APPROVAL_REJECTED', 'info', null, '{no} rejected', ['17.2'], ['no']),
  n('NTF.CORRECTION_APPROVED', 'info', null, 'Your correction was approved', ['CR-06', '23.7']),
  n('NTF.CORRECTION_REJECTED', 'info', null, 'Your correction was rejected', ['CR-06', '23.7']),
] as const satisfies readonly MessageDefinition[];

export type ApprovalMessageKey = (typeof APPROVAL_MESSAGES)[number]['key'];
