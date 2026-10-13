/**
 * The submitted admission application as a PDF for the family (client 2026-10-13): every section
 * of the form as it was submitted — admission, student, addresses, previous schooling, parents and
 * guardians, the institution's own fields, references, documents, fees and the declaration. Built
 * from the family's own view of the application, so the Aadhaar numbers and PANs appear masked.
 */
import { formatDate, formatDateTime, formatInr } from '../utils/format';
import { PdfDocument, type Rgb } from '../utils/pdf';
import type { CfField } from './custom-values.service';

interface Person {
  readonly name?: string | null | undefined;
  readonly mobile?: string | null | undefined;
  readonly email?: string | null | undefined;
  readonly occupation?: string | null | undefined;
  readonly relation?: string | null | undefined;
}

interface Address {
  readonly line1?: string | null | undefined;
  readonly line2?: string | null | undefined;
  readonly city?: string | null | undefined;
  readonly state?: string | null | undefined;
  readonly pin?: string | null | undefined;
}

/** What the PDF reads of the application (the family's view, ADM-025). */
export interface FormView {
  readonly applicationNo: string;
  readonly status: string;
  readonly year: { readonly label: string };
  readonly class: { readonly name: string } | null;
  readonly midTerm: boolean;
  readonly joiningDate: string | null;
  readonly midTermReason: string | null;
  readonly student: {
    readonly firstName: string | null;
    readonly middleName: string | null;
    readonly lastName: string | null;
    readonly gender: string | null;
    readonly dob: string | null;
    readonly aadhaar?: string | null | undefined;
    readonly pan?: string | null | undefined;
    readonly category?: string | null | undefined;
    readonly medium?: string | null | undefined;
    readonly bloodGroup?: string | null | undefined;
    readonly allergies?: string | null | undefined;
    readonly health?: string | null | undefined;
  };
  readonly addresses: {
    readonly residential?: Address | null | undefined;
    readonly sameAsResidential?: boolean | undefined;
    readonly correspondence?: Address | null | undefined;
  } | null;
  readonly previous: {
    readonly school?: string | null | undefined;
    readonly lastClass?: string | null | undefined;
    readonly result?: string | null | undefined;
    readonly board?: string | null | undefined;
    readonly otherBoard?: string | null | undefined;
  } | null;
  readonly parents: {
    readonly father?: Person | null | undefined;
    readonly mother?: Person | null | undefined;
    readonly guardian?: Person | null | undefined;
    readonly primary?: string | null | undefined;
    readonly children?: string | null | undefined;
    readonly transport?: boolean | undefined;
    readonly transportStop?: { readonly name: string } | null;
    readonly hostel?: boolean | undefined;
    readonly localGuardian?: {
      readonly name?: string | null | undefined;
      readonly relation?: string | null | undefined;
      readonly mobile?: string | null | undefined;
      readonly address?: string | null | undefined;
    } | null;
  } | null;
  /** Each person's Aadhaar and PAN, masked (client 2026-10-13). */
  readonly identityNumbers?: Readonly<
    Record<
      string,
      { readonly aadhaar?: string | null | undefined; readonly pan?: string | null | undefined }
    >
  >;
  readonly customFields: Readonly<Record<string, unknown>>;
  readonly tc: {
    readonly mode: string;
    readonly number?: string | null | undefined;
    readonly dueDate: string | null;
  } | null;
  readonly references: readonly Person[];
  readonly documents: readonly { readonly type: string; readonly name: string }[];
  readonly fees: readonly {
    readonly feeType: string;
    readonly amount: { readonly amount: string };
    readonly status: string;
    readonly receiptNo: string | null;
  }[];
  readonly declaration: { readonly at: string | null; readonly by: string | null } | null;
  readonly submittedAt: string | null;
}

const BRAND: Rgb = [15, 110, 120];
const MUTED: Rgb = [90, 100, 110];
const RULE: Rgb = [220, 226, 230];
const LEFT = 48;
const VALUE_X = 210;
const RIGHT = 547;
const BOTTOM = 790;

const title = (s: string | null | undefined) =>
  (s ?? '')
    .toLowerCase()
    .replace(/(^|[\s.'-])([a-z])/g, (_m, a: string, b: string) => a + b.toUpperCase());
const label = (code: string | null | undefined, names: Readonly<Record<string, string>>) =>
  code ? (names[code] ?? title(code.replace(/_/g, ' '))) : '';
const join = (...parts: (string | null | undefined)[]) =>
  parts
    .map((p) => (p ?? '').trim())
    .filter(Boolean)
    .join(', ');
const rupees = (amount: string) => {
  const [r = '0', p = ''] = amount.split('.');
  return formatInr(Number(r) * 100 + Number(`${p}00`.slice(0, 2))).replace('₹', 'Rs. ');
};

const STATUS: Readonly<Record<string, string>> = {
  SUBMITTED: 'Submitted',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
};
const GENDER: Readonly<Record<string, string>> = { MALE: 'Male', FEMALE: 'Female', OTHER: 'Other' };
const CATEGORY: Readonly<Record<string, string>> = {
  GENERAL: 'General',
  OBC: 'OBC',
  SC: 'SC',
  ST: 'ST',
  OTHER: 'Other',
};
const BOARD: Readonly<Record<string, string>> = {
  CBSE: 'CBSE',
  ICSE: 'ICSE',
  STATE: 'State board',
  IB: 'IB',
};
const DOCUMENT: Readonly<Record<string, string>> = {
  PHOTO: 'Photograph',
  BIRTH: 'Birth certificate',
  ADDRESS: 'Address proof',
  REPORT: 'Last report card',
  TC: 'Transfer certificate',
  OTHER: 'Other document',
  STUDENT_AADHAAR_FRONT: 'Student’s Aadhaar card (front)',
  STUDENT_AADHAAR_BACK: 'Student’s Aadhaar card (back)',
  STUDENT_PAN_FRONT: 'Student’s PAN card (front)',
  STUDENT_PAN_BACK: 'Student’s PAN card (back)',
  ...cardLabels('FATHER', 'Father’s'),
  ...cardLabels('MOTHER', 'Mother’s'),
  ...cardLabels('GUARDIAN', 'Guardian’s'),
  ...cardLabels('LOCAL_GUARDIAN', 'Local guardian’s'),
};
function cardLabels(prefix: string, whose: string): Record<string, string> {
  return {
    [`${prefix}_AADHAAR_FRONT`]: `${whose} Aadhaar card (front)`,
    [`${prefix}_AADHAAR_BACK`]: `${whose} Aadhaar card (back)`,
    [`${prefix}_PAN_FRONT`]: `${whose} PAN card (front)`,
    [`${prefix}_PAN_BACK`]: `${whose} PAN card (back)`,
  };
}
const FEE: Readonly<Record<string, string>> = {
  APPLICATION: 'Application fee',
  ADMISSION: 'Admission fee',
};

/** Writes sections of label–value rows, starting a new page when one is full. */
class FormWriter {
  readonly doc: PdfDocument;
  private y = 0;
  private page = 1;

  constructor(
    docTitle: string,
    private readonly footer: string,
  ) {
    this.doc = new PdfDocument(docTitle);
  }

  at(y: number) {
    this.y = y;
  }

  private room(h: number) {
    if (this.y + h <= BOTTOM) return;
    this.foot();
    this.doc.addPage();
    this.page += 1;
    this.y = 56;
  }

  foot() {
    this.doc.line(LEFT, BOTTOM + 14, RIGHT, BOTTOM + 14, { color: RULE });
    this.doc.text(LEFT, BOTTOM + 28, this.footer, { size: 8, color: MUTED });
    this.doc.text(RIGHT, BOTTOM + 28, `Page ${this.page}`, {
      size: 8,
      color: MUTED,
      align: 'right',
    });
  }

  section(name: string) {
    this.room(48);
    this.y += 14;
    this.doc.text(LEFT, this.y, name, { size: 11, bold: true, color: BRAND });
    this.y += 6;
    this.doc.line(LEFT, this.y, RIGHT, this.y, { color: RULE });
    this.y += 16;
  }

  /** One row; an empty value shows as a dash, a long one wraps. */
  row(k: string, v: string | null | undefined) {
    const lines = this.doc.wrap((v ?? '').trim() || '—', RIGHT - VALUE_X, 10);
    this.room(lines.length * 14 + 4);
    this.doc.text(LEFT, this.y, k, { size: 10, color: MUTED });
    for (const [i, line] of lines.entries()) {
      this.doc.text(VALUE_X, this.y + i * 14, line, { size: 10 });
    }
    this.y += lines.length * 14 + 4;
  }

  note(text: string) {
    const lines = this.doc.wrap(text, RIGHT - LEFT, 9);
    this.room(lines.length * 12 + 4);
    for (const line of lines) {
      this.doc.text(LEFT, this.y, line, { size: 9, color: MUTED });
      this.y += 12;
    }
    this.y += 8;
  }
}

function customValue(f: CfField | undefined, v: unknown): string {
  if (v === null || v === undefined || v === '') return '';
  const opt = (x: unknown) => f?.options.find((o) => o.id === x)?.label ?? String(x);
  if (Array.isArray(v)) return v.map(opt).join(', ');
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (f?.type === 'DATE' && typeof v === 'string') return formatDate(v);
  return opt(v);
}

export function admissionFormPdf(
  institution: { readonly name: string; readonly city?: string | null },
  v: FormView,
  fields: readonly CfField[],
  now: Date,
): Buffer {
  const w = new FormWriter(
    `Application ${v.applicationNo}`,
    `${v.applicationNo} · a copy of the application as submitted, made by RingPe on ${formatDateTime(now)}`,
  );
  const d = w.doc;
  d.text(LEFT, 64, institution.name, { size: 16, bold: true, color: BRAND });
  d.text(LEFT, 84, join('Application for admission', institution.city), { size: 11, color: MUTED });
  d.text(RIGHT, 64, v.applicationNo, { size: 12, bold: true, align: 'right' });
  d.text(RIGHT, 84, v.submittedAt ? `Submitted ${formatDateTime(v.submittedAt)}` : '', {
    size: 9,
    align: 'right',
    color: MUTED,
  });
  d.line(LEFT, 100, RIGHT, 100, { color: RULE });
  w.at(108);

  const s = v.student;
  w.section('Admission');
  w.row('Academic year', v.year.label);
  w.row('Class sought', v.class?.name);
  w.row('Admission type', v.midTerm ? 'Mid-term' : 'Regular');
  w.row('Joining date', v.joiningDate ? formatDate(v.joiningDate) : '');
  if (v.midTerm) w.row('Reason for joining mid-term', v.midTermReason);
  w.row('Status', label(v.status, STATUS));

  w.section('Student');
  w.row('Name', [s.firstName, s.middleName, s.lastName].filter(Boolean).map(title).join(' '));
  w.row('Gender', label(s.gender, GENDER));
  w.row('Date of birth', s.dob ? formatDate(s.dob) : '');
  w.row('Aadhaar number', s.aadhaar);
  w.row('PAN', s.pan);
  w.row('Category', label(s.category, CATEGORY));
  w.row('Medium of instruction', s.medium);
  w.row('Blood group', s.bloodGroup === 'UNKNOWN' ? 'Not known' : s.bloodGroup);
  w.row('Allergies', s.allergies);
  w.row('Health conditions', s.health);

  const a = v.addresses;
  const addr = (x: Address | null | undefined) =>
    x ? join(x.line1, x.line2, x.city, x.state, x.pin) : '';
  w.section('Addresses');
  w.row('Residential address', addr(a?.residential));
  w.row(
    'Correspondence address',
    a?.sameAsResidential ? 'Same as the residential address' : addr(a?.correspondence),
  );

  const pr = v.previous;
  w.section('Previous schooling');
  w.row('Last school attended', pr?.school);
  w.row('Class studying now', pr?.lastClass);
  w.row('Last result', pr?.result);
  w.row('Board', pr?.board === 'OTHER' ? pr.otherBoard : label(pr?.board, BOARD));
  if (v.midTerm) {
    w.row(
      'Transfer certificate',
      v.tc?.mode === 'UNDERTAKING'
        ? `Undertaking — to be handed in by ${v.tc.dueDate ? formatDate(v.tc.dueDate) : '—'}`
        : v.tc?.number
          ? `Received — number ${v.tc.number}`
          : v.documents.some((x) => x.type === 'TC')
            ? 'Attached'
            : '',
    );
  }

  const p = v.parents;
  const person = (x: Person | null | undefined) =>
    x?.name ? join(title(x.name), x.relation, x.mobile, x.email, x.occupation) : '';
  // Each person's Aadhaar and PAN, masked (client 2026-10-13).
  const ids = (who: string) => {
    const x = v.identityNumbers?.[who];
    return join(x?.aadhaar ? `Aadhaar ${x.aadhaar}` : '', x?.pan ? `PAN ${x.pan}` : '');
  };
  w.section('Parents and guardians');
  w.row('Father', person(p?.father));
  w.row('Father’s Aadhaar and PAN', ids('father'));
  w.row('Mother', person(p?.mother));
  w.row('Mother’s Aadhaar and PAN', ids('mother'));
  if (p?.guardian?.name) {
    w.row('Guardian', person(p.guardian));
    w.row('Guardian’s Aadhaar and PAN', ids('guardian'));
  }
  w.row('Primary contact', title(p?.primary));
  w.row(
    'Children',
    p?.children === 'SINGLE' ? 'Single child' : p?.children === 'MORE' ? 'More than one child' : '',
  );
  w.row(
    'School transport',
    p?.transport
      ? join('Yes', p.transportStop?.name ? `pick-up at ${p.transportStop.name}` : '')
      : 'No',
  );
  w.row('Hostel', p?.hostel ? 'Yes' : 'No');
  if (p?.hostel && p.localGuardian?.name) {
    const lg = p.localGuardian;
    w.row('Local guardian', join(title(lg.name), lg.relation, lg.mobile, lg.address));
    w.row('Local guardian’s Aadhaar and PAN', ids('localGuardian'));
  }

  const custom = fields
    .map((f) => [f.label, customValue(f, v.customFields[f.id])] as const)
    .filter(([, x]) => x !== '');
  if (custom.length) {
    w.section('More about the student');
    for (const [k, x] of custom) w.row(k, x);
  }

  if (v.references.length) {
    w.section('References');
    for (const [i, r] of v.references.entries()) w.row(`Reference ${i + 1}`, person(r));
  }

  w.section('Documents');
  if (!v.documents.length) w.row('Documents', 'None attached');
  for (const x of v.documents) w.row(label(x.type, DOCUMENT), x.name);

  if (v.fees.length) {
    w.section('Fees');
    for (const f of v.fees) {
      w.row(
        label(f.feeType, FEE),
        join(
          rupees(f.amount.amount),
          f.status === 'PAID' ? 'paid' : 'to pay',
          f.receiptNo ? `receipt ${f.receiptNo}` : '',
        ),
      );
    }
  }

  w.section('Declaration');
  // The form's own wording (the review step).
  w.note(
    'I declare that the information in this application is true and complete to the best of my knowledge. I understand that the school may cancel the admission if any of it is found to be false.',
  );
  w.row(
    'Declared',
    v.declaration?.at
      ? join(v.declaration.by ? `by ${v.declaration.by}` : '', formatDateTime(v.declaration.at))
      : '',
  );
  w.foot();
  return d.toBuffer();
}
