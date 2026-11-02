/**
 * Reference seeds (docs/04 §11): status registers, payment channels, languages. Idempotent
 * (ON DUPLICATE KEY UPDATE), generated from the shared registers so code and database agree.
 */
import { createHash } from 'node:crypto';
import {
  ADDRESS_PROOF_TYPES,
  ALL_TASKS,
  ALL_STATUS_DOMAINS,
  ROLE_TEMPLATES,
  grantsOf,
  CONSENT_DOCUMENTS,
  ID_DOCUMENT_TYPES,
  INCOME_BANDS,
  OCCUPATIONS,
  PLAN_SEEDS,
  RELATIONS,
  SECURITY_QUESTIONS,
  renderStatusSeedSql,
} from '../config/registers';
import { LAUNCH_LANGUAGES } from '../utils/i18n';
import { MACHINE_TRANSLATIONS } from './translations';

/** RNG-PAY-129 payment modes 1–8 (9 POS NFC pending Q14 M7). */
export const PAYMENT_CHANNELS = [
  { code: 'TRANSFER', mode: 1 },
  { code: 'STATIC_QR', mode: 2 },
  { code: 'ALLOWANCE', mode: 3 },
  { code: 'TUITION', mode: 4 },
  { code: 'POS_QR', mode: 5 },
  { code: 'DYNAMIC_QR', mode: 6 },
  { code: 'NFC', mode: 7 },
  { code: 'EVENT', mode: 8 },
] as const;

/** A MySQL string literal; line breaks are escaped so each statement stays on one line. */
const q = (v: string) =>
  `'${v.replace(/\\/g, '\\\\').replace(/'/g, "''").replace(/\n/g, '\\n').replace(/\r/g, '\\r')}'`;

export function renderReferenceSeedSql(): string {
  const channels = PAYMENT_CHANNELS.map(
    (c) =>
      `INSERT INTO ref_payment_channels (code, legacy_mode, label_key) VALUES (${q(c.code)}, ${c.mode}, ${q(`channel.${c.code.toLowerCase()}`)}) ON DUPLICATE KEY UPDATE legacy_mode = VALUES(legacy_mode), label_key = VALUES(label_key);`,
  );
  const languages = LAUNCH_LANGUAGES.map(
    (l, i) =>
      `INSERT INTO languages (code, name, native_name, enabled, is_default, sort_order) VALUES (${q(l.code)}, ${q(l.name)}, ${q(l.nativeName)}, TRUE, ${i === 0 ? 'TRUE' : 'FALSE'}, ${(i + 1) * 10}) ON DUPLICATE KEY UPDATE name = VALUES(name), native_name = VALUES(native_name), sort_order = VALUES(sort_order);`,
  );
  const questions = SECURITY_QUESTIONS.map(
    (sq, i) =>
      `INSERT INTO ref_security_questions (code, label_key, text_en, active, sort_order) VALUES (${q(sq.code)}, ${q(sq.labelKey)}, ${q(sq.en)}, TRUE, ${(i + 1) * 10}) ON DUPLICATE KEY UPDATE label_key = VALUES(label_key), text_en = VALUES(text_en), sort_order = VALUES(sort_order);`,
  );
  const idDocs = ID_DOCUMENT_TYPES.map(
    (d, i) =>
      `INSERT INTO ref_id_document_types (code, label_key, number_regex, active, sort_order) VALUES (${q(d.code)}, ${q(d.labelKey)}, ${q(d.pattern)}, TRUE, ${(i + 1) * 10}) ON DUPLICATE KEY UPDATE label_key = VALUES(label_key), number_regex = VALUES(number_regex), sort_order = VALUES(sort_order);`,
  );
  // A version's text is inserted once and never overwritten (the consent records point at it); a
  // new text arrives as a new version. Only the active flag follows the register.
  const consents = CONSENT_DOCUMENTS.map(
    (c) =>
      `INSERT INTO consent_documents (kind, version, title_en, body_en, is_draft, active) VALUES (${q(c.kind)}, ${q(c.version)}, ${q(c.title)}, ${q(c.body)}, ${c.draft ? 'TRUE' : 'FALSE'}, ${c.active ? 'TRUE' : 'FALSE'}) ON DUPLICATE KEY UPDATE active = VALUES(active);`,
  );
  // Personal-details masters (6.11): editable lists, seeded from the registers.
  const list = (table: string, items: readonly { code: string; labelKey: string }[]) =>
    items.map(
      (it, i) =>
        `INSERT INTO ${table} (code, label_key, active, sort_order) VALUES (${q(it.code)}, ${q(it.labelKey)}, TRUE, ${(i + 1) * 10}) ON DUPLICATE KEY UPDATE label_key = VALUES(label_key), sort_order = VALUES(sort_order);`,
    );
  const relations = RELATIONS.map(
    (r, i) =>
      `INSERT INTO ref_relations (code, label_key, usage_scope, active, sort_order) VALUES (${q(r.code)}, ${q(r.labelKey)}, ${q(r.scopes.join(','))}, TRUE, ${(i + 1) * 10}) ON DUPLICATE KEY UPDATE label_key = VALUES(label_key), usage_scope = VALUES(usage_scope), sort_order = VALUES(sort_order);`,
  );
  const masters = [
    ...relations,
    ...list('ref_income_bands', INCOME_BANDS),
    ...list('ref_occupations', OCCUPATIONS),
    ...list('ref_address_proof_types', ADDRESS_PROOF_TYPES),
  ];
  // Roles → tasks → sub-tasks (6.28, docs/01 §6; prototype o.roles). Seeded roles keep a stable
  // public id derived from their code. Their tasks and grants are seeded once (grants_seeded): an
  // administrator's later changes on the roles screen are never undone by a re-seed.
  const tasks = ALL_TASKS.flatMap((t, i) => [
    `INSERT INTO tasks (scope, code, label_key, sort_order) VALUES (${q(t.scope)}, ${q(t.code)}, ${q(`task.${t.scope.toLowerCase()}.${t.code}`)}, ${(i + 1) * 10}) ON DUPLICATE KEY UPDATE label_key = VALUES(label_key), sort_order = VALUES(sort_order);`,
    ...t.subTasks.map(
      (st) =>
        `INSERT INTO sub_tasks (task_id, code, label_key, view_only) SELECT id, ${q(st.code)}, ${q(`subtask.${t.scope.toLowerCase()}.${st.code}`)}, ${st.code.endsWith('.view') ? 'TRUE' : 'FALSE'} FROM tasks WHERE scope = ${q(t.scope)} AND code = ${q(t.code)} ON DUPLICATE KEY UPDATE label_key = VALUES(label_key), view_only = VALUES(view_only);`,
    ),
  ]);
  /** A stable UUID (version 8, RFC 9562) derived from a seeded row's kind and code. */
  const stableId = (kind: string, code: string) => {
    const h = createHash('sha256').update(`${kind}:${code}`).digest('hex').slice(0, 32).split('');
    h[12] = '8';
    h[16] = '89ab'[parseInt(h[16] ?? '0', 16) % 4] ?? '8';
    return h.join('').toUpperCase();
  };
  const roles = ROLE_TEMPLATES.flatMap((r) => [
    `INSERT INTO roles (public_id, scope, code, name, description, read_only) VALUES (UNHEX('${stableId('role', r.code)}'), ${q(r.scope)}, ${q(r.code)}, ${q(r.name)}, ${q(r.description)}, ${r.readOnly ? 'TRUE' : 'FALSE'}) ON DUPLICATE KEY UPDATE public_id = VALUES(public_id), name = VALUES(name), description = VALUES(description), read_only = VALUES(read_only);`,
    `INSERT INTO role_task_assignments (role_id, task_id) SELECT r.id, t.id FROM roles r JOIN tasks t ON t.scope = r.scope WHERE r.code = ${q(r.code)} AND r.grants_seeded = FALSE AND t.code IN (${r.tasks.map(q).join(', ')}) ON DUPLICATE KEY UPDATE role_task_assignments.task_id = role_task_assignments.task_id;`,
    `INSERT INTO role_tasks (role_id, sub_task_id) SELECT r.id, st.id FROM roles r JOIN tasks t ON t.scope = r.scope JOIN sub_tasks st ON st.task_id = t.id WHERE r.code = ${q(r.code)} AND r.grants_seeded = FALSE AND st.code IN (${grantsOf(r).map(q).join(', ')}) ON DUPLICATE KEY UPDATE role_tasks.sub_task_id = role_tasks.sub_task_id;`,
    `UPDATE roles SET grants_seeded = TRUE WHERE code = ${q(r.code)};`,
  ]);
  // Plans (FR-SAS-05): the prototype's plans as draft data. Each plan, its modules and allowances
  // are written once; operators' later edits (2.7) are never overwritten by a re-seed.
  const union = (rows: readonly string[]) => rows.join(' UNION ALL ');
  // Version 1 of each plan's terms (migration 0015); the default platform fee is ₹1.00 up to ₹100,
  // else 0.5 % (BR-17). Nothing is written once the plan has a version.
  const a = (p: (typeof PLAN_SEEDS)[number]) => p.allowances;
  const plans = PLAN_SEEDS.flatMap((p) => [
    `INSERT INTO plans (public_id, code, name, description) VALUES (UNHEX('${stableId('plan', p.code)}'), ${q(p.code)}, ${q(p.name)}, ${q(p.description)}) ON DUPLICATE KEY UPDATE plans.code = plans.code;`,
    `INSERT INTO plan_versions (plan_id, version, cycle, price_paise, trial_days, members, sms_per_month, whatsapp_per_month, storage_gb, fee_flat_paise, fee_threshold_paise, fee_percent_bp) SELECT p.id, 1, ${q(p.cycle)}, ${p.pricePaise}, 30, ${a(p).MEMBERS}, ${a(p).SMS}, ${a(p).WHATSAPP}, ${a(p).STORAGE_GB}, 100, 10000, 50 FROM plans p WHERE p.code = ${q(p.code)} AND NOT EXISTS (SELECT 1 FROM plan_versions v WHERE v.plan_id = p.id) ON DUPLICATE KEY UPDATE plan_versions.id = plan_versions.id;`,
    `INSERT INTO plan_version_modules (plan_version_id, module_key) SELECT v.id, m.k FROM plan_versions v JOIN plans p ON p.id = v.plan_id JOIN (${union(p.modules.map((m) => `SELECT ${q(m)} AS k`))}) m WHERE p.code = ${q(p.code)} AND v.version = 1 AND NOT EXISTS (SELECT 1 FROM plan_version_modules x WHERE x.plan_version_id = v.id) ON DUPLICATE KEY UPDATE plan_version_modules.module_key = plan_version_modules.module_key;`,
    `UPDATE plans p JOIN plan_versions v ON v.plan_id = p.id AND v.version = 1 SET p.current_version_id = v.id WHERE p.code = ${q(p.code)} AND p.current_version_id IS NULL;`,
  ]);
  // CampusOne's invoice and bank details: example values until the client supplies them (Q25, Q26;
  // client 2026-10-03 "take as example"). Written once; operators' edits are never overwritten.
  const billingProfile = [
    `INSERT INTO platform_billing_profile (id, legal_name, gstin, address, state_code, sac_code, payee_name, payee_bank, payee_account_no, payee_ifsc, is_example) VALUES (1, 'CampusOne Technologies Private Limited (example)', '29AAACR0000A1Z5', 'Example address, 2nd Floor, MG Road, Bengaluru, Karnataka 560001', '29', '998314', 'CampusOne Technologies Private Limited (example)', 'Example Bank', '000000000000', 'EXMP0000001', TRUE) ON DUPLICATE KEY UPDATE platform_billing_profile.id = platform_billing_profile.id;`,
  ];
  // Machine drafts (client 2026-10-02); a reviewed or edited text (HUMAN) is kept.
  // 500 rows a statement: one statement per row made seeding take minutes.
  const rows = Object.entries(MACHINE_TRANSLATIONS).flatMap(([lang, texts]) =>
    Object.entries(texts).map(([key, text]) => `(${q(lang)}, ${q(key)}, ${q(text)}, 'MACHINE')`),
  );
  const translations: string[] = [];
  for (let i = 0; i < rows.length; i += 500) {
    translations.push(
      `INSERT INTO translations (lang_code, msg_key, text, source) VALUES ${rows.slice(i, i + 500).join(', ')} ON DUPLICATE KEY UPDATE text = IF(source = 'MACHINE', VALUES(text), text), updated_at = IF(source = 'MACHINE', UTC_TIMESTAMP(3), updated_at);`,
    );
  }
  return [
    renderStatusSeedSql(ALL_STATUS_DOMAINS),
    '-- payment channels (RNG-PAY-129)',
    ...channels,
    '',
    '-- launch languages in picker order (Q18, client 2026-10-02)',
    ...languages,
    '',
    '-- security questions, identity documents (OI-IDN-02), consent and terms texts',
    ...questions,
    ...idDocs,
    ...consents,
    '',
    '-- personal-details masters (6.11): relations, income bands, occupations, address proofs',
    ...masters,
    '',
    '-- roles, tasks and sub-tasks (6.28; docs/01 §6)',
    ...tasks,
    ...roles,
    '',
    '-- plans (FR-SAS-05; prices wait for Q14 M14)',
    ...plans,
    '',
    '-- CampusOne invoice and bank details (example values until Q25/Q26 are answered)',
    ...billingProfile,
    '',
    '-- machine-draft translations (client 2026-10-02; reviewed in the back office)',
    ...translations,
    '',
  ].join('\n');
}
