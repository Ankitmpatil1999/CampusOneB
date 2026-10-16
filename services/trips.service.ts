/**
 * Trips (SRS 22.8–22.18; TRN-023…034; job trip-generation; FR-TRN-05…07; BR-62; RC-25; OI-TRN-15/16,
 * OI-TRN-20…26; prototype c.trips, m.crew, m.transport).
 *
 * - **Generation (22.17):** each day one trip per active assignment whose dates, session days, route and
 *   vehicle allow it — not on a holiday for everyone — with its stops in travel order (a pickup runs
 *   the route backwards) and planned times from the route's times, or from the session's start and the
 *   distance at `trn.speedKmph`. Trips still Scheduled from an earlier day are cancelled. Re-runs never
 *   duplicate (one trip per assignment and date).
 * - **The crew** (the trip's driver or attendant) starts the trip, marks each stop reached, departed or
 *   skipped in order (BR-62; a skip needs remarks), records boarding (RC-25) and completes the trip once
 *   the final stop is reached. Every step is an event (OI-TRN-22) and goes to the console in real time;
 *   passengers and families are told when the trip starts or is cancelled (OI-TRN-25).
 * - **The console** lists trips with server-side filters (OI-TRN-16), cancels a scheduled trip with
 *   remarks (OI-TRN-15) and reads the eight reports (OI-TRN-20).
 * - **The family** sees the allocation, today's trips and their progress (OI-TRN-24).
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import { LIMITS, type LimitDefinition } from '../config/registers';
import type { BoardingStatus, Database, TripStatus } from '../models/ringpe_models';
import type { JobContext } from '../schedulers';
import { CustomAPIError, ValidationError } from '../utils/CustomAPIError';
import { istBusinessDate } from '../utils/format';
import { binToUuid, isUuid, newPublicIdPair, uuidToBin } from '../utils/idGenerator';
import { emit, rooms } from '../utils/outbox';
import type { Principal } from '../utils/principal';
import { institutionOf } from './academic-year';
import { recordAudit } from './audit.service';
import { occurrences } from './calendar.service';
import { memberOf } from './member-roles';
import { notify } from './notifications.service';
import type { SettingsService } from './settings.service';

type Db = Kysely<Database> | Transaction<Database>;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const WEEKDAY = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'] as const;
/** How often reading today's trips looks for any still to make (per institution). */
const ENSURE_EVERY_MS = 60_000;
const nameOf = (first: string | null | undefined, last: string | null | undefined) =>
  [first, last].filter(Boolean).join(' ');
const ymd = (d: Date | string) => (typeof d === 'string' ? d.slice(0, 10) : istBusinessDate(d));
const hm = (t: string | null) => (t ? t.slice(0, 5) : null);
const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);
const addDays = (d: string, n: number) => {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};
const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const toTime = (m: number) => {
  const x = Math.max(0, Math.min(23 * 60 + 59, Math.round(m)));
  return `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}:00`;
};
export const TRANSPORT_REPORTS = [
  'daily-summary',
  'route-performance',
  'vehicle-utilisation',
  'driver-performance',
  'attendant-performance',
  'allocation',
  'cancelled-trips',
  'trip-stops',
] as const;
export type TransportReport = (typeof TRANSPORT_REPORTS)[number];

export class TripsService {
  constructor(
    private readonly deps: {
      readonly db: Kysely<Database>;
      readonly settings?: SettingsService;
      readonly now?: () => Date;
    },
  ) {}

  private now() {
    return this.deps.now?.() ?? new Date();
  }

  /** When each institution's trips of the day were last checked on reading (id → date and time). */
  private readonly checked = new Map<string, { date: string; at: number }>();

  /**
   * Today's trips, made when they are read (client 2026-10-15: "Active trips are not displaying in
   * Live today"). The daily job makes them at 00:10; a route assigned later in the day, or a day
   * the job didn't run, had none until the next run. Generation is re-runnable, so the trips still
   * missing are made here — looked for at most once a minute per institution. A failure leaves the
   * reading as it was; the job and the next look try again.
   */
  private async ensureToday(institutionId: string, date: string) {
    if (date !== istBusinessDate(this.now())) return;
    const at = this.now().getTime();
    const last = this.checked.get(institutionId);
    if (last && last.date === date && at - last.at < ENSURE_EVERY_MS) return;
    this.checked.set(institutionId, { date, at });
    try {
      if (await this.missingToday(institutionId, date)) await this.generate(institutionId, date);
    } catch {
      this.checked.delete(institutionId);
    }
  }

  /** Whether an assignment that runs on the date has no trip yet (the job's own selection). */
  private async missingToday(institutionId: string, date: string) {
    const weekday = WEEKDAY[new Date(`${date}T00:00:00Z`).getUTCDay()]!;
    const rows = await this.deps.db
      .selectFrom('transport_assignments as a')
      .innerJoin('transport_sessions as s', 's.id', 'a.session_id')
      .innerJoin('transport_routes as r', 'r.id', 'a.route_id')
      .innerJoin('transport_vehicles as v', 'v.id', 'a.vehicle_id')
      .leftJoin('transport_trips as t', (j) =>
        j.onRef('t.assignment_id', '=', 'a.id').on('t.trip_date', '=', date),
      )
      .select('s.days')
      .where('a.institution_id', '=', institutionId)
      .where('a.active', '=', 1)
      .where('a.effective_from', '<=', date)
      .where('a.effective_to', '>=', date)
      .where('s.active', '=', 1)
      .where('r.active', '=', 1)
      .where('v.active', '=', 1)
      .where('t.id', 'is', null)
      .execute();
    return rows.some((r) => r.days.split(',').includes(weekday));
  }

  private by(p: Principal) {
    return isUuid(p.subject) ? uuidToBin(p.subject) : null;
  }

  private async limit(l: LimitDefinition) {
    if (!this.deps.settings) return Number(l.value);
    const v = await this.deps.settings.values();
    return Number(v[l.key] ?? l.value);
  }

  private async holiday(db: Db, institutionId: string, date: string) {
    const rows = await db
      .selectFrom('calendar_entries')
      .select(['start_date', 'end_date', 'recurrence', 'repeat_until'])
      .where('institution_id', '=', institutionId)
      .where('type', '=', 'Holiday')
      .where('audience', '=', 'ALL')
      .where('deleted_at', 'is', null)
      .execute();
    return rows.some(
      (h) =>
        occurrences(
          {
            start: ymd(h.start_date),
            end: ymd(h.end_date),
            recurrence: h.recurrence,
            until: h.repeat_until ? ymd(h.repeat_until) : null,
          },
          date,
          date,
        ).length > 0,
    );
  }

  private async event(
    db: Db,
    institutionId: string,
    tripId: string,
    e: {
      event:
        'SCHEDULED' | 'STARTED' | 'REACHED' | 'DEPARTED' | 'SKIPPED' | 'COMPLETED' | 'CANCELLED';
      seq?: number | null;
      actor?: Buffer | null;
      remarks?: string | null;
    },
    at: Date,
  ) {
    await db
      .insertInto('transport_trip_events')
      .values({
        institution_id: institutionId,
        trip_id: tripId,
        event: e.event,
        seq: e.seq ?? null,
        actor: e.actor ?? null,
        remarks: e.remarks ?? null,
        at,
      })
      .execute();
    const trip = await db
      .selectFrom('transport_trips')
      .select('public_id')
      .where('id', '=', tripId)
      .executeTakeFirst();
    await emit(db, {
      institutionId,
      type: 'trip.updated',
      rooms: [rooms.institutionConsole(institutionId)],
      data: {
        tripId: trip ? binToUuid(trip.public_id) : null,
        event: e.event,
        seq: e.seq ?? null,
      },
    });
  }

  // --- the job trip-generation ----------------------------------------------------------------------------
  async run(ctx: Pick<JobContext, 'item'> & { scope?: { institutionId: string } | undefined }) {
    const date = istBusinessDate(this.now());
    let q = this.deps.db
      .selectFrom('transport_assignments')
      .select('institution_id')
      .distinct()
      .where('active', '=', 1)
      .where('effective_from', '<=', date)
      .where('effective_to', '>=', date);
    if (ctx.scope) q = q.where('institution_id', '=', ctx.scope.institutionId);
    for (const r of await q.execute()) {
      const id = String(r.institution_id);
      try {
        const out = await this.generate(id, date);
        ctx.item({
          institutionId: id,
          status: out.created || out.cancelled ? 'SUCCESS' : 'SKIPPED',
          processed: out.created,
          failed: 0,
          note: `${out.created} trips created, ${out.cancelled} stale trips cancelled${out.holiday ? ' (holiday: none created)' : ''}`,
        });
      } catch {
        ctx.item({
          institutionId: id,
          status: 'FAILED',
          processed: 0,
          failed: 1,
          note: 'Trip generation failed; the next run tries again',
        });
      }
    }
  }

  /** The day's trips for one institution (re-runnable). */
  async generate(institutionId: string, date: string) {
    const db = this.deps.db;
    const at = this.now();
    const speed = await this.limit(LIMITS.transportSpeedKmph);
    let cancelled = 0;
    await db.transaction().execute(async (trx) => {
      const stale = await trx
        .selectFrom('transport_trips')
        .select('id')
        .where('institution_id', '=', institutionId)
        .where('status', '=', 'SCHEDULED')
        .where('trip_date', '<', date)
        .forUpdate()
        .execute();
      for (const t of stale) {
        await trx
          .updateTable('transport_trips')
          .set({
            status: 'CANCELLED',
            cancelled_at: at,
            cancel_remarks: 'Not run on its date',
            row_version: sql<number>`row_version + 1`,
          })
          .where('id', '=', t.id)
          .execute();
        await this.event(
          trx,
          institutionId,
          t.id,
          { event: 'CANCELLED', remarks: 'Not run on its date' },
          at,
        );
      }
      cancelled = stale.length;
    });
    if (await this.holiday(db, institutionId, date))
      return { created: 0, cancelled, holiday: true };
    const weekday = WEEKDAY[new Date(`${date}T00:00:00Z`).getUTCDay()]!;
    const assignments = await db
      .selectFrom('transport_assignments as a')
      .innerJoin('transport_sessions as s', 's.id', 'a.session_id')
      .innerJoin('transport_routes as r', 'r.id', 'a.route_id')
      .innerJoin('transport_vehicles as v', 'v.id', 'a.vehicle_id')
      .select([
        'a.id',
        'a.route_id',
        'a.session_id',
        'a.vehicle_id',
        'a.driver_crew_id',
        'a.attendant_crew_id',
        's.direction',
        's.start_time',
        's.days',
      ])
      .where('a.institution_id', '=', institutionId)
      .where('a.active', '=', 1)
      .where('a.effective_from', '<=', date)
      .where('a.effective_to', '>=', date)
      .where('s.active', '=', 1)
      .where('r.active', '=', 1)
      .where('v.active', '=', 1)
      .execute();
    let created = 0;
    for (const a of assignments) {
      if (!a.days.split(',').includes(weekday)) continue;
      const stops = await db
        .selectFrom('transport_route_stops')
        .select(['seq', 'stop_id', 'arrival', 'departure', 'distance_km'])
        .where('route_id', '=', String(a.route_id))
        .orderBy('seq')
        .execute();
      if (!stops.length) continue;
      let pos = 0;
      const along = stops.map((s, i) => {
        pos += i === 0 ? 0 : Number(s.distance_km);
        return { ...s, pos };
      });
      const travel = a.direction === 'PICKUP' ? [...along].reverse() : along;
      const start = toMin(a.start_time);
      const pub = newPublicIdPair();
      try {
        await db.transaction().execute(async (trx) => {
          const ins = await trx
            .insertInto('transport_trips')
            .values({
              public_id: pub.bin,
              institution_id: institutionId,
              assignment_id: String(a.id),
              route_id: String(a.route_id),
              session_id: String(a.session_id),
              vehicle_id: String(a.vehicle_id),
              driver_crew_id: String(a.driver_crew_id),
              attendant_crew_id: a.attendant_crew_id ? String(a.attendant_crew_id) : null,
              trip_date: date,
              direction: a.direction,
              planned_start: a.start_time,
              created_at: at,
            })
            .executeTakeFirstOrThrow();
          await trx
            .insertInto('transport_trip_stops')
            .values(
              travel.map((s, i) => ({
                trip_id: String(ins.insertId),
                seq: i,
                stop_id: String(s.stop_id),
                planned_time:
                  (a.direction === 'DROP' ? s.arrival : (s.departure ?? s.arrival)) ??
                  toTime(start + (Math.abs(s.pos - travel[0]!.pos) / speed) * 60),
                distance_km: i === 0 ? 0 : Math.abs(s.pos - travel[i - 1]!.pos),
              })),
            )
            .execute();
          await this.event(trx, institutionId, String(ins.insertId), { event: 'SCHEDULED' }, at);
        });
        created++;
      } catch (e) {
        if ((e as { errno?: number }).errno !== 1062) throw e; // already generated for the date
      }
    }
    return { created, cancelled, holiday: false };
  }

  // --- reading trips ----------------------------------------------------------------------------------------
  private tripRows(db: Db) {
    return db
      .selectFrom('transport_trips as t')
      .innerJoin('transport_routes as r', 'r.id', 't.route_id')
      .innerJoin('transport_sessions as s', 's.id', 't.session_id')
      .innerJoin('transport_vehicles as v', 'v.id', 't.vehicle_id')
      .innerJoin('transport_crew as d', 'd.id', 't.driver_crew_id')
      .innerJoin('member_profiles as dm', 'dm.id', 'd.profile_id')
      .leftJoin('transport_crew as c', 'c.id', 't.attendant_crew_id')
      .leftJoin('member_profiles as cm', 'cm.id', 'c.profile_id')
      .selectAll('t')
      .select([
        'r.public_id as route_public_id',
        'r.code as route_code',
        'r.name as route_name',
        's.name as session_name',
        'v.public_id as vehicle_public_id',
        'v.name as vehicle_name',
        'v.registration',
        'v.capacity',
        'dm.first_name as driver_first',
        'dm.last_name as driver_last',
        'cm.first_name as attendant_first',
        'cm.last_name as attendant_last',
        (eb) =>
          eb
            .selectFrom('transport_trip_stops as ts')
            .select(sql<number>`COUNT(*)`.as('n'))
            .whereRef('ts.trip_id', '=', 't.id')
            .as('stops'),
        (eb) =>
          eb
            .selectFrom('transport_trip_stops as ts')
            .select(sql<number>`COUNT(*)`.as('n'))
            .whereRef('ts.trip_id', '=', 't.id')
            .where('ts.status', 'in', ['DEPARTED', 'SKIPPED', 'REACHED'])
            .as('passed'),
        // The list shows where the bus is and who is on it without reading each trip (Phase 7 gap).
        (eb) =>
          eb
            .selectFrom('transport_trip_stops as ts')
            .innerJoin('transport_stops as st', 'st.id', 'ts.stop_id')
            .select('st.name')
            .whereRef('ts.trip_id', '=', 't.id')
            .where('ts.status', 'in', ['UPCOMING', 'REACHED'])
            .orderBy('ts.seq')
            .limit(1)
            .as('next_stop'),
        (eb) =>
          eb
            .selectFrom('transport_trip_stops as ts')
            .innerJoin('transport_stops as st', 'st.id', 'ts.stop_id')
            .select('st.name')
            .whereRef('ts.trip_id', '=', 't.id')
            .orderBy('ts.seq', 'desc')
            .limit(1)
            .as('last_stop'),
        (eb) =>
          eb
            .selectFrom('transport_boardings as b')
            .select(sql<number>`COUNT(*)`.as('n'))
            .whereRef('b.trip_id', '=', 't.id')
            .where('b.status', '=', 'CHECKED_IN')
            .as('on_board'),
        (eb) =>
          eb
            .selectFrom('transport_boardings as b')
            .select(sql<number>`COUNT(*)`.as('n'))
            .whereRef('b.trip_id', '=', 't.id')
            .where('b.status', 'in', ['CHECKED_IN', 'CHECKED_OUT'])
            .as('boarded'),
      ]);
  }

  private tripView(
    t: Awaited<ReturnType<ReturnType<TripsService['tripRows']>['execute']>>[number],
  ) {
    const stops = Number(t.stops ?? 0);
    const passed = Number(t.passed ?? 0);
    return {
      id: binToUuid(t.public_id),
      date: ymd(t.trip_date),
      direction: t.direction,
      session: t.session_name,
      route: { id: binToUuid(t.route_public_id), code: t.route_code, name: t.route_name },
      vehicle: {
        id: binToUuid(t.vehicle_public_id),
        name: t.vehicle_name,
        registration: t.registration,
        capacity: t.capacity,
      },
      driver: nameOf(t.driver_first, t.driver_last),
      attendant: t.attendant_first ? nameOf(t.attendant_first, t.attendant_last) : null,
      plannedStart: hm(t.planned_start),
      status: t.status,
      startedAt: iso(t.started_at),
      completedAt: iso(t.completed_at),
      cancelledAt: iso(t.cancelled_at),
      cancelRemarks: t.cancel_remarks,
      progress: { stops, passed },
      // The next stop not yet left (null once every stop is passed) and the last stop of the route.
      nextStop: t.status === 'STARTED' ? (t.next_stop ?? null) : null,
      lastStop: t.last_stop ?? null,
      passengers: { onBoard: Number(t.on_board ?? 0), boarded: Number(t.boarded ?? 0) },
      version: t.row_version,
    };
  }

  private async tripOne(db: Db, institutionId: string, id: string) {
    if (!isUuid(id)) throw new CustomAPIError(404, 'TRN.TRIP_NOT_FOUND');
    const t = await this.tripRows(db)
      .where('t.public_id', '=', uuidToBin(id))
      .where('t.institution_id', '=', institutionId)
      .executeTakeFirst();
    if (!t) throw new CustomAPIError(404, 'TRN.TRIP_NOT_FOUND');
    return t;
  }

  /** The trip's stops with their passengers (allocated that day) and boarding. */
  private async detail(db: Db, t: Awaited<ReturnType<TripsService['tripOne']>>) {
    const date = ymd(t.trip_date);
    const [stops, events, passengers, boardings] = await Promise.all([
      db
        .selectFrom('transport_trip_stops as ts')
        .innerJoin('transport_stops as s', 's.id', 'ts.stop_id')
        .select([
          'ts.seq',
          'ts.stop_id',
          'ts.planned_time',
          'ts.distance_km',
          'ts.status',
          'ts.reached_at',
          'ts.departed_at',
          'ts.skip_remarks',
          's.public_id',
          's.name',
          's.landmark',
        ])
        .where('ts.trip_id', '=', t.id)
        .orderBy('ts.seq')
        .execute(),
      db
        .selectFrom('transport_trip_events as e')
        .leftJoin('platform_accounts as a', 'a.public_id', 'e.actor')
        .select(['e.event', 'e.seq', 'e.remarks', 'e.at', 'a.first_name', 'a.last_name'])
        .where('e.trip_id', '=', t.id)
        .orderBy('e.id')
        .execute(),
      db
        .selectFrom('transport_allocations as al')
        .innerJoin('member_profiles as m', 'm.id', 'al.profile_id')
        .leftJoin('enrolments as en', (j) =>
          j.onRef('en.student_profile_id', '=', 'm.id').onRef('en.year_id', '=', 'al.year_id'),
        )
        .leftJoin('sections as sec', 'sec.id', 'en.section_id')
        .leftJoin('classes as c', 'c.id', 'sec.class_id')
        .select([
          'al.stop_id',
          'm.id',
          'm.public_id',
          'm.first_name',
          'm.last_name',
          'm.admission_no',
          'c.name as class_name',
          'sec.name as section_name',
        ])
        .where('al.route_id', '=', String(t.route_id))
        .where('al.active', '=', 1)
        .where('al.effective_from', '<=', date)
        .where('al.effective_to', '>=', date)
        .orderBy('m.first_name')
        .execute(),
      db.selectFrom('transport_boardings').selectAll().where('trip_id', '=', t.id).execute(),
    ]);
    const boarded = new Map(boardings.map((b) => [String(b.profile_id), b]));
    return {
      ...this.tripView(t),
      stops: stops.map((s) => ({
        seq: s.seq,
        stop: { id: binToUuid(s.public_id), name: s.name, landmark: s.landmark },
        plannedTime: hm(s.planned_time),
        distanceKm: Number(s.distance_km),
        status: s.status,
        reachedAt: iso(s.reached_at),
        departedAt: iso(s.departed_at),
        skipRemarks: s.skip_remarks,
        passengers: passengers
          .filter((x) => String(x.stop_id) === String(s.stop_id))
          .map((x) => {
            const b = boarded.get(String(x.id));
            return {
              id: binToUuid(x.public_id),
              name: nameOf(x.first_name, x.last_name),
              admissionNo: x.admission_no,
              classSection: x.class_name ? `${x.class_name} ${x.section_name ?? ''}`.trim() : null,
              boarding: b
                ? {
                    status: b.status,
                    method: b.method,
                    stopSeq: b.stop_seq,
                    deviation: b.deviation === 'YES',
                  }
                : null,
            };
          }),
      })),
      passengers: passengers.length,
      boarded: boardings.filter((b) => b.status === 'CHECKED_IN' || b.status === 'CHECKED_OUT')
        .length,
      events: events.map((e) => ({
        event: e.event,
        seq: e.seq,
        remarks: e.remarks,
        at: iso(e.at),
        by: nameOf(e.first_name, e.last_name) || null,
      })),
    };
  }

  /** TRN-023: the trips of a date with server filters. */
  async list(
    p: Principal,
    f: {
      date?: string | undefined;
      status?: TripStatus | undefined;
      routeId?: string | undefined;
      vehicleId?: string | undefined;
      cursor?: string | undefined;
    },
  ) {
    const inst = await institutionOf(this.deps.db, p);
    const date = f.date && DAY.test(f.date) ? f.date : istBusinessDate(this.now());
    await this.ensureToday(String(inst.id), date);
    let q = this.tripRows(this.deps.db)
      .where('t.institution_id', '=', inst.id)
      .where('t.trip_date', '=', date);
    if (f.status) q = q.where('t.status', '=', f.status);
    if (f.routeId && isUuid(f.routeId)) q = q.where('r.public_id', '=', uuidToBin(f.routeId));
    if (f.vehicleId && isUuid(f.vehicleId)) q = q.where('v.public_id', '=', uuidToBin(f.vehicleId));
    if (f.cursor && /^\d+$/.test(f.cursor)) q = q.where('t.id', '>', f.cursor);
    const rows = await q.orderBy('t.planned_start').orderBy('t.id').limit(101).execute();
    const counts = await this.deps.db
      .selectFrom('transport_trips')
      .select(['status', sql<number>`COUNT(*)`.as('n')])
      .where('institution_id', '=', inst.id)
      .where('trip_date', '=', date)
      .groupBy('status')
      .execute();
    const n = (s: TripStatus) => Number(counts.find((c) => c.status === s)?.n ?? 0);
    const page = rows.slice(0, 100);
    return {
      date,
      counts: {
        scheduled: n('SCHEDULED'),
        started: n('STARTED'),
        completed: n('COMPLETED'),
        cancelled: n('CANCELLED'),
      },
      items: page.map((t) => this.tripView(t)),
      nextCursor: rows.length > 100 ? String(page.at(-1)!.id) : null,
    };
  }

  /** TRN-024: one trip with stops, passengers and its event timeline. */
  async trip(p: Principal, id: string) {
    const inst = await institutionOf(this.deps.db, p);
    return this.detail(this.deps.db, await this.tripOne(this.deps.db, inst.id, id));
  }

  private async passengerAccounts(db: Db, routeId: string, date: string) {
    const rows = await db
      .selectFrom('transport_allocations as al')
      .innerJoin('member_profiles as m', 'm.id', 'al.profile_id')
      .leftJoin('guardianships as g', 'g.ward_profile_id', 'm.id')
      .leftJoin('member_profiles as gm', 'gm.id', 'g.guardian_profile_id')
      .select(['m.account_id', 'gm.account_id as guardian_account'])
      .where('al.route_id', '=', routeId)
      .where('al.active', '=', 1)
      .where('al.effective_from', '<=', date)
      .where('al.effective_to', '>=', date)
      .execute();
    return [
      ...new Set(
        rows
          .flatMap((r) => [r.account_id, r.guardian_account])
          .filter((a): a is string => a !== null && a !== undefined)
          .map(String),
      ),
    ];
  }

  /** TRN-025: cancel a scheduled trip with remarks; passengers and families are told. */
  async cancel(p: Principal, id: string, input: { remarks: string }) {
    const inst = await institutionOf(this.deps.db, p);
    const remarks = input.remarks.trim();
    if (remarks.length < 5 || remarks.length > 300)
      throw new ValidationError([{ field: 'remarks', code: 'TRN.CANCEL_REMARKS' }]);
    const at = this.now();
    await this.deps.db.transaction().execute(async (trx) => {
      const t = await this.tripOne(trx, inst.id, id);
      await trx
        .selectFrom('transport_trips')
        .select('id')
        .where('id', '=', t.id)
        .forUpdate()
        .execute();
      const cur = await trx
        .selectFrom('transport_trips')
        .select('status')
        .where('id', '=', t.id)
        .executeTakeFirstOrThrow();
      if (cur.status === 'CANCELLED') throw new CustomAPIError(409, 'TRN.TRIP_ALREADY_CANCELLED');
      if (cur.status === 'COMPLETED') throw new CustomAPIError(409, 'TRN.TRIP_COMPLETED_CANCEL');
      if (cur.status === 'STARTED') throw new CustomAPIError(409, 'TRN.TRIP_STARTED_CANCEL');
      await trx
        .updateTable('transport_trips')
        .set({
          status: 'CANCELLED',
          cancelled_at: at,
          cancel_remarks: remarks,
          row_version: sql<number>`row_version + 1`,
        })
        .where('id', '=', t.id)
        .execute();
      await this.event(trx, inst.id, t.id, { event: 'CANCELLED', actor: this.by(p), remarks }, at);
      await notify(
        trx,
        {
          institutionId: inst.id,
          accountIds: await this.passengerAccounts(trx, String(t.route_id), ymd(t.trip_date)),
          surface: 'MEMBER',
          category: 'ACCOUNT',
          titleKey: 'NTF.TRIP_CANCELLED',
          params: { session: t.session_name, route: `${t.route_code} · ${t.route_name}` },
          body: remarks,
          link: '/transport',
        },
        at,
      );
      await recordAudit(trx, {
        institutionId: inst.id,
        action: 'TRIP_CANCELLED',
        entityType: 'transport_trip',
        entityRef: id,
        after: { remarks },
      });
    });
    return this.trip(p, id);
  }

  // --- TRN-026: reports -------------------------------------------------------------------------------------
  async report(
    p: Principal,
    kind: string,
    f: { from?: string | undefined; to?: string | undefined },
  ) {
    const inst = await institutionOf(this.deps.db, p);
    if (!(TRANSPORT_REPORTS as readonly string[]).includes(kind))
      throw new CustomAPIError(404, 'TRN.REPORT_NOT_FOUND');
    const today = istBusinessDate(this.now());
    const to = f.to && DAY.test(f.to) ? f.to : today;
    const from = f.from && DAY.test(f.from) ? f.from : addDays(to, -29);
    if (to < from) throw new ValidationError([{ field: 'to', code: 'TRN.RANGE_DATES' }]);
    const db = this.deps.db;
    const trips = await this.tripRows(db)
      .where('t.institution_id', '=', inst.id)
      .where('t.trip_date', '>=', from)
      .where('t.trip_date', '<=', to)
      .orderBy('t.trip_date')
      .execute();
    const delay = (t: (typeof trips)[number]) => {
      if (!t.started_at) return null;
      const started = new Date(t.started_at);
      const planned = new Date(`${ymd(t.trip_date)}T${t.planned_start}+05:30`);
      return Math.round((started.getTime() - planned.getTime()) / 60_000);
    };
    const summarise = (group: typeof trips) => {
      const delays = group.map(delay).filter((d): d is number => d !== null);
      return {
        trips: group.length,
        completed: group.filter((t) => t.status === 'COMPLETED').length,
        cancelled: group.filter((t) => t.status === 'CANCELLED').length,
        onTime: delays.filter((d) => d <= 5).length,
        averageDelayMinutes: delays.length
          ? Math.round(delays.reduce((a, b) => a + b, 0) / delays.length)
          : null,
      };
    };
    const groupBy = <K extends string>(key: (t: (typeof trips)[number]) => K) => {
      const m = new Map<K, typeof trips>();
      for (const t of trips) m.set(key(t), [...(m.get(key(t)) ?? []), t]);
      return m;
    };
    let rows: unknown[] = [];
    if (kind === 'daily-summary') {
      rows = [...groupBy((t) => ymd(t.trip_date)).entries()].map(([date, g]) => ({
        date,
        ...summarise(g),
      }));
    } else if (kind === 'route-performance') {
      rows = [...groupBy((t) => `${t.route_code} · ${t.route_name}`).entries()].map(
        ([route, g]) => ({ route, ...summarise(g) }),
      );
    } else if (kind === 'vehicle-utilisation') {
      const distances = trips.length
        ? await db
            .selectFrom('transport_trip_stops')
            .select(['trip_id', sql<string>`SUM(distance_km)`.as('km')])
            .where(
              'trip_id',
              'in',
              trips.map((t) => t.id),
            )
            .groupBy('trip_id')
            .execute()
        : [];
      const km = new Map(distances.map((d) => [String(d.trip_id), Number(d.km ?? 0)]));
      rows = [...groupBy((t) => `${t.vehicle_name} · ${t.registration}`).entries()].map(
        ([vehicle, g]) => ({
          vehicle,
          capacity: g[0]!.capacity,
          ...summarise(g),
          distanceKm:
            Math.round(
              g
                .filter((t) => t.status === 'COMPLETED')
                .reduce((n, t) => n + (km.get(t.id) ?? 0), 0) * 100,
            ) / 100,
        }),
      );
    } else if (kind === 'driver-performance') {
      rows = [...groupBy((t) => nameOf(t.driver_first, t.driver_last)).entries()].map(
        ([driver, g]) => ({ driver, ...summarise(g) }),
      );
    } else if (kind === 'attendant-performance') {
      rows = [
        ...groupBy((t) =>
          t.attendant_first ? nameOf(t.attendant_first, t.attendant_last) : '—',
        ).entries(),
      ].map(([attendant, g]) => ({ attendant, ...summarise(g) }));
    } else if (kind === 'cancelled-trips') {
      rows = trips
        .filter((t) => t.status === 'CANCELLED')
        .map((t) => ({
          date: ymd(t.trip_date),
          route: `${t.route_code} · ${t.route_name}`,
          session: t.session_name,
          vehicle: t.vehicle_name,
          remarks: t.cancel_remarks,
          cancelledAt: iso(t.cancelled_at),
        }));
    } else if (kind === 'trip-stops') {
      const stops = trips.length
        ? await db
            .selectFrom('transport_trip_stops as ts')
            .innerJoin('transport_stops as s', 's.id', 'ts.stop_id')
            .select(['s.name', 'ts.status'])
            .where(
              'ts.trip_id',
              'in',
              trips.map((t) => t.id),
            )
            .execute()
        : [];
      const by = new Map<string, { reached: number; skipped: number; upcoming: number }>();
      for (const s of stops) {
        const x = by.get(s.name) ?? { reached: 0, skipped: 0, upcoming: 0 };
        if (s.status === 'SKIPPED') x.skipped++;
        else if (s.status === 'UPCOMING') x.upcoming++;
        else x.reached++;
        by.set(s.name, x);
      }
      rows = [...by.entries()].map(([stop, x]) => ({ stop, ...x }));
    } else if (kind === 'allocation') {
      const al = await db
        .selectFrom('transport_allocations as al')
        .innerJoin('transport_routes as r', 'r.id', 'al.route_id')
        .innerJoin('transport_stops as s', 's.id', 'al.stop_id')
        .select([
          'r.code',
          'r.name as route_name',
          's.name as stop_name',
          sql<number>`COUNT(*)`.as('n'),
        ])
        .where('al.institution_id', '=', inst.id)
        .where('al.active', '=', 1)
        .where('al.effective_from', '<=', to)
        .where('al.effective_to', '>=', from)
        .groupBy(['r.code', 'r.name', 's.name'])
        .orderBy('r.code')
        .execute();
      rows = al.map((a) => ({
        route: `${a.code} · ${a.route_name}`,
        stop: a.stop_name,
        passengers: Number(a.n),
      }));
    }
    return { kind, from, to, items: rows };
  }

  // --- the crew (TRN-027…033) -------------------------------------------------------------------------------
  private async crewOf(p: Principal) {
    const me = await memberOf(this.deps.db, p);
    const c = await this.deps.db
      .selectFrom('transport_crew')
      .select(['id', 'role'])
      .where('institution_id', '=', me.institutionId)
      .where('profile_id', '=', me.rowId)
      .where('active', '=', 1)
      .executeTakeFirst();
    if (!c) throw new CustomAPIError(403, 'TRN.NOT_CREW');
    return { ...me, crewId: String(c.id), role: c.role };
  }

  private async crewTrip(db: Db, crew: { institutionId: string; crewId: string }, id: string) {
    if (!isUuid(id)) throw new CustomAPIError(404, 'TRN.TRIP_NOT_FOUND');
    const t = await this.tripOne(db, crew.institutionId, id);
    if (
      String(t.driver_crew_id) !== crew.crewId &&
      String(t.attendant_crew_id ?? '') !== crew.crewId
    ) {
      throw new CustomAPIError(403, 'TRN.NOT_YOUR_TRIP');
    }
    return t;
  }

  async crewTrips(p: Principal, f: { date?: string | undefined }) {
    const crew = await this.crewOf(p);
    const date = f.date && DAY.test(f.date) ? f.date : istBusinessDate(this.now());
    await this.ensureToday(crew.institutionId, date);
    const rows = await this.tripRows(this.deps.db)
      .where('t.institution_id', '=', crew.institutionId)
      .where('t.trip_date', '=', date)
      .where((eb) =>
        eb.or([
          eb('t.driver_crew_id', '=', crew.crewId),
          eb('t.attendant_crew_id', '=', crew.crewId),
        ]),
      )
      .orderBy('t.planned_start')
      .execute();
    return { date, role: crew.role, items: rows.map((t) => this.tripView(t)) };
  }

  async crewTripDetail(p: Principal, id: string) {
    const crew = await this.crewOf(p);
    return this.detail(this.deps.db, await this.crewTrip(this.deps.db, crew, id));
  }

  /** Locks the trip and checks its state for a crew action. */
  private async forAction(
    trx: Transaction<Database>,
    crew: { institutionId: string; crewId: string },
    id: string,
  ) {
    const t = await this.crewTrip(trx, crew, id);
    const cur = await trx
      .selectFrom('transport_trips')
      .select(['status'])
      .where('id', '=', t.id)
      .forUpdate()
      .executeTakeFirstOrThrow();
    if (cur.status === 'CANCELLED') throw new CustomAPIError(409, 'TRN.TRIP_CANCELLED_UPDATE');
    if (cur.status === 'COMPLETED') throw new CustomAPIError(409, 'TRN.TRIP_COMPLETED_UPDATE');
    return { t, status: cur.status };
  }

  /** TRN-029: start a scheduled trip; passengers and families are told. */
  async start(p: Principal, id: string) {
    const crew = await this.crewOf(p);
    const at = this.now();
    await this.deps.db.transaction().execute(async (trx) => {
      const { t, status } = await this.forAction(trx, crew, id);
      if (status !== 'SCHEDULED') throw new CustomAPIError(409, 'TRN.TRIP_NOT_SCHEDULED');
      await trx
        .updateTable('transport_trips')
        .set({ status: 'STARTED', started_at: at, row_version: sql<number>`row_version + 1` })
        .where('id', '=', t.id)
        .execute();
      await this.event(trx, crew.institutionId, t.id, { event: 'STARTED', actor: this.by(p) }, at);
      await notify(
        trx,
        {
          institutionId: crew.institutionId,
          accountIds: await this.passengerAccounts(trx, String(t.route_id), ymd(t.trip_date)),
          surface: 'MEMBER',
          category: 'ACCOUNT',
          titleKey: 'NTF.TRIP_STARTED',
          params: { bus: t.vehicle_name, session: t.session_name },
          body: `${t.route_code} · ${t.route_name}`,
          link: '/transport',
        },
        at,
      );
    });
    return this.crewTripDetail(p, id);
  }

  /** TRN-030: a stop reached, departed or skipped — in order (BR-62). */
  async stopEvent(
    p: Principal,
    id: string,
    input: {
      seq: number;
      event: 'REACHED' | 'DEPARTED' | 'SKIPPED';
      remarks?: string | null | undefined;
    },
  ) {
    const crew = await this.crewOf(p);
    const at = this.now();
    const remarks = (input.remarks ?? '').trim() || null;
    if (input.event === 'SKIPPED' && (!remarks || remarks.length < 3))
      throw new ValidationError([{ field: 'remarks', code: 'TRN.SKIP_REMARKS' }]);
    await this.deps.db.transaction().execute(async (trx) => {
      const { t, status } = await this.forAction(trx, crew, id);
      if (status !== 'STARTED') throw new CustomAPIError(409, 'TRN.TRIP_NOT_STARTED');
      const stops = await trx
        .selectFrom('transport_trip_stops')
        .selectAll()
        .where('trip_id', '=', t.id)
        .orderBy('seq')
        .forUpdate()
        .execute();
      const stop = stops.find((s) => s.seq === input.seq);
      if (!stop) throw new CustomAPIError(404, 'TRN.TRIP_STOP_NOT_FOUND');
      const prev = stops.find((s) => s.seq === input.seq - 1);
      const prevDone = !prev || prev.status === 'DEPARTED' || prev.status === 'SKIPPED';
      let set: Record<string, unknown>;
      if (input.event === 'REACHED') {
        if (stop.status !== 'UPCOMING') throw new CustomAPIError(409, 'TRN.STOP_NOT_UPCOMING');
        if (!prevDone) throw new CustomAPIError(409, 'TRN.STOP_OUT_OF_ORDER');
        set = { status: 'REACHED', reached_at: at };
      } else if (input.event === 'DEPARTED') {
        if (stop.status !== 'REACHED') throw new CustomAPIError(409, 'TRN.STOP_NOT_REACHED');
        set = { status: 'DEPARTED', departed_at: at };
      } else {
        if (stop.status !== 'UPCOMING') throw new CustomAPIError(409, 'TRN.SKIP_NOT_UPCOMING');
        if (!prevDone) throw new CustomAPIError(409, 'TRN.STOP_OUT_OF_ORDER');
        set = { status: 'SKIPPED', skip_remarks: remarks };
      }
      await trx.updateTable('transport_trip_stops').set(set).where('id', '=', stop.id).execute();
      await this.event(
        trx,
        crew.institutionId,
        t.id,
        { event: input.event, seq: input.seq, actor: this.by(p), remarks },
        at,
      );
    });
    return this.crewTripDetail(p, id);
  }

  /** TRN-031: boarding (RC-25) — boarded, got off, no show or missed; a different stop is a deviation. */
  async board(
    p: Principal,
    id: string,
    input: {
      memberId: string;
      stopSeq?: number | null | undefined;
      event: BoardingStatus;
      method?: 'QR' | 'NFC' | 'MANUAL' | undefined;
    },
  ) {
    const crew = await this.crewOf(p);
    const at = this.now();
    await this.deps.db.transaction().execute(async (trx) => {
      const { t, status } = await this.forAction(trx, crew, id);
      if (status !== 'STARTED') throw new CustomAPIError(409, 'TRN.TRIP_NOT_STARTED');
      const date = ymd(t.trip_date);
      const m = isUuid(input.memberId)
        ? await trx
            .selectFrom('member_profiles')
            .select(['id', 'first_name', 'last_name'])
            .where('public_id', '=', uuidToBin(input.memberId))
            .where('institution_id', '=', crew.institutionId)
            .executeTakeFirst()
        : undefined;
      const allocation = m
        ? await trx
            .selectFrom('transport_allocations')
            .select('stop_id')
            .where('profile_id', '=', String(m.id))
            .where('route_id', '=', String(t.route_id))
            .where('active', '=', 1)
            .where('effective_from', '<=', date)
            .where('effective_to', '>=', date)
            .executeTakeFirst()
        : undefined;
      if (!m || !allocation) {
        throw new ValidationError([
          {
            field: 'memberId',
            code: 'TRN.NOT_A_PASSENGER',
            params: { name: m ? nameOf(m.first_name, m.last_name) : 'This member' },
          },
        ]);
      }
      let deviation: 'YES' | 'NO' = 'NO';
      if (input.stopSeq !== undefined && input.stopSeq !== null) {
        const stop = await trx
          .selectFrom('transport_trip_stops')
          .select('stop_id')
          .where('trip_id', '=', t.id)
          .where('seq', '=', input.stopSeq)
          .executeTakeFirst();
        if (!stop) throw new CustomAPIError(404, 'TRN.TRIP_STOP_NOT_FOUND');
        if (input.event === 'CHECKED_IN' && String(stop.stop_id) !== String(allocation.stop_id))
          deviation = 'YES';
      }
      const existing = await trx
        .selectFrom('transport_boardings')
        .selectAll()
        .where('trip_id', '=', t.id)
        .where('profile_id', '=', String(m.id))
        .forUpdate()
        .executeTakeFirst();
      if (input.event === 'CHECKED_OUT') {
        if (existing?.status !== 'CHECKED_IN') throw new CustomAPIError(409, 'TRN.BOARDING_ORDER');
        await trx
          .updateTable('transport_boardings')
          .set({
            status: 'CHECKED_OUT',
            actor: this.by(p),
            at,
            row_version: sql<number>`row_version + 1`,
          })
          .where('id', '=', existing.id)
          .execute();
        return;
      }
      if (existing) throw new CustomAPIError(409, 'TRN.BOARDING_ORDER');
      await trx
        .insertInto('transport_boardings')
        .values({
          institution_id: crew.institutionId,
          trip_id: t.id,
          profile_id: String(m.id),
          status: input.event,
          method: input.method ?? 'MANUAL',
          stop_seq: input.stopSeq ?? null,
          allocated_stop_id: String(allocation.stop_id),
          deviation,
          actor: this.by(p),
          at,
        })
        .execute();
    });
    return this.crewTripDetail(p, id);
  }

  /** TRN-032: complete a started trip once its final stop is reached or departed. */
  async complete(p: Principal, id: string) {
    const crew = await this.crewOf(p);
    const at = this.now();
    await this.deps.db.transaction().execute(async (trx) => {
      const { t, status } = await this.forAction(trx, crew, id);
      if (status !== 'STARTED') throw new CustomAPIError(409, 'TRN.TRIP_NOT_STARTED_COMPLETE');
      const last = await trx
        .selectFrom('transport_trip_stops')
        .select(['status'])
        .where('trip_id', '=', t.id)
        .orderBy('seq', 'desc')
        .limit(1)
        .executeTakeFirst();
      if (!last || (last.status !== 'REACHED' && last.status !== 'DEPARTED'))
        throw new CustomAPIError(409, 'TRN.STOPS_PENDING');
      await trx
        .updateTable('transport_trips')
        .set({ status: 'COMPLETED', completed_at: at, row_version: sql<number>`row_version + 1` })
        .where('id', '=', t.id)
        .execute();
      await this.event(
        trx,
        crew.institutionId,
        t.id,
        { event: 'COMPLETED', actor: this.by(p) },
        at,
      );
    });
    return this.crewTripDetail(p, id);
  }

  /** TRN-033: the crew member's past trips. */
  async crewHistory(p: Principal, f: { from?: string | undefined; to?: string | undefined }) {
    const crew = await this.crewOf(p);
    const today = istBusinessDate(this.now());
    const to = f.to && DAY.test(f.to) ? f.to : today;
    const from = f.from && DAY.test(f.from) ? f.from : addDays(to, -29);
    if (to < from) throw new ValidationError([{ field: 'to', code: 'TRN.RANGE_DATES' }]);
    const rows = await this.tripRows(this.deps.db)
      .where('t.institution_id', '=', crew.institutionId)
      .where('t.trip_date', '>=', from)
      .where('t.trip_date', '<=', to)
      .where((eb) =>
        eb.or([
          eb('t.driver_crew_id', '=', crew.crewId),
          eb('t.attendant_crew_id', '=', crew.crewId),
        ]),
      )
      .orderBy('t.trip_date', 'desc')
      .orderBy('t.planned_start', 'desc')
      .limit(500)
      .execute();
    const items = rows.map((t) => this.tripView(t));
    return {
      from,
      to,
      counts: {
        trips: items.length,
        completed: items.filter((t) => t.status === 'COMPLETED').length,
        cancelled: items.filter((t) => t.status === 'CANCELLED').length,
      },
      items,
    };
  }

  // --- TRN-034: the passenger and family ------------------------------------------------------------------------
  async mine(p: Principal, f: { for?: string | undefined }) {
    const me = await memberOf(this.deps.db, p, f.for);
    const date = istBusinessDate(this.now());
    const db = this.deps.db;
    const al = await db
      .selectFrom('transport_allocations as al')
      .innerJoin('transport_routes as r', 'r.id', 'al.route_id')
      .innerJoin('transport_stops as s', 's.id', 'al.stop_id')
      .select([
        'al.route_id',
        'al.stop_id',
        'al.effective_from',
        'al.effective_to',
        'r.code',
        'r.name as route_name',
        's.public_id as stop_public_id',
        's.name as stop_name',
        's.landmark',
      ])
      .where('al.profile_id', '=', me.rowId)
      .where('al.active', '=', 1)
      .where('al.effective_from', '<=', date)
      .where('al.effective_to', '>=', date)
      .executeTakeFirst();
    if (!al) return { member: { name: me.name }, allocation: null, trips: [] };
    await this.ensureToday(me.institutionId, date);
    const trips = await this.tripRows(db)
      .where('t.institution_id', '=', me.institutionId)
      .where('t.route_id', '=', String(al.route_id))
      .where('t.trip_date', '=', date)
      .orderBy('t.planned_start')
      .execute();
    const out = [];
    for (const t of trips) {
      const d = await this.detail(db, t);
      const mine = d.stops.find((s) => s.stop.id === binToUuid(al.stop_public_id));
      out.push({
        id: d.id,
        session: d.session,
        direction: d.direction,
        status: d.status,
        plannedStart: d.plannedStart,
        startedAt: d.startedAt,
        completedAt: d.completedAt,
        cancelRemarks: d.cancelRemarks,
        vehicle: { name: d.vehicle.name, registration: d.vehicle.registration },
        driver: d.driver,
        attendant: d.attendant,
        myStop: mine
          ? {
              seq: mine.seq,
              plannedTime: mine.plannedTime,
              status: mine.status,
              reachedAt: mine.reachedAt,
              departedAt: mine.departedAt,
            }
          : null,
        stops: d.stops.map((s) => ({
          seq: s.seq,
          name: s.stop.name,
          landmark: s.stop.landmark,
          plannedTime: s.plannedTime,
          status: s.status,
          reachedAt: s.reachedAt,
          departedAt: s.departedAt,
        })),
      });
    }
    return {
      member: { name: me.name },
      allocation: {
        route: { code: al.code, name: al.route_name },
        stop: { id: binToUuid(al.stop_public_id), name: al.stop_name, landmark: al.landmark },
        from: ymd(al.effective_from),
        to: ymd(al.effective_to),
      },
      trips: out,
    };
  }

  /** For the tenant check of console routes before a body is read. */
  async lookup(p: Principal, id: string) {
    const inst = await institutionOf(this.deps.db, p);
    await this.tripOne(this.deps.db, inst.id, id);
  }
}
