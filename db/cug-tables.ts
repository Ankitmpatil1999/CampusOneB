/**
 * The two databases (client 2026-10-21: "separate the RingPe database and the CUG database", as the
 * earlier application had them; migration 0081). Both live on the same MySQL server, so one
 * connection, one transaction and the foreign keys still span them — nothing the application does
 * changes:
 *
 * - **RingPe** (the database in DATABASE_URL, e.g. `ringpe`): the platform — accounts, sign-in and
 *   sessions, personal details, languages and translations, reference data, roles and permissions,
 *   operators, plans and RingPe's billing of schools, platform settings, partner API clients, jobs,
 *   files, and the shared logs and outboxes (audit, requests, communication, notifications).
 * - **CUG** (`<RingPe database>_cug`, e.g. `ringpe_cug`): the schools — every table listed here.
 *
 * The application keeps writing plain table names: `CugSchemaPlugin` (models/cug-schema-plugin.ts)
 * puts `<cug>.` before every table of this list, in Kysely queries and in raw `sql` text alike.
 * A migration after 0081 that touches one of these tables writes `{{CUG}}.<table>` (the migrator
 * fills in the name); a new school table is created as `{{CUG}}.<table>` and added here — the
 * migrations suite checks that this list and the CUG database hold exactly the same tables.
 */
export const CUG_TABLES: readonly string[] = [
  // --- the school and its set-up
  'institutions',
  'institution_contacts',
  'institution_settings',
  'institution_lifecycle_events',
  'institution_comm_events',
  'institution_corporate_codes',
  'institution_payment_gateways',
  'class_corporate_codes',
  'feature_toggles',
  'feature_change_log',
  'notification_channel_settings',
  'onboarding_checklist_steps',
  'cancellation_requests',
  'data_exports',
  'custom_field_definitions',
  'custom_field_options',
  'custom_field_values',
  'custom_field_value_options',
  // --- people and their roles at the school
  'user_types',
  'departments',
  'member_profiles',
  'member_uploads',
  'guardianships',
  'profile_roles',
  // --- academics
  'academic_years',
  'classes',
  'sections',
  'subjects',
  'class_subjects',
  'periods',
  'timetable_slots',
  'teacher_assignments',
  'enrolments',
  'enrolment_changes',
  'rollovers',
  'rollover_items',
  'calendar_entries',
  'calendar_entry_targets',
  'exam_names',
  'exams',
  'marks',
  'homework',
  'homework_students',
  'homework_submissions',
  'student_leaves',
  'staff_leaves',
  'quiz_attempts',
  'quiz_attempt_questions',
  // --- attendance, readers and cards
  'attendance_types',
  'attendance_days',
  'attendance_events',
  'period_attendance',
  'location_attendance',
  'auto_absent_settings',
  'auto_absent_runs',
  'terminals',
  'terminal_changes',
  'terminal_nonces',
  'cards',
  'card_writes',
  'visitors',
  // --- transport
  'transport_routes',
  'transport_stops',
  'transport_route_stops',
  'transport_vehicles',
  'transport_crew',
  'transport_assignments',
  'transport_allocations',
  'transport_sessions',
  'transport_trips',
  'transport_trip_stops',
  'transport_trip_events',
  'transport_boardings',
  // --- admissions
  'admission_links',
  'admission_applications',
  'admission_application_seq',
  'admission_documents',
  'admission_references',
  'admission_payments',
  'admission_imports',
  // --- fees
  'fee_heads',
  'fee_structures',
  'fee_structure_versions',
  'fee_structure_classes',
  'fee_structure_heads',
  'fee_structure_instalments',
  'fee_assignments',
  'fee_records',
  'fee_record_heads',
  'fee_uploads',
  'fee_collections',
  'fee_collection_attempts',
  'fee_payment_requests',
  'fee_consents',
  'fee_financing_registrations',
  'fee_financing_records',
  'entry_fees',
  // --- wallets, ledger and money movements
  'wallets',
  'wallet_balances',
  'wallet_day_balances',
  'wallet_number_sequences',
  'virtual_accounts',
  'ledger_accounts',
  'ledger_transactions',
  'ledger_entries',
  'ledger_idempotency',
  'payment_attempts',
  'payment_requests',
  'refunds',
  'chargebacks',
  'bank_credits',
  'bank_va_validations',
  'allowance_grants',
  // --- merchants, POS, coupons, events and assets
  'merchants',
  'merchant_qr_codes',
  'merchant_asset_groups',
  'asset_groups',
  'assets',
  'pos_outlets',
  'pos_categories',
  'pos_items',
  'pos_orders',
  'pos_order_lines',
  'pos_operator_tags',
  'pos_offline_batches',
  'pos_offline_batch_items',
  'pos_offline_captures',
  'coupon_types',
  'coupon_type_merchants',
  'coupon_slots',
  'coupons',
  'coupon_issuances',
  'coupon_redemptions',
  'coupon_taps',
  'events',
  'event_heads',
  'entry_passes',
  'entry_pass_scans',
  // --- settlement, reconciliation and accounting
  'settlements',
  'settlement_lines',
  'recon_statements',
  'recon_statement_rows',
  'recon_mismatches',
  'accounting_settings',
  'accounting_mappings',
  'accounting_vouchers',
  // --- communication and support at the school
  'announcement_categories',
  'announcements',
  'announcement_recipients',
  'conversations',
  'conversation_participants',
  'direct_messages',
  'comm_log_daily',
  'comm_log_daily_done',
  'comm_log_gaps',
  'tickets',
  'ticket_events',
  'call_logs',
];

const CUG = new Set(CUG_TABLES);

export const isCugTable = (name: string) => CUG.has(name);

/** The CUG database that goes with a RingPe database (`ringpe` → `ringpe_cug`). */
export const cugDatabaseOf = (ringpeDatabase: string) => `${ringpeDatabase}_cug`;

/** The database named in a mysql:// URL. */
export function databaseOfUrl(url: string): string {
  const name = decodeURIComponent(new URL(url).pathname.replace(/^\//, '').split('/')[0] ?? '');
  if (!name) throw new Error('The database URL names no database');
  return name;
}

/**
 * Puts the CUG database before CUG tables in SQL text (raw `sql` fragments, the development seed):
 * only where a table name stands — after FROM, JOIN, INTO, UPDATE or TABLE — never a column
 * (`ON DUPLICATE KEY UPDATE x = …`) and never a name that is already qualified.
 */
export function qualifyCugSql(text: string, cugDatabase: string): string {
  return text.replace(
    /\b(FROM|JOIN|INTO|UPDATE|TABLE)(\s+)(`?)([A-Za-z_][A-Za-z0-9_]*)\3(?![.\w`])(?!\s*=)/gi,
    (all, kw: string, ws: string, _q: string, name: string, offset: number, whole: string) => {
      if (!CUG.has(name)) return all;
      // `x`.`table` or x.table: already qualified.
      if (whole[offset - 1] === '.') return all;
      return `${kw}${ws}\`${cugDatabase}\`.\`${name}\``;
    },
  );
}
