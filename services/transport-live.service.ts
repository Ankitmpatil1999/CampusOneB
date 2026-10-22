/**
 * Live bus tracking and road distances (client 2026-10-21: "parents should get to know where the bus
 * is"; Google Maps; the driver's phone; positions kept 30 days).
 *
 * - **The crew's phone** sends its position every trn.positions.intervalSeconds while a trip it runs
 *   is Started (TRN-036). Fixes less accurate than trn.positions.maxAccuracyM, from before the trip
 *   started or from the future are not used; a resent fix adds nothing (one per trip and time). The
 *   trip keeps the latest fix and the km run (jumps faster than a bus can go are not counted).
 * - **"The bus is near your stop":** when the bus comes within trn.nearStop.meters of a stop not yet
 *   reached, its passengers and their parents are told once (NTF.BUS_NEAR_STOP, event BUS_NEAR).
 * - **Who sees the bus** (TRN-037): the passengers of the route — students (with the app), staff —
 *   and their parents, only while a trip of their route is running today. Its position, the trail of
 *   this trip, the stops, and about how many minutes to the member's stop: the distance left (the bus
 *   to the next stop in a straight line × the road factor, then the stops' own distances) at
 *   trn.speedKmph. No map service is called for it.
 * - **The console** reads the bus on the trips list and the trip (TripsService) and asks for a
 *   route's road distances (TRN-038) through the map service (integrations/maps.provider.ts).
 * - **Retention:** the job trip-generation deletes positions older than trn.positions.retentionDays.
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import { LIMITS, type LimitDefinition } from '../config/registers';
import {
  haversineKm,
  MapsServiceError,
  TEST_ROAD_FACTOR,
  type MapsProvider,
  type MapsRouter,
} from '../integrations/maps.provider';
import type { Database } from '../models/ringpe_models';
import { CustomAPIError, ValidationError } from '../utils/CustomAPIError';
import { istBusinessDate } from '../utils/format';
import { binToUuid, isUuid, uuidToBin } from '../utils/idGenerator';
import type { Principal } from '../utils/principal';
import { institutionOf } from './academic-year';
import { memberOf } from './member-roles';
import { notify } from './notifications.service';
import type { SettingsService } from './settings.service';

type Db = Kysely<Database> | Transaction<Database>;

export interface PositionInput {
  readonly lat: number;
  readonly lng: number;
  readonly accuracy?: number | null | undefined;
  readonly speed?: number | null | undefined;
  readonly heading?: number | null | undefined;
  /** When the phone took the fix (ISO). */
  readonly at: string;
}

/** A bus faster than this between two fixes is a GPS jump, not a distance run. */
const MAX_PLAUSIBLE_KMPH = 120;
/** Moves shorter than this are GPS noise while standing. */
const MIN_MOVE_KM = 0.02;
/** At most this many points of a trip's trail are returned (evenly thinned, the last kept). */
const TRAIL_POINTS = 300;
const nameOf = (first: string | null | undefined, last: string | null | undefined) =>
  [first, last].filter(Boolean).join(' ');
const ymd = (d: Date | string) => (typeof d === 'string' ? d.slice(0, 10) : istBusinessDate(d));
const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);
const num = (v: string | number | null | undefined) =>
  v === null || v === undefined ? null : Number(v);
const hm = (t: string | null) => (t ? t.slice(0, 5) : null);

/** Every k-th point so at most `max` remain, the last always kept. */
export function thin<T>(points: readonly T[], max = TRAIL_POINTS): T[] {
  if (points.length <= max) return [...points];
  const step = Math.ceil(points.length / max);
  const out = points.filter((_, i) => i % step === 0);
  if (out.at(-1) !== points.at(-1)) out.push(points.at(-1)!);
  return out;
}

/**
 * Minutes to a stop: the bus to the next stop in a straight line × the road factor, plus the stops'
 * own distances after it up to the stop, at `speedKmph`. Null when the bus position isn't known.
 */
export function etaMinutes(
  bus: { lat: number; lng: number } | null,
  next: { lat: number | null; lng: number | null } | null,
  kmAfterNext: number,
  speedKmph: number,
) {
  if (!bus || !next || next.lat === null || next.lng === null || speedKmph <= 0) return null;
  const toNext = haversineKm(bus, { lat: next.lat, lng: next.lng }) * TEST_ROAD_FACTOR;
  return Math.max(1, Math.ceil(((toNext + kmAfterNext) / speedKmph) * 60));
}

export class TransportLiveService {
  constructor(
    private readonly deps: {
      readonly db: Kysely<Database>;
      readonly settings?: SettingsService;
      readonly maps: MapsRouter | null;
      readonly mapsConfig: { readonly provider: MapsProvider; readonly browserKey: string | null };
      readonly now?: () => Date;
    },
  ) {}

  private now() {
    return this.deps.now?.() ?? new Date();
  }

  private async limit(l: LimitDefinition) {
    if (!this.deps.settings) return Number(l.value);
    const v = await this.deps.settings.values();
    return Number(v[l.key] ?? l.value);
  }

  private async crewOf(p: Principal) {
    const me = await memberOf(this.deps.db, p);
    const c = await this.deps.db
      .selectFrom('transport_crew')
      .select(['id'])
      .where('institution_id', '=', me.institutionId)
      .where('profile_id', '=', me.rowId)
      .where('active', '=', 1)
      .executeTakeFirst();
    if (!c) throw new CustomAPIError(403, 'TRN.NOT_CREW');
    return { ...me, crewId: String(c.id) };
  }

  /** The accounts of a route's passengers on a date (one stop, or all) and their parents. */
  private async passengerAccounts(db: Db, routeId: string, date: string, stopId?: string) {
    let q = db
      .selectFrom('transport_allocations as al')
      .innerJoin('member_profiles as m', 'm.id', 'al.profile_id')
      .leftJoin('guardianships as g', 'g.ward_profile_id', 'm.id')
      .leftJoin('member_profiles as gm', 'gm.id', 'g.guardian_profile_id')
      .select(['m.id', 'm.account_id', 'gm.account_id as guardian_account'])
      .where('al.route_id', '=', routeId)
      .where('al.active', '=', 1)
      .where('al.effective_from', '<=', date)
      .where('al.effective_to', '>=', date);
    if (stopId) q = q.where('al.stop_id', '=', stopId);
    const rows = await q.execute();
    return {
      accounts: [
        ...new Set(
          rows
            .flatMap((r) => [r.account_id, r.guardian_account])
            .filter((a): a is string => a !== null && a !== undefined)
            .map(String),
        ),
      ],
      profiles: [...new Set(rows.map((r) => String(r.id)))],
    };
  }

  // --- TRN-036: the crew's phone ---------------------------------------------------------------------------
  async ingest(p: Principal, tripId: string, points: readonly PositionInput[]) {
    const crew = await this.crewOf(p);
    if (!isUuid(tripId)) throw new CustomAPIError(404, 'TRN.TRIP_NOT_FOUND');
    const [intervalSeconds, maxAccuracy, nearMeters] = await Promise.all([
      this.limit(LIMITS.transportPositionsIntervalSeconds),
      this.limit(LIMITS.transportPositionsMaxAccuracyM),
      this.limit(LIMITS.transportNearStopMeters),
    ]);
    const at = this.now();
    const fixes = points
      .map((x) => ({ ...x, when: new Date(x.at) }))
      .filter(
        (x) =>
          Number.isFinite(x.lat) &&
          Number.isFinite(x.lng) &&
          Math.abs(x.lat) <= 90 &&
          Math.abs(x.lng) <= 180 &&
          !(x.lat === 0 && x.lng === 0) &&
          !Number.isNaN(x.when.getTime()) &&
          (x.accuracy === null || x.accuracy === undefined || x.accuracy <= maxAccuracy),
      )
      .sort((a, b) => a.when.getTime() - b.when.getTime());
    let accepted = 0;
    await this.deps.db.transaction().execute(async (trx) => {
      const t = await trx
        .selectFrom('transport_trips as t')
        .innerJoin('transport_vehicles as v', 'v.id', 't.vehicle_id')
        .innerJoin('transport_routes as r', 'r.id', 't.route_id')
        .select([
          't.id',
          't.status',
          't.trip_date',
          't.route_id',
          't.driver_crew_id',
          't.attendant_crew_id',
          't.started_at',
          't.last_lat',
          't.last_lng',
          't.last_position_at',
          'v.name as vehicle_name',
          'r.code as route_code',
          'r.name as route_name',
        ])
        .where('t.public_id', '=', uuidToBin(tripId))
        .where('t.institution_id', '=', crew.institutionId)
        .forUpdate()
        .executeTakeFirst();
      if (!t) throw new CustomAPIError(404, 'TRN.TRIP_NOT_FOUND');
      if (
        String(t.driver_crew_id) !== crew.crewId &&
        String(t.attendant_crew_id ?? '') !== crew.crewId
      ) {
        throw new CustomAPIError(403, 'TRN.NOT_YOUR_TRIP');
      }
      if (t.status !== 'STARTED') throw new CustomAPIError(409, 'TRN.TRIP_NOT_RUNNING');
      const earliest = (t.started_at ? new Date(t.started_at).getTime() : at.getTime()) - 300_000;
      const latest = at.getTime() + 120_000;
      const usable = fixes.filter(
        (x) => x.when.getTime() >= earliest && x.when.getTime() <= latest,
      );
      if (!usable.length) return;
      const ins = await trx
        .insertInto('transport_trip_positions')
        .ignore()
        .values(
          usable.map((x) => ({
            institution_id: crew.institutionId,
            trip_id: String(t.id),
            lat: x.lat.toFixed(6),
            lng: x.lng.toFixed(6),
            accuracy_m:
              x.accuracy === null || x.accuracy === undefined
                ? null
                : Math.min(65535, Math.round(x.accuracy)),
            speed_kmph:
              x.speed === null || x.speed === undefined || x.speed < 0
                ? null
                : Math.min(999, Math.round(x.speed * 10) / 10),
            heading:
              x.heading === null || x.heading === undefined || x.heading < 0
                ? null
                : Math.round(x.heading) % 360,
            recorded_at: x.when,
            received_at: at,
          })),
        )
        .executeTakeFirst();
      accepted = Number(ins.numInsertedOrUpdatedRows ?? usable.length);
      // The latest fix and the distance run since the one before.
      const lastAt = t.last_position_at ? new Date(t.last_position_at).getTime() : 0;
      const newer = usable.filter((x) => x.when.getTime() > lastAt);
      if (!newer.length) return;
      let prev =
        t.last_lat !== null && t.last_lng !== null
          ? { lat: Number(t.last_lat), lng: Number(t.last_lng), when: lastAt }
          : null;
      let run = 0;
      for (const x of newer) {
        if (!prev) {
          prev = { lat: x.lat, lng: x.lng, when: x.when.getTime() };
          continue;
        }
        const d = haversineKm(prev, x);
        const hours = (x.when.getTime() - prev.when) / 3_600_000;
        if (d < MIN_MOVE_KM) continue; // standing: keep measuring from the same point
        if (hours > 0 && d / hours <= MAX_PLAUSIBLE_KMPH) run += d;
        prev = { lat: x.lat, lng: x.lng, when: x.when.getTime() };
      }
      const last = newer.at(-1)!;
      await trx
        .updateTable('transport_trips')
        .set({
          last_lat: last.lat.toFixed(6),
          last_lng: last.lng.toFixed(6),
          last_speed_kmph:
            last.speed === null || last.speed === undefined || last.speed < 0
              ? null
              : Math.min(999, Math.round(last.speed * 10) / 10),
          last_heading:
            last.heading === null || last.heading === undefined || last.heading < 0
              ? null
              : Math.round(last.heading) % 360,
          last_position_at: last.when,
          km_run: sql<string>`LEAST(99999.99, km_run + ${Math.round(run * 100) / 100})`,
        })
        .where('id', '=', t.id)
        .execute();
      // "The bus is near your stop": each stop not yet reached, once.
      const near = await trx
        .selectFrom('transport_trip_stops as ts')
        .innerJoin('transport_stops as s', 's.id', 'ts.stop_id')
        .select(['ts.id', 'ts.stop_id', 's.name', 's.lat', 's.lng'])
        .where('ts.trip_id', '=', t.id)
        .where('ts.status', '=', 'UPCOMING')
        .where('ts.near_notified_at', 'is', null)
        .where('s.lat', 'is not', null)
        .where('s.lng', 'is not', null)
        .execute();
      for (const s of near) {
        const metres = haversineKm(last, { lat: Number(s.lat), lng: Number(s.lng) }) * 1000;
        if (metres > nearMeters) continue;
        await trx
          .updateTable('transport_trip_stops')
          .set({ near_notified_at: at })
          .where('id', '=', s.id)
          .where('near_notified_at', 'is', null)
          .execute();
        const who = await this.passengerAccounts(
          trx,
          String(t.route_id),
          ymd(t.trip_date),
          String(s.stop_id),
        );
        if (!who.accounts.length) continue;
        await notify(
          trx,
          {
            institutionId: crew.institutionId,
            accountIds: who.accounts,
            surface: 'MEMBER',
            category: 'ACCOUNT',
            titleKey: 'NTF.BUS_NEAR_STOP',
            params: { bus: t.vehicle_name, stop: s.name },
            body: `${t.route_code} · ${t.route_name}. Open Transport to see it on the map.`,
            link: '/transport',
          },
          at,
        );
      }
    });
    return { accepted, running: true, intervalSeconds };
  }

  // --- TRN-037: the passenger and the family ---------------------------------------------------------------------
  async mine(p: Principal, f: { for?: string | undefined }) {
    const me = await memberOf(this.deps.db, p, f.for);
    const db = this.deps.db;
    const date = istBusinessDate(this.now());
    const [refreshSeconds, staleSeconds, speed] = await Promise.all([
      this.limit(LIMITS.transportPositionsIntervalSeconds),
      this.limit(LIMITS.transportPositionsStaleSeconds),
      this.limit(LIMITS.transportSpeedKmph),
    ]);
    const base = {
      member: { name: me.name },
      refreshSeconds,
      staleSeconds,
      maps: { provider: this.deps.mapsConfig.provider },
    };
    const al = await db
      .selectFrom('transport_allocations as al')
      .innerJoin('transport_routes as r', 'r.id', 'al.route_id')
      .innerJoin('transport_stops as s', 's.id', 'al.stop_id')
      .select([
        'al.route_id',
        'al.stop_id',
        'r.code',
        'r.name as route_name',
        's.public_id as stop_public_id',
        's.name as stop_name',
        's.lat as stop_lat',
        's.lng as stop_lng',
      ])
      .where('al.profile_id', '=', me.rowId)
      .where('al.active', '=', 1)
      .where('al.effective_from', '<=', date)
      .where('al.effective_to', '>=', date)
      .executeTakeFirst();
    if (!al) return { ...base, allocation: null, school: null, route: [], trip: null };
    const routeStops = await db
      .selectFrom('transport_route_stops as rs')
      .innerJoin('transport_stops as s', 's.id', 'rs.stop_id')
      .select(['rs.seq', 's.name', 's.lat', 's.lng'])
      .where('rs.route_id', '=', String(al.route_id))
      .orderBy('rs.seq')
      .execute();
    const school = routeStops[0];
    const out = {
      ...base,
      allocation: {
        route: { code: al.code, name: al.route_name },
        stop: {
          id: binToUuid(al.stop_public_id),
          name: al.stop_name,
          lat: num(al.stop_lat),
          lng: num(al.stop_lng),
        },
      },
      school:
        school && school.lat !== null && school.lng !== null
          ? { name: school.name, lat: Number(school.lat), lng: Number(school.lng) }
          : null,
      route: routeStops.map((s) => ({
        seq: s.seq,
        name: s.name,
        lat: num(s.lat),
        lng: num(s.lng),
      })),
    };
    const t = await db
      .selectFrom('transport_trips as t')
      .innerJoin('transport_sessions as se', 'se.id', 't.session_id')
      .innerJoin('transport_vehicles as v', 'v.id', 't.vehicle_id')
      .innerJoin('transport_crew as d', 'd.id', 't.driver_crew_id')
      .innerJoin('member_profiles as dm', 'dm.id', 'd.profile_id')
      .select([
        't.id',
        't.public_id',
        't.direction',
        't.started_at',
        't.last_lat',
        't.last_lng',
        't.last_speed_kmph',
        't.last_heading',
        't.last_position_at',
        'se.name as session_name',
        'v.name as vehicle_name',
        'v.registration',
        'dm.first_name as driver_first',
        'dm.last_name as driver_last',
      ])
      .where('t.institution_id', '=', me.institutionId)
      .where('t.route_id', '=', String(al.route_id))
      .where('t.trip_date', '=', date)
      .where('t.status', '=', 'STARTED')
      .orderBy('t.started_at', 'desc')
      .executeTakeFirst();
    if (!t) return { ...out, trip: null };
    const [stops, trail] = await Promise.all([
      db
        .selectFrom('transport_trip_stops as ts')
        .innerJoin('transport_stops as s', 's.id', 'ts.stop_id')
        .select([
          'ts.seq',
          'ts.stop_id',
          'ts.status',
          'ts.planned_time',
          'ts.distance_km',
          'ts.reached_at',
          'ts.departed_at',
          's.name',
          's.lat',
          's.lng',
        ])
        .where('ts.trip_id', '=', t.id)
        .orderBy('ts.seq')
        .execute(),
      this.trailOf(db, String(t.id)),
    ]);
    const bus =
      t.last_lat !== null && t.last_lng !== null
        ? {
            lat: Number(t.last_lat),
            lng: Number(t.last_lng),
            speedKmph: num(t.last_speed_kmph),
            heading: t.last_heading,
            at: iso(t.last_position_at),
          }
        : null;
    const stale =
      !t.last_position_at ||
      this.now().getTime() - new Date(t.last_position_at).getTime() > staleSeconds * 1000;
    const mine = stops.find((s) => String(s.stop_id) === String(al.stop_id)) ?? null;
    const next = stops.find((s) => s.status === 'UPCOMING') ?? null;
    let eta: number | null = null;
    if (mine && mine.status === 'UPCOMING' && next && next.seq <= mine.seq) {
      const after = stops
        .filter((s) => s.seq > next.seq && s.seq <= mine.seq)
        .reduce((n, s) => n + Number(s.distance_km), 0);
      eta = etaMinutes(bus, { lat: num(next.lat), lng: num(next.lng) }, after, speed);
    }
    return {
      ...out,
      trip: {
        id: binToUuid(t.public_id),
        direction: t.direction,
        session: t.session_name,
        startedAt: iso(t.started_at),
        vehicle: { name: t.vehicle_name, registration: t.registration },
        driver: nameOf(t.driver_first, t.driver_last),
        bus,
        stale,
        nextStop: next ? { seq: next.seq, name: next.name } : null,
        myStop: mine
          ? {
              seq: mine.seq,
              status: mine.status,
              plannedTime: hm(mine.planned_time),
              reachedAt: iso(mine.reached_at),
              departedAt: iso(mine.departed_at),
              etaMinutes: eta,
            }
          : null,
        stops: stops.map((s) => ({
          seq: s.seq,
          name: s.name,
          lat: num(s.lat),
          lng: num(s.lng),
          status: s.status,
          plannedTime: hm(s.planned_time),
        })),
        trail,
      },
    };
  }

  /** A trip's trail, oldest first, thinned ([lat, lng] pairs). */
  async trailOf(db: Db, tripRowId: string) {
    const rows = await db
      .selectFrom('transport_trip_positions')
      .select(['lat', 'lng'])
      .where('trip_id', '=', tripRowId)
      .orderBy('recorded_at')
      .limit(5000)
      .execute();
    return thin(rows.map((r) => [Number(r.lat), Number(r.lng)] as [number, number]));
  }

  // --- the console -------------------------------------------------------------------------------------------
  /** TRN-039: what the console's maps load with. */
  async mapsConfig(p: Principal) {
    await institutionOf(this.deps.db, p);
    const [refreshSeconds, staleSeconds] = await Promise.all([
      this.limit(LIMITS.transportPositionsIntervalSeconds),
      this.limit(LIMITS.transportPositionsStaleSeconds),
    ]);
    return {
      provider: this.deps.mapsConfig.provider,
      browserKey: this.deps.mapsConfig.browserKey,
      refreshSeconds,
      staleSeconds,
    };
  }

  /**
   * TRN-038: the road distance from each stop of a route to the next, through the map service — the
   * transport desk checks them and saves the route's stops (TRN-004). Nothing is saved here.
   */
  async distances(p: Principal, routeId: string) {
    const inst = await institutionOf(this.deps.db, p);
    if (!isUuid(routeId)) throw new CustomAPIError(404, 'TRN.ROUTE_NOT_FOUND');
    const route = await this.deps.db
      .selectFrom('transport_routes')
      .select('id')
      .where('public_id', '=', uuidToBin(routeId))
      .where('institution_id', '=', inst.id)
      .executeTakeFirst();
    if (!route) throw new CustomAPIError(404, 'TRN.ROUTE_NOT_FOUND');
    if (!this.deps.maps) throw new CustomAPIError(409, 'TRN.MAPS_OFF');
    const stops = await this.deps.db
      .selectFrom('transport_route_stops as rs')
      .innerJoin('transport_stops as s', 's.id', 'rs.stop_id')
      .select(['rs.seq', 's.public_id', 's.name', 's.lat', 's.lng'])
      .where('rs.route_id', '=', String(route.id))
      .orderBy('rs.seq')
      .execute();
    const missing = stops.filter((s) => s.lat === null || s.lng === null);
    if (missing.length) {
      throw new ValidationError([
        {
          field: 'stops',
          code: 'TRN.STOPS_WITHOUT_PLACE',
          params: { stops: missing.map((s) => s.name).join(', ') },
        },
      ]);
    }
    let legs: number[] = [];
    if (stops.length > 1) {
      try {
        legs = await this.deps.maps.legs(
          stops.map((s) => ({ lat: Number(s.lat), lng: Number(s.lng) })),
        );
      } catch (e) {
        if (e instanceof MapsServiceError) throw new CustomAPIError(502, 'TRN.MAPS_FAILED');
        throw e;
      }
    }
    const items = stops.map((s, i) => ({
      seq: s.seq,
      stopId: binToUuid(s.public_id),
      name: s.name,
      distanceKm: i === 0 ? 0 : (legs[i - 1] ?? 0),
    }));
    return {
      provider: this.deps.maps.provider,
      estimate: this.deps.maps.provider === 'test',
      items,
      totalKm: Math.round(items.reduce((n, s) => n + s.distanceKm, 0) * 100) / 100,
    };
  }
}

/** Deletes bus positions older than `days` (the job trip-generation), in batches; returns how many. */
export async function purgePositions(db: Kysely<Database>, days: number, now: Date) {
  const before = new Date(now.getTime() - days * 86_400_000);
  let total = 0;
  for (;;) {
    const r = await db
      .deleteFrom('transport_trip_positions')
      .where('received_at', '<', before)
      .limit(5000)
      .executeTakeFirst();
    const n = Number(r.numDeletedRows);
    total += n;
    if (n < 5000) return total;
  }
}
