/**
 * Reference masters seeded with the registers (SRS 6.2, 6.8; OI-IDN-02). Labels join the English
 * bundle so clients translate them like any other key. Operators maintain these lists later
 * (languages and masters administration, Phase 8).
 */

export interface ReferenceItem {
  readonly code: string;
  readonly labelKey: string;
  readonly en: string;
}

/** Security questions (prototype `au.next` options; 6.2 Step 5, 6.8). */
export const SECURITY_QUESTIONS: readonly ReferenceItem[] = [
  {
    code: 'FIRST_SCHOOL',
    labelKey: 'secq.first_school',
    en: 'What was the name of your first school?',
  },
  { code: 'FAVOURITE_FOOD', labelKey: 'secq.favourite_food', en: 'What is your favourite food?' },
  { code: 'BIRTH_TOWN', labelKey: 'secq.birth_town', en: 'In which town were you born?' },
  { code: 'FIRST_PET', labelKey: 'secq.first_pet', en: "What was your first pet's name?" },
];

export interface IdDocumentType extends ReferenceItem {
  /** Number format after normalisation (upper case, spaces and hyphens removed). */
  readonly pattern: string;
}

/**
 * Identity documents accepted at sign-up (OI-IDN-02: served from the master; the UI's and the
 * server's lists in the legacy system disagreed). Numbers are stored encrypted (ADR-0012).
 *
 * Aadhaar: only the last 6 digits are asked for and kept, never the full number (client Q16(e),
 * 2026-10-02; CMP-05 data minimisation).
 */
export const ID_DOCUMENT_TYPES: readonly IdDocumentType[] = [
  {
    code: 'AADHAAR',
    labelKey: 'iddoc.aadhaar',
    en: 'Aadhaar',
    pattern: '^[0-9]{6}$',
  },
  { code: 'PASSPORT', labelKey: 'iddoc.passport', en: 'Passport', pattern: '^[A-Z][0-9]{7}$' },
  {
    code: 'VOTER_ID',
    labelKey: 'iddoc.voter_id',
    en: 'Voter ID (EPIC)',
    pattern: '^[A-Z]{3}[0-9]{7}$',
  },
  {
    code: 'DRIVING_LICENCE',
    labelKey: 'iddoc.driving_licence',
    en: 'Driving licence',
    pattern: '^[A-Z]{2}[0-9]{2}[0-9]{4}[0-9]{7}$',
  },
];

/** Gender options (OI-IDN-02: the legacy UI sent a fixed value; client 2026-10-02: Male or Female). */
export const GENDERS: readonly ReferenceItem[] = [
  { code: 'MALE', labelKey: 'gender.male', en: 'Male' },
  { code: 'FEMALE', labelKey: 'gender.female', en: 'Female' },
];

export interface RelationItem extends ReferenceItem {
  /** Where the relation may be chosen (ref_relations.usage_scope). */
  readonly scopes: readonly ('guardian' | 'nominee' | 'reference')[];
}

/**
 * Relations (OI-IDN-13). Nominee relations are the prototype's list (client 2026-10-02: "use the
 * prototype's lists"); guardian relations serve members (2.5). The legacy option codes
 * ("option1"…"option11") are not carried over.
 */
export const RELATIONS: readonly RelationItem[] = [
  { code: 'SPOUSE', labelKey: 'relation.spouse', en: 'Spouse', scopes: ['nominee'] },
  { code: 'SON', labelKey: 'relation.son', en: 'Son', scopes: ['nominee'] },
  { code: 'DAUGHTER', labelKey: 'relation.daughter', en: 'Daughter', scopes: ['nominee'] },
  { code: 'MOTHER', labelKey: 'relation.mother', en: 'Mother', scopes: ['nominee', 'guardian'] },
  { code: 'FATHER', labelKey: 'relation.father', en: 'Father', scopes: ['nominee', 'guardian'] },
  { code: 'SIBLING', labelKey: 'relation.sibling', en: 'Sibling', scopes: ['nominee'] },
  { code: 'GUARDIAN', labelKey: 'relation.guardian', en: 'Guardian', scopes: ['guardian'] },
  { code: 'OTHER', labelKey: 'relation.other', en: 'Other', scopes: ['nominee'] },
];

/** Annual income bands (prototype pf.income; SRS 6.11 income categories). */
export const INCOME_BANDS: readonly ReferenceItem[] = [
  { code: 'BELOW_2_5L', labelKey: 'income.below_2_5l', en: 'Below ₹2.5 lakh' },
  { code: 'FROM_2_5L_TO_5L', labelKey: 'income.2_5l_5l', en: '₹2.5–5 lakh' },
  { code: 'FROM_5L_TO_10L', labelKey: 'income.5l_10l', en: '₹5–10 lakh' },
  { code: 'FROM_10L_TO_25L', labelKey: 'income.10l_25l', en: '₹10–25 lakh' },
  { code: 'ABOVE_25L', labelKey: 'income.above_25l', en: 'Above ₹25 lakh' },
];

/** Occupations (SRS 6.11 "occupations served by the platform"; standard Indian list, client). */
export const OCCUPATIONS: readonly ReferenceItem[] = [
  {
    code: 'SALARIED_PRIVATE',
    labelKey: 'occupation.salaried_private',
    en: 'Salaried – private sector',
  },
  { code: 'SALARIED_GOVT', labelKey: 'occupation.salaried_govt', en: 'Salaried – government' },
  { code: 'SELF_EMPLOYED', labelKey: 'occupation.self_employed', en: 'Self-employed / business' },
  {
    code: 'PROFESSIONAL',
    labelKey: 'occupation.professional',
    en: 'Professional (doctor, lawyer, CA …)',
  },
  { code: 'AGRICULTURE', labelKey: 'occupation.agriculture', en: 'Farmer / agriculture' },
  { code: 'DAILY_WAGE', labelKey: 'occupation.daily_wage', en: 'Daily wage worker' },
  { code: 'HOMEMAKER', labelKey: 'occupation.homemaker', en: 'Homemaker' },
  { code: 'STUDENT', labelKey: 'occupation.student', en: 'Student' },
  { code: 'RETIRED', labelKey: 'occupation.retired', en: 'Retired' },
  { code: 'OTHER', labelKey: 'occupation.other', en: 'Other' },
];

/** Address-proof documents (SRS 6.11 "address-proof document types"; standard Indian list). */
export const ADDRESS_PROOF_TYPES: readonly ReferenceItem[] = [
  { code: 'AADHAAR', labelKey: 'addrproof.aadhaar', en: 'Aadhaar' },
  { code: 'PASSPORT', labelKey: 'addrproof.passport', en: 'Passport' },
  { code: 'VOTER_ID', labelKey: 'addrproof.voter_id', en: 'Voter ID' },
  { code: 'DRIVING_LICENCE', labelKey: 'addrproof.driving_licence', en: 'Driving licence' },
  {
    code: 'UTILITY_BILL',
    labelKey: 'addrproof.utility_bill',
    en: 'Electricity, water or gas bill',
  },
  {
    code: 'BANK_STATEMENT',
    labelKey: 'addrproof.bank_statement',
    en: 'Bank statement or passbook',
  },
  { code: 'RENT_AGREEMENT', labelKey: 'addrproof.rent_agreement', en: 'Rental agreement' },
  { code: 'PROPERTY_TAX', labelKey: 'addrproof.property_tax', en: 'Property tax receipt' },
];

/** Why a linked bank account is replaced (SRS 6.11 "Select Account Update Reason"). */
export const BANK_CHANGE_REASONS: readonly ReferenceItem[] = [
  {
    code: 'ACCOUNT_CLOSED',
    labelKey: 'bankreason.account_closed',
    en: 'Existing Account Is closed',
  },
  { code: 'NEW_ACCOUNT', labelKey: 'bankreason.new_account', en: 'I want to use a new Account' },
];

export interface ConsentDocument {
  readonly kind: 'CONSENT' | 'TERMS';
  readonly version: string;
  readonly title: string;
  readonly body: string;
  readonly draft: boolean;
  /** Only active versions are offered; a published text never changes, a new version replaces it. */
  readonly active: boolean;
}

/** The prototype's "Terms of use" text (client 2026-10-02: use the prototype's texts). */
const TERMS_OF_USE_2026_10 = [
  'RingPe provides campus wallets and school services on behalf of your institution. Your mobile number identifies your account; your school decides which features you can use.',
  'We process your personal details to verify your identity, keep your money safe and meet the law in India. We never sell your data.',
  'Consent you give here is recorded with the date and the version of these terms.',
].join('\n\n');

/** The first drafts stay recorded (withdrawn) because consents may point at them. */
export const CONSENT_DOCUMENTS: readonly ConsentDocument[] = [
  {
    kind: 'CONSENT',
    version: '2026.10-draft1',
    title: 'Consent to share your details',
    body: 'I agree to share my details — name, mobile number, date of birth, e-mail, PAN and identity document — with RingPe and with the institutions I am linked to, so that my RingPe account and wallet can be opened and run. [Draft text: the final wording will be supplied by RingPe.]',
    draft: true,
    active: false,
  },
  {
    kind: 'TERMS',
    version: '2026.10-draft1',
    title: 'Terms and conditions',
    body: 'By creating a RingPe account I accept the RingPe terms and conditions and privacy policy. [Draft text: the final terms will be supplied by RingPe.]',
    draft: true,
    active: false,
  },
  {
    kind: 'CONSENT',
    version: '2026.10',
    title: 'Terms of use',
    body: TERMS_OF_USE_2026_10,
    draft: false,
    active: true,
  },
  {
    kind: 'TERMS',
    version: '2026.10',
    title: 'Terms of use',
    body: TERMS_OF_USE_2026_10,
    draft: false,
    active: true,
  },
];

/** Labels of every reference master, for the English bundle. */
export function referenceLabels(): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const item of [
    ...SECURITY_QUESTIONS,
    ...ID_DOCUMENT_TYPES,
    ...GENDERS,
    ...RELATIONS,
    ...INCOME_BANDS,
    ...OCCUPATIONS,
    ...ADDRESS_PROOF_TYPES,
    ...BANK_CHANGE_REASONS,
  ]) {
    out[item.labelKey] = item.en;
  }
  return out;
}
