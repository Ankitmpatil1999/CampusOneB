/**
 * Institution registers (SRS 7.2–7.5, 7.12.1; FR-INS-01…06, FR-SAS-05/10; prototype `RP.OB`):
 * feature permissions and the plan module that entitles each, notification channels, the
 * onboarding checklist, lifecycle actions, boards, and the institution-defined field types.
 */
import type { InstitutionStatus } from './status/institution';

/** Plan modules (prototype MODULES; FR-SAS-05). */
export const MODULES = [
  'Academics',
  'Attendance',
  'Transport',
  'Communication',
  'Fees',
  'Wallet and payments',
  'Coupons',
  'Allowances',
  'Events',
  'Point of sale',
] as const;
export type ModuleKey = (typeof MODULES)[number];

export interface FeatureDefinition {
  readonly key: string;
  readonly label: string;
  /** Operator's description (o.features). */
  readonly sub: string;
  /** Institution's description (c.institution). */
  readonly consoleSub: string;
  readonly consoleLabel: string;
  readonly icon: string;
  /** The plan module that entitles the feature; `null` = every plan. */
  readonly module: ModuleKey | null;
  readonly group: 'Money' | 'Campus';
  /** Another feature this one needs (switching that off switches this off too). */
  readonly needs?: string;
  readonly cr?: string;
}

/** Feature permissions (7.5; prototype FEATURES of o.features and c.institution). */
export const FEATURES: readonly FeatureDefinition[] = [
  {
    key: 'tuition',
    label: 'Tuition-fee collection',
    sub: 'Collect fees from the campus wallet',
    consoleLabel: 'Tuition-fee collection',
    consoleSub: 'Collect fees from the campus wallet into the fee account',
    icon: 'receipt',
    module: 'Fees',
    group: 'Money',
  },
  {
    key: 'feeConsent',
    label: 'Fee consent required',
    sub: 'Explicit consent before any fee debit',
    consoleLabel: 'Fee consent required',
    consoleSub: 'A parent accepts the consent before any wallet debit for fees',
    icon: 'clipcheck',
    module: 'Fees',
    group: 'Money',
    needs: 'tuition',
  },
  {
    key: 'nfc',
    label: 'NFC card payments',
    sub: 'Tap-to-pay at merchants and readers',
    consoleLabel: 'NFC card payments',
    consoleSub: 'Tap a card at counters and readers to pay',
    icon: 'nfc',
    module: 'Wallet and payments',
    group: 'Money',
  },
  {
    key: 'transfers',
    label: 'Wallet-to-wallet transfers',
    sub: 'Up to ₹10,000 per transfer',
    consoleLabel: 'Wallet-to-wallet transfers',
    consoleSub: 'Members send money to each other, up to ₹10,000',
    icon: 'send',
    module: 'Wallet and payments',
    group: 'Money',
  },
  {
    key: 'coupons',
    label: 'Coupons',
    sub: 'Meal and other coupon types (CR-15)',
    consoleLabel: 'Coupons',
    consoleSub: 'Meal and other coupon types at merchants and readers (CR-15)',
    icon: 'ticket',
    module: 'Coupons',
    group: 'Money',
  },
  {
    key: 'allowances',
    label: 'Allowances',
    sub: 'Restricted allowance wallet',
    consoleLabel: 'Allowances',
    consoleSub: 'Scheduled pocket money spendable at regular merchants',
    icon: 'gift',
    module: 'Allowances',
    group: 'Money',
  },
  {
    key: 'events',
    label: 'Events',
    sub: 'Paid events with an event QR',
    consoleLabel: 'Paid events',
    consoleSub: 'Event fees with their own QR',
    icon: 'calendar',
    module: 'Events',
    group: 'Money',
  },
  {
    key: 'attendance',
    label: 'Attendance',
    sub: 'Readers, period and manual attendance',
    consoleLabel: 'Attendance',
    consoleSub: 'Gate, period and location attendance with readers',
    icon: 'calcheck',
    module: 'Attendance',
    group: 'Campus',
  },
  {
    key: 'transport',
    label: 'Transport',
    sub: 'Routes, trips and live tracking',
    consoleLabel: 'Transport',
    consoleSub: 'Routes, trips and live tracking for families',
    icon: 'bus',
    module: 'Transport',
    group: 'Campus',
  },
  {
    key: 'quiz',
    label: 'Financial literacy quiz',
    sub: 'Available on every plan (OI-FIN-01 undecided)',
    consoleLabel: 'Financial literacy',
    consoleSub: 'Quizzes and leaderboards for students (CR-01)',
    icon: 'bulb',
    module: null,
    group: 'Campus',
    cr: 'CR-01',
  },
];

export const featureByKey = (key: string) => FEATURES.find((f) => f.key === key);

export type ChannelKey = 'IN_APP' | 'EMAIL' | 'SMS' | 'WHATSAPP';
export interface ChannelDefinition {
  readonly key: ChannelKey;
  readonly label: string;
  readonly consoleSub: string;
  readonly icon: string;
  /** The plan allowance that must be above zero; `null` = every plan. */
  readonly allowance: 'SMS' | 'WHATSAPP' | null;
  readonly locked?: true;
  /** Switched on when the institution is registered (OI-ONB-09: default on; WhatsApp off). */
  readonly defaultOn: boolean;
}

/** Notification channels (7.5; prototype CHANNELS). In-app is always on. */
export const CHANNELS: readonly ChannelDefinition[] = [
  {
    key: 'IN_APP',
    label: 'In-app',
    consoleSub: 'Always on — every notification is kept in the app',
    icon: 'bell',
    allowance: null,
    locked: true,
    defaultOn: true,
  },
  {
    key: 'EMAIL',
    label: 'E-mail',
    consoleSub: 'Receipts, fee alerts and announcements',
    icon: 'mail',
    allowance: null,
    defaultOn: true,
  },
  {
    key: 'SMS',
    label: 'SMS',
    consoleSub: "One-time codes and urgent alerts · counts against the plan's SMS allowance",
    icon: 'chat',
    allowance: 'SMS',
    defaultOn: true,
  },
  {
    key: 'WHATSAPP',
    label: 'WhatsApp',
    consoleSub: 'Announcements and alerts on WhatsApp',
    icon: 'chats',
    allowance: 'WHATSAPP',
    defaultOn: false,
  },
];

export type ChecklistKey =
  | 'details'
  | 'plan'
  | 'bank'
  | 'toggles'
  | 'usertypes'
  | 'year'
  | 'feeacct'
  | 'branding'
  | 'firstusers';

export interface ChecklistStep {
  readonly key: ChecklistKey;
  readonly label: string;
  readonly owner: 'Operator' | 'Institution';
  readonly required: boolean;
  readonly ref: string;
}

/** Onboarding checklist (FR-SAS-10, RNG-SAS-017/018; RC-10 Pending · Complete). */
export const CHECKLIST: readonly ChecklistStep[] = [
  {
    key: 'details',
    label: 'Institution details and administrator',
    owner: 'Operator',
    required: true,
    ref: 'FR-INS-01',
  },
  { key: 'plan', label: 'Plan selected', owner: 'Operator', required: true, ref: 'FR-SAS-06' },
  {
    key: 'bank',
    label: 'Bank corporate code and pool account',
    owner: 'Operator',
    required: true,
    ref: 'FR-WAL-03',
  },
  {
    key: 'toggles',
    label: 'Feature toggles set',
    owner: 'Operator',
    required: true,
    ref: 'FR-INS-04',
  },
  {
    key: 'usertypes',
    label: 'User types and departments',
    owner: 'Institution',
    required: true,
    ref: 'FR-INS-03',
  },
  {
    key: 'year',
    label: 'Academic year declared',
    owner: 'Institution',
    required: true,
    ref: 'FR-ACA-01',
  },
  {
    key: 'feeacct',
    label: 'Fee account designated',
    owner: 'Institution',
    required: true,
    ref: 'FR-INS-06',
  },
  {
    key: 'branding',
    label: 'Logo and branding',
    owner: 'Institution',
    required: false,
    ref: 'FR-INS-03',
  },
  {
    key: 'firstusers',
    label: 'First users onboarded',
    owner: 'Institution',
    required: false,
    ref: 'FR-IDN-15',
  },
];

export type LifecycleAction = 'START_TRIAL' | 'ACTIVATE' | 'SUSPEND' | 'REACTIVATE' | 'CANCEL';

/** Lifecycle actions (FR-INS-05) over the RC-08 transitions; the event names of 0003. */
export const LIFECYCLE: Readonly<
  Record<
    LifecycleAction,
    {
      readonly label: string;
      readonly from: readonly InstitutionStatus[];
      readonly to: InstitutionStatus;
      readonly event: string;
    }
  >
> = {
  START_TRIAL: {
    label: 'Start trial',
    from: ['PENDING_ACTIVATION'],
    to: 'ACTIVE',
    event: 'TRIAL_STARTED',
  },
  ACTIVATE: { label: 'Activate', from: ['PENDING_ACTIVATION'], to: 'ACTIVE', event: 'ACTIVATED' },
  SUSPEND: { label: 'Suspend', from: ['ACTIVE'], to: 'SUSPENDED', event: 'SUSPENDED' },
  REACTIVATE: { label: 'Reactivate', from: ['SUSPENDED'], to: 'ACTIVE', event: 'REACTIVATED' },
  CANCEL: {
    label: 'Cancel',
    from: ['PENDING_ACTIVATION', 'ACTIVE', 'SUSPENDED'],
    to: 'CANCELLED',
    event: 'CANCELLED',
  },
};

/** Boards offered at registration (prototype `ob.inst.new`). */
export const BOARDS = ['CBSE', 'ICSE', 'State', 'State PU', 'IB', 'Other'] as const;

/** Institution-defined field entities (OI-ONB-14 disposition: the prototype's four). */
export const CF_ENTITIES = {
  MEMBER: 'Member',
  FEE_STRUCTURE: 'Fee structure',
  ADMISSION_APPLICATION: 'Admission application',
  MERCHANT: 'Merchant',
} as const;
export type CfEntity = keyof typeof CF_ENTITIES;

/** The nine data types (OI-ONB-15 disposition: the prototype's set; RNG-ONB-104). */
export const CF_TYPES = {
  TEXT: { label: 'Text', icon: 'field' },
  LONG_TEXT: { label: 'Long text', icon: 'filetext' },
  NUMBER: { label: 'Number', icon: 'hash' },
  DATE: { label: 'Date', icon: 'calendar' },
  DROPDOWN: { label: 'Dropdown', icon: 'down' },
  MULTI_SELECT: { label: 'Multi-select', icon: 'listck' },
  YES_NO: { label: 'Yes/No', icon: 'toggle' },
  EMAIL: { label: 'E-mail', icon: 'mail' },
  PHONE: { label: 'Phone', icon: 'phone' },
} as const;
export type CfType = keyof typeof CF_TYPES;
export const CF_OPTION_TYPES: readonly CfType[] = ['DROPDOWN', 'MULTI_SELECT'];
export const CF_FILTER_TYPES: readonly CfType[] = ['DROPDOWN', 'MULTI_SELECT', 'YES_NO'];
export const CF_NO_UNIQUE_TYPES: readonly CfType[] = ['YES_NO', 'MULTI_SELECT'];

/** Words that suggest an identity-document number (prototype ID_WORDS; RNG-ONB-114, OI-GAS-27). */
export const ID_DOCUMENT_WORDS =
  /\b(aadh?aar|pan\b|pan (no|number|card)|passport|voter|driving licen[cs]e|ration card|uid|identity (number|document|card)|id (no|number|proof))/i;

export interface PlanSeed {
  readonly code: string;
  readonly name: string;
  readonly cycle: 'MONTHLY' | 'ANNUAL';
  readonly pricePaise: number;
  readonly description: string;
  readonly modules: readonly ModuleKey[];
  readonly allowances: { MEMBERS: number; SMS: number; WHATSAPP: number; STORAGE_GB: number };
}

/**
 * The prototype's plans, loaded as draft data operators edit in 2.7 (phase plan; prices wait for
 * Q14 · M14). A re-seed never overwrites an operator's change.
 */
export const PLAN_SEEDS: readonly PlanSeed[] = [
  {
    code: 'PL-ESS',
    name: 'Campus Essentials',
    cycle: 'MONTHLY',
    pricePaise: 650_000,
    description: 'Smaller schools starting with fees, attendance and the campus wallet.',
    modules: ['Academics', 'Attendance', 'Communication', 'Fees', 'Wallet and payments', 'Events'],
    allowances: { MEMBERS: 800, SMS: 3000, WHATSAPP: 0, STORAGE_GB: 20 },
  },
  {
    code: 'PL-PLUS',
    name: 'Campus Plus',
    cycle: 'ANNUAL',
    pricePaise: 18_000_000,
    description: 'Every module for a full campus, including transport, coupons and point of sale.',
    modules: MODULES,
    allowances: { MEMBERS: 2500, SMS: 15000, WHATSAPP: 5000, STORAGE_GB: 100 },
  },
  {
    code: 'PL-PRO',
    name: 'Campus Pro',
    cycle: 'ANNUAL',
    pricePaise: 32_000_000,
    description: 'Large and residential campuses with higher messaging and storage allowances.',
    modules: MODULES,
    allowances: { MEMBERS: 6000, SMS: 40000, WHATSAPP: 20000, STORAGE_GB: 250 },
  },
];
