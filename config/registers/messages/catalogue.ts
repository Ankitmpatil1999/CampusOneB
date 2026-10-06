import { APPROVAL_MESSAGES, type ApprovalMessageKey } from './approvals';
import { PAYMENT_MESSAGES, type PaymentMessageKey } from './payments';
import { TERMINAL_MESSAGES, type TerminalMessageKey } from './terminals';
import { ALLOWANCE_MESSAGES, type AllowanceMessageKey } from './allowances';
import { COUPON_MESSAGES, type CouponMessageKey } from './coupons';
import { EVENT_MESSAGES, type EventMessageKey } from './events';
import { POS_MESSAGES, type PosMessageKey } from './pos';
import { FEE_MESSAGES, type FeeMessageKey } from './fees';
import { ADMISSION_MESSAGES, type AdmissionMessageKey } from './admissions';
import { SETTLEMENT_MESSAGES, type SettlementMessageKey } from './settlement';
import { RECON_MESSAGES, type ReconMessageKey } from './recon';
import { GRIEVANCE_MESSAGES, type GrievanceMessageKey } from './grievances';
import { ACCOUNTING_MESSAGES, type AccountingMessageKey } from './accounting';
import { TEACHING_MESSAGES, type TeachingMessageKey } from './teaching';
import { ATTENDANCE_MESSAGES, type AttendanceMessageKey } from './attendance';
import { TRANSPORT_MESSAGES, type TransportMessageKey } from './transport';
import { PLATFORM_TOOL_MESSAGES, type PlatformToolMessageKey } from './platform-tools';
import { COMMUNICATION_MESSAGES, type CommunicationMessageKey } from './communication';
import { QUIZ_MESSAGES, type QuizMessageKey } from './quiz';
import { GOVERNANCE_MESSAGES, type GovernanceMessageKey } from './governance';
import { IDENTITY_MESSAGES, type IdentityMessageKey } from './identity';
import { INSTITUTION_MESSAGES, type InstitutionMessageKey } from './institution';
import { MEMBER_MESSAGES, type MemberMessageKey } from './members';
import { PERSONAL_MESSAGES, type PersonalMessageKey } from './personal';
import { PLATFORM_MESSAGES, type PlatformMessageKey } from './platform';
import { ROLE_MESSAGES, type RoleMessageKey } from './roles';
import { SAAS_MESSAGES, type SaasMessageKey } from './saas';
import { STAFF_MESSAGES, type StaffMessageKey } from './staff';
import type { MessageDefinition } from './types';

export type MessageKey =
  | PlatformMessageKey
  | IdentityMessageKey
  | PersonalMessageKey
  | StaffMessageKey
  | RoleMessageKey
  | GovernanceMessageKey
  | InstitutionMessageKey
  | SaasMessageKey
  | MemberMessageKey
  | ApprovalMessageKey
  | PaymentMessageKey
  | TerminalMessageKey
  | AllowanceMessageKey
  | CouponMessageKey
  | EventMessageKey
  | PosMessageKey
  | FeeMessageKey
  | AdmissionMessageKey
  | SettlementMessageKey
  | ReconMessageKey
  | GrievanceMessageKey
  | AccountingMessageKey
  | TeachingMessageKey
  | AttendanceMessageKey
  | TransportMessageKey
  | PlatformToolMessageKey
  | CommunicationMessageKey
  | QuizMessageKey;

const CATALOGUE: ReadonlyMap<string, MessageDefinition> = new Map(
  [
    ...PLATFORM_MESSAGES,
    ...IDENTITY_MESSAGES,
    ...PERSONAL_MESSAGES,
    ...STAFF_MESSAGES,
    ...ROLE_MESSAGES,
    ...GOVERNANCE_MESSAGES,
    ...INSTITUTION_MESSAGES,
    ...SAAS_MESSAGES,
    ...MEMBER_MESSAGES,
    ...APPROVAL_MESSAGES,
    ...PAYMENT_MESSAGES,
    ...TERMINAL_MESSAGES,
    ...ALLOWANCE_MESSAGES,
    ...COUPON_MESSAGES,
    ...EVENT_MESSAGES,
    ...POS_MESSAGES,
    ...FEE_MESSAGES,
    ...ADMISSION_MESSAGES,
    ...SETTLEMENT_MESSAGES,
    ...RECON_MESSAGES,
    ...GRIEVANCE_MESSAGES,
    ...ACCOUNTING_MESSAGES,
    ...TEACHING_MESSAGES,
    ...ATTENDANCE_MESSAGES,
    ...TRANSPORT_MESSAGES,
    ...PLATFORM_TOOL_MESSAGES,
    ...COMMUNICATION_MESSAGES,
    ...QUIZ_MESSAGES,
  ].map((m) => [m.key, m]),
);

export function allMessages(): readonly MessageDefinition[] {
  return [...CATALOGUE.values()];
}

export function getMessage(key: MessageKey): MessageDefinition {
  const m = CATALOGUE.get(key);
  if (!m) throw new Error(`Unknown message key ${key}`);
  return m;
}

/** Substitutes `{name}` placeholders. Unknown placeholders are left visible rather than dropped. */
export function renderMessage(
  key: MessageKey,
  params: Readonly<Record<string, string | number>> = {},
): string {
  return getMessage(key).en.replace(/\{(\w+)\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : whole,
  );
}

/** Problems found in the catalogue: duplicate keys, bad key format, class/approval mismatches. */
export function validateCatalogue(messages: readonly MessageDefinition[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const m of messages) {
    if (seen.has(m.key)) problems.push(`duplicate key ${m.key}`);
    seen.add(m.key);
    if (!/^[A-Z][A-Z0-9]*\.[A-Z0-9_]+$/.test(m.key)) problems.push(`bad key ${m.key}`);
    if (m.class === 'N' && m.register !== null) problems.push(`${m.key}: class N with a 27.5 id`);
    if (m.class !== 'N' && !/^MSG-[A-Z]+-\d+$/.test(m.register ?? '')) {
      problems.push(`${m.key}: class ${m.class} needs a 27.5 id`);
    }
    if (m.class === 'K' && m.approval !== 'register') {
      problems.push(`${m.key}: class K keeps the register wording`);
    }
    if (m.class === 'K' && m.srsText !== null && !m.placeholders && m.en !== m.srsText) {
      problems.push(`${m.key}: class K must use the 27.5 wording verbatim`);
    }
    for (const p of m.en.matchAll(/\{(\w+)\}/g)) {
      if (!m.placeholders?.includes(p[1] ?? '')) problems.push(`${m.key}: undeclared {${p[1]}}`);
    }
  }
  return problems;
}
