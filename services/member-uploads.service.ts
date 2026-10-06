/**
 * Onboarding from a sheet (SRS 6.18, 6.19; IDN-049…052; OI-IDN-21; RNG-GOV-019; prototype c.onboard
 * "Bulk upload"). The institution downloads the template (CSV — Excel opens and saves it), fills one
 * row per person and uploads it. Every row is checked first — user type, department, grade and
 * section, dates, mobile, one institution per person (BR-01), admission numbers in the sheet and
 * already in use, the institution's own fields — and the report shows each rejected row with its
 * reasons. Nothing is created until the upload is committed: all rows (only when none was rejected)
 * or the accepted rows only, in one transaction.
 */
import type { Kysely } from 'kysely';
import { LIMITS, renderMessage, type MessageKey } from '../config/registers';
import type { Database } from '../models/ringpe_models';
import { academicsRepository } from '../repositories/academics.repository';
import { userTypesRepository } from '../repositories/institution-setup.repository';
import { membersRepository as repo, KIND_CATEGORIES } from '../repositories/members.repository';
import { CustomAPIError, NotFoundError, ValidationError } from '../utils/CustomAPIError';
import { toCsv, parseCsv } from '../utils/csv';
import { binToUuid, isUuid, newPublicIdPair, uuidToBin } from '../utils/idGenerator';
import type { Principal } from '../utils/principal';
import { institutionsRepository } from '../repositories/institutions.repository';
import { recordAudit } from './audit.service';
import { activeFields, parseValues, type CfField } from './custom-values.service';
import type { MembersService, OnboardInput, StaffInput } from './members.service';
import { defaultValues, type SettingValues } from './settings.service';

export type UploadKind = 'MEMBERS' | 'STAFF';

const MEMBER_COLUMNS = [
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

const STAFF_COLUMNS = [
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

const GENDERS: Readonly<Record<string, 'MALE' | 'FEMALE' | 'OTHER'>> = {
  male: 'MALE',
  m: 'MALE',
  female: 'FEMALE',
  f: 'FEMALE',
  other: 'OTHER',
};
const RELATIONS: Readonly<Record<string, 'FATHER' | 'MOTHER' | 'GUARDIAN'>> = {
  father: 'FATHER',
  mother: 'MOTHER',
  guardian: 'GUARDIAN',
};
const MOBILE = /^[6-9]\d{9}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** "2010-06-15", "15/06/2010" or "15-06-2010" as YYYY-MM-DD. */
function toDate(v: string): string | null {
  const t = v.trim();
  let iso = t;
  const dmy = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(t);
  if (dmy) iso = `${dmy[3]}-${dmy[2]!.padStart(2, '0')}-${dmy[1]!.padStart(2, '0')}`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso) || Number.isNaN(Date.parse(iso))) return null;
  return iso;
}

interface RowReport {
  readonly row: number;
  readonly name: string;
  readonly accepted: boolean;
  readonly errors: readonly { readonly column: string; readonly message: string }[];
  readonly input?: OnboardInput | StaffInput;
}

export class MemberUploadsService {
  constructor(
    private readonly deps: {
      readonly db: Kysely<Database>;
      readonly members: MembersService;
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

  private columns(kind: UploadKind, fields: readonly CfField[]) {
    return [...(kind === 'STAFF' ? STAFF_COLUMNS : MEMBER_COLUMNS), ...fields.map((f) => f.label)];
  }

  // --- IDN-052 ------------------------------------------------------------------------------------
  /** The template: the columns, one example row, and the institution's own fields at the end. */
  async template(p: Principal, kind: UploadKind) {
    const inst = await this.own(p);
    const fields = await activeFields(this.deps.db, inst.id, 'MEMBER');
    const example =
      kind === 'STAFF'
        ? [
            'Teacher',
            'Primary',
            'Kavya',
            'Rao',
            'Female',
            '1990-07-12',
            '9845098450',
            'kavya.rao@school.example.in',
            '2026-06-01',
            '',
          ]
        : [
            'Student',
            'Aarav',
            'Shetty',
            'Male',
            '2014-05-21',
            '',
            '',
            'TV-2026-0101',
            'Grade 6',
            'A',
            'Middle school',
            '2026-06-01',
            'Ramesh',
            'Shetty',
            '9845012390',
            'Father',
          ];
    const cf = fields.map((f) =>
      f.type === 'DROPDOWN' || f.type === 'MULTI_SELECT'
        ? (f.options[0]?.label ?? '')
        : f.type === 'YES_NO'
          ? 'No'
          : '',
    );
    return {
      fileName: kind === 'STAFF' ? 'ringpe-staff-template.csv' : 'ringpe-members-template.csv',
      csv: toCsv([this.columns(kind, fields), [...example, ...cf]]),
    };
  }

  // --- IDN-049 ------------------------------------------------------------------------------------
  async upload(p: Principal, input: { kind: UploadKind; fileName: string; content: string }) {
    const db = this.deps.db;
    const inst = await this.own(p);
    const rows = parseCsv(input.content);
    const fields = await activeFields(db, inst.id, 'MEMBER');
    const header = this.columns(input.kind, fields);
    const got = (rows[0] ?? []).map((c) => c.trim().toLowerCase());
    if (!rows.length || header.some((h, i) => got[i] !== h.toLowerCase())) {
      throw new CustomAPIError(422, 'UPL.HEADER_MISMATCH');
    }
    const data = rows.slice(1);
    if (!data.length) throw new CustomAPIError(422, 'UPL.NO_ROWS');
    const max = await this.limit(LIMITS.uploadMaxRows);
    if (data.length > max) throw new CustomAPIError(422, 'UPL.TOO_MANY_ROWS', { params: { max } });

    const types = await userTypesRepository.list(db, inst.id);
    const departments = await db
      .selectFrom('departments')
      .select(['public_id', 'user_type_id', 'name'])
      .where('institution_id', '=', inst.id)
      .execute();
    const [classes, sections] = await Promise.all([
      academicsRepository.classes(db, inst.id),
      academicsRepository.sections(db, inst.id),
    ]);
    const seenAdmission = new Map<string, number>();
    const seenMobile = new Map<string, number>();
    const report: RowReport[] = [];
    for (const [i, cells] of data.entries()) {
      const cell = (name: string) => (cells[header.indexOf(name)] ?? '').trim();
      const errors: { column: string; message: string }[] = [];
      const err = (column: string, code: MessageKey, params?: Record<string, string | number>) =>
        errors.push({ column, message: renderMessage(code, params) });
      const typeName = cell('User type');
      const ut = types.find(
        (t) => t.name.toLowerCase() === typeName.toLowerCase() && t.status === 'ACTIVE',
      );
      if (!ut) err('User type', 'IDN.USER_TYPE_UNKNOWN', { t: typeName || '—' });
      else if (ut.category === 'MERCHANT') err('User type', 'IDN.MERCHANT_NOT_HERE');
      else if (input.kind === 'STAFF' && !KIND_CATEGORIES.STAFF.includes(ut.category)) {
        err('User type', 'IDN.USER_TYPE_UNKNOWN', { t: typeName });
      } else if (input.kind === 'MEMBERS' && KIND_CATEGORIES.STAFF.includes(ut.category)) {
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
      if (input.kind === 'STAFF' && !depName) err('Department', 'VALIDATION.REQUIRED');
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
        const prev = seenMobile.get(mobile);
        if (prev !== undefined && input.kind === 'STAFF') err('Mobile', 'IDN.STAFF_MOBILE_TAKEN');
        seenMobile.set(mobile, i + 2);
      }
      const email = cell('E-mail');
      if (email && !EMAIL.test(email)) err('E-mail', 'VALIDATION.EMAIL');
      const joinedText = cell('Joining date');
      const joined = joinedText ? toDate(joinedText) : null;
      if (joinedText && !joined) err('Joining date', 'VALIDATION.DATE');
      if (mobile && MOBILE.test(mobile)) {
        const profiles = await repo.profilesOfMobile(db, mobile);
        if (profiles.some((x) => String(x.institution_id) !== String(inst.id))) {
          err('Mobile', 'IDN.MOBILE_IN_OTHER_INSTITUTION');
        }
      }
      const customRaw = Object.fromEntries(
        fields.map((f) => [f.id, cell(f.label)]).filter(([, v]) => v !== ''),
      );
      const cf = parseValues(fields, customRaw, { partial: false });
      for (const e of cf.errors) {
        const f = fields.find((x) => `customFields.${x.id}` === e.field);
        errors.push({
          column: f?.label ?? e.field,
          message: renderMessage(e.code as MessageKey, e.params ?? {}),
        });
      }

      let rowInput: OnboardInput | StaffInput | undefined;
      if (input.kind === 'STAFF') {
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
        if (employeeNo && (await repo.employeeTaken(db, inst.id, employeeNo))) {
          err('Employee ID', 'IDN.EMPLOYEE_NO_TAKEN', { n: employeeNo });
        }
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
          };
        }
      } else {
        const student = ut?.category === 'STUDENT';
        if (ut && !student && !mobile) err('Mobile', 'VALIDATION.REQUIRED');
        if (ut?.category === 'PARENT') err('User type', 'IDN.WARD_REQUIRED');
        let sectionId: string | null = null;
        let admissionNo: string | null = null;
        const guardians: NonNullable<OnboardInput['guardians']>[number][] = [];
        if (student) {
          admissionNo = cell('Admission number') || null;
          if (!admissionNo) err('Admission number', 'IDN.ADMISSION_NO_REQUIRED');
          else {
            const prev = seenAdmission.get(admissionNo.toLowerCase());
            if (prev !== undefined)
              err('Admission number', 'IDN.ADMISSION_NO_REPEATED', { n: admissionNo });
            seenAdmission.set(admissionNo.toLowerCase(), i + 2);
            if (await repo.admissionTaken(db, inst.id, admissionNo)) {
              err('Admission number', 'IDN.ADMISSION_NO_TAKEN', { n: admissionNo });
            }
          }
          const c = classes.find((x) => x.name.toLowerCase() === cell('Grade').toLowerCase());
          const s = c
            ? sections.find(
                (x) =>
                  String(x.class_id) === String(c.id) &&
                  x.name.toLowerCase() === cell('Section').toLowerCase(),
              )
            : undefined;
          if (!s) err(cell('Grade') && c ? 'Section' : 'Grade', 'VALIDATION.FORMAT');
          else sectionId = binToUuid(s.public_id);
          const pFirst = cell('Parent first name');
          const pMobile = cell('Parent mobile');
          if (pFirst || pMobile) {
            const relText = cell('Parent relation');
            const relation = RELATIONS[relText.toLowerCase()];
            if (!pFirst) err('Parent first name', 'VALIDATION.REQUIRED');
            if (!MOBILE.test(pMobile)) err('Parent mobile', 'VALIDATION.MOBILE');
            else if (
              (await repo.profilesOfMobile(db, pMobile)).some(
                (x) => String(x.institution_id) !== String(inst.id),
              )
            ) {
              err('Parent mobile', 'IDN.MOBILE_IN_OTHER_INSTITUTION');
            }
            if (!relation) err('Parent relation', 'VALIDATION.FORMAT');
            if (pFirst && MOBILE.test(pMobile) && relation) {
              guardians.push({
                firstName: pFirst,
                lastName: cell('Parent last name') || null,
                mobile: pMobile,
                relation,
              });
            }
          }
        }
        if (!errors.length && ut) {
          rowInput = {
            userTypeId: binToUuid(ut.public_id),
            departmentId: dep ? binToUuid(dep.public_id) : null,
            firstName: first,
            lastName: last || null,
            gender: gender ?? null,
            dateOfBirth: dob,
            mobile: mobile || null,
            email: email || null,
            joinedOn: joined,
            admissionNo,
            sectionId,
            guardians,
            customFields: customRaw,
          };
        }
      }
      report.push({
        row: i + 2,
        name: [first, last].filter(Boolean).join(' ') || '—',
        accepted: errors.length === 0,
        errors,
        ...(rowInput ? { input: rowInput } : {}),
      });
    }
    const accepted = report.filter((r) => r.accepted).length;
    const pub = newPublicIdPair();
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
    const staffMails: Parameters<MembersService['welcome']>[0][number][] = [];
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
      const rows = report.filter((r) => r.accepted && r.input);
      if (!rows.length) throw new CustomAPIError(422, 'UPL.NOTHING_ACCEPTED');
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
          } else {
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
    await this.deps.members.welcome(staffMails);
    return { created, skipped: (await this.status(p, uploadId)).rejected };
  }
}
