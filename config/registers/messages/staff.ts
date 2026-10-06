/**
 * Staff sign-in messages (SRS 6.4 console sign-in, 6.38.4 CR-05; IDN-031…039). The console shows
 * one fixed message for every refusal (RNG-IDN-376: the code step reveals nothing about the
 * account), kept as the old 27.5 wording (Q22, class K). New strings (N) only where none exists.
 */
import type { MessageDefinition } from './types';

export const STAFF_MESSAGES = [
  {
    key: 'IDN.CONSOLE_SIGNIN_REFUSED',
    register: 'MSG-IDN-96',
    srsText: "That email and password don't match. Give it another go.",
    class: 'K',
    type: 'error',
    http: 401,
    en: "That email and password don't match. Give it another go.",
    approval: 'register',
    batch: 2,
    refs: ['6.4', 'RNG-IDN-376', 'OI-IDN-05'],
  },
  {
    key: 'IDN.CONSOLE_LOCKED',
    register: null,
    srsText: null,
    class: 'N',
    type: 'error',
    http: 423,
    en: 'This account is locked after too many sign-in attempts. Your administrator can release it.',
    approval: 'approved',
    batch: 2,
    refs: ['CR-05', 'RNG-IDN-380', 'OI-IDN-38', 'Q13'],
  },
  {
    key: 'IDN.SIGNIN_ATTEMPT_ENDED',
    register: null,
    srsText: null,
    class: 'N',
    type: 'error',
    http: 400,
    en: '{count} wrong codes ended this sign-in attempt. Enter your password to start again.',
    placeholders: ['count'],
    approval: 'approved',
    batch: 2,
    refs: ['CR-05', 'RNG-IDN-380', 'prototype c.signin'],
  },
  {
    key: 'IDN.RESET_LINK_INVALID',
    register: null,
    srsText: null,
    class: 'N',
    type: 'error',
    http: 401,
    en: 'This link has expired or was already used. Ask for a new one on the sign-in page.',
    approval: 'approved',
    batch: 2,
    refs: ['6.4', 'OI-IDN-05', 'client standing approval 2026-10-03'],
  },
] as const satisfies readonly MessageDefinition[];

export type StaffMessageKey = (typeof STAFF_MESSAGES)[number]['key'];
