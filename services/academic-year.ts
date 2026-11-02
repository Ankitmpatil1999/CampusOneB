/**
 * The academic year a record belongs to (CR-13; RNG-ACA-438…440, RNG-ACA-456). A request names the
 * year, or the institution's current year is taken; never the browser's value or today's date alone.
 * A closed year refuses every write; a date must fall inside its year.
 */
import type { Kysely, Transaction } from 'kysely';
import type { Database } from '../models/campusone_models';
import { CustomAPIError, NotFoundError, ValidationError } from '../utils/CustomAPIError';
import { formatDate } from '../utils/format';
import { binToUuid, isUuid, uuidToBin } from '../utils/idGenerator';
import type { Principal } from '../utils/principal';

type Db = Kysely<Database> | Transaction<Database>;

export interface Year {
  readonly id: string;
  readonly publicId: string;
  readonly label: string;
  readonly startsOn: string;
  readonly endsOn: string;
  readonly closed: boolean;
  readonly current: boolean;
}

const day = (d: Date | string) =>
  typeof d === 'string'
    ? d.slice(0, 10)
    : new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);

/** The console's institution (row id) from the session; another institution never. */
export async function institutionOf(db: Db, p: Principal) {
  if (!p.institutionId || !isUuid(p.institutionId)) throw new NotFoundError();
  const i = await db
    .selectFrom('institutions')
    .select(['id', 'name', 'short_name'])
    .where('public_id', '=', uuidToBin(p.institutionId))
    .executeTakeFirst();
  if (!i) throw new NotFoundError();
  return { id: String(i.id), name: i.name, shortName: i.short_name };
}

const toYear = (y: {
  id: string;
  public_id: Buffer;
  label: string;
  starts_on: Date | string;
  ends_on: Date | string;
  status: string;
  is_current: number | boolean;
}): Year => ({
  id: String(y.id),
  publicId: binToUuid(y.public_id),
  label: y.label,
  startsOn: day(y.starts_on),
  endsOn: day(y.ends_on),
  closed: y.status === 'CLOSED',
  current: Boolean(Number(y.is_current)),
});

/** The named year of the institution, or its current year when none is named. */
export async function yearFor(db: Db, institutionId: string, yearId?: string | null, lock = false) {
  let q = db
    .selectFrom('academic_years')
    .select(['id', 'public_id', 'label', 'starts_on', 'ends_on', 'status', 'is_current'])
    .where('institution_id', '=', institutionId);
  if (yearId) {
    if (!isUuid(yearId)) throw new NotFoundError();
    q = q.where('public_id', '=', uuidToBin(yearId));
  } else q = q.where('is_current', '=', 1 as never);
  const y = await (lock ? q.forUpdate() : q).executeTakeFirst();
  if (!y) {
    if (yearId) throw new NotFoundError();
    throw new CustomAPIError(409, 'ACA.NO_CURRENT_YEAR');
  }
  return toYear(y as Parameters<typeof toYear>[0]);
}

/** The year after `year` (the one starting next), if the institution has added it. */
export async function nextYear(db: Db, institutionId: string, year: Year) {
  const y = await db
    .selectFrom('academic_years')
    .select(['id', 'public_id', 'label', 'starts_on', 'ends_on', 'status', 'is_current'])
    .where('institution_id', '=', institutionId)
    .where('starts_on', '>', year.endsOn)
    .orderBy('starts_on')
    .limit(1)
    .executeTakeFirst();
  return y ? toYear(y as Parameters<typeof toYear>[0]) : null;
}

/** A closed year accepts no writes (RNG-ACA-456). */
export function assertOpen(year: Year) {
  if (year.closed) {
    throw new CustomAPIError(409, 'ACA.YEAR_CLOSED', { params: { label: year.label } });
  }
}

/** A date inside the year, or a field error naming the year's span. */
export function assertInYear(year: Year, date: string, field: string) {
  if (date < year.startsOn || date > year.endsOn) {
    throw new ValidationError([
      {
        field,
        code: 'ACA.DATE_OUTSIDE_YEAR',
        params: {
          label: year.label,
          from: formatDate(year.startsOn),
          to: formatDate(year.endsOn),
        },
      },
    ]);
  }
}

export const yearView = (y: Year) => ({
  id: y.publicId,
  label: y.label,
  startsOn: y.startsOn,
  endsOn: y.endsOn,
  closed: y.closed,
  current: y.current,
});
