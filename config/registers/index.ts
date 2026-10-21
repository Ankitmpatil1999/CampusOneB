export * from './status/types';
export * from './status/state-machine';
export * from './status/platform';
export * from './status/institution';
export * from './status/identity';
export * from './status/approvals';
export * from './status/members';
export * from './status/portal';
export * from './status/wallet';
export * from './status/payments';
export * from './status/partners';
export * from './status/terminals';
export * from './status/assets';
export * from './status/grievances';
export * from './payments';
export * from './status/seed-sql';
export * from './messages/types';
export * from './messages/platform';
export * from './messages/identity';
export * from './messages/personal';
export * from './messages/staff';
export * from './messages/roles';
export * from './messages/governance';
export * from './messages/institution';
export * from './messages/saas';
export * from './reference';
export * from './messages/catalogue';
export * from './limits';
export * from './access';
export * from './institution';
export * from './comm-events';

import { allMessages } from './messages/catalogue';
import { accessLabels } from './access';
import { referenceLabels } from './reference';
import { APPROVAL_DOMAINS } from './status/approvals';
import { IDENTITY_DOMAINS } from './status/identity';
import {
  CUSTOM_FIELD,
  INSTITUTION,
  INVOICE,
  ONBOARDING_STEP,
  PLAN_CHANGE_REQUEST,
  SUBSCRIPTION,
} from './status/institution';
import { PLATFORM_DOMAINS } from './status/platform';
import { ACADEMIC_YEAR, MEMBER_PROFILE } from './status/members';
import { CANCELLATION_REQUEST } from './status/portal';
import { WALLET } from './status/wallet';
import { PAYMENT_DOMAINS } from './status/payments';
import { PARTNER_DOMAINS } from './status/partners';
import { TERMINAL_DOMAINS } from './status/terminals';
import { ASSET_DOMAINS } from './status/assets';
import { ALLOWANCE_DOMAINS } from './status/allowances';
import { COUPON_DOMAINS } from './status/coupons';
import { EVENT_DOMAINS } from './status/events';
import { POS_DOMAINS } from './status/pos';
import { FEE_DOMAINS } from './status/fees';
import { ADMISSION_DOMAINS } from './status/admissions';
import { SETTLEMENT_DOMAINS } from './status/settlement';
import { RECON_DOMAINS } from './status/recon';
import { GRIEVANCE_DOMAINS } from './status/grievances';
import { ACCOUNTING_DOMAINS } from './status/accounting';
import { TEACHING_DOMAINS } from './status/teaching';
import { ATTENDANCE_DOMAINS } from './status/attendance';
import { TRANSPORT_DOMAINS } from './status/transport';
import { COMMUNICATION_DOMAINS } from './status/communication';
import { QUIZ_DOMAINS } from './status/quiz';
import type { StatusDomain } from './status/types';

/** Every status domain built so far (modules add theirs in their phase). */
export const ALL_STATUS_DOMAINS: readonly StatusDomain[] = [
  ...PLATFORM_DOMAINS,
  INSTITUTION,
  ONBOARDING_STEP,
  CUSTOM_FIELD,
  SUBSCRIPTION,
  INVOICE,
  PLAN_CHANGE_REQUEST,
  MEMBER_PROFILE,
  ACADEMIC_YEAR,
  CANCELLATION_REQUEST,
  WALLET,
  ...PAYMENT_DOMAINS,
  ...PARTNER_DOMAINS,
  ...TERMINAL_DOMAINS,
  ...ASSET_DOMAINS,
  ...ALLOWANCE_DOMAINS,
  ...COUPON_DOMAINS,
  ...EVENT_DOMAINS,
  ...POS_DOMAINS,
  ...FEE_DOMAINS,
  ...ADMISSION_DOMAINS,
  ...SETTLEMENT_DOMAINS,
  ...RECON_DOMAINS,
  ...GRIEVANCE_DOMAINS,
  ...ACCOUNTING_DOMAINS,
  ...TEACHING_DOMAINS,
  ...ATTENDANCE_DOMAINS,
  ...TRANSPORT_DOMAINS,
  ...COMMUNICATION_DOMAINS,
  ...QUIZ_DOMAINS,
  ...IDENTITY_DOMAINS,
  ...APPROVAL_DOMAINS,
];

/**
 * The default English bundle: every message and status label by key. Written out for the web and
 * mobile apps as `utils/messages.en.ts` (`npm run shared:sync`).
 */
export function englishBundle(): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const m of allMessages()) out[m.key] = m.en;
  for (const d of ALL_STATUS_DOMAINS) for (const v of d.values) out[v.labelKey] = v.label;
  Object.assign(out, referenceLabels(), accessLabels());
  return out;
}
