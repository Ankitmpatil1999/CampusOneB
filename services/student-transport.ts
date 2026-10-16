/**
 * A student's school transport, as the student's pages show it (the principal's student page,
 * client 2026-10-14; the console member's profile, client 2026-10-15): the allocation in force — the
 * route, the stop with its pick-up and drop times, the period — and the trips on that route today
 * with the vehicle, the driver and the attendant.
 */
import type { Kysely, Transaction } from 'kysely';
import type { Database } from '../models/ringpe_models';
import { istBusinessDate } from '../utils/format';

type Db = Kysely<Database> | Transaction<Database>;

const nameOf = (first: string | null | undefined, last: string | null | undefined) =>
  [first, last].filter(Boolean).join(' ');
const ymd = (d: Date | string | null | undefined) =>
  d ? (typeof d === 'string' ? d.slice(0, 10) : istBusinessDate(d)) : null;
const hhmm = (t: unknown) => (t ? String(t).slice(0, 5) : null);

export interface StudentTransport {
  readonly allocation: {
    readonly route: { readonly code: string; readonly name: string; readonly type: string };
    readonly stop: { readonly name: string; readonly landmark: string | null };
    readonly pickUp: string | null;
    readonly drop: string | null;
    readonly from: string | null;
    readonly to: string | null;
  } | null;
  readonly trips: readonly {
    readonly session: string;
    readonly direction: string;
    readonly startTime: string;
    readonly vehicle: { readonly name: string; readonly registration: string };
    readonly driver: { readonly name: string; readonly mobile: string | null };
    readonly attendant: string | null;
  }[];
}

export async function studentTransport(
  db: Db,
  q: { readonly profileRowId: string; readonly yearId: string; readonly today: string },
): Promise<StudentTransport> {
  const allocation = await db
    .selectFrom('transport_allocations as al')
    .innerJoin('transport_routes as r', 'r.id', 'al.route_id')
    .innerJoin('transport_stops as st', 'st.id', 'al.stop_id')
    .leftJoin('transport_route_stops as rs', (j) =>
      j.onRef('rs.route_id', '=', 'al.route_id').onRef('rs.stop_id', '=', 'al.stop_id'),
    )
    .select([
      'al.route_id',
      'al.effective_from',
      'al.effective_to',
      'r.code as route_code',
      'r.name as route_name',
      'r.route_type',
      'st.name as stop_name',
      'st.landmark',
      'rs.arrival',
      'rs.departure',
    ])
    .where('al.profile_id', '=', q.profileRowId)
    .where('al.year_id', '=', q.yearId)
    .where('al.active', '=', 1)
    .where('al.effective_to', '>=', q.today)
    .orderBy('al.effective_from')
    .executeTakeFirst();
  if (!allocation) return { allocation: null, trips: [] };
  const trips = await db
    .selectFrom('transport_assignments as ta')
    .innerJoin('transport_sessions as ss', 'ss.id', 'ta.session_id')
    .innerJoin('transport_vehicles as v', 'v.id', 'ta.vehicle_id')
    .innerJoin('transport_crew as dc', 'dc.id', 'ta.driver_crew_id')
    .innerJoin('member_profiles as dp', 'dp.id', 'dc.profile_id')
    .leftJoin('platform_accounts as da', 'da.id', 'dp.account_id')
    .leftJoin('transport_crew as ac', 'ac.id', 'ta.attendant_crew_id')
    .leftJoin('member_profiles as ap', 'ap.id', 'ac.profile_id')
    .select([
      'ss.name as session',
      'ss.direction',
      'ss.start_time',
      'v.name as vehicle',
      'v.registration',
      'dp.first_name as driver_first',
      'dp.last_name as driver_last',
      'dp.contact_mobile as driver_contact',
      'da.mobile as driver_mobile',
      'ap.first_name as attendant_first',
      'ap.last_name as attendant_last',
    ])
    .where('ta.route_id', '=', String(allocation.route_id))
    .where('ta.year_id', '=', q.yearId)
    .where('ta.active', '=', 1)
    .where('ta.effective_from', '<=', q.today)
    .where('ta.effective_to', '>=', q.today)
    .orderBy('ss.start_time')
    .execute();
  return {
    allocation: {
      route: {
        code: allocation.route_code,
        name: allocation.route_name,
        type: allocation.route_type,
      },
      stop: { name: allocation.stop_name, landmark: allocation.landmark },
      pickUp: hhmm(allocation.arrival),
      drop: hhmm(allocation.departure),
      from: ymd(allocation.effective_from),
      to: ymd(allocation.effective_to),
    },
    trips: trips.map((t) => ({
      session: t.session,
      direction: t.direction,
      startTime: String(t.start_time).slice(0, 5),
      vehicle: { name: t.vehicle, registration: t.registration },
      driver: {
        name: nameOf(t.driver_first, t.driver_last),
        mobile: t.driver_mobile ?? t.driver_contact,
      },
      attendant: t.attendant_first ? nameOf(t.attendant_first, t.attendant_last) : null,
    })),
  };
}
