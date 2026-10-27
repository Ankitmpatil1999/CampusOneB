/**
 * Onboarding from a sheet (SRS 6.18, 6.19; IDN-049…052; OI-IDN-21; RNG-GOV-019; prototype c.onboard
 * "Bulk upload"). The institution downloads the template (CSV — Excel opens and saves it), fills one
 * row per person and uploads it. Every row is checked first — user type, department, grade and
 * section, dates, mobile (it may be used at another institution too, client 2026-10-27), admission
 * numbers in the sheet and already in use, the institution's own fields — and the report shows
 * each rejected row with its reasons. Nothing is created until the upload is committed: all rows
 * (only when none was rejected) or the accepted rows only, in one transaction.
 *
 * The students' template is the admission form (client 2026-10-19; admission-sheet.ts): a row is
 * checked as the form is, and a committed row is onboarded with an approved application holding the
 * form, as an admission leaves a student. Until then the row waits encrypted in the report — it has
 * Aadhaar numbers and PANs.
 */
import type { Kysely, Transaction } from 'kysely';
import { LIMITS, renderMessage, type MessageKey } from '../config/registers';
import type { Database } from '../models/ringpe_models';
import { academicsRepository } from '../repositories/academics.repository';
import { userTypesRepository } from '../repositories/institution-setup.repository';
import { membersRepository as repo, KIND_CATEGORIES } from '../repositories/members.repository';
import {
  AuthorizationError,
  CustomAPIError,
  NotFoundError,
  ValidationError,
} from '../utils/CustomAPIError';
import { detectDelimiter, toCsv, parseCsv } from '../utils/csv';
import { binToUuid, isUuid, newPublicIdPair, uuidToBin } from '../utils/idGenerator';
import type { Principal } from '../utils/principal';
import { PATTERNS } from '../utils/validators';
import { institutionsRepository } from '../repositories/institutions.repository';
import { rolesRepository } from '../repositories/roles.repository';
import { recordAudit } from './audit.service';
import { ADMIN, checkProfileForRole } from './console-staff.service';
import { activeFields, parseValues, type CfField } from './custom-values.service';
import {
  SHEET_COLUMNS,
  columnOf,
  headerKey,
  headerOf,
  readSheetRow,
  sameHeader,
  sheetDate,
} from './admission-sheet';
import type { AdmissionsService, SheetApplication } from './admissions.service';
import type { FieldCipher } from '../utils/fieldEncryption';
import { titleCase } from '../utils/format';
import type { MembersService, OnboardInput, StaffInput } from './members.service';
import { defaultValues, type SettingValues } from './settings.service';

export type UploadKind = 'MEMBERS' | 'STAFF';

/** The members template before it became the admission form (client 2026-10-19). */
const OLD_MEMBER_COLUMNS = [
  'User type',
  'First name',
  'Last name',
  'Gender',
  'Date of birth',
  'Mobile',
  'E-mail',
  'Admission number',
  'Grade',
  'Section',
  'Department',
  'Joining date',
  'Parent first name',
  'Parent last name',
  'Parent mobile',
  'Parent relation',
] as const;

/** The staff template before each row carried the console role (client 2026-10-22). */
const OLD_STAFF_COLUMNS = [
  'User type',
  'Department',
  'First name',
  'Last name',
  'Gender',
  'Date of birth',
  'Mobile',
  'E-mail',
  'Joining date',
  'Employee ID',
] as const;

const STAFF_COLUMNS = [
  'User type',
  'Department',
  // The console role given with the profile, or None (client 2026-10-22).
  'Role',
  'First name',
  'Last name',
  'Gender',
  'Date of birth',
  'Mobile',
  'E-mail',
  'Joining date',
  'Employee ID',
] as const;

/** A role as written in a sheet: its name or code, case, spaces and punctuation aside. */
const roleKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
/** The roles a staff member can be given at onboarding: not RingPe's, not a merchant's. */
const NOT_FOR_STAFF = new Set([ADMIN, 'MERCHANT', 'VENDOR_MERCHANT']);

const GENDERS: Readonly<Record<string, 'MALE' | 'FEMALE' | 'OTHER'>> = {
  male: 'MALE',
  m: 'MALE',
  female: 'FEMALE',
  f: 'FEMALE',
  other: 'OTHER',
};
const MOBILE = /^[6-9]\d{9}$/;

const toDate = sheetDate;

interface RowReport {
  readonly row: number;
  readonly name: string;
  readonly accepted: boolean;
  readonly errors: readonly { readonly column: string; readonly message: string }[];
  readonly input?: OnboardInput | StaffInput;
  /** A student's row (the admission form), encrypted until it is committed. */
  readonly sealed?: string;
}

/** A student's row as it waits for the commit. */
interface SealedStudent {
  readonly app: SheetApplication;
  readonly userTypeId: string;
  readonly departmentId: string | null;
  readonly sectionId: string;
  readonly admissionNo: string;
  readonly memberFields: Readonly<Record<string, string>>;
}

const SEAL = 'upl_member_row';

export class MemberUploadsService {
  constructor(
    private readonly deps: {
      readonly db: Kysely<Database>;
      readonly members: MembersService;
      readonly admissions: AdmissionsService;
      readonly cipher: FieldCipher;
      readonly settings?: { values(): Promise<SettingValues> };
      readonly now?: () => Date;
    },
  ) {}

  private async limit(l: { key: string; value: number }) {
    const v = this.deps.settings ? await this.deps.settings.values() : defaultValues();
    return v[l.key] ?? l.value;
  }

  private async own(p: Principal, db: Kysely<Database> = this.deps.db, lock = false) {
    if (!p.institutionId || !isUuid(p.institutionId)) throw new NotFoundError();
    const row = await institutionsRepository.byPublicId(db, uuidToBin(p.institutionId), lock);
    if (!row) throw new NotFoundError();
    return row;
  }

  /**
   * The custom fields a sheet carries, by label: the admission form's (students, client 2026-10-19)
   * and the member's. A label both have is one column, read for both; a field named as one of the
   * form's columns ("Blood group") is read from that column. `all` are the extra columns.
   */
  private async fieldsOf(institutionId: string, kind: UploadKind) {
    const db = this.deps.db;
    const member = await activeFields(db, institutionId, 'MEMBER');
    if (kind === 'STAFF') return { form: [], member, all: member };
    const form = await activeFields(db, institutionId, 'ADMISSION_APPLICATION');
    const extra = (f: CfField) => !SHEET_COLUMNS.some((c) => sameHeader(c.label, f.label));
    const all = [
      ...form,
      ...member.filter((m) => !form.some((f) => sameHeader(f.label, m.label))),
    ].filter(extra);
    return { form, member, all };
  }

  /** The active institution roles (client 2026-10-22: a staff row names one, or None). */
  private async roles() {
    return (await rolesRepository.roles(this.deps.db, 'INSTITUTION')).filter(
      (r) => r.status === 'ACTIVE',
    );
  }

  private columns(kind: UploadKind, fields: readonly CfField[]) {
    const base = kind === 'STAFF' ? [...STAFF_COLUMNS] : SHEET_COLUMNS.map(headerOf);
    return [
      ...base,
      ...fields.map((f) => (kind === 'MEMBERS' && f.required ? `${f.label} *` : f.label)),
    ];
  }

  // --- IDN-052 ------------------------------------------------------------------------------------
  /**
   * The template: the columns, one example row, and the institution's own fields at the end. The
   * students' is the admission form (client 2026-10-19), its required columns marked " *".
   */
  async template(p: Principal, kind: UploadKind) {
    const inst = await this.own(p);
    const { all } = await this.fieldsOf(inst.id, kind);
    const teacher =
      kind === 'STAFF' ? (await this.roles()).find((r) => r.code === 'TEACHER') : null;
    const example =
      kind === 'STAFF'
        ? [
            'Teacher',
            'Primary',
            teacher?.name ?? 'None',
            'Kavya',
            'Rao',
            'Female',
            '1990-07-12',
            '9845098450',
            'kavya.rao@school.example.in',
            '2026-06-01',
            '',
          ]
        : SHEET_COLUMNS.map((c) => c.example);
    const cf = all.map((f) =>
      f.type === 'DROPDOWN' || f.type === 'MULTI_SELECT'
        ? (f.options[0]?.label ?? '')
        : f.type === 'YES_NO'
          ? 'No'
          : '',
    );
    return {
      fileName: kind === 'STAFF' ? 'ringpe-staff-template.csv' : 'ringpe-members-template.csv',
      csv: toCsv([this.columns(kind, all), [...example, ...cf]]),
    };
  }

  // --- IDN-049 ------------------------------------------------------------------------------------
  /**
   * Where each column is in the file (client 2026-10-13). The template's own columns must come first,
   * in order, as written (case, spacing and the required mark aside); the institution's fields may
   * follow in any order, and one missing (a template from before it was added) is read as empty. A
   * refusal says what is wrong: the other kind's template, the members template from before it was
   * the admission form, the first column that differs, or a column no one knows.
   */
  private columnIndex(kind: UploadKind, first: readonly string[], fields: readonly CfField[]) {
    const students = SHEET_COLUMNS.map((c) => c.label);
    const base = kind === 'STAFF' ? [...STAFF_COLUMNS] : students;
    const same = (cols: readonly string[]) => cols.every((h, i) => sameHeader(first[i] ?? '', h));
    if (!same(base)) {
      if (kind === 'MEMBERS' && same(OLD_MEMBER_COLUMNS)) {
        throw new CustomAPIError(422, 'UPL.OLD_TEMPLATE');
      }
      if (kind === 'STAFF' && same(OLD_STAFF_COLUMNS)) {
        throw new CustomAPIError(422, 'UPL.OLD_STAFF_TEMPLATE');
      }
      if (
        kind === 'MEMBERS'
          ? same(STAFF_COLUMNS) || same(OLD_STAFF_COLUMNS)
          : same(students) || same(OLD_MEMBER_COLUMNS)
      ) {
        const [used, wanted] = kind === 'STAFF' ? ['members', 'staff'] : ['staff', 'members'];
        throw new CustomAPIError(422, 'UPL.WRONG_TEMPLATE', { params: { used, wanted } });
      }
      const i = base.findIndex((h, n) => !sameHeader(first[n] ?? '', h));
      throw new CustomAPIError(422, 'UPL.HEADER_COLUMN', {
        params: {
          n: i + 1,
          expected: kind === 'STAFF' ? base[i]! : headerOf(SHEET_COLUMNS[i]!),
          found: first[i]?.trim() || '(empty)',
        },
      });
    }
    const index = new Map<string, number>(base.map((h, i) => [headerKey(h), i]));
    for (let i = base.length; i < first.length; i++) {
      if (!first[i]?.trim()) continue;
      const f = fields.find((x) => sameHeader(x.label, first[i]!));
      if (!f) {
        throw new CustomAPIError(422, 'UPL.HEADER_UNKNOWN', {
          params: { found: first[i]!.trim() },
        });
      }
      index.set(headerKey(f.label), i);
    }
    return index;
  }

  async upload(p: Principal, input: { kind: UploadKind; fileName: string; content: string }) {
    const db = this.deps.db;
    const inst = await this.own(p);
    // An Excel workbook (a zip) instead of the CSV the template is.
    if (input.content.startsWith('PK\u0003\u0004')) throw new CustomAPIError(422, 'UPL.NOT_CSV');
    const rows = parseCsv(input.content, detectDelimiter(input.content));
    if (!rows.length) throw new CustomAPIError(422, 'UPL.HEADER_MISMATCH');
    const { form, member, all } = await this.fieldsOf(inst.id, input.kind);
    const index = this.columnIndex(input.kind, rows[0]!, all);
    // Excel leaves rows it once had as empty lines.
    const data = rows.slice(1).filter((r) => r.some((c) => c.trim()));
    if (!data.length) throw new CustomAPIError(422, 'UPL.NO_ROWS');
    const max = await this.limit(LIMITS.uploadMaxRows);
    if (data.length > max) throw new CustomAPIError(422, 'UPL.TOO_MANY_ROWS', { params: { max } });

    const pub = newPublicIdPair();
    const report =
      input.kind === 'MEMBERS'
        ? await this.studentRows(inst.id, pub.id, data, index, form, member)
        : await this.staffRows(inst.id, data, index, member, p.subTasks.includes('members.roles'));
    const accepted = report.filter((r) => r.accepted).length;
    await repo.insertUpload(db, {
      publicId: pub.bin,
      institutionId: inst.id,
      kind: input.kind,
      fileName: input.fileName.slice(0, 200),
      total: report.length,
      accepted,
      rejected: report.length - accepted,
      report,
      by: isUuid(p.subject) ? uuidToBin(p.subject) : null,
    });
    return this.status(p, pub.id);
  }

  /** A row's cells by column, and its errors as the report shows them. */
  private rowOf(index: ReadonlyMap<string, number>, cells: readonly string[]) {
    const errors: { column: string; message: string }[] = [];
    return {
      cell: (name: string) => {
        const at = index.get(headerKey(name));
        return at === undefined ? '' : (cells[at] ?? '').trim();
      },
      errors,
      // One error a column: the first says what to fix.
      err: (
        column: string,
        code: MessageKey,
        params?: Readonly<Record<string, string | number>>,
      ) => {
        if (!errors.some((e) => e.column === column)) {
          errors.push({ column, message: renderMessage(code, params) });
        }
      },
    };
  }

  /**
   * The students' rows (client 2026-10-19): the admission form's sections, checked as the form checks
   * them (AdmissionsService.sheetState), and what onboarding needs — the student type, the class and
   * section, an admission number not used in the file or at the school, parents' mobiles not at
   * another school, the member's own fields.
   */
  private async studentRows(
    institutionId: string,
    uploadId: string,
    data: readonly (readonly string[])[],
    index: ReadonlyMap<string, number>,
    form: readonly CfField[],
    member: readonly CfField[],
  ) {
    const db = this.deps.db;
    const [types, departments, classes, sections, years, stops] = await Promise.all([
      userTypesRepository.list(db, institutionId),
      db
        .selectFrom('departments')
        .select(['public_id', 'user_type_id', 'name'])
        .where('institution_id', '=', institutionId)
        .execute(),
      academicsRepository.classes(db, institutionId),
      academicsRepository.sections(db, institutionId),
      db
        .selectFrom('academic_years')
        .select(['public_id', 'label', 'is_current'])
        .where('institution_id', '=', institutionId)
        .execute(),
      db
        .selectFrom('transport_stops')
        .select(['public_id', 'name'])
        .where('institution_id', '=', institutionId)
        .where('active', '=', 1)
        .execute(),
    ]);
    const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
    const look = {
      year: (label: string) => {
        const y = label
          ? years.find((x) => same(x.label, label))
          : years.find((x) => Number(x.is_current));
        return y ? binToUuid(y.public_id) : null;
      },
      classId: (name: string) => {
        const c = classes.find((x) => same(x.name, name));
        return c ? binToUuid(c.public_id) : null;
      },
      stop: (name: string) => {
        const s = stops.find((x) => same(x.name, name));
        return s ? binToUuid(s.public_id) : null;
      },
    };
    const studentType = types.find((t) => t.category === 'STUDENT' && t.status === 'ACTIVE');
    const parentType = types.find((t) => t.category === 'PARENT' && t.status === 'ACTIVE');
    // Client 2026-10-16: a new parent's e-mail (setting mem.parentEmail.required).
    const parentEmailRequired = await this.deps.members.parentEmailRequired();
    const seenAdmission = new Map<string, number>();
    const report: RowReport[] = [];
    for (const [i, cells] of data.entries()) {
      const { cell, errors, err } = this.rowOf(index, cells);
      const typeName = cell('User type');
      const ut = typeName
        ? types.find((t) => same(t.name, typeName) && t.status === 'ACTIVE')
        : studentType;
      if (!ut) err('User type', 'IDN.USER_TYPE_UNKNOWN', { t: typeName || 'Student' });
      else if (ut.category !== 'STUDENT') err('User type', 'UPL.NOT_A_STUDENT', { t: ut.name });
      const depName = cell('Department');
      const dep = ut
        ? departments.find((d) => String(d.user_type_id) === String(ut.id) && same(d.name, depName))
        : undefined;
      if (depName && ut && !dep)
        err('Department', 'IDN.DEPARTMENT_UNKNOWN', { d: depName, t: ut.name });

      const admissionNo = cell('Admission number');
      if (!admissionNo) err('Admission number', 'IDN.ADMISSION_NO_REQUIRED');
      else {
        if (seenAdmission.has(admissionNo.toLowerCase())) {
          err('Admission number', 'IDN.ADMISSION_NO_REPEATED', { n: admissionNo });
        }
        seenAdmission.set(admissionNo.toLowerCase(), i + 2);
        if (await repo.admissionTaken(db, institutionId, admissionNo)) {
          err('Admission number', 'IDN.ADMISSION_NO_TAKEN', { n: admissionNo });
        }
      }
      const c = classes.find((x) => same(x.name, cell('Class')));
      const sec = c
        ? sections.find((x) => String(x.class_id) === String(c.id) && same(x.name, cell('Section')))
        : undefined;
      if (!c) err('Class', cell('Class') ? 'VALIDATION.FORMAT' : 'VALIDATION.REQUIRED');
      else if (!sec) err('Section', cell('Section') ? 'VALIDATION.FORMAT' : 'VALIDATION.REQUIRED');

      // The admission form.
      const read = readSheetRow(cell, form, look);
      for (const x of read.problems) err(x.column, x.code, x.params);
      const checked = await this.deps.admissions.sheetState(db, institutionId, read.app);
      for (const e of checked.errors) {
        err(columnOf(e.field, form), e.code as MessageKey, e.params);
      }
      if (checked.state) {
        // The parents who get a RingPe account with the student, as on an admission.
        const guardians = this.deps.admissions.guardiansOf(checked.state.data.parents);
        if (guardians.length && !parentType) err('Primary contact', 'ADM.PARENT_TYPE_MISSING');
        const who = { FATHER: 'Father', MOTHER: 'Mother', GUARDIAN: 'Guardian' } as const;
        // A parent's mobile may be used at another institution too (client 2026-10-27).
        for (const g of guardians) {
          if (!g.email && parentEmailRequired)
            err(`${who[g.relation]} e-mail`, 'VALIDATION.REQUIRED');
        }
      }
      // The member's own fields (a label the form has too is the same column).
      const memberFields = Object.fromEntries(
        member.map((f) => [f.id, cell(f.label)]).filter(([, v]) => v !== ''),
      );
      const cf = parseValues(member, memberFields, { partial: false });
      for (const e of cf.errors) {
        const f = member.find((x) => `customFields.${x.id}` === e.field);
        err(f?.label ?? e.field, e.code as MessageKey, e.params ?? {});
      }

      const s = read.app.student as { firstName?: string; lastName?: string };
      let sealed: string | undefined;
      if (!errors.length && ut && sec && checked.state) {
        const row: SealedStudent = {
          app: read.app,
          userTypeId: binToUuid(ut.public_id),
          departmentId: dep ? binToUuid(dep.public_id) : null,
          sectionId: binToUuid(sec.public_id),
          admissionNo,
          memberFields,
        };
        sealed = this.deps.cipher
          .encrypt(SEAL, JSON.stringify(row), `${uploadId}:${i + 2}`)
          .toString('base64');
      }
      report.push({
        row: i + 2,
        name: [s.firstName, s.lastName].filter(Boolean).join(' ') || '—',
        accepted: errors.length === 0,
        errors,
        ...(sealed ? { sealed } : {}),
      });
    }
    return report;
  }

  /**
   * The staff rows (SRS 6.18): as before, and each one's console role (client 2026-10-22) — a role's
   * name (or code), or None — given only by a role that may give roles (members.roles), checked as
   * the access page checks it.
   */
  private async staffRows(
    institutionId: string,
    data: readonly (readonly string[])[],
    index: ReadonlyMap<string, number>,
    fields: readonly CfField[],
    canGiveRoles: boolean,
  ) {
    const db = this.deps.db;
    const types = await userTypesRepository.list(db, institutionId);
    const departments = await db
      .selectFrom('departments')
      .select(['public_id', 'user_type_id', 'name'])
      .where('institution_id', '=', institutionId)
      .execute();
    const roles = await this.roles();
    const roleNames = roles
      .filter((r) => !(r.code && NOT_FOR_STAFF.has(r.code)))
      .map((r) => r.name)
      .join(', ');
    const seenMobile = new Map<string, number>();
    const report: RowReport[] = [];
    for (const [i, cells] of data.entries()) {
      const { cell, errors, err } = this.rowOf(index, cells);
      const typeName = cell('User type');
      const ut = types.find(
        (t) => t.name.toLowerCase() === typeName.toLowerCase() && t.status === 'ACTIVE',
      );
      if (!ut) err('User type', 'IDN.USER_TYPE_UNKNOWN', { t: typeName || '—' });
      else if (ut.category === 'MERCHANT') err('User type', 'IDN.MERCHANT_NOT_HERE');
      else if (!KIND_CATEGORIES.STAFF.includes(ut.category)) {
        err('User type', 'IDN.USER_TYPE_UNKNOWN', { t: typeName });
      }
      const depName = cell('Department');
      const dep = ut
        ? departments.find(
            (d) =>
              String(d.user_type_id) === String(ut.id) &&
              d.name.toLowerCase() === depName.toLowerCase(),
          )
        : undefined;
      if (depName && ut && !dep)
        err('Department', 'IDN.DEPARTMENT_UNKNOWN', { d: depName, t: ut.name });
      if (!depName) err('Department', 'VALIDATION.REQUIRED');
      const roleText = cell('Role');
      let role: (typeof roles)[number] | null = null;
      if (!roleText) err('Role', 'UPL.ROLE_REQUIRED', { roles: roleNames });
      else if (roleKey(roleText) !== 'none') {
        const r = roles.find(
          (x) =>
            roleKey(x.name) === roleKey(roleText) || roleKey(x.code ?? '') === roleKey(roleText),
        );
        if (!r) err('Role', 'UPL.ROLE_UNKNOWN', { role: roleText, roles: roleNames });
        else if (!canGiveRoles) err('Role', 'IDN.ROLE_NOT_PERMITTED');
        else if (r.code === ADMIN) err('Role', 'IDN.ROLE_NOT_ASSIGNABLE');
        else if (ut) {
          try {
            checkProfileForRole(r, { category: ut.category, merchant_type: null });
            role = r;
          } catch (e) {
            if (!(e instanceof CustomAPIError)) throw e;
            err('Role', e.code as MessageKey, e.params ?? {});
          }
        }
      }
      const first = cell('First name');
      if (!first) err('First name', 'VALIDATION.REQUIRED');
      const last = cell('Last name');
      const genderText = cell('Gender');
      const gender = genderText ? GENDERS[genderText.toLowerCase()] : undefined;
      if (genderText && !gender) err('Gender', 'VALIDATION.FORMAT');
      const dobText = cell('Date of birth');
      const dob = dobText ? toDate(dobText) : null;
      if (dobText && !dob) err('Date of birth', 'VALIDATION.DATE');
      const mobile = cell('Mobile');
      if (mobile && !MOBILE.test(mobile)) err('Mobile', 'VALIDATION.MOBILE');
      if (mobile) {
        if (seenMobile.has(mobile)) err('Mobile', 'IDN.STAFF_MOBILE_TAKEN');
        seenMobile.set(mobile, i + 2);
      }
      const email = cell('E-mail');
      // The platform's one e-mail rule (client 2026-10-15).
      if (email && !PATTERNS.email.test(email.trim().toLowerCase())) {
        err('E-mail', 'VALIDATION.EMAIL');
      }
      const joinedText = cell('Joining date');
      const joined = joinedText ? toDate(joinedText) : null;
      if (joinedText && !joined) err('Joining date', 'VALIDATION.DATE');
      // The mobile may be used at another institution too (client 2026-10-27).
      const customRaw = Object.fromEntries(
        fields.map((f) => [f.id, cell(f.label)]).filter(([, v]) => v !== ''),
      );
      const cf = parseValues(fields, customRaw, { partial: false });
      for (const e of cf.errors) {
        const f = fields.find((x) => `customFields.${x.id}` === e.field);
        err(f?.label ?? e.field, e.code as MessageKey, e.params ?? {});
      }
      if (!gender) err('Gender', 'VALIDATION.REQUIRED');
      if (!dob) err('Date of birth', 'VALIDATION.REQUIRED');
      if (!mobile) err('Mobile', 'VALIDATION.REQUIRED');
      if (!email) err('E-mail', 'VALIDATION.REQUIRED');
      if (!joined) err('Joining date', 'VALIDATION.REQUIRED');
      if (dob) {
        try {
          this.deps.members.checkStaffAge({ dateOfBirth: dob });
        } catch (e) {
          if (e instanceof ValidationError) err('Date of birth', e.errors[0]!.code as MessageKey);
        }
      }
      const employeeNo = cell('Employee ID');
      if (employeeNo && (await repo.employeeTaken(db, institutionId, employeeNo))) {
        err('Employee ID', 'IDN.EMPLOYEE_NO_TAKEN', { n: employeeNo });
      }
      let rowInput: StaffInput | undefined;
      if (!errors.length && ut && dep && gender && dob && joined) {
        rowInput = {
          userTypeId: binToUuid(ut.public_id),
          departmentId: binToUuid(dep.public_id),
          firstName: first,
          lastName: last || null,
          gender,
          dateOfBirth: dob,
          mobile,
          email,
          joinedOn: joined,
          employeeNo: employeeNo || null,
          customFields: customRaw,
          roleId: role ? binToUuid(role.public_id) : null,
        };
      }
      report.push({
        row: i + 2,
        name: [first, last].filter(Boolean).join(' ') || '—',
        accepted: errors.length === 0,
        errors,
        ...(rowInput ? { input: rowInput } : {}),
      });
    }
    return report;
  }

  /**
   * A student's row (the admission form, client 2026-10-19): checked again, onboarded as an admission
   * onboards — the parents with accounts, enrolled in the section — and the approved application
   * holding the form written with them.
   */
  private async onboardStudent(
    trx: Transaction<Database>,
    inst: Awaited<ReturnType<MemberUploadsService['own']>>,
    uploadId: string,
    r: RowReport,
    by: Buffer | null,
  ) {
    const x = JSON.parse(
      this.deps.cipher.decrypt(SEAL, Buffer.from(r.sealed!, 'base64'), `${uploadId}:${r.row}`),
    ) as SealedStudent;
    const checked = await this.deps.admissions.sheetState(trx, String(inst.id), x.app);
    const s = checked.state;
    if (!s) {
      const e = checked.errors[0]!;
      throw new CustomAPIError(422, e.code as MessageKey, e.params ? { params: e.params } : {});
    }
    const pub = newPublicIdPair();
    await this.deps.members.createMember(
      trx,
      inst,
      pub,
      {
        userTypeId: x.userTypeId,
        departmentId: x.departmentId,
        firstName: titleCase(s.firstName ?? ''),
        lastName: titleCase([s.middleName, s.lastName].filter(Boolean).join(' ')) || null,
        gender: s.gender,
        dateOfBirth: s.dob,
        mobile: null,
        email: null,
        joinedOn: s.joiningDate,
        admissionNo: x.admissionNo,
        sectionId: x.sectionId,
        guardians: this.deps.admissions.guardiansOf(s.data.parents),
        customFields: x.memberFields,
        enrolYearId: x.app.yearId,
      },
      by,
    );
    const m = await trx
      .selectFrom('member_profiles')
      .select('id')
      .where('public_id', '=', pub.bin)
      .executeTakeFirstOrThrow();
    await this.deps.admissions.insertFromSheet(trx, String(inst.id), s, checked.reference ?? null, {
      sectionId: x.sectionId,
      admissionNo: x.admissionNo,
      memberRowId: String(m.id),
      by,
    });
  }

  // --- IDN-050 ------------------------------------------------------------------------------------
  async status(p: Principal, uploadId: string) {
    const inst = await this.own(p);
    if (!isUuid(uploadId)) throw new NotFoundError();
    const u = await repo.upload(this.deps.db, inst.id, uuidToBin(uploadId));
    if (!u) throw new NotFoundError();
    const report = (typeof u.report === 'string' ? JSON.parse(u.report) : u.report) as RowReport[];
    return {
      id: uploadId,
      kind: u.kind,
      fileName: u.file_name,
      status: u.status,
      total: u.rows_total,
      accepted: u.rows_accepted,
      rejected: u.rows_rejected,
      committed: u.committed_count,
      rows: report.map((r) => ({
        row: r.row,
        name: r.name,
        accepted: r.accepted,
        errors: r.errors,
      })),
    };
  }

  // --- IDN-051 ------------------------------------------------------------------------------------
  async commit(p: Principal, uploadId: string, input: { mode: 'ALL' | 'ACCEPTED' }) {
    if (!isUuid(uploadId)) throw new NotFoundError();
    const by = isUuid(p.subject) ? uuidToBin(p.subject) : null;
    const staffMails: Awaited<ReturnType<MembersService['createStaff']>>[] = [];
    const created = await this.deps.db.transaction().execute(async (trx) => {
      const inst = await this.own(p, trx, true);
      const u = await repo.upload(trx, inst.id, uuidToBin(uploadId), true);
      if (!u) throw new NotFoundError();
      if (u.status === 'COMMITTED') throw new CustomAPIError(409, 'UPL.ALREADY_COMMITTED');
      if (input.mode === 'ALL' && u.rows_rejected > 0) {
        throw new CustomAPIError(409, 'UPL.HAS_REJECTED', { params: { n: u.rows_rejected } });
      }
      const report = (
        typeof u.report === 'string' ? JSON.parse(u.report) : u.report
      ) as RowReport[];
      const rows = report.filter((r) => r.accepted && (r.input || r.sealed));
      if (!rows.length) throw new CustomAPIError(422, 'UPL.NOTHING_ACCEPTED');
      // Rows that give a console role are committed only by a role that may give roles.
      if (
        u.kind === 'STAFF' &&
        !p.subTasks.includes('members.roles') &&
        rows.some((r) => (r.input as StaffInput | undefined)?.roleId)
      ) {
        throw new AuthorizationError('IDN.ROLE_NOT_PERMITTED');
      }
      for (const r of rows) {
        try {
          if (u.kind === 'STAFF') {
            staffMails.push(
              await this.deps.members.createStaff(
                trx,
                inst,
                newPublicIdPair(),
                r.input as StaffInput,
                by,
              ),
            );
          } else if (r.sealed) {
            await this.onboardStudent(trx, inst, uploadId, r, by);
          } else {
            // A students' upload checked before the template was the admission form.
            await this.deps.members.createMember(
              trx,
              inst,
              newPublicIdPair(),
              r.input as OnboardInput,
              by,
            );
          }
        } catch (e) {
          // Something changed since the check (another upload, a single onboarding): nothing is kept.
          if (e instanceof CustomAPIError) {
            throw new CustomAPIError(409, 'UPL.ROW_CHANGED', {
              params: { row: r.row, reason: renderMessage(e.code as MessageKey, e.params) },
            });
          }
          throw e;
        }
      }
      if (!(await repo.commitUpload(trx, u.id, rows.length, new Date()))) {
        throw new CustomAPIError(409, 'UPL.ALREADY_COMMITTED');
      }
      await recordAudit(trx, {
        institutionId: inst.id,
        action: 'MEMBERS_UPLOADED',
        entityType: 'member_upload',
        entityRef: uploadId,
        after: { kind: u.kind, created: rows.length, skipped: u.rows_rejected },
      });
      return rows.length;
    });
    const shown = await this.deps.members.passwordsShown();
    await this.deps.members.welcome(staffMails, shown);
    return {
      created,
      skipped: (await this.status(p, uploadId)).rejected,
      // New staff accounts' temporary passwords, shown once (client 2026-10-07).
      ...(shown && staffMails.length
        ? {
            passwords: staffMails.flatMap((x) =>
              x.password
                ? [
                    {
                      name: x.name,
                      email: x.email,
                      employeeNo: x.employeeNo,
                      temporaryPassword: x.password,
                    },
                  ]
                : [],
            ),
          }
        : {}),
    };
  }
}
