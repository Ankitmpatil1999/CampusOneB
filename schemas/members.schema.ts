/**
 * Member and academic-structure DTOs (IDN-044…059; ACA-001…003, ACA-009…013; prototype c.members,
 * c.onboard, c.search, c.structure).
 */
import { z } from 'zod';
import { PATTERNS } from '../utils/validators';

const required = (max: number) =>
  z
    .string({ message: 'VALIDATION.REQUIRED' })
    .trim()
    .min(1, { message: 'VALIDATION.REQUIRED' })
    .max(max, { message: 'VALIDATION.FORMAT' });
const optional = (max: number) =>
  z.string().trim().max(max, { message: 'VALIDATION.FORMAT' }).nullish();
const name = (max = 60) =>
  required(max).regex(/^[A-Za-z][A-Za-z .'-]*$/, { message: 'VALIDATION.FORMAT' });
const mobile = z
  .string({ message: 'VALIDATION.REQUIRED' })
  .regex(/^[6-9]\d{9}$/, { message: 'VALIDATION.MOBILE' });
const email = z
  .string()
  .trim()
  .max(254, { message: 'VALIDATION.EMAIL' })
  .regex(PATTERNS.email, { message: 'VALIDATION.EMAIL' });
const date = z.iso.date({ message: 'VALIDATION.DATE' });
const uuid = z.uuid({ message: 'VALIDATION.FORMAT' });
const gender = z.enum(['MALE', 'FEMALE', 'OTHER'], { message: 'VALIDATION.FORMAT' });
const relation = z.enum(['FATHER', 'MOTHER', 'GUARDIAN'], { message: 'VALIDATION.FORMAT' });
const reason = z
  .string({ message: 'VALIDATION.REQUIRED' })
  .trim()
  .min(1, { message: 'VALIDATION.REQUIRED' })
  .max(300, { message: 'VALIDATION.FORMAT' });
const customFields = z
  .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.null()]))
  .optional()
  .describe('Institution fields by field id (Dropdown / Multi-select values as option labels)');
const kind = z.enum(['STUDENTS', 'PARENTS', 'STAFF', 'MERCHANTS']);
const status = z.enum(['ACTIVE', 'INACTIVE', 'SUSPENDED']);

export const membersQuerySchema = z
  .object({
    kind: z.enum(['STUDENTS', 'PARENTS', 'STAFF', 'MERCHANTS', 'ALL']).optional(),
    q: z.string().trim().max(60).optional(),
    status: status.optional(),
    userTypeId: uuid.optional(),
    departmentId: uuid.optional(),
    classId: uuid.optional(),
    sectionId: uuid.optional(),
    cursor: z.string().max(400).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  .meta({ id: 'MembersQuery' });

const ref = z.object({ id: z.uuid(), name: z.string() });

export const memberListSchema = z
  .object({
    year: z.object({ id: z.uuid(), label: z.string() }).nullable(),
    columns: z.array(z.object({ id: z.uuid(), label: z.string() })),
    filters: z.array(z.object({ id: z.uuid(), label: z.string(), options: z.array(z.string()) })),
    counts: z.object({
      tabs: z.object({
        STUDENTS: z.number().int(),
        PARENTS: z.number().int(),
        STAFF: z.number().int(),
        MERCHANTS: z.number().int(),
        ALL: z.number().int(),
      }),
      statuses: z.object({
        ACTIVE: z.number().int(),
        INACTIVE: z.number().int(),
        SUSPENDED: z.number().int(),
      }),
    }),
    items: z.array(
      z.object({
        id: z.uuid(),
        memberNo: z.string(),
        name: z.string(),
        kind,
        userType: z.object({ id: z.uuid(), name: z.string(), category: z.string() }),
        department: ref.nullable(),
        admissionNo: z.string().nullable(),
        employeeNo: z.string().nullable(),
        grade: z.object({ class: z.string(), section: z.string().nullable() }).nullable(),
        mobile: z.string().nullable(),
        children: z
          .array(z.object({ id: z.uuid(), name: z.string(), grade: z.string().nullable() }))
          .optional(),
        relation: z.string().nullable().optional(),
        linked: z.boolean().describe('Linked to a RingPe account'),
        status,
        wallet: z
          .object({
            status: z.enum(['ACTIVE', 'INACTIVE', 'SUSPENDED']),
            balance: z.object({ amount: z.string(), currency: z.literal('INR') }),
          })
          .nullable()
          .describe('The campus (or merchant) wallet; balances are never cached'),
        pending: z.object({ suspension: z.boolean(), delink: z.boolean() }),
        customFields: z.record(z.string(), z.string()),
      }),
    ),
    nextCursor: z.string().nullable(),
  })
  .meta({ id: 'MemberList' });

export const memberDetailSchema = z
  .object({
    id: z.uuid(),
    memberNo: z.string(),
    name: z.string(),
    firstName: z.string(),
    lastName: z.string().nullable(),
    kind,
    userType: z.object({ id: z.uuid(), name: z.string(), category: z.string() }),
    department: ref.nullable(),
    gender: gender.nullable(),
    dateOfBirth: z.string().nullable(),
    admissionNo: z.string().nullable(),
    employeeNo: z.string().nullable(),
    joinedOn: z.string().nullable(),
    grade: z
      .object({
        class: z.string(),
        classId: z.uuid(),
        section: z.string().nullable(),
        sectionId: z.uuid(),
        year: z.string().nullable(),
      })
      .nullable(),
    contact: z.object({ mobile: z.string().nullable(), email: z.string().nullable() }),
    account: z.object({ linked: z.boolean(), mobileMasked: z.string().nullable() }),
    guardians: z.array(
      z.object({
        id: z.uuid(),
        name: z.string(),
        relation: z.string(),
        mobile: z.string().nullable(),
        primary: z.boolean(),
        status,
      }),
    ),
    wards: z.array(
      z.object({
        id: z.uuid(),
        name: z.string(),
        relation: z.string(),
        grade: z.string().nullable(),
        status,
      }),
    ),
    roles: z.array(z.object({ code: z.string(), name: z.string() })),
    status,
    statusReason: z.string().nullable(),
    statusChangedAt: z.iso.datetime().nullable(),
    transactionPermission: z
      .object({
        enabled: z.boolean(),
        reason: z.string().nullable(),
        changedAt: z.string().nullable(),
      })
      .describe('Payments on or off for the profile (BR-13, IDN-056)'),
    wallet: z
      .object({
        status: z.enum(['ACTIVE', 'INACTIVE', 'SUSPENDED']),
        balance: z.object({ amount: z.string(), currency: z.literal('INR') }),
      })
      .nullable()
      .describe('The campus (or merchant) wallet; balances are never cached'),
    pending: z.object({ suspension: z.boolean(), delink: z.boolean() }),
    customFields: z.array(
      z.object({
        id: z.uuid(),
        label: z.string(),
        type: z.string(),
        required: z.boolean(),
        unique: z.boolean(),
        options: z.array(z.string()),
        value: z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.null()]),
      }),
    ),
    transport: z
      .object({
        allocation: z
          .object({
            route: z.object({ code: z.string(), name: z.string(), type: z.string() }),
            stop: z.object({ name: z.string(), landmark: z.string().nullable() }),
            pickUp: z.string().nullable(),
            drop: z.string().nullable(),
            from: z.string().nullable(),
            to: z.string().nullable(),
          })
          .nullable(),
        trips: z.array(
          z.object({
            session: z.string(),
            direction: z.string(),
            startTime: z.string(),
            vehicle: z.object({ name: z.string(), registration: z.string() }),
            driver: z.object({ name: z.string(), mobile: z.string().nullable() }),
            attendant: z.string().nullable(),
          }),
        ),
      })
      .nullable()
      .describe(
        "A student's school transport: the allocation in force and today's trips on its route (client 2026-10-15); null for others",
      ),
    onboardedAt: z.iso.datetime(),
    lastChangedAt: z.iso.datetime().nullable(),
    version: z.number().int().describe('Send as If-Match "v<n>" to edit'),
    kindLabel: kind,
  })
  .meta({ id: 'MemberDetail' });

export const memberUpdateSchema = z
  .strictObject({
    departmentId: uuid.nullish(),
    email: email.nullish(),
    joinedOn: date.nullish(),
    sectionId: uuid.optional().describe('Grade and section for the current year (students)'),
    customFields,
  })
  .meta({ id: 'MemberUpdate' });

export const eligibilitySchema = z.strictObject({ mobile }).meta({ id: 'MemberEligibilityCheck' });

export const eligibilityResultSchema = z
  .object({
    eligible: z.boolean(),
    code: z.string().describe('Why: other institution, profile here, account exists, new person'),
    account: z.boolean(),
    profiles: z.array(
      z.object({
        id: z.uuid(),
        category: z.string(),
        name: z.string(),
        userType: z.string(),
        status,
      }),
    ),
  })
  .meta({ id: 'MemberEligibility' });

export const onboardSchema = z
  .strictObject({
    userTypeId: uuid,
    departmentId: uuid.nullish(),
    firstName: name(),
    lastName: name().nullish(),
    gender: gender.nullish(),
    dateOfBirth: date.nullish(),
    mobile: mobile.nullish(),
    email: email.nullish(),
    joinedOn: date.nullish(),
    admissionNo: optional(30),
    sectionId: uuid.nullish(),
    guardians: z
      .array(
        z.strictObject({
          memberId: uuid.optional(),
          firstName: name().optional(),
          lastName: name().nullish(),
          mobile: mobile.optional(),
          email: email.nullish(),
          relation,
        }),
      )
      .max(3)
      .optional(),
    wards: z.array(uuid).max(10).optional(),
    relation: relation.optional(),
    customFields,
  })
  .meta({ id: 'MemberOnboard' });

export const onboardResultSchema = z
  .object({ id: z.uuid(), memberNo: z.string(), guardians: z.array(z.uuid()) })
  .meta({ id: 'MemberOnboarded' });

export const staffSchema = z
  .strictObject({
    userTypeId: uuid,
    departmentId: uuid,
    firstName: name(),
    lastName: name().nullish(),
    gender,
    dateOfBirth: date,
    mobile,
    email,
    joinedOn: date,
    employeeNo: optional(30),
    customFields,
    roleId: uuid
      .nullish()
      .describe(
        'The console role given with the profile (client 2026-10-22; IDN-062): needs members.roles; not the Institution Administrator role; one that fits the user type',
      ),
  })
  .meta({ id: 'StaffOnboard' });

export const staffResultSchema = z
  .object({
    id: z.uuid(),
    memberNo: z.string(),
    employeeNo: z.string(),
    newAccount: z.boolean().describe('A RingPe account was created with a temporary password'),
    temporaryPassword: z
      .string()
      .optional()
      .describe(
        'Shown once (setting idn.staff.passwordShownOnce; never stored, not in a replay); changed at first sign-in',
      ),
    role: z.string().nullable().describe('The console role given, by name; null when none'),
  })
  .meta({ id: 'StaffOnboarded' });

export const statusChangeSchema = z
  .strictObject({ to: status, reason: reason.nullish() })
  .meta({ id: 'MemberStatusChange' });

export const statusResultSchema = z
  .object({
    status: status.nullable().describe('The new status; null when the change waits for a checker'),
    approvalId: z.uuid().nullable(),
  })
  .meta({ id: 'MemberStatusResult' });

export const delinkSchema = z.strictObject({ reason }).meta({ id: 'MemberDelink' });

export const sessionEndSchema = z.strictObject({ reason }).meta({ id: 'MemberSessionEnd' });

export const schoolRecordQuerySchema = z.object({
  for: uuid.optional().describe('A child’s profile on this account (a parent looking)'),
});

export const sessionEndResultSchema = z
  .object({
    ended: z.int().min(0).describe('App sessions ended (0 when the member was not signed in)'),
  })
  .meta({ id: 'MemberSessionEndResult' });

export const delinkResultSchema = z
  .object({ delinked: z.boolean(), approvalId: z.uuid().nullable() })
  .meta({ id: 'MemberDelinkResult' });

export const memberHistorySchema = z
  .object({
    items: z.array(
      z.object({
        action: z.string(),
        at: z.iso.datetime(),
        by: z.string(),
        before: z.unknown(),
        after: z.unknown(),
        reason: z.string().nullable(),
      }),
    ),
  })
  .meta({ id: 'MemberHistory' });

export const searchQuerySchema = z
  .object({ q: z.string().trim().max(60).default('') })
  .meta({ id: 'ConsoleSearchQuery' });

export const searchResultSchema = z
  .object({
    members: z.array(
      z.object({
        id: z.uuid(),
        memberNo: z.string(),
        name: z.string(),
        kind,
        userType: z.string(),
        detail: z.string(),
        number: z.string().nullable(),
        status,
      }),
    ),
    references: z.array(z.unknown()),
  })
  .meta({ id: 'ConsoleSearch' });

export const uploadKindSchema = z.enum(['MEMBERS', 'STAFF'], { message: 'VALIDATION.FORMAT' });

export const uploadSchema = z
  .object({
    kind: uploadKindSchema,
    file: z.string().describe('The filled-in template (CSV, at most 2 MB)'),
  })
  .meta({ id: 'MemberUpload' });

export const uploadResultSchema = z
  .object({
    id: z.uuid(),
    kind: uploadKindSchema,
    fileName: z.string(),
    status: z.enum(['VALIDATED', 'COMMITTED']),
    total: z.number().int(),
    accepted: z.number().int(),
    rejected: z.number().int(),
    committed: z.number().int().nullable(),
    rows: z.array(
      z.object({
        row: z.number().int(),
        name: z.string(),
        accepted: z.boolean(),
        errors: z.array(z.object({ column: z.string(), message: z.string() })),
      }),
    ),
  })
  .meta({ id: 'MemberUploadReport' });

export const commitSchema = z
  .strictObject({
    mode: z
      .enum(['ALL', 'ACCEPTED'], { message: 'VALIDATION.FORMAT' })
      .describe('ALL: only when no row was rejected; ACCEPTED: the accepted rows only'),
  })
  .meta({ id: 'MemberUploadCommit' });

export const commitResultSchema = z
  .object({
    created: z.number().int(),
    skipped: z.number().int(),
    passwords: z
      .array(
        z.object({
          name: z.string(),
          email: z.string(),
          employeeNo: z.string(),
          temporaryPassword: z.string(),
        }),
      )
      .optional()
      .describe('New staff accounts, shown once (setting idn.staff.passwordShownOnce)'),
  })
  .meta({ id: 'MemberUploadCommitted' });

// --- academic structure ------------------------------------------------------------------------------
export const yearsSchema = z
  .object({
    items: z.array(
      z.object({
        id: z.uuid(),
        label: z.string(),
        startsOn: z.string(),
        endsOn: z.string(),
        status: z.enum(['OPEN', 'CLOSED']),
        current: z.boolean(),
        version: z.number().int(),
      }),
    ),
  })
  .meta({ id: 'AcademicYears' });

export const yearSchema = yearsSchema.shape.items.element.meta({ id: 'AcademicYear' });

export const yearInputSchema = z
  .strictObject({
    label: required(9).regex(/^\d{4}-\d{2}$/, { message: 'VALIDATION.FORMAT' }),
    startsOn: date,
    endsOn: date,
  })
  .meta({ id: 'AcademicYearInput' });

export const yearActionSchema = z
  .strictObject({
    action: z.enum(['MAKE_CURRENT', 'CLOSE'], { message: 'VALIDATION.FORMAT' }),
    reason,
  })
  .meta({ id: 'AcademicYearAction' });

const sectionOut = z.object({
  id: z.uuid(),
  name: z.string(),
  capacity: z.number().int().nullable(),
  students: z.number().int().describe('Active students placed this year'),
});

export const classSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    order: z.number().int(),
    sections: z.array(sectionOut),
    students: z.number().int(),
    version: z.number().int(),
  })
  .meta({ id: 'Class' });

export const classesSchema = z
  .object({
    year: z.object({ id: z.uuid(), label: z.string() }).nullable(),
    items: z.array(classSchema),
  })
  .meta({ id: 'Classes' });

const sectionIn = z.strictObject({
  id: uuid.optional(),
  name: required(20),
  capacity: z.number().int().min(1).max(500).nullish(),
});

export const classInputSchema = z
  .strictObject({
    name: required(40),
    order: z.number().int().min(0).max(999).optional(),
    sections: z.array(sectionIn).max(30),
  })
  .meta({ id: 'ClassInput' });

export const classUpdateSchema = z
  .strictObject({
    name: required(40),
    order: z.number().int().min(0).max(999),
    sections: z.array(sectionIn).max(30),
  })
  .meta({ id: 'ClassUpdate' });

export const sectionInputSchema = z
  .strictObject({ name: required(20), capacity: z.number().int().min(1).max(500).nullish() })
  .meta({ id: 'SectionInput' });
