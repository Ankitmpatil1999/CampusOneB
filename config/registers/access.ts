/**
 * Roles → tasks → sub-tasks catalogue (SRS 6.28; docs/01 §6). A role is **assigned tasks** — a task
 * opens its menu pages — and **granted sub-tasks** inside them — every action checks its sub-task
 * on the server (RNG-GOV-001; prototype o.roles: "Menus follow the task … every action checks its
 * sub-task"). Seeded into `tasks`, `sub_tasks`, `roles`, `role_task_assignments`, `role_tasks`.
 *
 * - Operator tasks and their sub-task names are the prototype's (OPTASKS), plus the platform
 *   settings of PLT-012…014 (client: every default changeable).
 * - Institution tasks are the prototype's (RP.ROLE_TASKS); their sub-tasks are docs/01 §6.2.
 * - Only the Institution Administrator decides approvals (Q9); only the Platform Administrator may
 *   drill through into one institution (Q10a).
 */
import type { RoleScope } from '../../models/ringpe_models';

export interface SubTaskDefinition {
  readonly code: string;
  readonly en: string;
}

export interface TaskDefinition {
  readonly scope: RoleScope;
  readonly code: string;
  readonly en: string;
  /** Governing change request, shown next to the task (e.g. CR-18). */
  readonly cr?: string;
  readonly subTasks: readonly SubTaskDefinition[];
}

const sub = (code: string, en: string): SubTaskDefinition => ({ code, en });

/** Institution sub-tasks: `<task>.<action>` with a plain name. */
const inst = (
  code: string,
  en: string,
  subs: readonly (readonly [string, string])[],
): TaskDefinition => ({
  scope: 'INSTITUTION',
  code,
  en,
  subTasks: subs.map(([s, name]) => sub(`${code}.${s}`, name)),
});

/** The prototype's institution tasks (RP.ROLE_TASKS) with the sub-tasks of docs/01 §6.2. */
export const INSTITUTION_TASKS: readonly TaskDefinition[] = [
  inst('home', 'Home', [['view', 'Overview']]),
  inst('reports', 'Reports', [['view', 'Read reports']]),
  inst('members', 'Members', [
    ['view', 'See members'],
    ['edit', 'Edit member details'],
    ['onboard', 'Onboard members'],
    ['status', 'Activate, suspend, deactivate'],
    ['delink', 'De-link members'],
    ['roles', 'Assign console roles'],
    ['unlock', 'Release locked console accounts'],
    ['approve', 'Approve member requests'],
  ]),
  inst('cards', 'NFC cards', [
    ['view', 'See cards'],
    ['edit', 'Issue, block and re-issue cards'],
  ]),
  inst('config', 'Institution set-up', [
    ['view', 'See set-up'],
    ['edit', 'Change set-up'],
  ]),
  inst('merchants', 'Merchants & QR', [
    ['view', 'See merchants'],
    ['edit', 'Edit merchants and QR codes'],
    ['status', 'Activate and suspend merchants'],
    ['report', 'Merchant reports'],
  ]),
  inst('allowances', 'Allowances', [
    ['view', 'See allowances'],
    ['issue', 'Issue allowances'],
  ]),
  inst('coupons', 'Coupons', [
    ['view', 'See coupons'],
    ['edit', 'Edit coupon types'],
    ['issue', 'Issue coupons'],
  ]),
  inst('fees', 'Fees', [
    ['view', 'See fees'],
    ['edit', 'Edit fee structures and records'],
    ['collect', 'Collect fees'],
    ['approve', 'Approve fee changes'],
  ]),
  inst('events', 'Events', [
    ['view', 'See events'],
    ['edit', 'Edit events'],
  ]),
  inst('passes', 'Entry passes', [
    ['view', 'See passes'],
    ['edit', 'Edit passes'],
  ]),
  inst('settlements', 'Settlements', [['view', 'See settlements']]),
  inst('recon', 'Transactions & MIS', [['view', 'See transactions']]),
  // Client request 2026-10-09: each school's own payment gateway accounts (migration 0065).
  inst('gateways', 'Payment gateways', [
    ['view', 'See payment gateways'],
    ['edit', 'Add and change payment gateways'],
  ]),
  inst('vouchers', 'Accounting', [
    ['view', 'See vouchers'],
    ['edit', 'Post vouchers'],
  ]),
  inst('grievances', 'Grievances', [
    ['view', 'See grievances'],
    ['edit', 'Work on grievances'],
    ['approve', 'Approve resolutions'],
  ]),
  inst('approvals', 'Approvals', [
    ['view', 'See approval requests'],
    ['decide', 'Approve or reject requests'],
  ]),
  inst('admissions', 'Admissions', [
    ['view', 'See applications'],
    ['edit', 'Work on applications'],
    ['approve', 'Approve admissions'],
  ]),
  inst('admfees', 'Admission fees', [
    ['view', 'See admission fees'],
    ['collect', 'Collect admission fees'],
  ]),
  inst('admqr', 'Admission link & QR', [
    ['view', 'See the admission link'],
    ['edit', 'Change the admission link'],
  ]),
  inst('academics', 'Academics', [
    ['view', 'See academics'],
    ['edit', 'Edit academics'],
    ['year', 'Open and close academic years'],
    ['approve', 'Approve closed-year corrections'],
  ]),
  // Client request 2026-10-05 (Phase 10): teachers on the web. Their own classes only — every
  // route still checks the teacher's assignments, as in the app.
  inst('teaching', 'Teaching', [
    ['view', 'My classes, timetable and records'],
    ['marks', 'Enter and publish marks'],
    ['attendance', 'Take class and period attendance'],
    ['homework', 'Set and review homework'],
    ['leave', "Decide my class's student leave"],
    ['announce', 'Send class announcements'],
  ]),
  inst('leave', 'Teacher leave', [
    ['view', 'See leave requests'],
    ['decide', 'Decide leave requests'],
  ]),
  inst('attendance', 'Attendance', [
    ['view', 'See attendance'],
    ['mark', 'Mark attendance'],
    ['config', 'Attendance rules'],
  ]),
  inst('frontdesk', 'Front desk', [
    ['view', 'See the front desk'],
    ['edit', 'Record visitors and movements'],
  ]),
  inst('readers', 'Readers', [
    ['view', 'See readers'],
    ['edit', 'Register and change readers'],
  ]),
  inst('transport', 'Transport', [
    ['view', 'See transport'],
    ['edit', 'Edit routes, vehicles and allocations'],
  ]),
  inst('comms', 'Announcements', [
    ['view', 'See announcements'],
    ['send', 'Send announcements'],
  ]),
  inst('commreport', 'Communication report', [['view', 'Read the communication report']]),
];

const op = (code: string, en: string, subs: readonly SubTaskDefinition[], cr?: string) =>
  ({ scope: 'OPERATOR', code, en, subTasks: subs, ...(cr ? { cr } : {}) }) as TaskDefinition;

/** The prototype's operator tasks (OPTASKS), names as the prototype shows them. */
export const OPERATOR_TASKS: readonly TaskDefinition[] = [
  op('home', 'Home', [sub('home.view', 'Overview and search')]),
  op('tenants', 'Tenants', [
    sub('inst.register', 'Register institutions'),
    sub('inst.lifecycle', 'Activate, suspend, reactivate, cancel'),
    sub('plans.edit', 'Create and edit plans'),
    sub('billing.invoice', 'Generate invoices'),
    sub('billing.paid', 'Mark invoices paid'),
    sub('features.edit', 'Change feature permissions'),
  ]),
  op('settle', 'Settlement', [
    sub('settle.view', 'View queue and statements'),
    sub('settle.stage1', 'Stage-1 approval (maker)'),
    sub('settle.final', 'Final approval (checker)'),
    sub('settle.reject', 'Reject a settlement (checker)'),
    sub('settle.payout', 'Record payout reference (checker)'),
  ]),
  op('recon', 'Reconciliation', [
    sub('recon.upload', 'Upload external statements'),
    sub('recon.resolve', 'Resolve mismatches and refunds'),
    sub('recon.chargeback', 'Raise and complete chargebacks'),
  ]),
  op('jobs', 'Scheduled processing', [
    sub('jobs.view', 'View runs and run logs'),
    sub('jobs.run', 'Run a job now'),
  ]),
  op(
    'crossinst',
    'Cross-institution report',
    [
      sub('xi.aggregate', 'Aggregated figures across institutions'),
      sub('xi.drill', 'Drill through into one institution'),
    ],
    'CR-18',
  ),
  op(
    'access',
    'Access record',
    [sub('access.view', 'Read the cross-institution access record')],
    'CR-18',
  ),
  op('logs', 'Log analyser', [sub('logs.query', 'Query request and activity logs')]),
  op('support', 'Support desk', [
    sub('support.lookup', 'Find tickets and member transactions'),
    sub('support.calls', 'Log calls against tickets'),
  ]),
  op('platform', 'Platform administration', [
    sub('roles.edit', 'Roles, tasks and accounts'),
    sub('lang.edit', 'Languages and translations'),
    sub('partners.edit', 'Partner API clients'),
    sub('quiz.edit', 'Quiz question bank'),
    sub('settings.view', 'See platform settings'),
    sub('settings.edit', 'Change platform settings'),
    sub('mkr.decide', 'Decide platform approval requests'),
  ]),
];

export const ALL_TASKS: readonly TaskDefinition[] = [...INSTITUTION_TASKS, ...OPERATOR_TASKS];

/** Sub-tasks only these roles may hold (client decisions). */
export const RESERVED_SUB_TASKS: Readonly<Record<string, readonly string[]>> = {
  'xi.drill': ['PLATFORM_ADMIN'], // Q10a
  'approvals.decide': ['INSTITUTION_ADMIN'], // Q9
  'mkr.decide': ['PLATFORM_ADMIN'], // ADR-0015 point 5
};

export interface RoleTemplate {
  readonly code: string;
  readonly scope: RoleScope;
  readonly name: string;
  readonly description: string;
  readonly readOnly?: boolean;
  /** Tasks assigned (menus). */
  readonly tasks: readonly string[];
  /** Sub-tasks granted; omitted = every sub-task of the tasks (only `.view` for read-only roles). */
  readonly subTasks?: readonly string[];
}

/** docs/01 §6.1 (institution roles, the prototype's RP.ROLE_TASKS) and §6.3 (operator roles). */
export const ROLE_TEMPLATES: readonly RoleTemplate[] = [
  {
    code: 'INSTITUTION_ADMIN',
    scope: 'INSTITUTION',
    name: 'Institution Administrator',
    description: 'Everything in the institution console',
    // Teaching is a teacher's own work: an administrator who teaches is given the Teacher role too.
    tasks: INSTITUTION_TASKS.map((t) => t.code).filter((c) => c !== 'teaching'),
  },
  {
    code: 'TEACHER',
    scope: 'INSTITUTION',
    name: 'Teacher',
    description: 'Their own classes on the web: marks, attendance, homework, leave, announcements',
    tasks: ['teaching'],
  },
  {
    code: 'ACCOUNTANT',
    scope: 'INSTITUTION',
    name: 'Accountant',
    description: 'Fees, collections, settlements and accounting',
    tasks: [
      'home',
      'reports',
      'fees',
      'events',
      'admfees',
      'settlements',
      'recon',
      'vouchers',
      'gateways',
      'approvals',
    ],
  },
  {
    code: 'COUNSELLOR',
    scope: 'INSTITUTION',
    name: 'Counsellor',
    description: 'Admissions and admission fees',
    tasks: ['home', 'admissions', 'admfees', 'admqr'],
  },
  {
    code: 'ACADEMIC_COORDINATOR',
    scope: 'INSTITUTION',
    name: 'Academic Coordinator',
    description: 'Academics, teacher leave and attendance',
    tasks: ['home', 'reports', 'academics', 'leave', 'attendance', 'comms'],
  },
  {
    code: 'TRANSPORT_ADMIN',
    scope: 'INSTITUTION',
    name: 'Transport Administrator',
    description: 'Routes, vehicles, crew and allocations',
    tasks: ['home', 'reports', 'transport'],
  },
  {
    code: 'MANAGEMENT',
    scope: 'INSTITUTION',
    name: 'Management',
    description: 'Read-only view of the institution',
    readOnly: true,
    tasks: [
      'home',
      'reports',
      'merchants',
      'fees',
      'settlements',
      'recon',
      'vouchers',
      'approvals',
      'attendance',
      'commreport',
    ],
  },
  {
    code: 'GRIEVANCE_OFFICER',
    scope: 'INSTITUTION',
    name: 'Grievance Officer',
    description: 'Grievances and their resolution',
    tasks: ['home', 'grievances', 'approvals'],
  },
  {
    code: 'FRONT_DESK',
    scope: 'INSTITUTION',
    name: 'Front desk',
    description: 'Visitors, late arrivals and early leavers',
    tasks: ['home', 'frontdesk', 'attendance'],
    subTasks: [
      'home.view',
      'frontdesk.view',
      'frontdesk.edit',
      'attendance.view',
      'attendance.mark',
    ],
  },
  {
    code: 'PLATFORM_ADMIN',
    scope: 'OPERATOR',
    name: 'Platform Administrator',
    description: 'Tenants, plans, roles, languages, partners, cross-institution reporting',
    tasks: ['home', 'tenants', 'platform', 'crossinst', 'access', 'jobs'],
    subTasks: [
      'home.view',
      'inst.register',
      'inst.lifecycle',
      'plans.edit',
      'billing.invoice',
      'billing.paid',
      'features.edit',
      'roles.edit',
      'lang.edit',
      'partners.edit',
      'quiz.edit',
      'settings.view',
      'settings.edit',
      'xi.aggregate',
      'xi.drill',
      'access.view',
      'jobs.view',
      'jobs.run',
      'mkr.decide',
    ],
  },
  {
    code: 'SETTLEMENT_MAKER',
    scope: 'OPERATOR',
    name: 'Settlement Maker',
    description: 'Stage-1 approval of settlements',
    tasks: ['home', 'settle'],
    subTasks: ['home.view', 'settle.view', 'settle.stage1'],
  },
  {
    code: 'SETTLEMENT_CHECKER',
    scope: 'OPERATOR',
    name: 'Settlement Checker',
    description: 'Final approval, rejection and payout references',
    tasks: ['home', 'settle'],
    subTasks: ['home.view', 'settle.view', 'settle.final', 'settle.reject', 'settle.payout'],
  },
  {
    code: 'RECON_OFFICER',
    scope: 'OPERATOR',
    name: 'Reconciliation Officer',
    description: 'Statements, mismatches, refunds and chargebacks',
    tasks: ['home', 'recon', 'jobs', 'settle', 'crossinst'],
    subTasks: [
      'home.view',
      'recon.upload',
      'recon.resolve',
      'recon.chargeback',
      'jobs.view',
      'settle.view',
      'xi.aggregate',
    ],
  },
  {
    code: 'SUPPORT_OFFICER',
    scope: 'OPERATOR',
    name: 'Support Officer',
    description: 'Support desk: tickets, transactions and calls',
    tasks: ['home', 'support'],
    subTasks: ['home.view', 'support.lookup', 'support.calls'],
  },
  {
    code: 'LOG_ANALYST',
    scope: 'OPERATOR',
    name: 'Log Analyst',
    description: 'Request and activity logs, access record',
    tasks: ['home', 'logs', 'access'],
    subTasks: ['home.view', 'logs.query', 'access.view'],
  },
];

const tasksOf = (scope: RoleScope) =>
  scope === 'INSTITUTION' ? INSTITUTION_TASKS : OPERATOR_TASKS;

/** The task a sub-task belongs to, in a scope. */
export function taskOfSubTask(scope: RoleScope, subTask: string): TaskDefinition | undefined {
  return tasksOf(scope).find((t) => t.subTasks.some((s) => s.code === subTask));
}

/** The sub-tasks a role template grants (validated against its tasks and the reserved list). */
export function grantsOf(role: RoleTemplate): readonly string[] {
  const tasks = role.tasks.map((code) => {
    const t = tasksOf(role.scope).find((x) => x.code === code);
    if (!t) throw new Error(`Role ${role.code}: unknown task ${code}`);
    return t;
  });
  const all =
    role.subTasks ??
    tasks.flatMap((t) =>
      t.subTasks
        .map((s) => s.code)
        .filter((s) => !role.readOnly || s.endsWith('.view'))
        .filter((s) => !RESERVED_SUB_TASKS[s] || RESERVED_SUB_TASKS[s].includes(role.code)),
    );
  for (const s of all) {
    const t = taskOfSubTask(role.scope, s);
    if (!t || !role.tasks.includes(t.code)) {
      throw new Error(`Role ${role.code}: sub-task ${s} is outside its tasks`);
    }
    const reserved = RESERVED_SUB_TASKS[s];
    if (reserved && !reserved.includes(role.code)) {
      throw new Error(`Role ${role.code}: sub-task ${s} is reserved`);
    }
  }
  return [...new Set(all)];
}

/** Labels of tasks and sub-tasks for the roles screens (translated like every other text). */
export function accessLabels(): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const t of ALL_TASKS) {
    const scope = t.scope.toLowerCase();
    out[`task.${scope}.${t.code}`] = t.en;
    for (const s of t.subTasks) out[`subtask.${scope}.${s.code}`] = s.en;
  }
  return out;
}
