/**
 * Notices of what was done for a member (client 2026-10-22: "any action taken needs to inform the
 * person concerned"): checked in or out, a fee received or changed, a teaching assignment, a pass or
 * coupons issued or cancelled, a settlement paid. New texts, class N — client standing approval
 * 2026-10-03. Each belongs to an event in comm-events.ts.
 */
import type { MessageDefinition } from './types';

const info = (key: string, en: string, placeholders: readonly string[]) =>
  ({
    key,
    register: null,
    srsText: null,
    class: 'N',
    type: 'info',
    en,
    placeholders,
    approval: 'approved',
    batch: 11,
    refs: ['client 2026-10-22', 'client standing approval 2026-10-03'],
  }) as const;

export const NOTICE_MESSAGES = [
  info('NTF.CHECKED_IN', '{name} checked in at {time}', ['name', 'time']),
  info('NTF.CHECKED_OUT', '{name} checked out at {time}', ['name', 'time']),
  info('NTF.FEE_RECEIVED', '{amount} received for {fee}', ['amount', 'fee']),
  info('NTF.FEE_CHANGED', '{fee} changed: {what}', ['fee', 'what']),
  info('NTF.TEACHING_ASSIGNED', 'You are now {what}', ['what']),
  info('NTF.TEACHING_ENDED', 'You are no longer {what}', ['what']),
  info('NTF.PASS_ISSUED', '{pass} pass for {date}', ['pass', 'date']),
  info('NTF.PASS_CANCELLED', '{pass} pass for {date} is cancelled', ['pass', 'date']),
  info('NTF.COUPONS_ISSUED', '{types} coupons from {from} to {to}', ['types', 'from', 'to']),
  info('NTF.COUPONS_CANCELLED', 'Coupons from {from} to {to} are cancelled', ['from', 'to']),
  info('NTF.SETTLEMENT_PAID', 'Settlement of {amount} paid', ['amount']),
] as const satisfies readonly MessageDefinition[];

export type NoticeMessageKey = (typeof NOTICE_MESSAGES)[number]['key'];
