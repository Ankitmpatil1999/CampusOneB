/**
 * The signed-in member's profile and what it may open in the teacher, principal and student views
 * (CR-02: the teacher portal is built from assignments; the principal and management read). The
 * profile is the session's own, or (`for`) a child's profile on the same account (a guardian).
 */
import type { Kysely, Transaction } from 'kysely';
import type { Database, UserTypeCategory } from '../models/ringpe_models';
import { CustomAPIError, NotFoundError } from '../utils/CustomAPIError';
import { isUuid, uuidToBin } from '../utils/idGenerator';
import type { Principal } from '../utils/principal';

type Db = Kysely<Database> | Transaction<Database>;

export interface Member {
  readonly rowId: string;
  readonly institutionId: string;
  readonly accountId: string | null;
  readonly category: UserTypeCategory;
  readonly name: string;
}

export async function memberOf(db: Db, p: Principal, forProfile?: string): Promise<Member> {
  const wanted = forProfile ?? p.profileId;
  if (!isUuid(p.subject) || !wanted || !isUuid(wanted)) throw new NotFoundError();
  const m = await db
    .selectFrom('member_profiles as m')
    .innerJoin('platform_accounts as a', 'a.id', 'm.account_id')
    .innerJoin('user_types as ut', 'ut.id', 'm.user_type_id')
    .select([
      'm.id',
      'm.institution_id',
      'm.account_id',
      'm.first_name',
      'm.last_name',
      'm.status',
      'ut.category',
    ])
    .where('a.public_id', '=', uuidToBin(p.subject))
    .where('m.public_id', '=', uuidToBin(wanted))
    .executeTakeFirst();
  if (!m || m.status === 'INACTIVE') throw new NotFoundError();
  return {
    rowId: String(m.id),
    institutionId: String(m.institution_id),
    accountId: m.account_id === null ? null : String(m.account_id),
    category: m.category,
    name: [m.first_name, m.last_name].filter(Boolean).join(' '),
  };
}

export async function teacherOf(db: Db, p: Principal) {
  const m = await memberOf(db, p);
  if (m.category !== 'TEACHER' && m.category !== 'PRINCIPAL') {
    throw new CustomAPIError(403, 'ACA.TEACHERS_ONLY');
  }
  return m;
}

export async function principalOf(db: Db, p: Principal) {
  const m = await memberOf(db, p);
  if (m.category !== 'PRINCIPAL' && m.category !== 'MANAGEMENT') {
    throw new CustomAPIError(403, 'ACA.PRINCIPAL_ONLY');
  }
  return m;
}

export async function studentOf(db: Db, p: Principal, forProfile?: string) {
  const m = await memberOf(db, p, forProfile);
  if (m.category !== 'STUDENT') throw new CustomAPIError(403, 'ACA.NOT_A_STUDENT_PROFILE');
  return m;
}
