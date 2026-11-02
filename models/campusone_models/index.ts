/**
 * Kysely table types (docs/04). Platform tables of migrations 0001–0004 are here; each area adds a
 * file (identity.ts, governance.ts, …) and joins the `Database` interface below. BIGINT columns arrive as strings
 * (`bigNumberStrings`, ADR-0004) and are typed as such.
 */
import type { ColumnType } from 'kysely';
import type { AccessTables } from './access';
import type { GovernanceTables } from './governance';
import type { IdentityTables } from './identity';
import type { InstitutionTables } from './institution';
import type { OutboxTables } from './outbox';
import type { TerminalTables } from './terminals';
import type { AssetTables } from './assets';
import type { AllowanceTables } from './allowances';
import type { CouponTables } from './coupons';
import type { EventTables } from './events';
import type { PosTables } from './pos';
import type { FeeTables } from './fees';
import type { AdmissionTables } from './admissions';
import type { SettlementTables } from './settlement';
import type { ReconTables } from './recon';
import type { GrievanceTables } from './grievances';
import type { AccountingTables } from './accounting';
import type { TeachingTables } from './teaching';
import type { AttendanceTables } from './attendance';
import type { TransportTables } from './transport';
import type { PlatformToolTables } from './platform-tools';
import type { CommunicationTables } from './communication';
import type { QuizTables } from './quiz';
import type { PartnerTables } from './partners';
import type { PaymentTables } from './payments';
import type { PersonalTables } from './personal';
import type { WalletTables } from './wallet';

export type * from './identity';
export type * from './governance';
export type * from './personal';
export type * from './access';
export type * from './institution';
export type * from './wallet';
export type * from './payments';
export type * from './partners';
export type * from './outbox';
export type * from './terminals';
export type * from './assets';
export type * from './allowances';
export type * from './coupons';
export type * from './events';
export type * from './pos';
export type * from './fees';
export type * from './admissions';
export type * from './settlement';
export type * from './recon';
export type * from './grievances';
export type * from './accounting';
export type * from './teaching';
export type * from './attendance';
export type * from './transport';
export type * from './platform-tools';
export type * from './communication';
export type * from './quiz';

type BigIntId = ColumnType<string, string | number | undefined, never>;
type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;

export interface SchemaMigrationsTable {
  version: string;
  description: string;
  checksum: string;
  applied_at: Timestamp;
  applied_by: string;
}

export interface RefStatusValuesTable {
  domain: string;
  code: string;
  label_key: string;
  tone: 'ok' | 'warn' | 'bad' | 'info' | 'neutral' | 'brand' | 'violet' | 'accent';
  is_terminal: number;
  sort_order: number;
  register_value: string | null;
  srs_ref: string | null;
  rc_ref: string | null;
}

export interface JobRunsTable {
  id: BigIntId;
  public_id: Buffer;
  job_id: string;
  period_key: string;
  trigger_kind: 'SCHEDULE' | 'MANUAL' | 'CATCH_UP';
  requested_by: Buffer | null;
  reason: string | null;
  scope_institution_id: string | null;
  correlation_id: Buffer;
  status: 'STARTED' | 'SUCCESS' | 'PARTIAL_FAILURE' | 'FAILED';
  processed: number;
  failed: number;
  skipped: number;
  started_at: Timestamp;
  ended_at: Timestamp | null;
}

export interface JobRunItemsTable {
  id: BigIntId;
  job_run_id: string;
  institution_id: string | null;
  status: 'SUCCESS' | 'FAILED' | 'SKIPPED';
  items_processed: number;
  items_failed: number;
  note: string | null;
  error_code: string | null;
  started_at: Timestamp;
  ended_at: Timestamp | null;
}

export interface Database
  extends
    IdentityTables,
    GovernanceTables,
    PersonalTables,
    AccessTables,
    InstitutionTables,
    WalletTables,
    PaymentTables,
    PartnerTables,
    OutboxTables,
    TerminalTables,
    AssetTables,
    AllowanceTables,
    CouponTables,
    EventTables,
    PosTables,
    FeeTables,
    AdmissionTables,
    SettlementTables,
    ReconTables,
    GrievanceTables,
    AccountingTables,
    TeachingTables,
    AttendanceTables,
    TransportTables,
    PlatformToolTables,
    CommunicationTables,
    QuizTables {
  schema_migrations: SchemaMigrationsTable;
  ref_status_values: RefStatusValuesTable;
  job_runs: JobRunsTable;
  job_run_items: JobRunItemsTable;
}
