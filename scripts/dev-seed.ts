/**
 * DEVELOPMENT DATA ONLY — refused when NODE_ENV=production or APP_ENV is uat/prod.
 *
 * Creates the prototype's sample school and staff so the console and the back office can be signed
 * into before institutions (2.4) and members (2.5) exist: Tunga Valley Public School (Shivamogga)
 * with its administrator, accountant and management, and the platform operators. Idempotent:
 * existing rows (matched by e-mail or identifier) are kept and only missing links are added.
 *
 *   npm run seed:dev
 *
 * Passwords come from DEV_STAFF_PASSWORD / DEV_OPS_PASSWORD; without them the prototype's demo
 * passwords are used (local machines only).
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { openMigrationConnection } from '../db/mysql-executor';
import { createStorage } from '../integrations/storage.provider';
import { institutionIdentifier, nameAddressKey } from '../services/institutions.service';
import { loadFieldCipher } from '../utils/fieldEncryption';
import { istBusinessDate } from '../utils/format';
import { binToUuid, newPublicIdPair, uuidToBin } from '../utils/idGenerator';
import { hashSecret } from '../utils/password';
import { Kysely, MysqlDialect } from 'kysely';
import { createPool } from 'mysql2';
import { newQrToken } from '../config/registers';
import type { Database } from '../models/ringpe_models';
import { LedgerService } from '../services/ledger.service';
import { merchantCode } from '../services/merchants.service';
import { createFinancingPartner } from '../integrations/financing.provider';
import { CONSENT_TEMPLATE_VERSION } from '../services/fee-dues.service';
import { FeeRecordsService } from '../services/fee-records.service';
import { FeesService } from '../services/fees.service';
import { FinancingService } from '../services/financing.service';
import type { MembersService } from '../services/members.service';
import { PaymentEngine } from '../services/payment-engine.service';
import type { PaymentSecurityService } from '../services/payment-security.service';
import { SettingsService } from '../services/settings.service';
import { CustomAPIError } from '../utils/CustomAPIError';
import type { Principal } from '../utils/principal';

const nodeEnv = process.env['NODE_ENV'] ?? 'development';
const appEnv = process.env['APP_ENV'] ?? 'local';
if (nodeEnv === 'production' || appEnv === 'uat' || appEnv === 'prod') {
  console.error('seed:dev is refused outside local and development environments');
  process.exit(2);
}
const url = process.env['DB_MIGRATOR_URL'];
if (!url) {
  console.error('DB_MIGRATOR_URL is not set (see .env.example)');
  process.exit(2);
}
const staffPassword = process.env['DEV_STAFF_PASSWORD'] || 'Tvps@2026';
const opsPassword = process.env['DEV_OPS_PASSWORD'] || 'Ringpe@2026';
const memberPassword = process.env['DEV_MEMBER_PASSWORD'] || 'Member@2026';
const MEMBER_MOBILE = '9886110000';
const MERCHANT_MOBILE = '9886110001';

const SCHOOL = {
  identifier: 'RPETUNSHI000011026',
  name: 'Tunga Valley Public School',
  short: 'TVPS',
  board: 'CBSE',
  line1: "No. 27, 'Sahyadri', 3rd Main, Vinobanagar",
  city: 'Shivamogga',
  state: 'Karnataka',
  pin: '577204',
};
const TVPS_ADDRESS = '14, 2nd Cross, Vidyanagar, Shivamogga, Karnataka 577203';
const USER_TYPES = [
  ['Student', 'STUDENT'],
  ['Parent', 'PARENT'],
  ['Teacher', 'TEACHER'],
  ['Staff', 'STAFF'],
  ['Principal', 'PRINCIPAL'],
  ['Management', 'MANAGEMENT'],
  ['Merchant', 'MERCHANT'],
  ['Crew', 'CREW'],
  // Types the STAFF below use; on a fresh database they must exist before the staff profiles
  // (TVPS_USER_TYPES adds them again later with their departments — INSERT IGNORE keeps one row).
  ['Counsellor', 'STAFF'],
  ['Coordinator', 'STAFF'],
  ['Transport administrator', 'STAFF'],
] as const;
const STAFF = [
  {
    first: 'Prakash',
    last: 'Shetty',
    email: 'prakash.shetty@tvps.example.in',
    mobile: '9845011201',
    type: 'Staff',
    emp: 'EMP0001',
    role: 'INSTITUTION_ADMIN',
  },
  {
    first: 'Deepa',
    last: 'Nayak',
    email: 'accounts@tvps.example.in',
    mobile: '9845011202',
    type: 'Staff',
    emp: 'EMP0002',
    role: 'ACCOUNTANT',
  },
  {
    first: 'K.',
    last: 'Venkatesh',
    email: 'chairman@tvps.example.in',
    mobile: '9845011203',
    type: 'Management',
    emp: 'EMP0003',
    role: 'MANAGEMENT',
  },
  // One sample user for each remaining console role, to try each role's pages (client 2026-10-06).
  {
    first: 'Anitha',
    last: 'Rao',
    email: 'counsellor@tvps.example.in',
    mobile: '9845011204',
    type: 'Counsellor',
    emp: 'EMP0004',
    role: 'COUNSELLOR',
  },
  {
    first: 'Suresh',
    last: 'Bhat',
    email: 'coordinator@tvps.example.in',
    mobile: '9845011205',
    type: 'Coordinator',
    emp: 'EMP0005',
    role: 'ACADEMIC_COORDINATOR',
  },
  {
    first: 'Naveen',
    last: 'Gowda',
    email: 'transport@tvps.example.in',
    mobile: '9845011206',
    type: 'Transport administrator',
    emp: 'EMP0006',
    role: 'TRANSPORT_ADMIN',
  },
  {
    first: 'Meera',
    last: 'Kamath',
    email: 'grievances@tvps.example.in',
    mobile: '9845011207',
    type: 'Staff',
    emp: 'EMP0007',
    role: 'GRIEVANCE_OFFICER',
  },
  {
    first: 'Rajesh',
    last: 'Pai',
    email: 'frontdesk@tvps.example.in',
    mobile: '9845011208',
    type: 'Staff',
    emp: 'EMP0008',
    role: 'FRONT_DESK',
  },
] as const;
const OPERATORS = [
  {
    first: 'Arjun',
    last: 'Mehta',
    email: 'arjun@ringpe.example',
    mobile: '9845011301',
    role: 'PLATFORM_ADMIN',
  },
  {
    first: 'Priya',
    last: 'Sharma',
    email: 'priya@ringpe.example',
    mobile: '9845011302',
    role: 'SETTLEMENT_MAKER',
  },
  {
    first: 'Rahul',
    last: 'Verma',
    email: 'rahul@ringpe.example',
    mobile: '9845011303',
    role: 'SETTLEMENT_CHECKER',
  },
  {
    first: 'Ananya',
    last: 'Iyer',
    email: 'ananya@ringpe.example',
    mobile: '9845011304',
    role: 'RECON_OFFICER',
  },
  {
    first: 'Imran',
    last: 'Sheikh',
    email: 'imran@ringpe.example',
    mobile: '9845011305',
    role: 'LOG_ANALYST',
  },
  {
    first: 'Joseph',
    last: "D'Souza",
    email: 'joseph@ringpe.example',
    mobile: '9845011306',
    role: 'SUPPORT_OFFICER',
  },
] as const;

/** The prototype's user types and departments (c.roles), with the category that drives behaviour. */
const TVPS_USER_TYPES: readonly [string, string, readonly string[]][] = [
  ['Student', 'STUDENT', ['Primary', 'Middle school', 'Secondary', 'Senior secondary']],
  ['Parent', 'PARENT', ['Parents']],
  [
    'Teacher',
    'TEACHER',
    ['Primary', 'Middle school', 'Secondary', 'Senior secondary', 'Physical education'],
  ],
  [
    'Staff',
    'STAFF',
    ['Administration', 'Front office', 'Accounts', 'Housekeeping', 'Security', 'IT'],
  ],
  ['Merchant', 'MERCHANT', ['Canteen', 'Bookstore', 'Mess', 'Vendors', 'Institution']],
  ['Principal', 'PRINCIPAL', ['Academics']],
  ['Management', 'MANAGEMENT', ['Governing body']],
  ['Accounts', 'STAFF', ['Accounts']],
  ['Counsellor', 'STAFF', ['Admissions']],
  ['Coordinator', 'STAFF', ['Academics']],
  ['Transport administrator', 'STAFF', ['Transport']],
  ['Crew', 'CREW', ['Drivers', 'Attendants']],
  ['Non-teaching staff', 'STAFF', ['Front office', 'Library', 'Laboratory', 'Maintenance']],
];

interface DemoField {
  readonly entity: 'MEMBER' | 'FEE_STRUCTURE' | 'ADMISSION_APPLICATION' | 'MERCHANT';
  readonly label: string;
  readonly type: string;
  readonly options?: readonly string[];
  readonly required: boolean;
  readonly unique: boolean;
  readonly listColumn: boolean;
  readonly filter: boolean;
  readonly active: boolean;
  readonly by: 'admin' | 'accounts';
  readonly at: string;
}

/** The prototype's institution-defined fields for TVPS (c.fields seed). */
const TVPS_FIELDS: readonly DemoField[] = [
  {
    entity: 'MEMBER',
    label: 'House',
    type: 'DROPDOWN',
    options: ['Kaveri', 'Tunga', 'Bhadra', 'Sharavathi'],
    required: false,
    unique: false,
    listColumn: true,
    filter: true,
    active: true,
    by: 'admin',
    at: '2026-06-02T05:00:00Z',
  },
  {
    entity: 'MEMBER',
    label: 'Uses school transport',
    type: 'YES_NO',
    required: false,
    unique: false,
    listColumn: false,
    filter: true,
    active: true,
    by: 'admin',
    at: '2026-06-02T05:00:00Z',
  },
  {
    entity: 'MEMBER',
    label: 'Emergency contact (other than parents)',
    type: 'PHONE',
    required: false,
    unique: false,
    listColumn: false,
    filter: false,
    active: true,
    by: 'admin',
    at: '2026-06-02T05:00:00Z',
  },
  {
    entity: 'FEE_STRUCTURE',
    label: 'Concession category',
    type: 'DROPDOWN',
    options: ['None', 'Sibling', 'Staff ward', 'Merit scholarship'],
    required: true,
    unique: false,
    listColumn: true,
    filter: true,
    active: true,
    by: 'accounts',
    at: '2026-04-10T05:00:00Z',
  },
  {
    entity: 'FEE_STRUCTURE',
    label: 'Ledger code',
    type: 'TEXT',
    required: false,
    unique: true,
    listColumn: false,
    filter: false,
    active: true,
    by: 'accounts',
    at: '2026-04-10T05:00:00Z',
  },
  {
    entity: 'ADMISSION_APPLICATION',
    label: 'How did you hear about us?',
    type: 'DROPDOWN',
    options: ['Friends or family', 'School website', 'Newspaper', 'Social media', 'Other'],
    required: false,
    unique: false,
    listColumn: false,
    filter: true,
    active: true,
    by: 'admin',
    at: '2026-08-01T05:00:00Z',
  },
  {
    entity: 'ADMISSION_APPLICATION',
    label: 'Sibling studying here (admission number)',
    type: 'TEXT',
    required: false,
    unique: false,
    listColumn: true,
    filter: false,
    active: true,
    by: 'admin',
    at: '2026-08-01T05:00:00Z',
  },
  {
    entity: 'ADMISSION_APPLICATION',
    label: 'Interested in the hostel',
    type: 'YES_NO',
    required: false,
    unique: false,
    listColumn: false,
    filter: true,
    active: true,
    by: 'admin',
    at: '2026-08-01T05:00:00Z',
  },
  {
    entity: 'MERCHANT',
    label: 'FSSAI licence number',
    type: 'TEXT',
    required: false,
    unique: true,
    listColumn: true,
    filter: false,
    active: true,
    by: 'admin',
    at: '2025-11-03T05:00:00Z',
  },
  {
    entity: 'MEMBER',
    label: 'Previous roll number',
    type: 'NUMBER',
    required: false,
    unique: false,
    listColumn: false,
    filter: false,
    active: false,
    by: 'admin',
    at: '2025-06-01T05:00:00Z',
  },
];

const FEATURE_KEYS = [
  'tuition',
  'feeConsent',
  'nfc',
  'transfers',
  'coupons',
  'allowances',
  'events',
  'attendance',
  'transport',
  'quiz',
] as const;
const ALL_STEPS = [
  'details',
  'plan',
  'bank',
  'toggles',
  'usertypes',
  'year',
  'feeacct',
  'branding',
  'firstusers',
] as const;

interface DemoTenant {
  readonly name: string;
  readonly short: string;
  readonly city: string;
  readonly address: string;
  readonly board: string;
  readonly plan: string;
  readonly seq: number;
  readonly since: string;
  readonly status: 'ACTIVE' | 'PENDING_ACTIVATION' | 'SUSPENDED' | 'CANCELLED';
  readonly subscription?: 'TRIAL' | 'GRACE';
  readonly trialEnd?: string;
  readonly code: string | null;
  readonly pool: string | null;
  readonly primary: readonly [string, string, string];
  readonly secondary: readonly [string, string, string] | null;
  readonly off?: readonly string[];
  readonly whatsapp?: boolean;
  readonly steps?: readonly string[];
  readonly history: readonly [string, string, string | null, string | null, string][];
}

/** The prototype's other tenants (o.institutions), as demo data; no accounts sign in to them. */
const DEMO_TENANTS: readonly DemoTenant[] = [
  {
    name: 'Sahyadri Vidya Mandir',
    short: 'SVM',
    city: 'Sagar',
    board: 'State',
    plan: 'PL-PLUS',
    seq: 57,
    address: 'Jog Road, Keladi Circle, Sagar, Karnataka 577401',
    since: '2022-07-04',
    status: 'ACTIVE',
    code: 'RPSV',
    pool: 'POOLSVM0057',
    primary: ['Girija Hegde', 'principal@svm-sagar.example.in', '9448012077'],
    secondary: ['Mohan Rao', 'accounts@svm-sagar.example.in', '9448012078'],
    history: [
      [
        '2022-07-18T10:00:00Z',
        'ACTIVATED',
        'PENDING_ACTIVATION',
        'ACTIVE',
        'First annual invoice paid',
      ],
    ],
  },
  {
    name: 'Malnad International School',
    short: 'MIS',
    city: 'Chikkamagaluru',
    board: 'ICSE',
    plan: 'PL-PRO',
    seq: 71,
    address: 'Kadur Road, Hiremagaluru, Chikkamagaluru 577101',
    since: '2023-01-09',
    status: 'ACTIVE',
    code: 'RPMI',
    pool: 'POOLMIS0071',
    primary: ['Dr. Anand Gowda', 'director@malnadintl.example.in', '9483300110'],
    secondary: ['Shalini Pai', 'finance@malnadintl.example.in', '9483300112'],
    history: [
      [
        '2023-01-30T10:00:00Z',
        'ACTIVATED',
        'PENDING_ACTIVATION',
        'ACTIVE',
        'First annual invoice paid',
      ],
    ],
  },
  {
    name: 'Kaveri Heritage Academy',
    short: 'KHA',
    city: 'Mysuru',
    board: 'CBSE',
    plan: 'PL-ESS',
    seq: 96,
    address: 'Hunsur Road, Bogadi, Mysuru 570026',
    since: '2024-06-03',
    status: 'ACTIVE',
    code: 'RPKH',
    pool: 'POOLKHA0096',
    off: ['coupons', 'allowances', 'transport'],
    primary: ['Lalitha Urs', 'office@kaveriheritage.example.in', '9900456701'],
    secondary: ['Ravi Prasad', 'ravi.p@kaveriheritage.example.in', '9900456702'],
    history: [
      ['2024-06-14T10:00:00Z', 'ACTIVATED', 'PENDING_ACTIVATION', 'ACTIVE', 'First invoice paid'],
    ],
  },
  {
    name: 'Western Ghats Residential School',
    short: 'WGRS',
    city: 'Sirsi',
    board: 'CBSE',
    plan: 'PL-PRO',
    seq: 88,
    address: 'Yellapur Road, Sirsi, Uttara Kannada 581401',
    since: '2023-11-06',
    status: 'ACTIVE',
    subscription: 'GRACE',
    code: 'RPWG',
    pool: 'POOLWGRS0088',
    whatsapp: true,
    primary: ['Fr. Joseph Pinto', 'rector@wgrs.example.in', '9449801234'],
    secondary: ['Asha Naik', 'bursar@wgrs.example.in', '9449801235'],
    history: [
      [
        '2023-11-20T10:00:00Z',
        'ACTIVATED',
        'PENDING_ACTIVATION',
        'ACTIVE',
        'First annual invoice paid',
      ],
    ],
  },
  {
    name: 'Bhadra Valley PU College',
    short: 'BVPU',
    city: 'Bhadravati',
    board: 'State PU',
    plan: 'PL-PLUS',
    seq: 131,
    address: 'BH Road, New Town, Bhadravati 577301',
    since: '2026-09-10',
    status: 'ACTIVE',
    subscription: 'TRIAL',
    trialEnd: '2026-10-12',
    code: 'RPBV',
    pool: 'POOLBVPU0131',
    off: ['transport'],
    steps: ALL_STEPS.filter((s) => s !== 'branding'),
    primary: ['Prof. S. Manjunath', 'principal@bvpu.example.in', '9731100456'],
    secondary: ['Nayana K', 'office@bvpu.example.in', '9731100457'],
    history: [
      [
        '2026-09-12T09:00:00Z',
        'ACTIVATED',
        'PENDING_ACTIVATION',
        'ACTIVE',
        'Trial started on Campus Plus',
      ],
    ],
  },
  {
    name: 'Coastal Pearl School',
    short: 'CPS',
    city: 'Udupi',
    board: 'CBSE',
    plan: 'PL-PLUS',
    seq: 64,
    address: 'Manipal Road, Kunjibettu, Udupi 576102',
    since: '2022-06-06',
    status: 'SUSPENDED',
    code: 'RPCP',
    pool: 'POOLCPS0064',
    primary: ["Sr. Maria D'Costa", 'principal@coastalpearl.example.in', '9845554101'],
    secondary: ['Vijay Kamath', 'accounts@coastalpearl.example.in', '9845554102'],
    history: [
      [
        '2022-06-24T10:00:00Z',
        'ACTIVATED',
        'PENDING_ACTIVATION',
        'ACTIVE',
        'First annual invoice paid',
      ],
      [
        '2026-09-18T04:30:00Z',
        'SUSPENDED',
        'ACTIVE',
        'SUSPENDED',
        'Invoice unpaid after the grace period',
      ],
    ],
  },
  {
    name: 'Hampi Heritage School',
    short: 'HHS',
    city: 'Hosapete',
    board: 'State',
    plan: 'PL-ESS',
    seq: 134,
    address: 'Station Road, Hosapete, Vijayanagara 583201',
    since: '2026-09-24',
    status: 'PENDING_ACTIVATION',
    code: null,
    pool: null,
    off: ['coupons', 'allowances', 'transport'],
    steps: ['details', 'plan', 'toggles', 'usertypes', 'year'],
    primary: ['Basavaraj Patil', 'secretary@hampiheritage.example.in', '9880771020'],
    secondary: null,
    history: [],
  },
  {
    name: 'Nandi Hills Public School',
    short: 'NHPS',
    city: 'Chikkaballapur',
    board: 'CBSE',
    plan: 'PL-ESS',
    seq: 98,
    address: 'Nandi Road, Chikkaballapur 562101',
    since: '2024-06-10',
    status: 'CANCELLED',
    code: 'RPNH',
    pool: 'POOLNHPS0098',
    off: ['coupons', 'allowances', 'transport'],
    primary: ['H. Narayanaswamy', 'trust@nandihills.example.in', '9845220011'],
    secondary: null,
    history: [
      ['2024-06-28T10:00:00Z', 'ACTIVATED', 'PENDING_ACTIVATION', 'ACTIVE', 'First invoice paid'],
      ['2026-08-31T12:00:00Z', 'CANCELLED', 'ACTIVE', 'CANCELLED', 'The trust closed the school'],
    ],
  },
];

const conn = await openMigrationConnection(url);
const one = async <T>(q: string, p: readonly unknown[] = []) =>
  (await conn.query<T>(q, p))[0] as T | undefined;
/** The row id of a member profile just inserted, by its public id (the connection returns no insertId). */
const insertedId = async (publicId: Buffer, _inserted?: unknown) => {
  const r = await one<{ id: number }>('SELECT id FROM member_profiles WHERE public_id = ?', [
    publicId,
  ]);
  if (!r) throw new Error('member profile not inserted');
  return r.id;
};

/**
 * Every school gets its current academic year, as registration does (`institutions.service`) and as
 * migration 0020 did for schools that existed then — the seed inserts its schools directly.
 */
async function ensureCurrentYears() {
  await conn.query(
    `INSERT INTO academic_years (public_id, institution_id, label, starts_on, ends_on, status, is_current)
     SELECT UUID_TO_BIN(UUID()), i.id,
            CONCAT(y.start_year, '-', LPAD(MOD(y.start_year + 1, 100), 2, '0')),
            MAKEDATE(y.start_year, 1) + INTERVAL 3 MONTH,
            MAKEDATE(y.start_year + 1, 1) + INTERVAL 3 MONTH - INTERVAL 1 DAY,
            'OPEN', TRUE
       FROM institutions i
       JOIN (SELECT IF(MONTH(UTC_DATE()) >= 4, YEAR(UTC_DATE()), YEAR(UTC_DATE()) - 1) AS start_year) y
      WHERE NOT EXISTS (SELECT 1 FROM academic_years a WHERE a.institution_id = i.id)`,
  );
}

/**
 * Subscriptions and invoices (2.7) as the prototype shows them: running tenants have a period that
 * renews on 1 April (annual plans) or on the 1st of next month (monthly plans); TVPS has last year's
 * renewal paid by NEFT and an SMS overage invoice due. Rows that exist are left alone.
 */
/** The prototype's grades (S.classes): sections A and B, Science and Commerce for Grades 11–12. */
const GRADES = ['Nursery', 'LKG', 'UKG', ...Array.from({ length: 12 }, (_, i) => `Grade ${i + 1}`)];
const FIRST_M = [
  'Aarav',
  'Vihaan',
  'Aditya',
  'Arjun',
  'Rohan',
  'Karthik',
  'Pranav',
  'Siddharth',
  'Nikhil',
  'Rahul',
  'Varun',
  'Kiran',
  'Harsha',
  'Tejas',
  'Shreyas',
  'Akash',
  'Dhruv',
  'Ishaan',
  'Yash',
  'Samarth',
  'Chirag',
  'Abhay',
  'Naveen',
  'Gautham',
];
const FIRST_F = [
  'Ananya',
  'Anika',
  'Diya',
  'Isha',
  'Kavya',
  'Meera',
  'Nisha',
  'Pooja',
  'Riya',
  'Sneha',
  'Tanvi',
  'Aditi',
  'Bhavana',
  'Chaitra',
  'Deepika',
  'Harini',
  'Keerthi',
  'Manasa',
  'Navya',
  'Pallavi',
  'Rashmi',
  'Sahana',
  'Shreya',
  'Varsha',
];
const FATHERS = [
  'Mahesh',
  'Suresh',
  'Ramesh',
  'Ganesh',
  'Prakash',
  'Vinay',
  'Sunil',
  'Anand',
  'Ravi',
  'Manjunath',
  'Srinivas',
  'Raghavendra',
];
const LAST = [
  'Hegde',
  'Rao',
  'Shetty',
  'Bhat',
  'Kulkarni',
  'Nayak',
  'Gowda',
  'Kamath',
  'Pai',
  'Shenoy',
  'Acharya',
  'Joshi',
  'Kini',
  'Naik',
  'Prabhu',
  'Patil',
  'Desai',
  'Iyer',
  'Menon',
  'Reddy',
];

/**
 * Members (2.5) as the prototype shows them: the grades and sections, three students a grade with
 * their fathers as parents (siblings share a parent), admission numbers like TVPS/2019/0412. Rows
 * that exist are left alone.
 */
async function membersSetup(tvpsId: string) {
  const year = await one<{ id: number }>(
    'SELECT id FROM academic_years WHERE institution_id = ? AND is_current = TRUE',
    [tvpsId],
  );
  if (!year) return;
  for (const [i, name] of GRADES.entries()) {
    await conn.query(
      `INSERT IGNORE INTO classes (public_id, institution_id, name, sort_order) VALUES (?, ?, ?, ?)`,
      [newPublicIdPair().bin, tvpsId, name, i],
    );
    const cls = await one<{ id: number }>(
      'SELECT id FROM classes WHERE institution_id = ? AND name = ?',
      [tvpsId, name],
    );
    for (const sec of i >= 13 ? ['Science', 'Commerce'] : ['A', 'B']) {
      await conn.query(
        `INSERT IGNORE INTO sections (public_id, institution_id, class_id, name) VALUES (?, ?, ?, ?)`,
        [newPublicIdPair().bin, tvpsId, cls?.id, sec],
      );
    }
  }
  const type = async (name: string) =>
    (
      await one<{ id: number }>('SELECT id FROM user_types WHERE institution_id = ? AND name = ?', [
        tvpsId,
        name,
      ])
    )?.id;
  const dept = async (ut: number | undefined, name: string) =>
    (
      await one<{ id: number }>('SELECT id FROM departments WHERE user_type_id = ? AND name = ?', [
        ut,
        name,
      ])
    )?.id ?? null;
  const studentType = await type('Student');
  const parentType = await type('Parent');
  if (!studentType || !parentType) return;
  const parentDept = await dept(parentType, 'Parents');
  let n = 0;
  for (const [g, grade] of GRADES.entries()) {
    const cls = await one<{ id: number }>(
      'SELECT id FROM classes WHERE institution_id = ? AND name = ?',
      [tvpsId, grade],
    );
    const secs = await conn.query<{ id: number; name: string }>(
      'SELECT id, name FROM sections WHERE class_id = ? ORDER BY name',
      [cls?.id],
    );
    const sections = secs as unknown as { id: number; name: string }[];
    const deptName =
      g <= 7 ? 'Primary' : g <= 10 ? 'Middle school' : g <= 12 ? 'Secondary' : 'Senior secondary';
    const studentDept = await dept(studentType, deptName);
    for (let k = 0; k < 3; k++, n++) {
      const girl = (n + k) % 2 === 1;
      const first = girl ? FIRST_F[n % FIRST_F.length]! : FIRST_M[n % FIRST_M.length]!;
      // Every fourth child is the younger sibling of the previous family (one shared parent).
      const family = n % 4 === 3 ? n - 1 : n;
      const last = LAST[family % LAST.length]!;
      const joinYear = 2026 - Math.min(g, 9);
      const admissionNo = `TVPS/${joinYear}/${String(400 + n * 7).padStart(4, '0')}`;
      const exists = await one<{ id: number }>(
        'SELECT id FROM member_profiles WHERE institution_id = ? AND admission_no = ?',
        [tvpsId, admissionNo],
      );
      const age = 3 + g;
      const dob = `${2026 - age}-${String((n % 12) + 1).padStart(2, '0')}-${String((n % 27) + 1).padStart(2, '0')}`;
      const studentPub = newPublicIdPair().bin;
      const studentId =
        exists?.id ??
        (await insertedId(
          studentPub,
          await conn.query(
            `INSERT INTO member_profiles (public_id, institution_id, user_type_id, department_id, first_name, last_name, gender, date_of_birth, admission_no, joined_on, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE')`,
            [
              studentPub,
              tvpsId,
              studentType,
              studentDept,
              first,
              last,
              girl ? 'FEMALE' : 'MALE',
              dob,
              admissionNo,
              `${joinYear}-06-01`,
            ],
          ),
        ));

      await conn.query(
        'INSERT IGNORE INTO enrolments (institution_id, student_profile_id, year_id, section_id) VALUES (?, ?, ?, ?)',
        [tvpsId, studentId, year.id, sections[k % sections.length]?.id],
      );
      const mobile = `98861${String(10000 + family).slice(-5)}`;
      // The parent's own profile: children linked to the parent's account share the number.
      let parent = await one<{ id: number }>(
        'SELECT id FROM member_profiles WHERE institution_id = ? AND contact_mobile = ? AND user_type_id = ?',
        [tvpsId, mobile, parentType],
      );
      if (!parent) {
        const parentPub = newPublicIdPair().bin;
        await conn.query(
          `INSERT INTO member_profiles (public_id, institution_id, user_type_id, department_id, first_name, last_name, gender, contact_mobile, joined_on, status)
           VALUES (?, ?, ?, ?, ?, ?, 'MALE', ?, ?, 'ACTIVE')`,
          [
            parentPub,
            tvpsId,
            parentType,
            parentDept,
            FATHERS[family % FATHERS.length],
            last,
            mobile,
            `${joinYear}-06-01`,
          ],
        );
        parent = { id: await insertedId(parentPub) };
      }
      await conn.query(
        `INSERT INTO guardianships (institution_id, guardian_profile_id, ward_profile_id, relation, is_primary_contact) VALUES (?, ?, ?, 'FATHER', TRUE) ON DUPLICATE KEY UPDATE relation = relation`,
        [tvpsId, parent.id, studentId],
      );
    }
  }
}

async function billingSetup(tvpsId: string) {
  const today = new Date().toISOString().slice(0, 10);
  const year = Number(today.slice(0, 4)) - (Number(today.slice(5, 7)) < 4 ? 1 : 0);
  const month = today.slice(0, 7);
  const nextMonth = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 1))
    .toISOString()
    .slice(0, 10);
  const lastOfMonth = new Date(Date.parse(`${nextMonth}T00:00:00Z`) - 86_400_000)
    .toISOString()
    .slice(0, 10);
  // Running subscriptions get their period; others follow the institution's status.
  await conn.query(
    `UPDATE subscriptions s
       JOIN institutions i ON i.id = s.institution_id
       JOIN plan_versions v ON v.id = s.plan_version_id
        SET s.status = COALESCE(s.status, CASE i.status WHEN 'ACTIVE' THEN 'ACTIVE'
              WHEN 'SUSPENDED' THEN 'SUSPENDED' WHEN 'CANCELLED' THEN 'CANCELLED' END),
            s.current_period_start_on = IF(v.cycle = 'ANNUAL', ?, ?),
            s.current_period_end_on = IF(v.cycle = 'ANNUAL', ?, ?),
            s.renews_on = IF(v.cycle = 'ANNUAL', ?, ?)
      WHERE i.status <> 'PENDING_ACTIVATION' AND s.renews_on IS NULL
        AND (s.status IS NULL OR s.status <> 'TRIAL')`,
    [
      `${year}-04-01`,
      `${month}-01`,
      `${year + 1}-03-31`,
      lastOfMonth,
      `${year + 1}-04-01`,
      nextMonth,
    ],
  );
  const plus = await one<{ price_paise: number }>(
    `SELECT v.price_paise FROM plans p JOIN plan_versions v ON v.id = p.current_version_id
      WHERE p.code = 'PL-PLUS'`,
  );
  const price = Number(plus?.price_paise ?? 18_000_000);
  const tax = (paise: number) => Math.floor((paise * 1800 + 5000) / 10000);
  const add = (d: string, n: number) =>
    new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
  const invoices = [
    {
      trigger: 'RENEWAL',
      key: `${year}-04-01`,
      label: `01 Apr ${year} – 31 Mar ${year + 1}`,
      from: `${year}-04-01`,
      to: `${year + 1}-03-31`,
      line: 'Campus Plus · annual · renewal',
      qty: 1,
      unit: price,
      issued: `${year}-03-17`,
      paid: { on: `${year}-03-28`, utr: 'SBIN826087731' },
    },
    {
      trigger: 'USAGE_OVERAGE',
      key: add(today, -35).slice(0, 7),
      label: new Intl.DateTimeFormat('en-GB', {
        month: 'short',
        year: 'numeric',
        timeZone: 'UTC',
      }).format(new Date(`${add(today, -35).slice(0, 7)}-01T00:00:00Z`)),
      from: null,
      to: null,
      line: '1,240 SMS above allowance × ₹0.25',
      qty: 1240,
      unit: 25,
      issued: add(today, -5),
      paid: null,
    },
  ];
  for (const v of invoices) {
    const amount = v.qty * v.unit;
    await conn.query(
      `INSERT IGNORE INTO invoices (public_id, institution_id, invoice_no, trigger_kind, period_key,
         period_label, period_from_on, period_to_on, amount_paise, tax_bp, tax_paise, total_paise,
         issued_on, due_on, grace_until_on, status, paid_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1800, ?, ?, ?, ?, ?, ?, ?)`,
      [
        newPublicIdPair().bin,
        tvpsId,
        `TMP-${randomUUID().slice(0, 12)}`,
        v.trigger,
        v.key,
        v.label,
        v.from,
        v.to,
        amount,
        tax(amount),
        amount + tax(amount),
        v.issued,
        add(v.issued, 15),
        add(v.issued, 29),
        v.paid ? 'PAID' : 'DUE',
        v.paid ? `${v.paid.on} 06:30:00.000` : null,
      ],
    );
    // Numbered like the API (INV-YYYY-NNNNN by id), with its line and payment — also on a re-run.
    const row = await one<{ id: number }>(
      'SELECT id FROM invoices WHERE institution_id = ? AND trigger_kind = ? AND period_key = ?',
      [tvpsId, v.trigger, v.key],
    );
    if (!row) continue;
    await conn.query(
      `UPDATE invoices SET invoice_no = CONCAT('INV-', YEAR(issued_on), '-', LPAD(id, 5, '0')), period_label = ?
        WHERE id = ? AND invoice_no LIKE 'TMP-%'`,
      [v.label, row.id],
    );
    if (!(await one('SELECT id FROM invoice_lines WHERE invoice_id = ? LIMIT 1', [row.id]))) {
      await conn.query(
        `INSERT INTO invoice_lines (institution_id, invoice_id, description, quantity, unit_price_paise, amount_paise)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [tvpsId, row.id, v.line, v.qty, v.unit, amount],
      );
    }
    if (v.paid) {
      await conn.query(
        `INSERT IGNORE INTO invoice_payments (public_id, institution_id, invoice_id, method, utr, amount_paise, paid_on)
         VALUES (?, ?, ?, 'BANK_TRANSFER', ?, ?, ?)`,
        [newPublicIdPair().bin, tvpsId, row.id, v.paid.utr, amount + tax(amount), v.paid.on],
      );
    }
  }
}

/**
 * Approvals (2.6): a parent with a RingPe account asks for a date-of-birth correction with a
 * certificate attached; it waits in TVPS's queue and the administrator's bell shows it. Created once.
 */
async function approvalsSetup(tvpsId: string) {
  const mobile = MEMBER_MOBILE;
  const exists = await one<{ id: number }>(
    `SELECT a.id FROM approval_requests a JOIN platform_accounts p ON p.public_id = a.maker_ref
     WHERE a.institution_id = ? AND p.mobile = ?`,
    [tvpsId, mobile],
  );
  if (exists) return;
  const parent = await one<{ id: number; first_name: string; last_name: string }>(
    'SELECT id, first_name, last_name FROM member_profiles WHERE institution_id = ? AND contact_mobile = ? ORDER BY id LIMIT 1',
    [tvpsId, mobile],
  );
  if (!parent) return;
  const acc = newPublicIdPair();
  await conn.query(
    `INSERT IGNORE INTO platform_accounts (public_id, mobile, email, first_name, last_name, gender, dob)
     VALUES (?, ?, ?, ?, ?, 'MALE', '1984-02-11')`,
    [
      acc.bin,
      mobile,
      'mahesh.hegde@example.in',
      parent.first_name.toUpperCase(),
      parent.last_name.toUpperCase(),
    ],
  );
  const account = await one<{ id: number; public_id: Buffer }>(
    'SELECT id, public_id FROM platform_accounts WHERE mobile = ?',
    [mobile],
  );
  if (!account) return;
  await conn.query(
    'UPDATE member_profiles SET account_id = ? WHERE contact_mobile = ? AND account_id IS NULL',
    [account.id, mobile],
  );
  const accountUuid = binToUuid(account.public_id);

  // The certificate (a one-page sample PDF) in the local file store.
  const pdf = Buffer.from(
    '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
  );
  const file = newPublicIdPair();
  const objectKey = `account-${accountUuid}/evidence/2026-10/${file.id}`;
  await createStorage('local', process.env['UPLOAD_DIR'] ?? 'uploads').put(objectKey, pdf);
  await conn.query(
    `INSERT INTO files (public_id, institution_id, purpose, object_key, original_name, mime_type, size_bytes, sha256, scan_status, created_by)
     VALUES (?, NULL, 'evidence', ?, 'birth-certificate.pdf', 'application/pdf', ?, ?, 'CLEAN', ?)`,
    [
      file.bin,
      objectKey,
      pdf.length,
      createHash('sha256').update(pdf).digest('hex'),
      account.public_id,
    ],
  );
  const fileRow = await one<{ id: number }>('SELECT id FROM files WHERE public_id = ?', [file.bin]);

  const approval = newPublicIdPair();
  const correction = newPublicIdPair();
  const name = `${parent.first_name} ${parent.last_name}`;
  const summary = `Date of birth for ${name}: 11 Feb 1984 → 21 Feb 1984 (member request)`;
  await conn.query(
    `INSERT INTO approval_requests (public_id, institution_id, module, action, summary, subject_type, subject_ref, payload, maker_type, maker_ref, created_at, updated_at)
     VALUES (?, ?, 'PII_CORRECTION', 'UPDATE', ?, 'account', ?, ?, 'member', ?, UTC_TIMESTAMP(3) - INTERVAL 3 HOUR, UTC_TIMESTAMP(3) - INTERVAL 3 HOUR)`,
    [
      approval.bin,
      tvpsId,
      summary,
      account.public_id,
      JSON.stringify({ correction: correction.id, field: 'DOB' }),
      account.public_id,
    ],
  );
  const req = await one<{ id: number; request_seq: number }>(
    'SELECT id, request_seq FROM approval_requests WHERE public_id = ?',
    [approval.bin],
  );
  const cipher = await loadFieldCipher(process.env['FIELD_KEYS_FILE'] ?? 'keys/field-keys.json');
  await conn.query(
    `INSERT INTO pii_correction_requests (public_id, account_id, institution_id, field, current_masked, proposed_enc, reason, evidence_file_id, approval_request_id)
     VALUES (?, ?, ?, 'DOB', '11 Feb 1984', ?, ?, ?, ?)`,
    [
      correction.bin,
      account.id,
      tvpsId,
      cipher.encrypt(
        'pii_correction',
        '1984-02-21',
        `pii_correction_requests.proposed:${correction.id}`,
      ),
      'My birth certificate shows 21 February; the date was mistyped at sign-up',
      fileRow?.id,
      req?.id,
    ],
  );
  // The administrator's bell.
  const admins = (await conn.query<{ account_id: number }>(
    `SELECT DISTINCT m.account_id FROM profile_roles pr JOIN roles r ON r.id = pr.role_id
     JOIN member_profiles m ON m.id = pr.profile_id
     WHERE pr.institution_id = ? AND r.code = 'INSTITUTION_ADMIN' AND m.account_id IS NOT NULL`,
    [tvpsId],
  )) as unknown as { account_id: number }[];
  const no = `APR-${String(req?.request_seq ?? 1).padStart(4, '0')}`;
  for (const a of admins) {
    await conn.query(
      `INSERT INTO notifications (created_on, public_id, institution_id, account_id, surface, category, title_key, params, body, link)
       VALUES (UTC_DATE(), ?, ?, ?, 'CONSOLE', 'APPROVAL', 'NTF.APPROVAL_RAISED', ?, ?, ?)`,
      [
        newPublicIdPair().bin,
        tvpsId,
        a.account_id,
        JSON.stringify({ no }),
        summary,
        `/console/approvals?open=${approval.id}`,
      ],
    );
  }
}

/**
 * Payments (3.3): the canteen, the book corner and a lab vendor with their payment QR codes; the
 * canteen also takes dynamic QR and has an app login (MERCHANT_MOBILE); the sample parent's family
 * wallets get one development top-up (an ADJUSTMENT posting keyed per wallet, so a re-run adds
 * nothing). Development data only — refused in production with the rest of this script.
 */
async function paymentsSetup(tvpsId: string, institutionName: string) {
  const type = await one<{ id: string }>(
    "SELECT id FROM user_types WHERE institution_id = ? AND category = 'MERCHANT' ORDER BY id LIMIT 1",
    [tvpsId],
  );
  if (!type) return;
  const cipher = await loadFieldCipher(process.env['FIELD_KEYS_FILE'] ?? 'keys/field-keys.json');
  const merchants = [
    [
      'Campus Canteen',
      'REGULAR',
      'Canteen',
      'Ravi',
      'Kumar',
      MERCHANT_MOBILE,
      '123456781234',
      'SBIN0001234',
      true,
    ],
    [
      'Book Corner',
      'REGULAR',
      'Bookstore',
      'Lata',
      'Shenoy',
      '9886110002',
      '223344556677',
      'CNRB0004521',
      false,
    ],
    [
      'Lab Supplies Co',
      'VENDOR',
      'Vendors',
      'Imran',
      'Pasha',
      '9886110003',
      '998877665544',
      'HDFC0000123',
      false,
    ],
  ] as const;
  for (const [name, subType, dept, first, last, mobile, acct, ifsc, dynamic] of merchants) {
    const exists = await one<{ profile_id: string }>(
      'SELECT profile_id FROM merchants WHERE institution_id = ? AND display_name = ?',
      [tvpsId, name],
    );
    if (exists) continue;
    const d = await one<{ id: string }>(
      'SELECT id FROM departments WHERE user_type_id = ? AND name = ?',
      [type.id, dept],
    );
    const pub = newPublicIdPair();
    await conn.query(
      `INSERT INTO member_profiles (public_id, institution_id, user_type_id, department_id, first_name,
         last_name, contact_mobile, contact_email, joined_on, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, '2026-06-01', 'ACTIVE')`,
      [
        pub.bin,
        tvpsId,
        type.id,
        d?.id ?? null,
        first.toUpperCase(),
        last.toUpperCase(),
        mobile,
        `${name.toLowerCase().replace(/[^a-z]+/g, '.')}@tvps.example.in`,
      ],
    );
    const p = (await one<{ id: string }>('SELECT id FROM member_profiles WHERE public_id = ?', [
      pub.bin,
    ]))!;
    await conn.query(
      `INSERT INTO merchants (profile_id, institution_id, unique_id, display_name, sub_type, holder_name,
         bank_name, acct_enc, acct_bidx, acct_last4, ifsc, accepts_allowance, accepts_coupon,
         dynamic_qr_enabled)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
      [
        p.id,
        tvpsId,
        merchantCode(name, institutionName, String(p.id), new Date('2026-06-01T06:30:00Z')),
        name,
        subType,
        `${first} ${last}`.toUpperCase(),
        cipher.encrypt('bank_acct', acct, `merchants.acct:${pub.id}`),
        cipher.blindIndex('bank_acct', acct),
        acct.slice(-4),
        ifsc,
        subType === 'REGULAR',
        subType === 'REGULAR',
        dynamic,
      ],
    );
    await conn.query(
      `INSERT INTO merchant_qr_codes (public_id, institution_id, merchant_profile_id, kind, token)
       VALUES (?, ?, ?, 'PAYMENT', ?)`,
      [newPublicIdPair().bin, tvpsId, p.id, newQrToken()],
    );
  }

  // The canteen's app login: the counter phone signs in with the mobile and the member password.
  const canteen = await one<{ id: string; account_id: string | null }>(
    `SELECT m.id, m.account_id FROM member_profiles m JOIN merchants mer ON mer.profile_id = m.id
      WHERE m.institution_id = ? AND mer.display_name = 'Campus Canteen'`,
    [tvpsId],
  );
  if (canteen && !canteen.account_id) {
    await conn.query(
      `INSERT IGNORE INTO platform_accounts (public_id, mobile, email, first_name, last_name, status)
       VALUES (?, ?, 'canteen@tvps.example.in', 'RAVI', 'KUMAR', 'ACTIVE')`,
      [newPublicIdPair().bin, MERCHANT_MOBILE],
    );
    const acc = (await one<{ id: string }>('SELECT id FROM platform_accounts WHERE mobile = ?', [
      MERCHANT_MOBILE,
    ]))!;
    await conn.query('UPDATE member_profiles SET account_id = ? WHERE id = ?', [
      acc.id,
      canteen.id,
    ]);
    await conn.query(
      `INSERT IGNORE INTO account_credentials (account_id, kind, hash) VALUES (?, 'PASSWORD', ?)`,
      [acc.id, await hashSecret(memberPassword)],
    );
  }

  // Development top-ups: the parent's family wallets start with money to spend (once per wallet).
  const db = new Kysely<Database>({
    dialect: new MysqlDialect({
      pool: createPool({
        uri: url!,
        supportBigNumbers: true,
        bigNumberStrings: true,
        timezone: 'Z',
      }),
    }),
  });
  try {
    const wallets = await db
      .selectFrom('wallets as w')
      .innerJoin('member_profiles as m', 'm.id', 'w.owner_profile_id')
      .select(['w.id', 'm.first_name'])
      .where('m.institution_id', '=', tvpsId)
      .where('m.contact_mobile', '=', MEMBER_MOBILE)
      .where('w.kind', '=', 'CAMPUS')
      .execute();
    const ledger = new LedgerService();
    for (const w of wallets) {
      await db.transaction().execute((trx) =>
        ledger.post(trx, {
          institutionId: tvpsId,
          type: 'ADJUSTMENT',
          channel: 'BACK_OFFICE',
          amountPaise: 150_000,
          idempotencyKey: `DEV-TOPUP:${w.id}`,
          debit: { account: 'ADJUSTMENT', institutionId: tvpsId },
          credit: { walletId: String(w.id) },
          narration: 'Development top-up',
        }),
      );
    }
  } finally {
    await db.destroy();
  }
}

/**
 * Allowances (4.3) as the prototype shows them: the feature on, an allowance QR for the regular
 * merchants that accept allowances, this month's allowance credited to the parent's children and
 * twenty other students (₹500, 3 payments and ₹200 a day), and next month's scheduled for a few.
 * Development only: the credit is posted directly (the 00:05 job does it in a real school), once
 * per grant (DEV-ALW-CREDIT:<grant>), so a re-run changes nothing.
 */
/**
 * The parent's children without a phone sit on the parent's account under the parent's number
 * (BR-02, CR-04), so the app's profile switcher shows them (as members.service does when a child is
 * onboarded with a guardian). Only wards with no account of their own are linked.
 */
async function familySetup(tvpsId: string) {
  const parent = await one<{ account_id: string; id: string }>(
    `SELECT m.account_id, m.id FROM member_profiles m
      WHERE m.institution_id = ? AND m.contact_mobile = ? AND m.account_id IS NOT NULL
      ORDER BY m.id LIMIT 1`,
    [tvpsId, MEMBER_MOBILE],
  );
  if (!parent) return;
  await conn.query(
    `UPDATE member_profiles w
       JOIN guardianships g ON g.ward_profile_id = w.id
        SET w.account_id = ?, w.contact_mobile = ?
      WHERE g.guardian_profile_id = ? AND w.account_id IS NULL`,
    [parent.account_id, MEMBER_MOBILE, parent.id],
  );
}

async function allowancesSetup(tvpsId: string) {
  await conn.query(
    `INSERT INTO feature_toggles (institution_id, feature_key, enabled) VALUES (?, 'allowances', TRUE)
     ON DUPLICATE KEY UPDATE enabled = TRUE`,
    [tvpsId],
  );
  const regular = await conn.query(
    `SELECT mer.profile_id FROM merchants mer
      WHERE mer.institution_id = ? AND mer.sub_type = 'REGULAR' AND mer.accepts_allowance = 1
        AND NOT EXISTS (SELECT 1 FROM merchant_qr_codes q WHERE q.merchant_profile_id = mer.profile_id
                        AND q.kind = 'ALLOWANCE')`,
    [tvpsId],
  );
  for (const m of regular as { profile_id: string }[]) {
    await conn.query(
      `INSERT INTO merchant_qr_codes (public_id, institution_id, merchant_profile_id, kind, token)
       VALUES (?, ?, ?, 'ALLOWANCE', ?)`,
      [newPublicIdPair().bin, tvpsId, m.profile_id, newQrToken()],
    );
  }
  const today = istBusinessDate(new Date());
  const [y, mo] = today.split('-').map(Number) as [number, number];
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const thisStart = iso(new Date(Date.UTC(y, mo - 1, 1)));
  const thisEnd = iso(new Date(Date.UTC(y, mo, 0)));
  const nextStart = iso(new Date(Date.UTC(y, mo, 1)));
  const nextEnd = iso(new Date(Date.UTC(y, mo + 1, 0)));
  const students = (await conn.query(
    `SELECT m.id, w.id AS wallet_id, m.contact_mobile FROM member_profiles m
       JOIN user_types ut ON ut.id = m.user_type_id
       JOIN wallets w ON w.owner_profile_id = m.id AND w.kind = 'ALLOWANCE'
      WHERE m.institution_id = ? AND ut.category = 'STUDENT' AND m.status = 'ACTIVE'
      ORDER BY (m.contact_mobile = ?) DESC, m.id
      LIMIT 22`,
    [tvpsId, MEMBER_MOBILE],
  )) as { id: string; wallet_id: string; contact_mobile: string | null }[];
  const db = new Kysely<Database>({
    dialect: new MysqlDialect({
      pool: createPool({
        uri: url!,
        supportBigNumbers: true,
        bigNumberStrings: true,
        timezone: 'Z',
      }),
    }),
  });
  try {
    const ledger = new LedgerService();
    for (const [i, st] of students.entries()) {
      const periods =
        i % 4 === 0
          ? [
              [thisStart, thisEnd],
              [nextStart, nextEnd],
            ]
          : [[thisStart, thisEnd]];
      for (const [start, end] of periods) {
        const exists = await db
          .selectFrom('allowance_grants')
          .select('id')
          .where('profile_id', '=', st.id)
          .where('start_date', '=', start!)
          .executeTakeFirst();
        if (exists) continue;
        const pub = newPublicIdPair();
        const r = await db
          .insertInto('allowance_grants')
          .values({
            public_id: pub.bin,
            institution_id: tvpsId,
            profile_id: st.id,
            wallet_id: st.wallet_id,
            name: start === thisStart ? 'Monthly pocket money' : 'Next month pocket money',
            amount_paise: 50_000,
            start_date: start!,
            expiry_date: end!,
            daily_count_limit: 3,
            daily_amount_limit_paise: 20_000,
          })
          .executeTakeFirstOrThrow();
        if (start !== thisStart) continue;
        const id = String(r.insertId);
        await db.transaction().execute(async (trx) => {
          const posted = await ledger.post(trx, {
            institutionId: tvpsId,
            type: 'ALLOWANCE_CREDIT',
            channel: 'JOB',
            amountPaise: 50_000,
            idempotencyKey: `DEV-ALW-CREDIT:${id}`,
            debit: { account: 'ALLOWANCE_FUNDING', institutionId: tvpsId },
            credit: { walletId: st.wallet_id },
            narration: 'Allowance: Monthly pocket money',
            businessRef: { type: 'allowance_grant', id },
            at: new Date(`${thisStart}T00:05:00+05:30`),
          });
          await trx
            .updateTable('wallets')
            .set({ status: 'ACTIVE' })
            .where('id', '=', st.wallet_id)
            .where('status', '=', 'INACTIVE')
            .execute();
          await trx
            .updateTable('allowance_grants')
            .set({
              credited_at: new Date(`${thisStart}T00:05:00+05:30`),
              credit_txn_id: posted.txnId,
            })
            .where('id', '=', id)
            .execute();
        });
      }
    }
  } finally {
    await db.destroy();
  }
}

/** Development operator tags (the token a tag reader would read), printed at the end. */
const DEV_TAGS = [
  ['Ramesh Poojary', '9901234567', 'OTDEVRAMESH'],
  ['Shanthi Naik', '9741188220', 'OTDEVSHANTHI'],
  ['Ganesh Acharya', '9632045571', 'OTDEVGANESH'],
] as const;

/**
 * Phase 4 as the prototype shows it: the fee account designated (events need a payee), the
 * readers and the canteen's POS counter registered (unpaired: the console issues the pairing
 * code), campus cards for the sample family and a class of students, the canteen's outlet with
 * the prototype's menu and three operator tags, and two paid events. Rows that exist are kept.
 */
async function phase4Setup(tvpsId: string, institutionName: string) {
  const canteen = await one<{ profile_id: string }>(
    "SELECT profile_id FROM merchants WHERE institution_id = ? AND display_name = 'Campus Canteen'",
    [tvpsId],
  );
  if (!canteen) return;
  const admin = await one<{ public_id: Buffer }>(
    "SELECT public_id FROM platform_accounts WHERE email = 'prakash.shetty@tvps.example.in'",
  );
  const by = admin?.public_id ?? null;

  // The fee account: a merchant of its own, designated once (MER 12.7).
  const inst = (await one<{ fee_merchant_profile_id: string | null }>(
    'SELECT fee_merchant_profile_id FROM institutions WHERE id = ?',
    [tvpsId],
  ))!;
  if (!inst.fee_merchant_profile_id) {
    const type = await one<{ id: string }>(
      "SELECT id FROM user_types WHERE institution_id = ? AND category = 'MERCHANT' ORDER BY id LIMIT 1",
      [tvpsId],
    );
    if (type) {
      const cipher = await loadFieldCipher(
        process.env['FIELD_KEYS_FILE'] ?? 'keys/field-keys.json',
      );
      const pub = newPublicIdPair();
      await conn.query(
        `INSERT INTO member_profiles (public_id, institution_id, user_type_id, first_name, last_name,
           contact_email, joined_on, status)
         VALUES (?, ?, ?, 'SCHOOL', 'OFFICE', 'fees@tvps.example.in', '2026-06-01', 'ACTIVE')`,
        [pub.bin, tvpsId, type.id],
      );
      const p = (await one<{ id: string }>('SELECT id FROM member_profiles WHERE public_id = ?', [
        pub.bin,
      ]))!;
      const acct = '501234567890';
      await conn.query(
        `INSERT INTO merchants (profile_id, institution_id, unique_id, display_name, sub_type,
           holder_name, bank_name, acct_enc, acct_bidx, acct_last4, ifsc, accepts_allowance,
           accepts_coupon, dynamic_qr_enabled)
         VALUES (?, ?, ?, 'TVPS Fee Account', 'REGULAR', 'TUNGA VALLEY PUBLIC SCHOOL', NULL, ?, ?, ?,
           'SBIN0001234', FALSE, FALSE, FALSE)`,
        [
          p.id,
          tvpsId,
          merchantCode(
            'TVPS Fee Account',
            institutionName,
            String(p.id),
            new Date('2026-06-01T06:30:00Z'),
          ),
          cipher.encrypt('bank_acct', acct, `merchants.acct:${pub.id}`),
          cipher.blindIndex('bank_acct', acct),
          acct.slice(-4),
        ],
      );
      await conn.query('UPDATE institutions SET fee_merchant_profile_id = ? WHERE id = ?', [
        p.id,
        tvpsId,
      ]);
      inst.fee_merchant_profile_id = String(p.id);
    }
  }

  // Readers and the POS counter (CR-10), unpaired.
  const readers = [
    ['Main gate', 'Main gate', 'ATTENDANCE', null, null],
    ['Library desk', 'Library', 'LOCATION', null, 'Library'],
    ['Mess coupon counter', 'Mess hall', 'COUPON', canteen.profile_id, null],
    ['Balance kiosk', 'Front office', 'BALANCE_CHECK', null, null],
    ['Card desk', 'Front office', 'CARD_ISSUE', null, null],
    ['Canteen counter 1', 'Canteen', 'POS', canteen.profile_id, null],
  ] as const;
  for (const [name, location, purpose, merchant, locType] of readers) {
    const exists = await one('SELECT id FROM terminals WHERE institution_id = ? AND name = ?', [
      tvpsId,
      name,
    ]);
    if (exists) continue;
    await conn.query(
      `INSERT INTO terminals (public_id, institution_id, name, location, purpose, merchant_profile_id,
         location_type, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [newPublicIdPair().bin, tvpsId, name, location, purpose, merchant, locType, by],
    );
    await conn.query(
      `INSERT INTO terminal_changes (terminal_id, name, location, purpose, changed_by)
       SELECT id, name, location, purpose, created_by FROM terminals
        WHERE institution_id = ? AND name = ?`,
      [tvpsId, name],
    );
  }

  // Campus cards: the sample family and the first thirty active students (development tokens).
  await conn.query(
    `INSERT IGNORE INTO cards (public_id, institution_id, profile_id, token, status, issue_reason)
     SELECT UUID_TO_BIN(UUID()), m.institution_id, m.id, CONCAT('NFCDEV', LPAD(m.id, 10, '0')),
            'ACTIVE', 'NEW_REGISTRATION'
       FROM member_profiles m JOIN user_types ut ON ut.id = m.user_type_id
      WHERE m.institution_id = ? AND m.status = 'ACTIVE'
        AND (m.contact_mobile = ? OR (ut.category = 'STUDENT' AND m.id IN (
              SELECT id FROM (SELECT x.id FROM member_profiles x JOIN user_types xt ON xt.id = x.user_type_id
                               WHERE x.institution_id = ? AND xt.category = 'STUDENT' AND x.status = 'ACTIVE'
                               ORDER BY x.id LIMIT 30) AS first30)))
        AND NOT EXISTS (SELECT 1 FROM cards c WHERE c.profile_id = m.id)`,
    [tvpsId, MEMBER_MOBILE, tvpsId],
  );

  // The canteen's outlet, the prototype's menu and three operator tags.
  await conn.query(
    `INSERT IGNORE INTO pos_outlets (public_id, institution_id, merchant_profile_id, name, opens_at,
       closes_at, gstin)
     VALUES (?, ?, ?, 'Campus Canteen', '07:30:00', '17:00:00', '29ABCDE1234F1Z5')`,
    [newPublicIdPair().bin, tvpsId, canteen.profile_id],
  );
  const outlet = (await one<{ id: string }>(
    'SELECT id FROM pos_outlets WHERE merchant_profile_id = ?',
    [canteen.profile_id],
  ))!;
  const menu = [
    [
      'Meals',
      [
        ['Veg thali', 60],
        ['Lemon rice', 35],
        ['Curd rice', 30],
        ['Veg pulao', 45, false],
      ],
    ],
    [
      'Tiffin',
      [
        ['Masala dosa', 40],
        ['Idli vada', 30],
        ['Poori sagu', 40],
        ['Upma', 25],
      ],
    ],
    [
      'Snacks',
      [
        ['Samosa', 15],
        ['Veg puff', 20],
        ['Paneer roll', 45],
        ['Sandwich', 35],
      ],
    ],
    [
      'Drinks',
      [
        ['Filter coffee', 15],
        ['Badam milk', 25],
        ['Fresh lime soda', 25],
        ['Buttermilk', 15],
      ],
    ],
  ] as const;
  for (const [cat, items] of menu) {
    await conn.query(
      'INSERT IGNORE INTO pos_categories (public_id, institution_id, outlet_id, name) VALUES (?, ?, ?, ?)',
      [newPublicIdPair().bin, tvpsId, outlet.id, cat],
    );
    const c = (await one<{ id: string }>(
      'SELECT id FROM pos_categories WHERE outlet_id = ? AND name = ?',
      [outlet.id, cat],
    ))!;
    for (const [name, rupees, available] of items as readonly (readonly [
      string,
      number,
      boolean?,
    ])[]) {
      await conn.query(
        `INSERT IGNORE INTO pos_items (public_id, institution_id, outlet_id, category_id, name,
           food_type, price_paise, gst_bp, available)
         VALUES (?, ?, ?, ?, ?, 'VEG', ?, 500, ?)`,
        [newPublicIdPair().bin, tvpsId, outlet.id, c.id, name, rupees * 100, available ?? true],
      );
    }
  }
  for (const [name, mobile, token] of DEV_TAGS) {
    const live = await one(
      "SELECT id FROM pos_operator_tags WHERE outlet_id = ? AND mobile = ? AND status = 'ACTIVE'",
      [outlet.id, mobile],
    );
    if (live) continue;
    await conn.query(
      `INSERT IGNORE INTO pos_operator_tags (public_id, institution_id, outlet_id, operator_name, mobile,
         token_hash, token_last4)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        newPublicIdPair().bin,
        tvpsId,
        outlet.id,
        name,
        mobile,
        createHash('sha256').update(token).digest(),
        token.slice(-4),
      ],
    );
  }

  // Two paid events to the fee account (13.7): this month's Annual Day and a science trip.
  if (inst.fee_merchant_profile_id) {
    const today = istBusinessDate(new Date());
    const shift = (n: number) =>
      new Date(Date.parse(`${today}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
    const events = [
      [
        'Annual Day 2026',
        'Costume and stage for the Annual Day on the last Saturday of the month.',
        shift(-2),
        shift(20),
        [
          ['Costume', 30_000],
          ['Stage and sound', 20_000],
        ],
      ],
      [
        'Science centre trip',
        'A day at the regional science centre: bus and entry.',
        today,
        shift(10),
        [
          ['Bus', 25_000],
          ['Entry ticket', 10_000],
        ],
      ],
    ] as const;
    for (const [title, description, start, end, heads] of events) {
      const exists = await one('SELECT id FROM events WHERE institution_id = ? AND title = ?', [
        tvpsId,
        title,
      ]);
      if (exists) continue;
      const total = heads.reduce((a, [, p]) => a + p, 0);
      const pub = newPublicIdPair();
      await conn.query(
        `INSERT INTO events (public_id, institution_id, title, description, start_date, end_date,
           total_paise, merchant_profile_id, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [pub.bin, tvpsId, title, description, start, end, total, inst.fee_merchant_profile_id, by],
      );
      const e = (await one<{ id: string }>('SELECT id FROM events WHERE public_id = ?', [
        pub.bin,
      ]))!;
      for (const [i, [name, paise]] of heads.entries()) {
        await conn.query(
          'INSERT INTO event_heads (event_id, name, amount_paise, sort_order) VALUES (?, ?, ?, ?)',
          [e.id, name, paise, i],
        );
      }
    }
  }
}

/**
 * Fees (Phase 5, SRS 13) as a school sees them in October, made through the fee services so the
 * one pricing formula, the approvals and the payment engine apply:
 *
 * - tuition on, the fee heads, the year's entry fees (₹500 application, mandatory; ₹10,000 admission);
 * - "Middle school <year>" for Grades 6–8 (Tuition ₹18,000 and Annual ₹4,500, Transport ₹6,000
 *   optional; Term 1 40 % due 15 Jul, Term 2 30 % due 15 Oct, Term 3 30 % due 15 Jan; ₹250 late
 *   fine), approved by the administrator and assigned on 1 June (four students take Transport);
 * - "Secondary <year>" (Grades 9–10) waiting for the checker, and "Primary <year>" (Grades 1–5)
 *   returned by the administrator with remarks — both from the accountant;
 * - the families' consent to wallet collection (all but one), a development top-up of each wallet,
 *   Term 1 collected in July through the payment engine, one Term 2 paid early, two Term 1 records
 *   overdue with the fine (the auto-debit job's rule), one collection waiting for a top-up, one
 *   student financed by the partner (approved) and one registration pending, and a manual record.
 *
 * Development only. Re-runnable: every step checks what exists first, and money moves under fixed
 * idempotency keys (DEV-FEE-TOPUP:<wallet>, DEV-FEE-COLLECT:<record>).
 */
async function phase5Setup(tvpsId: string) {
  await conn.query(
    `INSERT INTO feature_toggles (institution_id, feature_key, enabled) VALUES (?, 'tuition', TRUE)
     ON DUPLICATE KEY UPDATE enabled = TRUE`,
    [tvpsId],
  );
  const inst = await one<{ public_id: Buffer; fee_merchant_profile_id: string | null }>(
    'SELECT public_id, fee_merchant_profile_id FROM institutions WHERE id = ?',
    [tvpsId],
  );
  // The fee account is designated in phase 4; without it nothing can be collected.
  if (!inst?.fee_merchant_profile_id) return;
  const year = await one<{ id: string; public_id: Buffer; label: string; starts_on: Date }>(
    `SELECT id, public_id, label, starts_on FROM academic_years
      WHERE institution_id = ? AND is_current = 1 AND status = 'OPEN'`,
    [tvpsId],
  );
  if (!year) return;
  const yearId = binToUuid(year.public_id);
  const sy = new Date(year.starts_on).getUTCFullYear();
  const staff = async (email: string) =>
    one<{ account: Buffer; profile: Buffer }>(
      `SELECT a.public_id AS account, m.public_id AS profile FROM platform_accounts a
         JOIN member_profiles m ON m.account_id = a.id AND m.institution_id = ?
        WHERE a.email = ? ORDER BY m.id LIMIT 1`,
      [tvpsId, email],
    );
  const adminRow = await staff('prakash.shetty@tvps.example.in');
  const accountantRow = await staff('accounts@tvps.example.in');
  if (!adminRow || !accountantRow) return;
  const principal = (r: { account: Buffer; profile: Buffer }): Principal => ({
    subject: binToUuid(r.account),
    surface: 'console',
    sessionId: 'dev-seed',
    institutionId: binToUuid(inst.public_id),
    profileId: binToUuid(r.profile),
    subTasks: [],
  });
  const admin = principal(adminRow);
  const accountant = principal(accountantRow);

  // A moment of the school year; one still in the future happens now instead.
  const at = (iso: string) => {
    const d = new Date(iso);
    return d.getTime() < Date.now() ? d : new Date();
  };
  const today = istBusinessDate(new Date());
  const db = new Kysely<Database>({
    dialect: new MysqlDialect({
      pool: createPool({
        uri: url!,
        supportBigNumbers: true,
        bigNumberStrings: true,
        timezone: 'Z',
      }),
    }),
  });
  const warn = (step: string, e: unknown) => {
    if (!(e instanceof CustomAPIError)) throw e;
    console.warn(`  fees: ${step} skipped (${e.code})`);
  };
  try {
    const settings = new SettingsService(db);
    // An administrator's own request applies directly (ADR-0015); the accountant's waits.
    const members = {
      adminSelfApplies: async (_db: unknown, p: Principal) => p.subject === admin.subject,
    } as unknown as MembersService;
    // The console collects with system authority (no PIN, no member cap), as the worker does.
    const noMemberAuth = {
      verifyPin: () => Promise.reject(new Error('The seed never takes a PIN')),
      checkCap: () => Promise.reject(new Error('The seed never applies a member cap')),
    } as unknown as PaymentSecurityService;
    const servicesAt = (when: Date) => {
      const now = () => when;
      const ledger = new LedgerService({ now });
      const engine = new PaymentEngine({
        db,
        ledger,
        paymentSecurity: noMemberAuth,
        settings,
        now,
      });
      return {
        ledger,
        fees: new FeesService({ db, members, settings, now }),
        records: new FeeRecordsService({ db, engine, members, settings, now }),
        financing: new FinancingService({
          db,
          partner: createFinancingPartner(
            'test',
            process.env['FINANCING_PARTNER_NAME'] || 'Example Finance (example)',
          ),
          settings,
          now,
        }),
      };
    };
    const june = at(`${sy}-06-01T05:00:00Z`);

    // Fee heads (seeded with the defaults the first time) and the year's entry fees.
    const headIds = new Map(
      (await servicesAt(june).fees.heads(admin)).items.map((h) => [h.name, h.id]),
    );
    const entry = await one(
      'SELECT year_id FROM entry_fees WHERE institution_id = ? AND year_id = ?',
      [tvpsId, year.id],
    );
    if (!entry) {
      await servicesAt(june).fees.setEntryFees(admin, yearId, null, {
        applicationFeePaise: 50_000,
        applicationMandatory: true,
        admissionFeePaise: 1_000_000,
      });
    }

    // The structures.
    const classIds = async (names: readonly string[]) =>
      (
        (await conn.query<{ public_id: Buffer }>(
          'SELECT public_id FROM classes WHERE institution_id = ? AND name IN (?) ORDER BY sort_order',
          [tvpsId, names],
        )) as { public_id: Buffer }[]
      ).map((c) => binToUuid(c.public_id));
    const structureOf = async (name: string) => {
      const r = await one<{ public_id: Buffer }>(
        'SELECT public_id FROM fee_structures WHERE institution_id = ? AND year_id = ? AND name = ?',
        [tvpsId, year.id, name],
      );
      return r ? binToUuid(r.public_id) : null;
    };
    const input = async (
      name: string,
      classes: readonly string[],
      heads: readonly (readonly [string, number, boolean?])[],
      fineRupees: number,
    ) => ({
      yearId,
      name,
      classIds: await classIds(classes),
      heads: heads
        .filter(([h]) => headIds.has(h))
        .map(([h, rupees, optional]) => ({
          headId: headIds.get(h)!,
          amountPaise: rupees * 100,
          optional: !!optional,
        })),
      instalments: [
        { label: 'Term 1', dueDate: `${sy}-07-15`, share: '40' },
        { label: 'Term 2', dueDate: `${sy}-10-15`, share: '30' },
        { label: 'Term 3', dueDate: `${sy + 1}-01-15`, share: '30' },
      ],
      lateFinePaise: fineRupees * 100,
    });

    const middleName = `Middle school ${year.label}`;
    let middle = await structureOf(middleName);
    if (!middle) {
      const s = await servicesAt(june).fees.create(
        admin,
        await input(
          middleName,
          ['Grade 6', 'Grade 7', 'Grade 8'],
          [
            ['Tuition', 18_000],
            ['Annual', 4_500],
            ['Transport', 6_000, true],
          ],
          250,
        ),
      );
      await servicesAt(june).fees.submit(admin, s.id, { note: null });
      middle = s.id;
    }

    // Grades 6–8 in class, section and admission order: the cast of the records below.
    const students = (await conn.query(
      `SELECT m.id, m.public_id, w.id AS wallet_id FROM member_profiles m
         JOIN enrolments e ON e.student_profile_id = m.id AND e.year_id = ?
         JOIN sections sec ON sec.id = e.section_id
         JOIN classes c ON c.id = sec.class_id
         LEFT JOIN wallets w ON w.owner_profile_id = m.id AND w.kind = 'CAMPUS'
        WHERE m.institution_id = ? AND m.status = 'ACTIVE' AND c.name IN ('Grade 6', 'Grade 7', 'Grade 8')
        ORDER BY c.sort_order, sec.name, m.id`,
      [year.id, tvpsId],
    )) as { id: string; public_id: Buffer; wallet_id: string | null }[];
    const TRANSPORT = [1, 2, 3, 8];
    const NO_CONSENT = 7;
    const TOP_UP: Readonly<Record<number, number>> = {
      0: 12_000,
      1: 12_000,
      2: 12_000,
      3: 12_000,
      4: 16_000,
      5: 2_000,
      6: 12_000,
      7: 1_500,
      8: 12_000,
    };
    const transport = headIds.get('Transport');
    await servicesAt(june).fees.assign(admin, middle, {
      preview: false,
      optional: transport
        ? TRANSPORT.filter((i) => students[i]).map((i) => ({
            studentId: binToUuid(students[i]!.public_id),
            headIds: [transport],
          }))
        : [],
    });

    const secondaryName = `Secondary ${year.label}`;
    if (!(await structureOf(secondaryName))) {
      const when = at(`${sy}-09-25T06:30:00Z`);
      const s = await servicesAt(when).fees.create(
        accountant,
        await input(
          secondaryName,
          ['Grade 9', 'Grade 10'],
          [
            ['Tuition', 24_000],
            ['Annual', 6_000],
            ['Laboratory', 3_000],
            ['Transport', 6_000, true],
          ],
          300,
        ),
      );
      await servicesAt(when).fees.submit(accountant, s.id, { note: null });
    }

    const primaryName = `Primary ${year.label}`;
    if (!(await structureOf(primaryName))) {
      const when = at(`${sy}-09-10T06:30:00Z`);
      const s = await servicesAt(when).fees.create(
        accountant,
        await input(
          primaryName,
          ['Grade 1', 'Grade 2', 'Grade 3', 'Grade 4', 'Grade 5'],
          [
            ['Tuition', 14_000],
            ['Annual', 3_500],
            ['Activity', 1_200],
          ],
          200,
        ),
      );
      const sent = await servicesAt(when).fees.submit(accountant, s.id, { note: null });
      // The administrator returns it with remarks (the checker's rejection, MKR-003).
      const back = at(`${sy}-09-12T09:15:00Z`);
      const remarks =
        'The Activity fee for Grades 1–5 is ₹1,500 as agreed at the PTA meeting. Please correct it and submit again.';
      await conn.query(
        `UPDATE approval_requests SET status = 'REJECTED', checker_ref = ?, remarks = ?, decided_at = ?,
           updated_at = ?, row_version = row_version + 1
         WHERE public_id = ? AND status = 'PENDING'`,
        [uuidToBin(admin.subject), remarks, back, back, uuidToBin(sent.approvalId)],
      );
      await db
        .transaction()
        .execute((trx) =>
          servicesAt(back).fees.applyReturned(
            trx,
            { structure: s.id, version: s.current.id },
            remarks,
            back,
          ),
        );
    }

    // The families' consent to collection from the wallet (they sign in to the app to give it).
    const months = Number((await settings.values())['fee.consent.validityMonths'] ?? 3);
    for (const [i, st] of students.entries()) {
      if (i === NO_CONSENT) continue;
      const g = await one<{
        id: string;
        account_id: string | null;
        contact_mobile: string | null;
        first_name: string;
        last_name: string | null;
      }>(
        `SELECT p.id, p.account_id, p.contact_mobile, p.first_name, p.last_name
           FROM guardianships g JOIN member_profiles p ON p.id = g.guardian_profile_id
          WHERE g.ward_profile_id = ? ORDER BY p.id LIMIT 1`,
        [st.id],
      );
      if (!g?.contact_mobile) continue;
      if (await one('SELECT id FROM fee_consents WHERE student_profile_id = ?', [st.id])) continue;
      let accountId = g.account_id;
      if (!accountId) {
        await conn.query(
          `INSERT IGNORE INTO platform_accounts (public_id, mobile, first_name, last_name)
           VALUES (?, ?, ?, ?)`,
          [
            newPublicIdPair().bin,
            g.contact_mobile,
            g.first_name.toUpperCase(),
            g.last_name?.toUpperCase() ?? null,
          ],
        );
        accountId =
          (
            await one<{ id: string }>('SELECT id FROM platform_accounts WHERE mobile = ?', [
              g.contact_mobile,
            ])
          )?.id ?? null;
        if (!accountId) continue;
        await conn.query(
          'UPDATE member_profiles SET account_id = ? WHERE id = ? AND account_id IS NULL',
          [accountId, g.id],
        );
      }
      // Given in July and renewed at the end of September (the consent lasts `months`).
      for (const agreed of [at(`${sy}-07-08T04:00:00Z`), at(`${sy}-09-30T04:00:00Z`)]) {
        const until = new Date(agreed);
        until.setUTCMonth(until.getUTCMonth() + months);
        await conn.query(
          `INSERT INTO fee_consents (public_id, institution_id, student_profile_id, account_id,
             text_version, accepted_text, agreed_at, valid_until)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            newPublicIdPair().bin,
            tvpsId,
            st.id,
            accountId,
            CONSENT_TEMPLATE_VERSION,
            `I, ${g.first_name} ${g.last_name ?? ''}, authorise Tunga Valley Public School to collect the school fees as they fall due from the campus wallet. If the balance is not enough, the payment stays pending and is collected automatically when funds are available.`.replace(
              /\s+,/,
              ',',
            ),
            agreed,
            until,
          ],
        );
      }
    }

    // Development top-ups of the students' wallets (once per wallet).
    const july = at(`${sy}-07-01T04:30:00Z`);
    for (const [i, st] of students.entries()) {
      const rupees = TOP_UP[i];
      if (!st.wallet_id || !rupees) continue;
      await db.transaction().execute((trx) =>
        servicesAt(july).ledger.post(trx, {
          institutionId: tvpsId,
          type: 'ADJUSTMENT',
          channel: 'BACK_OFFICE',
          amountPaise: rupees * 100,
          idempotencyKey: `DEV-FEE-TOPUP:${st.wallet_id}`,
          debit: { account: 'ADJUSTMENT', institutionId: tvpsId },
          credit: { walletId: String(st.wallet_id) },
          narration: 'Development top-up',
          at: july,
        }),
      );
    }

    const recordOf = (st: { id: string }, label: string) =>
      one<{ id: string; public_id: Buffer; status: string; financed: number }>(
        `SELECT id, public_id, status, financed FROM fee_records
          WHERE institution_id = ? AND student_profile_id = ? AND year_id = ? AND label = ?`,
        [tvpsId, st.id, year.id, label],
      );
    const collect = async (i: number, label: string, when: Date) => {
      const st = students[i];
      const r = st ? await recordOf(st, label) : undefined;
      if (!r || Number(r.financed) || !['DUE', 'OVERDUE', 'PARTIALLY_PAID'].includes(r.status))
        return;
      const id = binToUuid(r.public_id);
      try {
        await servicesAt(when).records.collect(admin, id, `DEV-FEE-COLLECT:${id}`);
      } catch (e) {
        warn(`collecting ${label}`, e);
      }
    };
    // Term 1 collected in July from the families who agreed; Meera's Term 2 paid early.
    for (const i of [0, 1, 2, 3, 4, 6, 8]) await collect(i, 'Term 1', at(`${sy}-07-10T05:30:00Z`));
    await collect(4, 'Term 2', at(`${sy}-09-20T05:30:00Z`));

    // Pranav's family is financed by the partner (approved); Isha's registration is pending.
    const register = async (i: number, when: Date, approve: Date | null) => {
      const st = students[i];
      if (!st) return;
      let g = await one<{ partner_ref: string; status: string }>(
        'SELECT partner_ref, status FROM fee_financing_registrations WHERE student_profile_id = ?',
        [st.id],
      );
      if (!g) {
        try {
          const out = await servicesAt(when).financing.registerByInstitution(admin, {
            studentProfileId: binToUuid(st.public_id),
          });
          g = { partner_ref: out.partnerRef, status: out.status };
        } catch (e) {
          warn('financing registration', e);
          return;
        }
      }
      if (approve && g.status === 'PENDING') {
        await servicesAt(approve).financing.webhook({
          eventId: `DEV-FIN-${g.partner_ref}`,
          partnerRef: g.partner_ref,
          event: 'APPROVED',
        });
      }
    };
    await register(6, at(`${sy}-08-20T06:00:00Z`), at(`${sy}-08-22T07:00:00Z`));
    await register(3, at(`${sy}-09-30T06:00:00Z`), null);

    // Unpaid records past their due date are overdue with the late fine (the auto-debit job's rule).
    await conn.query(
      `UPDATE fee_records SET status = 'OVERDUE', fine_applied = (late_fine_paise > 0),
         updated_at = UTC_TIMESTAMP(3), row_version = row_version + 1
       WHERE institution_id = ? AND status IN ('DUE', 'PARTIALLY_PAID') AND due_date < ?`,
      [tvpsId, today],
    );

    // Kavya's Term 1: collected today, but the wallet is short — it waits for a top-up.
    const kavya = students[5];
    const k1 = kavya ? await recordOf(kavya, 'Term 1') : undefined;
    if (
      k1 &&
      !(await one(
        "SELECT id FROM fee_collection_attempts WHERE record_id = ? AND status = 'PENDING'",
        [k1.id],
      ))
    ) {
      await collect(5, 'Term 1', new Date());
    }

    // Pre-primary (Nursery, LKG, UKG), so the app's sample family sees its fees: Aarav's Term 1
    // collected in July; Term 2 due; the consent given in June has lapsed, so the app asks again.
    const preName = `Pre-primary ${year.label}`;
    let pre = await structureOf(preName);
    if (!pre) {
      const s = await servicesAt(june).fees.create(
        admin,
        await input(
          preName,
          ['Nursery', 'LKG', 'UKG'],
          [
            ['Tuition', 12_000],
            ['Annual', 3_000],
            ['Activity', 1_500],
          ],
          150,
        ),
      );
      await servicesAt(june).fees.submit(admin, s.id, { note: null });
      pre = s.id;
    }
    await servicesAt(june).fees.assign(admin, pre, { preview: false });
    const family = (await conn.query(
      `SELECT w.id, w.account_id, wl.id AS wallet_id FROM member_profiles p
         JOIN guardianships g ON g.guardian_profile_id = p.id
         JOIN member_profiles w ON w.id = g.ward_profile_id
         LEFT JOIN wallets wl ON wl.owner_profile_id = w.id AND wl.kind = 'CAMPUS'
        WHERE p.institution_id = ? AND p.contact_mobile = ?`,
      [tvpsId, MEMBER_MOBILE],
    )) as { id: string; account_id: string | null; wallet_id: string | null }[];
    for (const kid of family) {
      if (
        kid.account_id &&
        !(await one('SELECT id FROM fee_consents WHERE student_profile_id = ?', [kid.id]))
      ) {
        const agreed = at(`${sy}-06-25T04:00:00Z`);
        const until = new Date(agreed);
        until.setUTCMonth(until.getUTCMonth() + months);
        await conn.query(
          `INSERT INTO fee_consents (public_id, institution_id, student_profile_id, account_id,
             text_version, accepted_text, agreed_at, valid_until)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            newPublicIdPair().bin,
            tvpsId,
            kid.id,
            kid.account_id,
            CONSENT_TEMPLATE_VERSION,
            'I authorise Tunga Valley Public School to collect the school fees as they fall due from the campus wallet.',
            agreed,
            until,
          ],
        );
      }
      if (kid.wallet_id) {
        await db.transaction().execute((trx) =>
          servicesAt(july).ledger.post(trx, {
            institutionId: tvpsId,
            type: 'ADJUSTMENT',
            channel: 'BACK_OFFICE',
            amountPaise: 8_000_00,
            idempotencyKey: `DEV-FEE-TOPUP:${kid.wallet_id}`,
            debit: { account: 'ADJUSTMENT', institutionId: tvpsId },
            credit: { walletId: String(kid.wallet_id) },
            narration: 'Development top-up',
            at: july,
          }),
        );
      }
      const t1 = await recordOf(kid, 'Term 1');
      if (t1 && ['DUE', 'OVERDUE'].includes(t1.status)) {
        const id = binToUuid(t1.public_id);
        try {
          await servicesAt(at(`${sy}-07-10T05:30:00Z`)).records.collect(
            admin,
            id,
            `DEV-FEE-COLLECT:${id}`,
          );
        } catch (e) {
          warn('collecting the sample family’s Term 1', e);
        }
      }
    }

    // A record created individually: Siddharth's science fair kit.
    const sid = students[8];
    const lab = headIds.get('Laboratory');
    if (sid && !(await recordOf(sid, 'Science fair kit'))) {
      const due = new Date(Date.parse(`${today}T00:00:00Z`) + 16 * 86_400_000)
        .toISOString()
        .slice(0, 10);
      try {
        await servicesAt(new Date()).records.manual(admin, {
          studentId: binToUuid(sid.public_id),
          yearId,
          label: 'Science fair kit',
          dueDate: due,
          amountPaise: 120_000,
          ...(lab ? { headId: lab } : {}),
          remarks: 'Materials for the Grade 8 science fair',
        });
      } catch (e) {
        warn('the manual record', e);
      }
    }
  } finally {
    await db.destroy();
  }
}

/**
 * Admissions (Phase 5.4–5.5; prototype c.applications, c.admissionqr, c.admfees, p.*): next year
 * open for admission with its entry fees, the admission link, and applications in each state.
 * Written once: an institution that already has applications is left as it is.
 */
async function admissionsSetup(tvpsId: string) {
  const cur = await one<{ starts_on: Date }>(
    "SELECT starts_on FROM academic_years WHERE institution_id = ? AND is_current = 1 AND status = 'OPEN'",
    [tvpsId],
  );
  if (!cur) return;
  const sy = new Date(cur.starts_on).getUTCFullYear();
  const nextLabel = `${sy + 1}-${String((sy + 2) % 100).padStart(2, '0')}`;
  if (
    !(await one('SELECT id FROM academic_years WHERE institution_id = ? AND label = ?', [
      tvpsId,
      nextLabel,
    ]))
  ) {
    await conn.query(
      `INSERT INTO academic_years (public_id, institution_id, label, starts_on, ends_on, status, is_current)
       VALUES (?, ?, ?, ?, ?, 'OPEN', 0)`,
      [newPublicIdPair().bin, tvpsId, nextLabel, `${sy + 1}-04-01`, `${sy + 2}-03-31`],
    );
  }
  const years = (await conn.query(
    'SELECT id, label FROM academic_years WHERE institution_id = ? AND label IN (?, ?)',
    [tvpsId, nextLabel, `${sy}-${String((sy + 1) % 100).padStart(2, '0')}`],
  )) as { id: string; label: string }[];
  const next = years.find((y) => y.label === nextLabel)!;
  const current = years.find((y) => y.label !== nextLabel);
  await conn.query(
    `INSERT IGNORE INTO entry_fees (institution_id, year_id, application_fee_paise, application_mandatory, admission_fee_paise)
     VALUES (?, ?, 50000, TRUE, 1000000)`,
    [tvpsId, next.id],
  );
  if (
    !(await one("SELECT id FROM admission_links WHERE institution_id = ? AND status = 'ACTIVE'", [
      tvpsId,
    ]))
  ) {
    await conn.query(
      'INSERT INTO admission_links (public_id, institution_id, token, year_id) VALUES (?, ?, ?, ?)',
      [newPublicIdPair().bin, tvpsId, randomBytes(32).toString('base64url'), next.id],
    );
  }
  if (await one('SELECT id FROM admission_applications WHERE institution_id = ?', [tvpsId])) return;

  const cipher = await loadFieldCipher(process.env['FIELD_KEYS_FILE'] ?? 'keys/field-keys.json');
  const classId = async (name: string) =>
    (
      await one<{ id: string }>('SELECT id FROM classes WHERE institution_id = ? AND name = ?', [
        tvpsId,
        name,
      ])
    )?.id ?? null;
  const counsellor = await one<{ public_id: Buffer }>(
    "SELECT public_id FROM platform_accounts WHERE email = 'prakash.shetty@tvps.example.in'",
  );
  const storage = createStorage('local', process.env['UPLOAD_DIR'] ?? 'uploads');
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
  let seq: Record<number, number> = {};
  const nextNo = (yyyy: number) => {
    seq[yyyy] = (seq[yyyy] ?? 0) + 1;
    return `TVPS/${yyyy}/${String(seq[yyyy]).padStart(6, '0')}`;
  };
  const daysFromToday = (n: number) =>
    new Date(Date.now() + 330 * 60_000 + n * 86_400_000).toISOString().slice(0, 10);

  type Person = { name: string; mobile?: string; email?: string; occupation?: string };
  const add = async (a: {
    source: 'PUBLIC' | 'COUNSELLOR';
    status: 'DRAFT' | 'SUBMITTED' | 'REJECTED';
    year: { id: string; label: string };
    className: string;
    first: string;
    last: string;
    gender: 'MALE' | 'FEMALE';
    dob: string;
    idNumber?: string;
    father: Person;
    mother?: Person;
    joining?: string;
    midTerm?: boolean;
    step: number;
    declared: boolean;
    appFee: 'NONE' | 'PENDING' | 'ONLINE' | 'CASH';
    docs: readonly ('PHOTO' | 'BIRTH' | 'ADDRESS' | 'REPORT' | 'TC')[];
    references?: readonly Person[];
    undertakingDue?: string;
    rejection?: { reason: string; remarks: string };
    daysAgo: number;
  }) => {
    const pub = newPublicIdPair();
    const yyyy = Number(a.year.label.slice(0, 4));
    const created = new Date(Date.now() - a.daysAgo * 86_400_000);
    const submitted = a.status !== 'DRAFT' ? new Date(created.getTime() + 3_600_000) : null;
    const data = {
      student: {
        category: 'GENERAL',
        medium: 'English',
        bloodGroup: 'O+',
        allergies: null,
        health: null,
      },
      addresses: {
        residential: {
          line1: 'No. 12, 4th Cross, Gopala',
          city: 'Shivamogga',
          state: 'Karnataka',
          pin: '577205',
        },
        sameAsResidential: true,
      },
      previous: a.className.startsWith('Grade')
        ? {
            school: 'Sunshine English School',
            lastClass: 'Previous class',
            result: 'Passed',
            board: 'STATE',
          }
        : null,
      parents: { father: a.father, ...(a.mother ? { mother: a.mother } : {}), primary: 'FATHER' },
      customFields: {},
      midTermReason: a.midTerm ? 'The family moved to Shivamogga' : null,
    };
    await conn.query(
      `INSERT INTO admission_applications (public_id, institution_id, application_no, source, status, year_id, class_id,
         mid_term, joining_date, first_name, last_name, gender, dob, id_number_enc, id_number_bidx, id_number_last4,
         primary_name, primary_relation, primary_mobile, primary_email, data, step, tc_mode, tc_due,
         declared_at, declared_by, submitted_at, decided_at, decided_by, rejection_reason, rejection_remarks,
         payment_status, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'FATHER', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        pub.bin,
        tvpsId,
        nextNo(yyyy),
        a.source,
        a.status,
        a.year.id,
        await classId(a.className),
        a.midTerm ? 1 : 0,
        a.joining ?? null,
        a.first.toUpperCase(),
        a.last.toUpperCase(),
        a.gender,
        a.dob,
        a.idNumber ? cipher.encrypt('adm_id_number', a.idNumber, pub.id) : null,
        a.idNumber ? cipher.blindIndex('adm_id_number', `${tvpsId}:${a.idNumber}`) : null,
        a.idNumber ? a.idNumber.slice(-4) : null,
        a.father.name,
        a.father.mobile ?? null,
        a.father.email ?? null,
        JSON.stringify(data),
        a.step,
        a.undertakingDue ? 'UNDERTAKING' : null,
        a.undertakingDue ?? null,
        a.declared ? (submitted ?? created) : null,
        a.declared ? (a.source === 'COUNSELLOR' ? 'Counsellor' : a.father.name) : null,
        a.status === 'SUBMITTED' || a.status === 'REJECTED' ? submitted : null,
        a.rejection ? new Date(created.getTime() + 2 * 86_400_000) : null,
        a.rejection && counsellor ? counsellor.public_id : null,
        a.rejection?.reason ?? null,
        a.rejection?.remarks ?? null,
        a.appFee === 'ONLINE' || a.appFee === 'CASH' ? 'COMPLETED' : 'PENDING',
        a.source === 'COUNSELLOR' && counsellor ? counsellor.public_id : null,
        created,
        submitted ?? created,
      ],
    );
    const app = await one<{ id: string }>(
      'SELECT id FROM admission_applications WHERE public_id = ?',
      [pub.bin],
    );
    if (!app) return;
    for (const t of a.docs) {
      const file = newPublicIdPair();
      const objectKey = `dev-seed/admissions/${file.id}.pdf`;
      await storage.put(objectKey, pdf);
      await conn.query(
        `INSERT INTO files (public_id, institution_id, purpose, object_key, original_name, mime_type, size_bytes, sha256, scan_status)
         VALUES (?, ?, 'document', ?, ?, 'application/pdf', ?, ?, 'CLEAN')`,
        [
          file.bin,
          tvpsId,
          objectKey,
          `${t.toLowerCase()}.pdf`,
          pdf.length,
          createHash('sha256').update(pdf).digest('hex'),
        ],
      );
      const f = await one<{ id: string }>('SELECT id FROM files WHERE public_id = ?', [file.bin]);
      await conn.query(
        'INSERT INTO admission_documents (application_id, doc_type, file_id) VALUES (?, ?, ?)',
        [app.id, t, f!.id],
      );
    }
    for (const r of a.references ?? []) {
      await conn.query(
        'INSERT INTO admission_references (public_id, application_id, name, relation, mobile) VALUES (?, ?, ?, ?, ?)',
        [newPublicIdPair().bin, app.id, r.name, r.occupation ?? null, r.mobile ?? '9845000000'],
      );
    }
    if (a.appFee !== 'NONE') {
      const fee = newPublicIdPair();
      const paid = a.appFee === 'ONLINE' || a.appFee === 'CASH';
      await conn.query(
        `INSERT INTO admission_payments (public_id, institution_id, application_id, fee_type, amount_paise, status, mode,
           gateway_order_id, gateway_payment_id, receipt_no, paid_by, paid_at, attempts)
         VALUES (?, ?, ?, 'APPLICATION', 50000, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          fee.bin,
          tvpsId,
          app.id,
          paid ? 'PAID' : 'PENDING',
          paid ? a.appFee : null,
          a.appFee === 'ONLINE' ? `order_test_${fee.id.slice(0, 16).replace(/-/g, '')}` : null,
          a.appFee === 'ONLINE' ? `pay_test_${fee.id.slice(-12)}` : null,
          paid ? `TVPS/R/${yyyy}/${String(Number(app.id)).padStart(6, '0')}` : null,
          a.appFee === 'CASH' ? a.father.name : null,
          paid ? (submitted ?? created) : null,
          a.appFee === 'ONLINE' ? 1 : 0,
        ],
      );
    }
  };

  await add({
    source: 'PUBLIC',
    status: 'SUBMITTED',
    year: next,
    className: 'Grade 1',
    first: 'Diya',
    last: 'Shetty',
    gender: 'FEMALE',
    dob: `${sy - 5}-02-14`,
    idNumber: '657410',
    father: {
      name: 'Rakesh Shetty',
      mobile: '9876501234',
      email: 'rakesh.shetty@example.com',
      occupation: 'Bank officer',
    },
    mother: { name: 'Pallavi Shetty', mobile: '9876501235', occupation: 'Teacher' },
    step: 7,
    declared: true,
    appFee: 'ONLINE',
    docs: ['PHOTO', 'BIRTH', 'ADDRESS', 'REPORT'],
    daysAgo: 6,
  });
  await add({
    source: 'PUBLIC',
    status: 'DRAFT',
    year: next,
    className: 'LKG',
    first: 'Ishaan',
    last: 'Rao',
    gender: 'MALE',
    dob: `${sy - 3}-08-02`,
    father: { name: 'Vinay Rao', mobile: '9876502240' },
    step: 3,
    declared: false,
    appFee: 'NONE',
    docs: ['BIRTH'],
    daysAgo: 3,
  });
  await add({
    source: 'PUBLIC',
    status: 'DRAFT',
    year: next,
    className: 'Grade 3',
    first: 'Arjun',
    last: 'Menon',
    gender: 'MALE',
    dob: `${sy - 7}-11-20`,
    idNumber: '204318',
    father: { name: 'Suresh Menon', mobile: '9876503310', email: 'suresh.menon@example.com' },
    step: 7,
    declared: true,
    appFee: 'PENDING',
    docs: ['BIRTH', 'ADDRESS', 'REPORT'],
    daysAgo: 1,
  });
  await add({
    source: 'PUBLIC',
    status: 'REJECTED',
    year: next,
    className: 'UKG',
    first: 'Tanvi',
    last: 'Kulkarni',
    gender: 'FEMALE',
    dob: `${sy - 4}-05-09`,
    father: { name: 'Mahesh Kulkarni', mobile: '9876504410' },
    step: 7,
    declared: true,
    appFee: 'ONLINE',
    docs: ['BIRTH', 'ADDRESS'],
    daysAgo: 12,
    rejection: {
      reason: 'SEATS_FULL',
      remarks: 'UKG is full for next year. We have kept the application on the waiting list.',
    },
  });
  if (current) {
    await add({
      source: 'COUNSELLOR',
      status: 'SUBMITTED',
      year: current,
      className: 'Grade 6',
      first: 'Kiran',
      last: 'Bhat',
      gender: 'MALE',
      dob: `${sy - 12}-08-01`,
      father: { name: 'Mohan Bhat', mobile: '9845001122' },
      joining: daysFromToday(7),
      midTerm: true,
      step: 7,
      declared: true,
      appFee: 'CASH',
      docs: ['BIRTH', 'ADDRESS', 'REPORT'],
      daysAgo: 2,
      references: [
        { name: 'Sunita Rao', mobile: '9845009988', occupation: 'Class teacher, previous school' },
      ],
      undertakingDue: `${sy + 1}-01-15`,
    });
  }
  for (const [yyyy, n] of Object.entries(seq)) {
    await conn.query(
      `INSERT INTO admission_application_seq (institution_id, year_number, last_no) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE last_no = GREATEST(last_no, VALUES(last_no))`,
      [tvpsId, Number(yyyy), n],
    );
  }
  seq = {};
}

/**
 * Institution set-up (2.4) for TVPS with the prototype's values, and the prototype's other tenants.
 * Rows that already exist are left as they are, so changes made on the screens survive a re-run.
 */
async function institutionSetup(tvpsId: string) {
  const cipher = await loadFieldCipher(process.env['FIELD_KEYS_FILE'] ?? 'keys/field-keys.json');
  const setUp = async (
    instId: string,
    o: {
      plan: string;
      subscription?: string | undefined;
      trialEnd?: string | undefined;
      primary: readonly [string, string, string];
      secondary: readonly [string, string, string] | null;
      off?: readonly string[] | undefined;
      whatsapp?: boolean | undefined;
      steps?: readonly string[] | undefined;
    },
  ) => {
    const inst = await one<{ public_id: Buffer }>(
      'SELECT public_id FROM institutions WHERE id = ?',
      [instId],
    );
    await conn.query(
      'INSERT IGNORE INTO institution_settings (institution_id, consent_validity_months) VALUES (?, 3)',
      [instId],
    );
    for (const [kind, c] of [
      ['PRIMARY', o.primary],
      ['SECONDARY', o.secondary],
    ] as const) {
      if (!c || !inst) continue;
      const enc = cipher.encrypt(
        'institution_contact',
        c[2],
        `institution_contacts.mobile:${binToUuid(inst.public_id)}:${kind}`,
      );
      await conn.query(
        `INSERT IGNORE INTO institution_contacts (institution_id, kind, name, email, mobile_enc, mobile_last4) VALUES (?, ?, ?, ?, ?, ?)`,
        [instId, kind, c[0], c[1], enc, c[2].slice(-4)],
      );
    }
    await conn.query(
      `INSERT IGNORE INTO subscriptions (institution_id, plan_id, plan_version_id, status, trial_ends_on)
       SELECT ?, p.id, p.current_version_id, ?, ? FROM plans p WHERE p.code = ?`,
      [instId, o.subscription ?? null, o.trialEnd ?? null, o.plan],
    );
    for (const k of FEATURE_KEYS) {
      await conn.query(
        'INSERT IGNORE INTO feature_toggles (institution_id, feature_key, enabled) VALUES (?, ?, ?)',
        [instId, k, !(o.off ?? []).includes(k)],
      );
    }
    for (const [ch, on] of [
      ['IN_APP', true],
      ['EMAIL', true],
      ['SMS', true],
      ['WHATSAPP', o.whatsapp ?? false],
    ] as const) {
      await conn.query(
        'INSERT IGNORE INTO notification_channel_settings (institution_id, channel, enabled) VALUES (?, ?, ?)',
        [instId, ch, on],
      );
    }
    for (const s of o.steps ?? ALL_STEPS) {
      await conn.query(
        'INSERT IGNORE INTO onboarding_checklist_steps (institution_id, step_key) VALUES (?, ?)',
        [instId, s],
      );
    }
  };
  const history = async (
    instId: string,
    events: readonly (readonly [string, string, string | null, string | null, string])[],
  ) => {
    const n = await one<{ n: number }>(
      'SELECT COUNT(*) AS n FROM institution_lifecycle_events WHERE institution_id = ?',
      [instId],
    );
    if (Number(n?.n ?? 0) > 0) return;
    for (const [at, action, from, to, reason] of events) {
      await conn.query(
        `INSERT INTO institution_lifecycle_events (institution_id, action, from_status, to_status, reason, occurred_at) VALUES (?, ?, ?, ?, ?, ?)`,
        [instId, action, from, to, reason, new Date(at)],
      );
    }
  };

  // ---- TVPS: the prototype's live tenant ----------------------------------------------------------
  await conn.query(
    `UPDATE institutions SET address_line1 = ?, pin_code = ?, office_phone = ?, office_email = ?, name_address_key = ?,
       corporate_code = COALESCE(corporate_code, 'RPTV'), pool_account_ref = COALESCE(pool_account_ref, 'POOLTVPS0042'),
       created_at = '2021-06-01 05:50:00.000'
     WHERE id = ? AND office_email IS NULL`,
    [
      TVPS_ADDRESS,
      '577203',
      '08182 245 610',
      'office@tvps.example.in',
      nameAddressKey(SCHOOL.name, TVPS_ADDRESS),
      tvpsId,
    ],
  );
  await setUp(tvpsId, {
    plan: 'PL-PLUS',
    primary: ['Prakash Shetty', 'prakash.shetty@tvps.example.in', '9845012345'],
    secondary: ['Deepa Nayak', 'accounts@tvps.example.in', '9845067890'],
  });
  await history(tvpsId, [
    ['2021-06-01T05:50:00Z', 'REGISTERED', null, 'PENDING_ACTIVATION', 'Signed agreement received'],
    [
      '2021-06-20T04:35:00Z',
      'ACTIVATED',
      'PENDING_ACTIVATION',
      'ACTIVE',
      'First annual invoice paid',
    ],
    [
      '2024-06-01T03:30:00Z',
      'PLAN_CHANGE',
      'Campus Essentials',
      'Campus Plus',
      'Transport and coupons needed for the hostel block',
    ],
  ]);
  for (const [name, category, departments] of TVPS_USER_TYPES) {
    await conn.query(
      'INSERT IGNORE INTO user_types (public_id, institution_id, name, category) VALUES (?, ?, ?, ?)',
      [newPublicIdPair().bin, tvpsId, name, category],
    );
    const ut = await one<{ id: string }>(
      'SELECT id FROM user_types WHERE institution_id = ? AND name = ?',
      [tvpsId, name],
    );
    for (const d of departments) {
      await conn.query(
        'INSERT IGNORE INTO departments (public_id, institution_id, user_type_id, name) VALUES (?, ?, ?, ?)',
        [newPublicIdPair().bin, tvpsId, ut?.id, d],
      );
    }
  }
  // The prototype's institution-defined fields (c.fields), defined by the administrator or accounts.
  const definer = async (email: string) =>
    (
      await one<{ public_id: Buffer }>('SELECT public_id FROM platform_accounts WHERE email = ?', [
        email,
      ])
    )?.public_id ?? null;
  const admin = await definer('prakash.shetty@tvps.example.in');
  const accounts = await definer('accounts@tvps.example.in');
  for (const [i, f] of TVPS_FIELDS.entries()) {
    const exists = await one<{ id: string }>(
      'SELECT id FROM custom_field_definitions WHERE institution_id = ? AND entity = ? AND label = ?',
      [tvpsId, f.entity, f.label],
    );
    if (exists) continue;
    await conn.query(
      `INSERT INTO custom_field_definitions (public_id, institution_id, entity, label, data_type, is_required, is_unique, list_column, filterable, position, status, no_id_doc_ack_at, deactivated_at, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        newPublicIdPair().bin,
        tvpsId,
        f.entity,
        f.label,
        f.type,
        f.required,
        f.unique,
        f.listColumn,
        f.filter,
        i + 1,
        f.active ? 'ACTIVE' : 'INACTIVE',
        new Date(f.at),
        f.active ? null : new Date('2026-05-20T05:00:00Z'),
        f.by === 'accounts' ? accounts : admin,
        new Date(f.at),
      ],
    );
    const row = await one<{ id: string }>(
      'SELECT id FROM custom_field_definitions WHERE institution_id = ? AND entity = ? AND label = ?',
      [tvpsId, f.entity, f.label],
    );
    for (const [p, label] of (f.options ?? []).entries()) {
      await conn.query(
        'INSERT INTO custom_field_options (institution_id, field_id, label, position) VALUES (?, ?, ?, ?)',
        [tvpsId, row?.id, label, p + 1],
      );
    }
  }
  // Staff without a department join their type's first one (Administration for Staff).
  await conn.query(
    `UPDATE member_profiles m
       JOIN (SELECT user_type_id, MIN(id) AS dept FROM departments GROUP BY user_type_id) d
         ON d.user_type_id = m.user_type_id
        SET m.department_id = d.dept
      WHERE m.institution_id = ? AND m.department_id IS NULL`,
    [tvpsId],
  );

  // ---- the prototype's other tenants ---------------------------------------------------------------
  for (const d of DEMO_TENANTS) {
    const key = nameAddressKey(d.name, d.address);
    let row = await one<{ id: string }>('SELECT id FROM institutions WHERE name_address_key = ?', [
      key,
    ]);
    if (!row) {
      const p = newPublicIdPair();
      const since = new Date(`${d.since}T05:00:00Z`);
      await conn.query(
        `INSERT INTO institutions (public_id, identifier, name, short_name, board, address_line1, city, status, suspended_at, cancelled_at, corporate_code, pool_account_ref, name_address_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          p.bin,
          `TMP${p.id.replace(/-/g, '').slice(0, 21).toUpperCase()}`,
          d.name,
          d.short,
          d.board,
          d.address,
          d.city,
          d.status,
          d.status === 'SUSPENDED' ? new Date('2026-09-18T04:30:00Z') : null,
          d.status === 'CANCELLED' ? new Date('2026-08-31T12:00:00Z') : null,
          d.code,
          d.pool,
          key,
          since,
        ],
      );
      row = await one<{ id: string }>('SELECT id FROM institutions WHERE name_address_key = ?', [
        key,
      ]);
      if (!row) throw new Error(`tenant ${d.name} not created`);
      await conn.query('UPDATE institutions SET identifier = ? WHERE id = ?', [
        institutionIdentifier(d.name, d.address, String(row.id), since),
        row.id,
      ]);
      await conn.query(
        'INSERT IGNORE INTO user_types (public_id, institution_id, name, category) VALUES (?, ?, ?, ?)',
        [newPublicIdPair().bin, row.id, 'Staff', 'STAFF'],
      );
    }
    await setUp(String(row.id), d);
    await history(String(row.id), [
      [
        `${d.since}T05:00:00Z`,
        'REGISTERED',
        null,
        'PENDING_ACTIVATION',
        'Signed agreement received',
      ],
      ...d.history,
    ]);
  }
}

try {
  // ---- the school ------------------------------------------------------------------------------
  let school = await one<{ id: string }>('SELECT id FROM institutions WHERE identifier = ?', [
    SCHOOL.identifier,
  ]);
  if (!school) {
    const key = createHash('sha256')
      .update(`${SCHOOL.name}|${SCHOOL.line1}|${SCHOOL.city}|${SCHOOL.pin}`.toLowerCase())
      .digest('hex');
    await conn.query(
      `INSERT INTO institutions (public_id, identifier, name, short_name, board, address_line1, city, state, pin_code, status, name_address_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?)`,
      [
        newPublicIdPair().bin,
        SCHOOL.identifier,
        SCHOOL.name,
        SCHOOL.short,
        SCHOOL.board,
        SCHOOL.line1,
        SCHOOL.city,
        SCHOOL.state,
        SCHOOL.pin,
        key,
      ],
    );
    school = await one<{ id: string }>('SELECT id FROM institutions WHERE identifier = ?', [
      SCHOOL.identifier,
    ]);
  }
  if (!school) throw new Error('school not created');
  for (const [name, category] of USER_TYPES) {
    await conn.query(
      `INSERT IGNORE INTO user_types (public_id, institution_id, name, category) VALUES (?, ?, ?, ?)`,
      [newPublicIdPair().bin, school.id, name, category],
    );
  }

  // ---- accounts --------------------------------------------------------------------------------
  const account = async (
    p: { first: string; last: string; email: string; mobile: string },
    password: string,
  ) => {
    let a = await one<{ id: string }>('SELECT id FROM platform_accounts WHERE email = ?', [
      p.email,
    ]);
    if (!a) {
      await conn.query(
        `INSERT INTO platform_accounts (public_id, mobile, email, email_verified_at, first_name, last_name, status)
         VALUES (?, ?, ?, UTC_TIMESTAMP(3), ?, ?, 'ACTIVE')`,
        [newPublicIdPair().bin, p.mobile, p.email, p.first.toUpperCase(), p.last.toUpperCase()],
      );
      a = await one<{ id: string }>('SELECT id FROM platform_accounts WHERE email = ?', [p.email]);
      if (!a) throw new Error(`account ${p.email} not created`);
      await conn.query(
        `INSERT INTO account_credentials (account_id, kind, hash) VALUES (?, 'PASSWORD', ?)`,
        [a.id, await hashSecret(password)],
      );
    }
    return a.id;
  };
  const roleId = async (code: string) => {
    const r = await one<{ id: string }>('SELECT id FROM roles WHERE code = ?', [code]);
    if (!r) throw new Error(`role ${code} missing — run npm run seed first`);
    return r.id;
  };

  for (const s of STAFF) {
    const accountId = await account(s, staffPassword);
    const type = await one<{ id: string }>(
      'SELECT id FROM user_types WHERE institution_id = ? AND name = ?',
      [school.id, s.type],
    );
    let profile = await one<{ id: string }>(
      'SELECT id FROM member_profiles WHERE institution_id = ? AND employee_no = ?',
      [school.id, s.emp],
    );
    if (!profile) {
      await conn.query(
        `INSERT INTO member_profiles (public_id, institution_id, account_id, user_type_id, first_name, last_name, employee_no)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          newPublicIdPair().bin,
          school.id,
          accountId,
          type?.id,
          s.first.toUpperCase(),
          s.last.toUpperCase(),
          s.emp,
        ],
      );
      profile = await one<{ id: string }>(
        'SELECT id FROM member_profiles WHERE institution_id = ? AND employee_no = ?',
        [school.id, s.emp],
      );
    }
    await conn.query(
      'INSERT IGNORE INTO profile_roles (institution_id, profile_id, role_id) VALUES (?, ?, ?)',
      [school.id, profile?.id, await roleId(s.role)],
    );
  }
  for (const o of OPERATORS) {
    const accountId = await account(o, opsPassword);
    await conn.query(
      `INSERT IGNORE INTO operator_accounts (public_id, account_id, role_id) VALUES (?, ?, ?)`,
      [newPublicIdPair().bin, accountId, await roleId(o.role)],
    );
  }

  await institutionSetup(school.id);
  await billingSetup(school.id);
  await ensureCurrentYears();
  await membersSetup(school.id);
  await approvalsSetup(school.id);
  await paymentsSetup(school.id, SCHOOL.name);
  await familySetup(school.id);
  await allowancesSetup(school.id);
  await phase4Setup(school.id, SCHOOL.name);
  await phase5Setup(school.id);
  await admissionsSetup(school.id);
  // The parent's app sign-in (mobile + password); a new device still asks for the code.
  const parentAccount = await one<{ id: string }>(
    'SELECT id FROM platform_accounts WHERE mobile = ?',
    [MEMBER_MOBILE],
  );
  if (parentAccount) {
    await conn.query(
      `INSERT IGNORE INTO account_credentials (account_id, kind, hash) VALUES (?, 'PASSWORD', ?)`,
      [parentAccount.id, await hashSecret(memberPassword)],
    );
  }

  console.log('development data ready (local only):');
  console.log(`  console      ${STAFF.map((s) => s.email).join(', ')}`);
  console.log(`  back office  ${OPERATORS.map((o) => o.email).join(', ')}`);
  console.log(`  member app   ${MEMBER_MOBILE} (parent), ${MERCHANT_MOBILE} (Campus Canteen)`);
  console.log(
    '  passwords    DEV_STAFF_PASSWORD / DEV_OPS_PASSWORD / DEV_MEMBER_PASSWORD, or the demo passwords',
  );
  console.log(
    `  POS tags     ${DEV_TAGS.map(([n, , t]) => `${n.split(' ')[0]} ${t}`).join(', ')} (Canteen counter 1; pair it from Readers in the console)`,
  );
} finally {
  await conn.close();
}
