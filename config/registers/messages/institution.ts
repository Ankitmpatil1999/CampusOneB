/**
 * Institution messages (SRS 7.2–7.5, 7.12.1; INS-001…019; prototype o.institutions, o.features,
 * c.institution, c.roles, c.fields). The old 27.5 wording is kept verbatim where the old system had
 * the message (class K, Q22); the rest are the prototype's texts (class N, client standing approval
 * 2026-10-03).
 */
import type { MessageDefinition } from './types';

const k = (
  key: string,
  register: string,
  srsText: string,
  http: number,
  refs: readonly string[],
  en: string = srsText,
  placeholders?: readonly string[],
) =>
  ({
    key,
    register,
    srsText,
    class: 'K',
    type: 'error',
    http,
    en,
    ...(placeholders ? { placeholders } : {}),
    approval: 'register',
    batch: 2,
    refs,
  }) as const;

/** Class R: the old wording with the smallest change that keeps it true (approved by the client). */
const r = (key: string, register: string, srsText: string, en: string, refs: readonly string[]) =>
  ({
    key,
    register,
    srsText,
    class: 'R',
    type: 'error',
    http: 422,
    en,
    approval: 'approved',
    batch: 2,
    refs: [...refs, 'client 2026-10-03: allow & and brackets'],
  }) as const;

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
    refs: [...refs, 'client standing approval 2026-10-03'],
  }) as const;

const CHARS = `contains invalid characters. Only alphanumeric characters, spaces, single quotes ('), hyphens (-), commas (,), dots (.), and underscores (_) are allowed.`;
/** The old list plus & and brackets, which the client allowed on 2026-10-03 (the old text would be false). */
const CHARS_NOW = `contains invalid characters. Only alphanumeric characters, spaces, single quotes ('), hyphens (-), commas (,), dots (.), underscores (_), ampersands (&) and brackets ( ) are allowed.`;
const TYPE_CHARS = `Only alphanumeric characters, spaces, single quotes ('), hyphens (-), and underscores (_) are allowed.`;

export const INSTITUTION_MESSAGES = [
  // --- registration (7.4.4 server checks, in order) -------------------------------------------------
  r(
    'INS.NAME_FORMAT',
    'MSG-ONB-57',
    `organization_name ${CHARS}`,
    `organization_name ${CHARS_NOW}`,
    ['7.4.4', 'RNG-ONB-033'],
  ),
  r('INS.ADDRESS_FORMAT', 'MSG-ONB-58', `address ${CHARS}`, `address ${CHARS_NOW}`, ['7.4.4']),
  k('INS.PRIMARY_NAME_FORMAT', 'MSG-ONB-60', 'Invalid primary_contact_name', 422, ['7.4.4']),
  k('INS.PRIMARY_EMAIL_FORMAT', 'MSG-ONB-61', 'Invalid primary_contact_email', 422, ['7.4.4']),
  k('INS.PRIMARY_PHONE_FORMAT', 'MSG-ONB-62', 'Invalid primary_contact_phone', 422, ['7.4.4']),
  k('INS.SECONDARY_NAME_FORMAT', 'MSG-ONB-63', 'Invalid secondary_contact_name', 422, ['7.4.4']),
  k('INS.SECONDARY_EMAIL_FORMAT', 'MSG-ONB-64', 'Invalid secondary_contact_email', 422, ['7.4.4']),
  k('INS.SECONDARY_PHONE_FORMAT', 'MSG-ONB-65', 'Invalid secondary_contact_phone', 422, ['7.4.4']),
  k(
    'INS.ADMIN_EMAIL_FORMAT',
    'MSG-ONB-66',
    'Invalid admin_contact_email: must be a valid email address.',
    422,
    ['7.4.4'],
  ),
  k('INS.NAME_ADDRESS_TAKEN', 'MSG-ONB-67', 'Organization already registered', 409, [
    'RNG-ONB-033',
    'FR-INS-01',
  ]),
  k('INS.ADMIN_EMAIL_UNKNOWN', 'MSG-ONB-68', 'Admin email not registered in CampusOne', 422, [
    'RNG-ONB-034',
  ]),
  k('INS.ADMIN_IN_INSTITUTION', 'MSG-ONB-69', 'User already mapped to a CUG organization', 409, [
    'RNG-ONB-034',
    'BR-01',
  ]),
  n(
    'INS.ADMIN_ACCOUNT_INACTIVE',
    409,
    'The CampusOne account with this e-mail is not active. Use another e-mail, or reactivate the account first.',
    ['RNG-ONB-034', 'client 2026-10-07: an unknown e-mail is never refused'],
  ),
  n(
    'INS.ADMIN_MOBILE_TAKEN',
    409,
    "This mobile number already has a CampusOne account. Use that account's e-mail as the administrator's e-mail, or another mobile number.",
    ['RNG-ONB-034', 'BR-01', 'client 2026-10-07'],
  ),
  n(
    'INS.ADMIN_IS_OPERATOR',
    409,
    'This account holds a CampusOne operator role. An institution administrator needs an account without one (OI-GOV-01).',
    ['OI-GOV-01', 'RNG-IDN-043'],
  ),
  {
    key: 'INS.REGISTERED_EMAIL_SUBJECT',
    register: 'MSG-ONB-73',
    srsText: 'Organization Registration Successful - <institution name>',
    class: 'K',
    type: 'info',
    en: 'Organization Registration Successful - {name}',
    placeholders: ['name'],
    approval: 'register',
    batch: 2,
    refs: ['RNG-ONB-038'],
  },

  // --- lifecycle, bank arrangement, checklist (FR-INS-05, FR-SAS-10/11) ---------------------------
  n(
    'INS.TRANSITION_INVALID',
    409,
    "This change isn't possible while the institution is {status}.",
    ['FR-INS-05', 'RNG-GOV-009', 'RC-08'],
    ['status'],
  ),
  n(
    'INS.REASON_TOO_SHORT',
    422,
    'Give a reason of at least {min} characters.',
    ['FR-SAS-11', 'RNG-SAS-019', 'prototype o.institutions'],
    ['min'],
  ),
  n(
    'INS.CHECKLIST_INCOMPLETE',
    409,
    'Complete the required onboarding steps first: {steps}.',
    ['RNG-SAS-018', 'prototype o.institutions'],
    ['steps'],
  ),
  n(
    'INS.FROZEN',
    409,
    '{institution} is cancelled — its configuration is frozen.',
    ['FR-INS-05', 'prototype o.features'],
    ['institution'],
  ),
  n(
    'INS.CORPORATE_CODE_FORMAT',
    422,
    'Use 1 to {max} capital letters or digits',
    ['FR-WAL-03', 'OQ-28', 'client 2026-10-14: up to 10 characters'],
    ['max'],
  ),
  n('INS.CORPORATE_CODE_TAKEN', 409, 'This corporate code is already in use', [
    'FR-INS-06',
    'OQ-28',
  ]),
  // A school's corporate codes and their classes (client 2026-10-13/14; migration 0076).
  n('CC.NOT_FOUND', 404, 'Corporate code not found.', ['client 2026-10-14']),
  n('CC.BANK_NAME_REQUIRED', 422, 'Enter the bank name (2 to 100 characters).', [
    'client 2026-10-14',
  ]),
  n(
    'CC.DEFAULT_REQUIRED',
    409,
    'The school always has a default code. Make another code the default instead.',
    ['client 2026-10-14'],
  ),
  n(
    'CC.DEFAULT_DISABLED',
    409,
    'The default code can’t be disabled. Make another code the default first.',
    ['client 2026-10-14'],
  ),
  n('CC.CLASS_UNKNOWN', 422, 'Choose classes of this school.', ['client 2026-10-14']),
  n(
    'CC.CLASS_TAKEN',
    409,
    'Already on the corporate code {code}: {classes}. Take them off that code first.',
    ['client 2026-10-14: a class uses one corporate code'],
    ['classes', 'code'],
  ),
  k(
    'INS.POOL_ACCOUNT_FORMAT',
    'MSG-ONB-39',
    'Invalid pool_account: must be Alphanumeric Only.',
    422,
    ['RNG-ONB-040', 'OI-ONB-05'],
  ),

  // --- features and channels (7.5, FR-INS-04, FR-SAS-05) -----------------------------------------
  n(
    'INS.NOT_ENTITLED_BY_PLAN',
    409,
    "{feature} isn't included in {plan}.",
    ['FR-SAS-05', 'prototype o.features'],
    ['feature', 'plan'],
  ),
  n(
    'INS.FEATURE_NEEDS',
    409,
    'Turn on {feature} first.',
    ['OI-FEE-11', 'prototype o.features'],
    ['feature'],
  ),
  n('INS.CHANNEL_LOCKED', 409, "In-app notifications can't be switched off.", [
    'OI-ONB-09',
    'prototype c.institution',
  ]),

  // --- user types and departments (7.3, OI-ONB-04) -------------------------------------------------
  k(
    'INS.USER_TYPE_NAME_FORMAT',
    'MSG-ONB-36',
    `Invalid user_type_name: <name>. ${TYPE_CHARS}`,
    422,
    ['7.3.4'],
    `Invalid user_type_name: {name}. ${TYPE_CHARS}`,
    ['name'],
  ),
  k(
    'INS.DEPARTMENT_NAME_FORMAT',
    'MSG-ONB-38',
    `Invalid department_name: <name>. ${TYPE_CHARS}`,
    422,
    ['7.3.4'],
    `Invalid department_name: {name}. ${TYPE_CHARS}`,
    ['name'],
  ),
  k(
    'INS.DEPARTMENT_REQUIRED',
    'MSG-ONB-27',
    'Please enter both a role name and at least one department.',
    422,
    ['7.3.4', 'FR-INS-03'],
  ),
  n(
    'INS.USER_TYPE_TAKEN',
    409,
    'A user type called “{name}” already exists',
    ['7.3', 'prototype c.roles'],
    ['name'],
  ),
  n(
    'INS.DEPARTMENT_TAKEN',
    409,
    '“{name}” is already in this user type',
    ['7.3', 'prototype c.roles'],
    ['name'],
  ),
  n(
    'INS.DEPARTMENT_IN_USE',
    409,
    'Members are in {department}, so it can’t be removed.',
    ['OI-ONB-04', 'prototype c.roles'],
    ['department'],
  ),
  n('INS.USER_TYPE_NAME_FIXED', 409, 'Members use this type, so its name is fixed.', [
    'OI-ONB-04',
    'prototype c.roles',
  ]),

  // --- details and fee account (7.2, 7.5, FR-INS-06) ----------------------------------------------
  k(
    'INS.FEE_ACCOUNT_NOT_MERCHANT',
    'MSG-ONB-99',
    'The user is not registered as a merchant in the organization.',
    409,
    ['FR-INS-06', 'OI-MER-09'],
  ),

  // --- institution-defined fields (CR-12, RNG-ONB-101…115) ------------------------------------------
  n(
    'CF.LIMIT_REACHED',
    409,
    '{entity} already has {max} active fields — deactivate one first',
    ['OI-ONB-16', 'prototype c.fields'],
    ['entity', 'max'],
  ),
  n('CF.ACK_REQUIRED', 422, "Confirm that this field won't capture identity-document numbers", [
    'RNG-ONB-114',
  ]),
  n(
    'CF.LABEL_TAKEN',
    409,
    '{entity} already has a field called “{label}”',
    ['RNG-ONB-101', 'prototype c.fields'],
    ['entity', 'label'],
  ),
  n(
    'CF.ID_DOCUMENT_LABEL',
    422,
    "This label suggests an identity-document number. Custom fields can't capture those (RNG-GAS-139).",
    ['RNG-ONB-114', 'OI-GAS-27'],
  ),
  n('CF.OPTIONS_TOO_FEW', 422, 'Add at least two options', ['RNG-ONB-105']),
  n('CF.OPTIONS_DUPLICATE', 422, 'Each option must be different', ['RNG-ONB-105']),
  n('CF.OPTIONS_NOT_ALLOWED', 422, 'Only Dropdown and Multi-select fields have options.', [
    'RNG-ONB-105',
  ]),
  n(
    'CF.TYPE_FIXED',
    409,
    'Type and entity are fixed — values have been captured. Create a new field instead.',
    ['RNG-ONB-113'],
  ),
  n(
    'CF.FILTER_TYPE',
    422,
    'Only Dropdown, Multi-select and Yes/No fields can be offered as a filter.',
    ['prototype c.fields'],
  ),
  n('CF.UNIQUE_TYPE', 422, "A Yes/No or Multi-select field can't be unique", [
    'RNG-ONB-106',
    'prototype c.fields',
  ]),
  n(
    'CF.UNIQUE_CONFLICT',
    409,
    "Can't make this field unique: some records already share a value. Fix those first.",
    ['RNG-ONB-106', 'OI-ONB-16'],
  ),
] as const satisfies readonly MessageDefinition[];

export type InstitutionMessageKey = (typeof INSTITUTION_MESSAGES)[number]['key'];
