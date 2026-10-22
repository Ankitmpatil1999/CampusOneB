/**
 * The members bulk upload's template is the admission form (client 2026-10-19): its columns follow
 * the form's steps and labels — class and year, the student, the addresses, the previous schooling,
 * the parents and guardians, a reference — then the office's columns (section, admission number) and
 * the custom fields. A column the form requires says so in the header ("First name *"). A row is
 * read into the form's sections here and checked by AdmissionsService.sheetState, as the form is.
 * Documents are not in a sheet; they can be added on the student's application later.
 */
import type { MessageKey } from '../config/registers';
import type { SheetApplication } from './admissions.service';
import type { CfField } from './custom-values.service';

export interface SheetColumn {
  readonly label: string;
  /** Required as on the form; the template's header ends with " *". */
  readonly required: boolean;
  /** The form's field (where an error on it is reported). */
  readonly field: string;
  /** The template's example row. */
  readonly example: string;
}

const col = (label: string, field: string, example = '', required = false): SheetColumn => ({
  label,
  field,
  example,
  required,
});
const req = (label: string, field: string, example: string) => col(label, field, example, true);

/** The people of the parents' step, as the columns name them. */
const PEOPLE = {
  father: 'Father',
  mother: 'Mother',
  guardian: 'Guardian',
  localGuardian: 'Local guardian',
} as const;

const address = (kind: 'residential' | 'correspondence', example: readonly string[]) => {
  const name = kind === 'residential' ? 'Residential' : 'Correspondence';
  const required = kind === 'residential';
  return [
    ['house number and street', 'line1'],
    ['area or locality', 'line2'],
    ['city or town', 'city'],
    ['state', 'state'],
    ['PIN code', 'pin'],
  ].map(([l, f], i) => col(`${name} ${l}`, `addresses.${kind}.${f}`, example[i] ?? '', required));
};

/** The template's columns, in the form's order. */
export const SHEET_COLUMNS: readonly SheetColumn[] = [
  // Class & year
  col('Academic year', 'class.yearId'),
  req('Class', 'class.classId', 'Grade 6'),
  req('Section', 'sectionId', 'A'),
  req('Admission number', 'admissionNo', 'TV-2026-0101'),
  col('Joining date', 'class.joiningDate', '2026-06-01'),
  col('Reason for joining mid-year', 'class.midTermReason'),
  // Student
  req('First name', 'student.firstName', 'Aarav'),
  col('Middle name', 'student.middleName'),
  req('Last name', 'student.lastName', 'Shetty'),
  req('Gender', 'student.gender', 'Male'),
  req('Date of birth', 'student.dob', '2014-05-21'),
  col('Aadhaar number', 'student.aadhaar'),
  col('PAN', 'student.pan'),
  col('Category', 'student.category', 'General'),
  col('Medium of instruction', 'student.medium', 'English'),
  col('Blood group', 'student.bloodGroup', 'B+'),
  col('Food allergies', 'student.allergies'),
  col('Health conditions', 'student.health'),
  // Addresses
  ...address('residential', [
    '12, 4th Cross, Vinoba Nagar',
    'Vinoba Nagar',
    'Shivamogga',
    'Karnataka',
    '577204',
  ]),
  col('Correspondence same as residential', 'addresses.sameAsResidential', 'Yes'),
  ...address('correspondence', []),
  // Previous schooling
  col('Last school attended', 'previous.school', 'Little Flower School'),
  col('Last class studied', 'previous.lastClass', 'Grade 5'),
  col('Last result', 'previous.result', 'Passed'),
  col('Board', 'previous.board', 'State'),
  col('Name of the board', 'previous.otherBoard'),
  // Parents & guardians
  req('Father full name', 'parents.father.name', 'Ramesh Shetty'),
  req('Father mobile', 'parents.father.mobile', '9845012390'),
  col('Father e-mail', 'parents.father.email', 'ramesh.shetty@example.in'),
  col('Father occupation', 'parents.father.occupation', 'Engineer'),
  col('Father annual income', 'parents.father.annualIncome'),
  req('Father Aadhaar number', 'parents.father.aadhaar', '2345 6789 0123'),
  req('Father PAN', 'parents.father.pan', 'ABCPS1234K'),
  req('Mother full name', 'parents.mother.name', 'Sunita Shetty'),
  req('Mother mobile', 'parents.mother.mobile', '9845012391'),
  col('Mother e-mail', 'parents.mother.email', 'sunita.shetty@example.in'),
  col('Mother occupation', 'parents.mother.occupation'),
  col('Mother annual income', 'parents.mother.annualIncome'),
  req('Mother Aadhaar number', 'parents.mother.aadhaar', '3456 7890 1234'),
  req('Mother PAN', 'parents.mother.pan', 'ABCPS5678L'),
  col('Guardian full name', 'parents.guardian.name'),
  col('Guardian relationship to the student', 'parents.guardian.relation'),
  col('Guardian mobile', 'parents.guardian.mobile'),
  col('Guardian e-mail', 'parents.guardian.email'),
  col('Guardian occupation', 'parents.guardian.occupation'),
  col('Guardian Aadhaar number', 'parents.guardian.aadhaar'),
  col('Guardian PAN', 'parents.guardian.pan'),
  req('Primary contact', 'parents.primary', 'Father'),
  req('Children in the family', 'parents.children', 'Single child'),
  col('Opt for school transport', 'parents.transport', 'No'),
  col('Preferred pick-up point', 'parents.transportStopId'),
  col('Hostel accommodation', 'parents.hostel', 'No'),
  col('Local guardian full name', 'parents.localGuardian.name'),
  col('Local guardian relationship', 'parents.localGuardian.relation'),
  col('Local guardian mobile', 'parents.localGuardian.mobile'),
  col('Local guardian address', 'parents.localGuardian.address'),
  col('Local guardian Aadhaar number', 'parents.localGuardian.aadhaar'),
  col('Local guardian PAN', 'parents.localGuardian.pan'),
  // References
  col('Reference full name', 'reference.name'),
  col('Reference: how they know the student', 'reference.relation'),
  col('Reference phone', 'reference.mobile'),
  col('Reference e-mail', 'reference.email'),
  // The office's
  col('User type', 'userTypeId'),
  col('Department', 'departmentId'),
];

/**
 * The existing-students upload's columns (ADM-020/029; client 2026-10-21): the form's, without what
 * the school doesn't collect for a student already enrolled — the mid-year reason, the previous
 * schooling, the pick-up point, the reference, the user type and department (always the Student type
 * and its Academics department) — and the children question optional.
 */
const NOT_IMPORTED = new Set([
  'Reason for joining mid-year',
  'Last school attended',
  'Last class studied',
  'Last result',
  'Board',
  'Name of the board',
  'Preferred pick-up point',
  'Reference full name',
  'Reference: how they know the student',
  'Reference phone',
  'Reference e-mail',
  // Students only (client 2026-10-21): the Student type and its Academics department.
  'User type',
  'Department',
]);
const OPTIONAL_IN_IMPORT = new Set(['Children in the family']);
/**
 * The student's school transport (client 2026-10-21), after the transport question: the route (its
 * code or name) and the stop on it allocate the student as the transport office does; the dates
 * default to the student's joining date (or the year's start) and the year's end.
 */
export const TRANSPORT_COLUMNS: readonly SheetColumn[] = [
  col('Transport route', 'transport.route'),
  col('Transport stop', 'transport.stop'),
  col('Transport from', 'transport.from'),
  col('Transport to', 'transport.to'),
];
export const IMPORT_COLUMNS: readonly SheetColumn[] = SHEET_COLUMNS.filter(
  (c) => !NOT_IMPORTED.has(c.label),
).flatMap((c) => [
  OPTIONAL_IN_IMPORT.has(c.label) ? { ...c, required: false } : c,
  ...(c.label === 'Opt for school transport' ? TRANSPORT_COLUMNS : []),
]);

/** The template's header of a column: " *" after a required one. */
export const headerOf = (c: SheetColumn) => (c.required ? `${c.label} *` : c.label);

/** A header cell as compared with a column: case, spacing and the required mark aside. */
export const headerKey = (s: string) =>
  s.replace(/\*/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
export const sameHeader = (a: string, b: string) => headerKey(a) === headerKey(b);

/**
 * The column of a field the form reports an error on ("parents.father.mobile" → "Father mobile"):
 * the field's own column, the first column of a group ("addresses.residential"), or the custom
 * field's.
 */
export function columnOf(field: string, custom: readonly CfField[]): string {
  const cf = /^customFields\.(.+)$/.exec(field);
  if (cf) return custom.find((f) => f.id === cf[1])?.label ?? field;
  const special: Record<string, string> = {
    'parents.primaryMobile': 'Primary contact',
    'parents.father': 'Father full name',
    'parents.mother': 'Mother full name',
    'parents.guardian': 'Guardian full name',
    'parents.localGuardian': 'Local guardian full name',
  };
  if (special[field]) return special[field]!;
  const exact = SHEET_COLUMNS.find((c) => c.field === field);
  if (exact) return exact.label;
  const inside = SHEET_COLUMNS.find((c) => c.field.startsWith(`${field}.`));
  if (inside) return inside.label;
  const around = SHEET_COLUMNS.filter((c) => field.startsWith(`${c.field}.`)).sort(
    (a, b) => b.field.length - a.field.length,
  )[0];
  return around?.label ?? field;
}

/** "2010-06-15", "15/06/2010" or "15-06-2010" as YYYY-MM-DD; null when it is not a date. */
export function sheetDate(v: string): string | null {
  const t = v.trim();
  let iso = t;
  const dmy = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(t);
  if (dmy) iso = `${dmy[3]}-${dmy[2]!.padStart(2, '0')}-${dmy[1]!.padStart(2, '0')}`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso) || Number.isNaN(Date.parse(iso))) return null;
  return iso;
}

const key = (v: string) => v.trim().toLowerCase().replace(/\s+/g, ' ');
const GENDER: Readonly<Record<string, string>> = {
  male: 'MALE',
  m: 'MALE',
  boy: 'MALE',
  female: 'FEMALE',
  f: 'FEMALE',
  girl: 'FEMALE',
  other: 'OTHER',
};
const CATEGORY: Readonly<Record<string, string>> = {
  general: 'GENERAL',
  gen: 'GENERAL',
  obc: 'OBC',
  sc: 'SC',
  st: 'ST',
  other: 'OTHER',
};
const BOARD: Readonly<Record<string, string>> = {
  cbse: 'CBSE',
  icse: 'ICSE',
  state: 'STATE',
  'state board': 'STATE',
  ib: 'IB',
  other: 'OTHER',
};
const PRIMARY: Readonly<Record<string, string>> = {
  father: 'FATHER',
  mother: 'MOTHER',
  guardian: 'GUARDIAN',
};
const CHILDREN: Readonly<Record<string, string>> = {
  single: 'SINGLE',
  'single child': 'SINGLE',
  one: 'SINGLE',
  '1': 'SINGLE',
  more: 'MORE',
  'more than one': 'MORE',
  'more than one child': 'MORE',
  '2+': 'MORE',
};
const BLOOD: Readonly<Record<string, string>> = {
  unknown: 'UNKNOWN',
  "don't know": 'UNKNOWN',
  'not known': 'UNKNOWN',
};

export interface SheetLookups {
  /** The year's public id by its label; empty: the current year. Null when there is none. */
  readonly year: (label: string) => string | null;
  /** The class's public id by name; null when there is none. */
  readonly classId: (name: string) => string | null;
  /** An active pick-up stop's public id by name; null when there is none. */
  readonly stop: (name: string) => string | null;
}

export interface SheetProblem {
  readonly column: string;
  readonly code: MessageKey;
  readonly params?: Readonly<Record<string, string | number>>;
}

/**
 * One row as the form's sections. A value the form would refuse is passed on as written, so the
 * form's own check reports it; what only a sheet can get wrong (Yes or No, a year, a stop) is
 * reported here.
 */
export function readSheetRow(
  cell: (label: string) => string,
  custom: readonly CfField[],
  look: SheetLookups,
): { app: SheetApplication; problems: SheetProblem[] } {
  const problems: SheetProblem[] = [];
  const opt = (label: string) => cell(label) || undefined;
  const pick = (map: Readonly<Record<string, string>>, label: string) => {
    const v = cell(label);
    return v ? (map[key(v)] ?? v) : undefined;
  };
  const date = (label: string) => {
    const v = cell(label);
    return v ? (sheetDate(v) ?? v) : undefined;
  };
  const yesNo = (label: string, dflt: boolean) => {
    const v = key(cell(label));
    if (!v) return dflt;
    if (['yes', 'y', 'true', '1'].includes(v)) return true;
    if (['no', 'n', 'false', '0'].includes(v)) return false;
    problems.push({ column: label, code: 'UPL.YES_NO' });
    return dflt;
  };
  const income = (label: string) => {
    const v = cell(label).replace(/[₹,\s]/g, '');
    if (!v) return undefined;
    return /^\d+$/.test(v) ? Number(v) : v;
  };
  const anyOf = (prefix: string) =>
    SHEET_COLUMNS.some((c) => c.label.startsWith(prefix) && cell(c.label));
  const upper = (label: string) => opt(label)?.toUpperCase();
  const person = (who: keyof typeof PEOPLE) => {
    const p = PEOPLE[who];
    return {
      name: opt(`${p} full name`),
      mobile: opt(`${p} mobile`),
      ...(who === 'localGuardian'
        ? { relation: opt(`${p} relationship`), address: opt(`${p} address`) }
        : {
            email: opt(`${p} e-mail`),
            occupation: opt(`${p} occupation`),
            ...(who === 'guardian'
              ? { relation: opt(`${p} relationship to the student`) }
              : { annualIncome: income(`${p} annual income`) }),
          }),
      aadhaar: opt(`${p} Aadhaar number`),
      pan: upper(`${p} PAN`),
    };
  };
  const addressOf = (name: 'Residential' | 'Correspondence') => ({
    line1: opt(`${name} house number and street`),
    line2: opt(`${name} area or locality`),
    city: opt(`${name} city or town`),
    state: opt(`${name} state`),
    pin: opt(`${name} PIN code`),
  });

  const yearLabel = cell('Academic year');
  const yearId = look.year(yearLabel);
  if (!yearId) {
    problems.push(
      yearLabel
        ? { column: 'Academic year', code: 'UPL.YEAR_UNKNOWN', params: { year: yearLabel } }
        : { column: 'Academic year', code: 'ACA.NO_CURRENT_YEAR' },
    );
  }
  const transport = yesNo('Opt for school transport', false);
  const stopName = cell('Preferred pick-up point');
  let transportStopId: string | null = null;
  if (transport && stopName) {
    transportStopId = look.stop(stopName);
    if (!transportStopId) {
      problems.push({
        column: 'Preferred pick-up point',
        code: 'UPL.STOP_UNKNOWN',
        params: { stop: stopName },
      });
    }
  }
  const same = yesNo('Correspondence same as residential', true);
  const reference = anyOf('Reference')
    ? {
        name: opt('Reference full name'),
        relation: opt('Reference: how they know the student'),
        mobile: opt('Reference phone'),
        email: opt('Reference e-mail'),
      }
    : null;
  const app: SheetApplication = {
    yearId: yearId ?? '',
    classId: look.classId(cell('Class')) ?? '',
    joiningDate: date('Joining date') ?? null,
    midTermReason: cell('Reason for joining mid-year') || null,
    student: {
      firstName: opt('First name'),
      middleName: opt('Middle name'),
      lastName: opt('Last name'),
      gender: pick(GENDER, 'Gender'),
      dob: date('Date of birth'),
      aadhaar: opt('Aadhaar number'),
      pan: upper('PAN'),
      category: pick(CATEGORY, 'Category'),
      medium: opt('Medium of instruction'),
      bloodGroup: (() => {
        const v = cell('Blood group');
        return v ? (BLOOD[key(v)] ?? v.replace(/\s+/g, '').toUpperCase()) : undefined;
      })(),
      allergies: opt('Food allergies'),
      health: opt('Health conditions'),
    },
    addresses: {
      residential: anyOf('Residential') ? addressOf('Residential') : undefined,
      sameAsResidential: same,
      correspondence: !same && anyOf('Correspondence ') ? addressOf('Correspondence') : null,
    },
    previous: {
      school: opt('Last school attended'),
      lastClass: opt('Last class studied'),
      result: opt('Last result'),
      board: pick(BOARD, 'Board'),
      otherBoard: opt('Name of the board'),
    },
    parents: {
      father: person('father'),
      mother: person('mother'),
      guardian: anyOf('Guardian ') ? person('guardian') : null,
      primary: pick(PRIMARY, 'Primary contact'),
      children: pick(CHILDREN, 'Children in the family'),
      transport,
      transportStopId,
      hostel: yesNo('Hostel accommodation', false),
      localGuardian: anyOf('Local guardian') ? person('localGuardian') : null,
    },
    customFields: Object.fromEntries(
      custom.map((f) => [f.id, cell(f.label)]).filter(([, v]) => v !== ''),
    ),
    reference,
  };
  return { app, problems };
}
