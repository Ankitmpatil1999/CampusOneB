/**
 * Roles administration messages (SRS 6.28; IDN-063…069, IDN-039; prototype o.roles). The old system
 * had no roles screen, so there is no 27.5 wording; the texts are the prototype's (class N, client
 * standing approval 2026-10-03).
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
    batch: 2,
    refs,
  }) as const;

export const ROLE_MESSAGES = [
  n(
    'IDN.ROLE_NAME_TAKEN',
    409,
    'A role with this name already exists (operator and institution role names must differ)',
    ['6.28', 'prototype o.roles'],
  ),
  n(
    'IDN.ROLE_NOT_EDITABLE',
    409,
    "These are the platform's default institution roles; they can't be changed here.",
    ['OI-GOV-01', 'prototype o.roles'],
  ),
  n(
    'IDN.LAST_ROLE_ADMIN',
    409,
    'At least one enabled role must keep “Roles, tasks and accounts”, or nobody could restore access.',
    ['RNG-GOV-001', 'prototype o.roles'],
  ),
  n('IDN.OWN_ROLE_DISABLE', 409, "You can't disable your own role", ['prototype o.roles']),
  n(
    'IDN.OWN_ROLE_CHANGE',
    409,
    "You can't change your own role — ask another Platform Administrator",
    ['prototype o.roles'],
  ),
  n('IDN.OWN_ACCOUNT_DISABLE', 409, "You can't disable your own account", ['prototype o.roles']),
  n(
    'IDN.TASK_NOT_ASSIGNED',
    409,
    'Assign the task first; its sub-tasks can then be granted one by one.',
    ['prototype o.roles'],
  ),
  n(
    'IDN.SUBTASK_RESERVED',
    409,
    'Only the {role} role may hold this sub-task.',
    ['Q9', 'Q10a', 'OI-GOV-01'],
    ['role'],
  ),
  n(
    'IDN.ACCOUNT_IS_INSTITUTION',
    409,
    "This account belongs to {institution}. An institution account can't hold an operator role (OI-GOV-01).",
    ['OI-GOV-01', 'RNG-IDN-043', 'prototype o.roles'],
    ['institution'],
  ),
  n(
    'IDN.ACCOUNT_EMAIL_UNKNOWN',
    404,
    'No RingPe account uses this e-mail. The person signs up first, then gets the role.',
    ['6.28'],
  ),
  n('IDN.ROLE_DISABLED', 409, 'This role is disabled. Enable it first.', ['6.28']),
  n(
    'IDN.ROLE_NOT_ASSIGNABLE',
    409,
    "This role can't be given or taken away here. RingPe assigns the Institution Administrator role, and students have no console roles.",
    ['6.28', 'FR-IDN-10', 'OI-IDN-27'],
  ),
  n(
    'IDN.ROLE_WRONG_PROFILE',
    409,
    'The {role} role can be given only to {who}.',
    ['6.28', 'client 2026-10-13'],
    ['role', 'who'],
  ),
  // A staff member's role given as they are onboarded (client 2026-10-22) needs members.roles.
  n(
    'IDN.ROLE_NOT_PERMITTED',
    403,
    'Your role can’t give console roles. Onboard the staff member without one, and ask the institution administrator to give it.',
    ['6.28', 'client 2026-10-22'],
  ),
] as const satisfies readonly MessageDefinition[];

export type RoleMessageKey = (typeof ROLE_MESSAGES)[number]['key'];
