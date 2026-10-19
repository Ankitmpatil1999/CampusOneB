/**
 * Transport masters, assignments and allocations (SRS 22.2–22.7, 22.16; TRN-001…022; FR-TRN-01…04;
 * BR-60, BR-61; CR-09, CR-13; OI-TRN-05…14, OI-TRN-28/29; prototype c.transport, c.routes, c.vehicles,
 * c.crew, c.sessions, c.assignments, c.allocations).
 *
 * - Masters are deactivated, never deleted (OI-TRN-29). A stop on an active route stays active.
 * - A route's stop list is replaced whole: sequence from 0 without gaps, no stop twice, distances not
 *   negative (22.16).
 * - Crew are members of the institution: a driver needs a licence with a future expiry (OI-TRN-08);
 *   the employee reference is unique (BR-60).
 * - Sessions run on chosen days of the week (OI-TRN-09).
 * - An assignment puts a route and session on a vehicle with a driver and an attendant for dates inside
 *   the year; overlapping dates never double-book the vehicle, the driver, the attendant or the
 *   route-session pair (BR-61).
 * - An allocation gives members a route and a stop on it for dates inside the year — never two active
 *   allocations over the same dates — and tells them and their families; it is ended, not deleted.
 * - A student whose admission form declined school transport is not allocated (client 2026-10-12);
 *   one with no choice on record (admitted before the form asked, imported, added directly) is.
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import type { Database, CrewRole, RouteType, TripDirection } from '../models/ringpe_models';
import {
  CustomAPIError,
  NotFoundError,
  PreconditionFailedError,
  ValidationError,
} from '../utils/CustomAPIError';
import { istBusinessDate } from '../utils/format';
import { binToUuid, isUuid, newPublicIdPair, uuidToBin } from '../utils/idGenerator';
import type { Principal } from '../utils/principal';
import { assertInYear, assertOpen, institutionOf, yearFor, yearView } from './academic-year';
import { recordAudit } from './audit.service';
import { notify } from './notifications.service';

type Db = Kysely<Database> | Transaction<Database>;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
export const WEEKDAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'] as const;
const nameOf = (first: string | null | undefined, last: string | null | undefined) =>
  [first, last].filter(Boolean).join(' ');
const ymd = (d: Date | string) => (typeof d === 'string' ? d.slice(0, 10) : istBusinessDate(d));
const hm = (t: string | null) => (t ? t.slice(0, 5) : null);
const dup = (e: unknown) => (e as { errno?: number }).errno === 1062;
const flag = (v: number | boolean | undefined) => (v === undefined ? undefined : v ? 1 : 0);

export class TransportService {
  constructor(
    private readonly deps: { readonly db: Kysely<Database>; readonly now?: () => Date },
  ) {}

  private now() {
    return this.deps.now?.() ?? new Date();
  }

  private by(p: Principal) {
    return isUuid(p.subject) ? uuidToBin(p.subject) : null;
  }

  private async row<
    T extends
      | 'transport_stops'
      | 'transport_routes'
      | 'transport_vehicles'
      | 'transport_crew'
      | 'transport_sessions',
  >(db: Db, table: T, institutionId: string, id: string, code: string) {
    if (!isUuid(id)) throw new CustomAPIError(404, code);
    const r = await (db as Kysely<Database>)
      .selectFrom(table as 'transport_stops')
      .selectAll()
      .where('public_id', '=', uuidToBin(id))
      .where('institution_id', '=', institutionId)
      .executeTakeFirst();
    if (!r) throw new CustomAPIError(404, code);
    return r as unknown as { id: string; row_version: number; active: number } & Record<
      string,
      unknown
    >;
  }

  /** Optimistic update of a master row; returns nothing — callers re-read the view. */
  private async patch(
    trx: Transaction<Database>,
    table:
      | 'transport_stops'
      | 'transport_routes'
      | 'transport_vehicles'
      | 'transport_crew'
      | 'transport_sessions',
    id: string,
    expected: number,
    set: Record<string, unknown>,
  ) {
    const r = await trx
      .updateTable(table as 'transport_stops')
      .set({
        ...(set as object),
        updated_at: this.now(),
        row_version: sql<number>`row_version + 1`,
      })
      .where('id', '=', id)
      .where('row_version', '=', expected)
      .executeTakeFirst();
    if (Number(r.numUpdatedRows) !== 1) throw new PreconditionFailedError();
  }

  private checkName(name: string | undefined, field = 'name') {
    const n = (name ?? '').trim();
    if (n.length < 2 || n.length > 80) throw new ValidationError([{ field, code: 'TRN.NAME' }]);
    return n;
  }

  // --- stops (TRN-005…007) -----------------------------------------------------------------------------------
  private stopView(s: {
    public_id: Buffer;
    name: string;
    landmark: string | null;
    lat: string | null;
    lng: string | null;
    active: number;
    row_version: number;
    routes?: number | string | null;
  }) {
    return {
      id: binToUuid(s.public_id),
      name: s.name,
      landmark: s.landmark,
      lat: s.lat === null ? null : Number(s.lat),
      lng: s.lng === null ? null : Number(s.lng),
      active: !!Number(s.active),
      routes: Number(s.routes ?? 0),
      version: s.row_version,
    };
  }

  async stops(p: Principal) {
    const inst = await institutionOf(this.deps.db, p);
    const rows = await this.deps.db
      .selectFrom('transport_stops as s')
      .selectAll('s')
      .select((eb) =>
        eb
          .selectFrom('transport_route_stops as rs')
          .innerJoin('transport_routes as r', 'r.id', 'rs.route_id')
          .select(sql<number>`COUNT(*)`.as('n'))
          .whereRef('rs.stop_id', '=', 's.id')
          .where('r.active', '=', 1)
          .as('routes'),
      )
      .where('s.institution_id', '=', inst.id)
      .orderBy('s.name')
      .execute();
    return { items: rows.map((s) => this.stopView(s)) };
  }

  private checkCoords(lat: number | null | undefined, lng: number | null | undefined) {
    if (lat !== undefined && lat !== null && (lat < -90 || lat > 90))
      throw new ValidationError([{ field: 'lat', code: 'TRN.LAT' }]);
    if (lng !== undefined && lng !== null && (lng < -180 || lng > 180))
      throw new ValidationError([{ field: 'lng', code: 'TRN.LNG' }]);
  }

  async createStop(
    p: Principal,
    input: {
      name: string;
      landmark?: string | null | undefined;
      lat?: number | null | undefined;
      lng?: number | null | undefined;
    },
  ) {
    const inst = await institutionOf(this.deps.db, p);
    const name = this.checkName(input.name);
    this.checkCoords(input.lat, input.lng);
    const pub = newPublicIdPair();
    const at = this.now();
    try {
      await this.deps.db
        .insertInto('transport_stops')
        .values({
          public_id: pub.bin,
          institution_id: inst.id,
          name,
          landmark: input.landmark?.trim().slice(0, 100) || null,
          lat: input.lat ?? null,
          lng: input.lng ?? null,
          created_at: at,
          updated_at: at,
        })
        .execute();
    } catch (e) {
      if (dup(e)) throw new CustomAPIError(409, 'TRN.STOP_NAME_TAKEN');
      throw e;
    }
    await recordAudit(this.deps.db, {
      institutionId: inst.id,
      action: 'STOP_CREATED',
      entityType: 'transport_stop',
      entityRef: pub.id,
      after: { name },
    });
    return (await this.stops(p)).items.find((s) => s.id === pub.id)!;
  }

  async updateStop(
    p: Principal,
    id: string,
    expected: number,
    input: {
      name?: string | undefined;
      landmark?: string | null | undefined;
      lat?: number | null | undefined;
      lng?: number | null | undefined;
      active?: boolean | undefined;
    },
  ) {
    const inst = await institutionOf(this.deps.db, p);
    this.checkCoords(input.lat, input.lng);
    await this.deps.db.transaction().execute(async (trx) => {
      const s = await this.row(trx, 'transport_stops', inst.id, id, 'TRN.STOP_NOT_FOUND');
      if (input.active === false && Number(s.active)) {
        const used = await trx
          .selectFrom('transport_route_stops as rs')
          .innerJoin('transport_routes as r', 'r.id', 'rs.route_id')
          .select('rs.route_id')
          .where('rs.stop_id', '=', s.id)
          .where('r.active', '=', 1)
          .executeTakeFirst();
        if (used) throw new CustomAPIError(409, 'TRN.STOP_IN_USE');
      }
      try {
        await this.patch(trx, 'transport_stops', s.id, expected, {
          ...(input.name !== undefined ? { name: this.checkName(input.name) } : {}),
          ...(input.landmark !== undefined
            ? { landmark: input.landmark?.trim().slice(0, 100) || null }
            : {}),
          ...(input.lat !== undefined ? { lat: input.lat } : {}),
          ...(input.lng !== undefined ? { lng: input.lng } : {}),
          ...(input.active !== undefined ? { active: flag(input.active) } : {}),
        });
      } catch (e) {
        if (dup(e)) throw new CustomAPIError(409, 'TRN.STOP_NAME_TAKEN');
        throw e;
      }
      await recordAudit(trx, {
        institutionId: inst.id,
        action: 'STOP_CHANGED',
        entityType: 'transport_stop',
        entityRef: id,
        after: input,
      });
    });
    return (await this.stops(p)).items.find((s) => s.id === id.toLowerCase())!;
  }

  // --- routes (TRN-001…004) ----------------------------------------------------------------------------------
  async routes(p: Principal, f: { active?: boolean | undefined }) {
    const inst = await institutionOf(this.deps.db, p);
    let q = this.deps.db
      .selectFrom('transport_routes')
      .selectAll()
      .where('institution_id', '=', inst.id);
    if (f.active !== undefined) q = q.where('active', '=', f.active ? 1 : 0);
    const routes = await q.orderBy('code').execute();
    const stops = routes.length
      ? await this.deps.db
          .selectFrom('transport_route_stops as rs')
          .innerJoin('transport_stops as s', 's.id', 'rs.stop_id')
          .select([
            'rs.route_id',
            'rs.seq',
            'rs.arrival',
            'rs.departure',
            'rs.distance_km',
            's.public_id',
            's.name',
            's.landmark',
            's.active',
          ])
          .where(
            'rs.route_id',
            'in',
            routes.map((r) => String(r.id)),
          )
          .orderBy('rs.route_id')
          .orderBy('rs.seq')
          .execute()
      : [];
    const passengers = routes.length
      ? await this.deps.db
          .selectFrom('transport_allocations')
          .select(['route_id', sql<number>`COUNT(*)`.as('n')])
          .where('institution_id', '=', inst.id)
          .where('active', '=', 1)
          .where('effective_to', '>=', istBusinessDate(this.now()))
          .groupBy('route_id')
          .execute()
      : [];
    return {
      items: routes.map((r) => {
        const list = stops.filter((s) => String(s.route_id) === String(r.id));
        return {
          id: binToUuid(r.public_id),
          code: r.code,
          name: r.name,
          description: r.description,
          type: r.route_type,
          mapLink: r.map_link,
          active: !!Number(r.active),
          distanceKm: Math.round(list.reduce((n, s) => n + Number(s.distance_km), 0) * 100) / 100,
          passengers: Number(passengers.find((x) => String(x.route_id) === String(r.id))?.n ?? 0),
          stops: list.map((s) => ({
            seq: s.seq,
            stop: {
              id: binToUuid(s.public_id),
              name: s.name,
              landmark: s.landmark,
              active: !!Number(s.active),
            },
            arrival: hm(s.arrival),
            departure: hm(s.departure),
            distanceKm: Number(s.distance_km),
          })),
          version: r.row_version,
        };
      }),
    };
  }

  private async route(p: Principal, id: string) {
    const out = (await this.routes(p, {})).items.find(
      (r) => isUuid(id) && r.id === id.toLowerCase(),
    );
    if (!out) throw new CustomAPIError(404, 'TRN.ROUTE_NOT_FOUND');
    return out;
  }

  private routeFields(input: {
    code?: string | undefined;
    name?: string | undefined;
    description?: string | null | undefined;
    type?: RouteType | undefined;
    mapLink?: string | null | undefined;
  }) {
    const code = input.code?.trim().toUpperCase();
    if (input.code !== undefined && (!code || code.length > 10 || !/^[A-Z0-9-]+$/.test(code))) {
      throw new ValidationError([{ field: 'code', code: 'TRN.ROUTE_DETAILS' }]);
    }
    if (input.mapLink && !/^https:\/\/\S+$/i.test(input.mapLink.trim())) {
      throw new ValidationError([{ field: 'mapLink', code: 'ACA.HW_LINK' }]);
    }
    return {
      ...(code !== undefined ? { code } : {}),
      ...(input.name !== undefined ? { name: this.checkName(input.name) } : {}),
      ...(input.description !== undefined
        ? { description: input.description?.trim().slice(0, 200) || null }
        : {}),
      ...(input.type !== undefined ? { route_type: input.type } : {}),
      ...(input.mapLink !== undefined ? { map_link: input.mapLink?.trim() || null } : {}),
    };
  }

  async createRoute(
    p: Principal,
    input: {
      code: string;
      name: string;
      description?: string | null | undefined;
      type?: RouteType | undefined;
      mapLink?: string | null | undefined;
    },
  ) {
    const inst = await institutionOf(this.deps.db, p);
    const fields = this.routeFields(input);
    const pub = newPublicIdPair();
    const at = this.now();
    try {
      await this.deps.db
        .insertInto('transport_routes')
        .values({
          public_id: pub.bin,
          institution_id: inst.id,
          code: fields.code!,
          name: fields.name!,
          description: fields.description ?? null,
          route_type: fields.route_type,
          map_link: fields.map_link ?? null,
          created_at: at,
          updated_at: at,
        })
        .execute();
    } catch (e) {
      if (dup(e)) throw new CustomAPIError(409, 'TRN.ROUTE_CODE_TAKEN');
      throw e;
    }
    await recordAudit(this.deps.db, {
      institutionId: inst.id,
      action: 'ROUTE_CREATED',
      entityType: 'transport_route',
      entityRef: pub.id,
      after: { code: fields.code },
    });
    return this.route(p, pub.id);
  }

  async updateRoute(
    p: Principal,
    id: string,
    expected: number,
    input: {
      code?: string | undefined;
      name?: string | undefined;
      description?: string | null | undefined;
      type?: RouteType | undefined;
      mapLink?: string | null | undefined;
      active?: boolean | undefined;
    },
  ) {
    const inst = await institutionOf(this.deps.db, p);
    const fields = this.routeFields(input);
    await this.deps.db.transaction().execute(async (trx) => {
      const r = await this.row(trx, 'transport_routes', inst.id, id, 'TRN.ROUTE_NOT_FOUND');
      try {
        await this.patch(trx, 'transport_routes', r.id, expected, {
          ...fields,
          ...(input.active !== undefined ? { active: flag(input.active) } : {}),
        });
      } catch (e) {
        if (dup(e)) throw new CustomAPIError(409, 'TRN.ROUTE_CODE_TAKEN');
        throw e;
      }
      await recordAudit(trx, {
        institutionId: inst.id,
        action: 'ROUTE_CHANGED',
        entityType: 'transport_route',
        entityRef: id,
        after: input,
      });
    });
    return this.route(p, id);
  }

  /** TRN-004: the whole ordered stop list, replaced at once (22.16). */
  async setRouteStops(
    p: Principal,
    id: string,
    expected: number,
    stops: readonly {
      stopId: string;
      seq: number;
      arrival?: string | null | undefined;
      departure?: string | null | undefined;
      distanceKm?: number | undefined;
    }[],
  ) {
    const inst = await institutionOf(this.deps.db, p);
    const sorted = [...stops].sort((a, b) => a.seq - b.seq);
    sorted.forEach((s, i) => {
      if (s.seq !== i)
        throw new ValidationError([{ field: `stops.${i}.seq`, code: 'TRN.STOP_SEQUENCE' }]);
      if ((s.distanceKm ?? 0) < 0)
        throw new ValidationError([{ field: `stops.${i}.distanceKm`, code: 'TRN.DISTANCE' }]);
      for (const t of [s.arrival, s.departure]) {
        if (t && !TIME.test(t))
          throw new ValidationError([{ field: `stops.${i}.arrival`, code: 'TRN.SESSION_TIMES' }]);
      }
      if (s.arrival && s.departure && s.departure < s.arrival) {
        throw new ValidationError([{ field: `stops.${i}.departure`, code: 'TRN.SESSION_TIMES' }]);
      }
    });
    await this.deps.db.transaction().execute(async (trx) => {
      const r = await this.row(trx, 'transport_routes', inst.id, id, 'TRN.ROUTE_NOT_FOUND');
      const ids = sorted.map((s) => s.stopId.toLowerCase());
      const known =
        ids.length && ids.every(isUuid)
          ? await trx
              .selectFrom('transport_stops')
              .select(['id', 'public_id', 'name'])
              .where('institution_id', '=', inst.id)
              .where(
                'public_id',
                'in',
                ids.map((x) => uuidToBin(x)),
              )
              .execute()
          : [];
      const byId = new Map(known.map((s) => [binToUuid(s.public_id), s]));
      const seen = new Set<string>();
      sorted.forEach((s, i) => {
        const stop = byId.get(s.stopId.toLowerCase());
        if (!stop)
          throw new ValidationError([{ field: `stops.${i}.stopId`, code: 'TRN.STOP_NOT_FOUND' }]);
        if (seen.has(String(stop.id))) {
          throw new ValidationError([
            { field: `stops.${i}.stopId`, code: 'TRN.DUPLICATE_STOP', params: { stop: stop.name } },
          ]);
        }
        seen.add(String(stop.id));
      });
      await this.patch(trx, 'transport_routes', r.id, expected, {});
      await trx.deleteFrom('transport_route_stops').where('route_id', '=', r.id).execute();
      if (sorted.length) {
        await trx
          .insertInto('transport_route_stops')
          .values(
            sorted.map((s) => ({
              route_id: r.id,
              seq: s.seq,
              stop_id: String(byId.get(s.stopId.toLowerCase())!.id),
              arrival: s.arrival ? `${s.arrival}:00` : null,
              departure: s.departure ? `${s.departure}:00` : null,
              distance_km: s.seq === 0 ? 0 : (s.distanceKm ?? 0),
            })),
          )
          .execute();
      }
      await recordAudit(trx, {
        institutionId: inst.id,
        action: 'ROUTE_STOPS_SET',
        entityType: 'transport_route',
        entityRef: id,
        after: { stops: sorted.length },
      });
    });
    return this.route(p, id);
  }

  // --- vehicles (TRN-008…010) --------------------------------------------------------------------------------
  async vehicles(p: Principal) {
    const inst = await institutionOf(this.deps.db, p);
    const rows = await this.deps.db
      .selectFrom('transport_vehicles')
      .selectAll()
      .where('institution_id', '=', inst.id)
      .orderBy('name')
      .execute();
    return {
      items: rows.map((v) => ({
        id: binToUuid(v.public_id),
        name: v.name,
        registration: v.registration,
        capacity: v.capacity,
        gps: { enabled: !!Number(v.gps_enabled), device: v.gps_device },
        active: !!Number(v.active),
        version: v.row_version,
      })),
    };
  }

  private vehicleFields(input: {
    name?: string | undefined;
    registration?: string | undefined;
    capacity?: number | undefined;
    gpsEnabled?: boolean | undefined;
    gpsDevice?: string | null | undefined;
  }) {
    const reg = input.registration?.trim().toUpperCase().replace(/\s+/g, '-');
    if (input.registration !== undefined && (!reg || reg.length > 15))
      throw new ValidationError([{ field: 'registration', code: 'TRN.REGISTRATION' }]);
    if (
      input.capacity !== undefined &&
      (!Number.isInteger(input.capacity) || input.capacity < 1 || input.capacity > 200)
    ) {
      throw new ValidationError([{ field: 'capacity', code: 'TRN.CAPACITY' }]);
    }
    return {
      ...(input.name !== undefined ? { name: this.checkName(input.name) } : {}),
      ...(reg !== undefined ? { registration: reg } : {}),
      ...(input.capacity !== undefined ? { capacity: input.capacity } : {}),
      ...(input.gpsEnabled !== undefined ? { gps_enabled: flag(input.gpsEnabled) } : {}),
      ...(input.gpsDevice !== undefined
        ? { gps_device: input.gpsDevice?.trim().slice(0, 60) || null }
        : {}),
    };
  }

  async createVehicle(
    p: Principal,
    input: {
      name: string;
      registration: string;
      capacity: number;
      gpsEnabled?: boolean | undefined;
      gpsDevice?: string | null | undefined;
    },
  ) {
    const inst = await institutionOf(this.deps.db, p);
    const f = this.vehicleFields(input);
    const pub = newPublicIdPair();
    const at = this.now();
    try {
      await this.deps.db
        .insertInto('transport_vehicles')
        .values({
          public_id: pub.bin,
          institution_id: inst.id,
          name: f.name!,
          registration: f.registration!,
          capacity: f.capacity!,
          gps_enabled: f.gps_enabled,
          gps_device: f.gps_device ?? null,
          created_at: at,
          updated_at: at,
        })
        .execute();
    } catch (e) {
      if (dup(e)) throw new CustomAPIError(409, 'TRN.REGISTRATION_TAKEN');
      throw e;
    }
    await recordAudit(this.deps.db, {
      institutionId: inst.id,
      action: 'VEHICLE_CREATED',
      entityType: 'transport_vehicle',
      entityRef: pub.id,
      after: { registration: f.registration },
    });
    return (await this.vehicles(p)).items.find((v) => v.id === pub.id)!;
  }

  async updateVehicle(
    p: Principal,
    id: string,
    expected: number,
    input: {
      name?: string | undefined;
      registration?: string | undefined;
      capacity?: number | undefined;
      gpsEnabled?: boolean | undefined;
      gpsDevice?: string | null | undefined;
      active?: boolean | undefined;
    },
  ) {
    const inst = await institutionOf(this.deps.db, p);
    const f = this.vehicleFields(input);
    await this.deps.db.transaction().execute(async (trx) => {
      const v = await this.row(trx, 'transport_vehicles', inst.id, id, 'TRN.VEHICLE_NOT_FOUND');
      try {
        await this.patch(trx, 'transport_vehicles', v.id, expected, {
          ...f,
          ...(input.active !== undefined ? { active: flag(input.active) } : {}),
        });
      } catch (e) {
        if (dup(e)) throw new CustomAPIError(409, 'TRN.REGISTRATION_TAKEN');
        throw e;
      }
      await recordAudit(trx, {
        institutionId: inst.id,
        action: 'VEHICLE_CHANGED',
        entityType: 'transport_vehicle',
        entityRef: id,
        after: input,
      });
    });
    return (await this.vehicles(p)).items.find((v) => v.id === id.toLowerCase())!;
  }

  // --- crew (TRN-011…013) --------------------------------------------------------------------------------------
  async crew(p: Principal) {
    const inst = await institutionOf(this.deps.db, p);
    const rows = await this.deps.db
      .selectFrom('transport_crew as c')
      .innerJoin('member_profiles as m', 'm.id', 'c.profile_id')
      .selectAll('c')
      .select(['m.public_id as member_public_id', 'm.first_name', 'm.last_name'])
      .where('c.institution_id', '=', inst.id)
      .orderBy('c.role')
      .orderBy('m.first_name')
      .execute();
    const today = istBusinessDate(this.now());
    return {
      items: rows.map((c) => ({
        id: binToUuid(c.public_id),
        member: { id: binToUuid(c.member_public_id), name: nameOf(c.first_name, c.last_name) },
        role: c.role,
        licenceNo: c.licence_no,
        licenceExpiry: c.licence_expiry ? ymd(c.licence_expiry) : null,
        licenceExpired: c.licence_expiry ? ymd(c.licence_expiry) < today : false,
        employeeRef: c.employee_ref,
        active: !!Number(c.active),
        version: c.row_version,
      })),
    };
  }

  private crewLicence(
    role: CrewRole,
    no: string | null | undefined,
    expiry: string | null | undefined,
  ) {
    if (role !== 'DRIVER') return;
    if (!no?.trim() || !expiry || !DAY.test(expiry) || expiry <= istBusinessDate(this.now())) {
      throw new ValidationError([{ field: 'licenceNo', code: 'TRN.LICENCE_REQUIRED' }]);
    }
  }

  async createCrew(
    p: Principal,
    input: {
      memberId: string;
      role: CrewRole;
      licenceNo?: string | null | undefined;
      licenceExpiry?: string | null | undefined;
      employeeRef: string;
    },
  ) {
    const inst = await institutionOf(this.deps.db, p);
    this.crewLicence(input.role, input.licenceNo, input.licenceExpiry);
    const ref = input.employeeRef.trim();
    if (!ref || ref.length > 30)
      throw new ValidationError([{ field: 'employeeRef', code: 'TRN.NAME' }]);
    const m = isUuid(input.memberId)
      ? await this.deps.db
          .selectFrom('member_profiles')
          .select(['id', 'status'])
          .where('public_id', '=', uuidToBin(input.memberId))
          .where('institution_id', '=', inst.id)
          .executeTakeFirst()
      : undefined;
    if (!m || m.status !== 'ACTIVE')
      throw new ValidationError([{ field: 'memberId', code: 'TRN.MEMBER_NOT_FOUND' }]);
    const pub = newPublicIdPair();
    const at = this.now();
    try {
      await this.deps.db
        .insertInto('transport_crew')
        .values({
          public_id: pub.bin,
          institution_id: inst.id,
          profile_id: String(m.id),
          role: input.role,
          licence_no: input.licenceNo?.trim() || null,
          licence_expiry: input.licenceExpiry ?? null,
          employee_ref: ref,
          created_at: at,
          updated_at: at,
        })
        .execute();
    } catch (e) {
      if (dup(e)) {
        const msg = String((e as Error).message);
        if (msg.includes('employee_ref'))
          throw new CustomAPIError(409, 'TRN.EMPLOYEE_REF_TAKEN', { params: { ref } });
        if (msg.includes('licence')) throw new CustomAPIError(409, 'TRN.LICENCE_TAKEN');
        throw new CustomAPIError(409, 'TRN.ALREADY_CREW');
      }
      throw e;
    }
    await recordAudit(this.deps.db, {
      institutionId: inst.id,
      action: 'CREW_CREATED',
      entityType: 'transport_crew',
      entityRef: pub.id,
      after: { role: input.role, ref },
    });
    return (await this.crew(p)).items.find((c) => c.id === pub.id)!;
  }

  async updateCrew(
    p: Principal,
    id: string,
    expected: number,
    input: {
      licenceNo?: string | null | undefined;
      licenceExpiry?: string | null | undefined;
      employeeRef?: string | undefined;
      active?: boolean | undefined;
    },
  ) {
    const inst = await institutionOf(this.deps.db, p);
    await this.deps.db.transaction().execute(async (trx) => {
      const c = await this.row(trx, 'transport_crew', inst.id, id, 'TRN.CREW_NOT_FOUND');
      if (input.licenceNo !== undefined || input.licenceExpiry !== undefined) {
        this.crewLicence(
          c['role'] as CrewRole,
          input.licenceNo !== undefined ? input.licenceNo : (c['licence_no'] as string | null),
          input.licenceExpiry !== undefined
            ? input.licenceExpiry
            : c['licence_expiry']
              ? ymd(c['licence_expiry'] as Date | string)
              : null,
        );
      }
      try {
        await this.patch(trx, 'transport_crew', c.id, expected, {
          ...(input.licenceNo !== undefined ? { licence_no: input.licenceNo?.trim() || null } : {}),
          ...(input.licenceExpiry !== undefined ? { licence_expiry: input.licenceExpiry } : {}),
          ...(input.employeeRef !== undefined ? { employee_ref: input.employeeRef.trim() } : {}),
          ...(input.active !== undefined ? { active: flag(input.active) } : {}),
        });
      } catch (e) {
        if (dup(e))
          throw new CustomAPIError(409, 'TRN.EMPLOYEE_REF_TAKEN', {
            params: { ref: input.employeeRef ?? '' },
          });
        throw e;
      }
      await recordAudit(trx, {
        institutionId: inst.id,
        action: 'CREW_CHANGED',
        entityType: 'transport_crew',
        entityRef: id,
        after: input,
      });
    });
    return (await this.crew(p)).items.find((c) => c.id === id.toLowerCase())!;
  }

  // --- sessions (TRN-014…016) ----------------------------------------------------------------------------------
  async sessions(p: Principal) {
    const inst = await institutionOf(this.deps.db, p);
    const rows = await this.deps.db
      .selectFrom('transport_sessions')
      .selectAll()
      .where('institution_id', '=', inst.id)
      .orderBy('start_time')
      .execute();
    return {
      items: rows.map((s) => {
        const days = s.days ? s.days.split(',') : [];
        return {
          id: binToUuid(s.public_id),
          name: s.name,
          direction: s.direction,
          startTime: hm(s.start_time),
          endTime: hm(s.end_time),
          days,
          daily: days.length === 7 || (days.length === 6 && !days.includes('SUN')),
          active: !!Number(s.active),
          version: s.row_version,
        };
      }),
    };
  }

  private sessionFields(input: {
    name?: string | undefined;
    direction?: TripDirection | undefined;
    startTime?: string | undefined;
    endTime?: string | null | undefined;
    days?: readonly string[] | undefined;
  }) {
    if (input.startTime !== undefined && !TIME.test(input.startTime))
      throw new ValidationError([{ field: 'startTime', code: 'TRN.SESSION_TIMES' }]);
    if (
      input.endTime &&
      (!TIME.test(input.endTime) || (input.startTime && input.endTime <= input.startTime))
    ) {
      throw new ValidationError([{ field: 'endTime', code: 'TRN.SESSION_TIMES' }]);
    }
    const days = input.days ? [...new Set(input.days.map((d) => d.toUpperCase()))] : undefined;
    if (days && (!days.length || days.some((d) => !(WEEKDAYS as readonly string[]).includes(d)))) {
      throw new ValidationError([{ field: 'days', code: 'TRN.SESSION_DAYS' }]);
    }
    return {
      ...(input.name !== undefined ? { name: this.checkName(input.name).slice(0, 40) } : {}),
      ...(input.direction !== undefined ? { direction: input.direction } : {}),
      ...(input.startTime !== undefined ? { start_time: `${input.startTime}:00` } : {}),
      ...(input.endTime !== undefined
        ? { end_time: input.endTime ? `${input.endTime}:00` : null }
        : {}),
      ...(days ? { days: WEEKDAYS.filter((d) => days.includes(d)).join(',') } : {}),
    };
  }

  async createSession(
    p: Principal,
    input: {
      name: string;
      direction: TripDirection;
      startTime: string;
      endTime?: string | null | undefined;
      days: readonly string[];
    },
  ) {
    const inst = await institutionOf(this.deps.db, p);
    const f = this.sessionFields(input);
    const pub = newPublicIdPair();
    const at = this.now();
    try {
      await this.deps.db
        .insertInto('transport_sessions')
        .values({
          public_id: pub.bin,
          institution_id: inst.id,
          name: f.name!,
          direction: f.direction!,
          start_time: f.start_time!,
          end_time: f.end_time ?? null,
          days: f.days!,
          created_at: at,
          updated_at: at,
        })
        .execute();
    } catch (e) {
      if (dup(e)) throw new CustomAPIError(409, 'TRN.SESSION_NAME_TAKEN');
      throw e;
    }
    await recordAudit(this.deps.db, {
      institutionId: inst.id,
      action: 'TRANSPORT_SESSION_CREATED',
      entityType: 'transport_session',
      entityRef: pub.id,
      after: { name: f.name },
    });
    return (await this.sessions(p)).items.find((s) => s.id === pub.id)!;
  }

  async updateSession(
    p: Principal,
    id: string,
    expected: number,
    input: {
      name?: string | undefined;
      direction?: TripDirection | undefined;
      startTime?: string | undefined;
      endTime?: string | null | undefined;
      days?: readonly string[] | undefined;
      active?: boolean | undefined;
    },
  ) {
    const inst = await institutionOf(this.deps.db, p);
    const f = this.sessionFields(input);
    await this.deps.db.transaction().execute(async (trx) => {
      const s = await this.row(trx, 'transport_sessions', inst.id, id, 'TRN.SESSION_NOT_FOUND');
      try {
        await this.patch(trx, 'transport_sessions', s.id, expected, {
          ...f,
          ...(input.active !== undefined ? { active: flag(input.active) } : {}),
        });
      } catch (e) {
        if (dup(e)) throw new CustomAPIError(409, 'TRN.SESSION_NAME_TAKEN');
        throw e;
      }
      await recordAudit(trx, {
        institutionId: inst.id,
        action: 'TRANSPORT_SESSION_CHANGED',
        entityType: 'transport_session',
        entityRef: id,
        after: input,
      });
    });
    return (await this.sessions(p)).items.find((s) => s.id === id.toLowerCase())!;
  }

  // --- vehicle assignments (TRN-017…019) -----------------------------------------------------------------------
  private assignmentRows(db: Db) {
    return db
      .selectFrom('transport_assignments as a')
      .innerJoin('transport_routes as r', 'r.id', 'a.route_id')
      .innerJoin('transport_sessions as s', 's.id', 'a.session_id')
      .innerJoin('transport_vehicles as v', 'v.id', 'a.vehicle_id')
      .innerJoin('transport_crew as d', 'd.id', 'a.driver_crew_id')
      .innerJoin('member_profiles as dm', 'dm.id', 'd.profile_id')
      .leftJoin('transport_crew as t', 't.id', 'a.attendant_crew_id')
      .leftJoin('member_profiles as tm', 'tm.id', 't.profile_id')
      .selectAll('a')
      .select([
        'r.public_id as route_public_id',
        'r.code as route_code',
        'r.name as route_name',
        's.public_id as session_public_id',
        's.name as session_name',
        's.direction',
        's.start_time',
        'v.public_id as vehicle_public_id',
        'v.name as vehicle_name',
        'v.registration',
        'd.public_id as driver_public_id',
        'dm.first_name as driver_first',
        'dm.last_name as driver_last',
        't.public_id as attendant_public_id',
        'tm.first_name as attendant_first',
        'tm.last_name as attendant_last',
      ]);
  }

  private assignmentView(
    a: Awaited<ReturnType<ReturnType<TransportService['assignmentRows']>['execute']>>[number],
  ) {
    return {
      id: binToUuid(a.public_id),
      route: { id: binToUuid(a.route_public_id), code: a.route_code, name: a.route_name },
      session: {
        id: binToUuid(a.session_public_id),
        name: a.session_name,
        direction: a.direction,
        startTime: hm(a.start_time),
      },
      vehicle: {
        id: binToUuid(a.vehicle_public_id),
        name: a.vehicle_name,
        registration: a.registration,
      },
      driver: { id: binToUuid(a.driver_public_id), name: nameOf(a.driver_first, a.driver_last) },
      attendant: a.attendant_public_id
        ? {
            id: binToUuid(a.attendant_public_id),
            name: nameOf(a.attendant_first, a.attendant_last),
          }
        : null,
      from: ymd(a.effective_from),
      to: ymd(a.effective_to),
      active: !!Number(a.active),
      version: a.row_version,
    };
  }

  async assignments(p: Principal) {
    const inst = await institutionOf(this.deps.db, p);
    const rows = await this.assignmentRows(this.deps.db)
      .where('a.institution_id', '=', inst.id)
      .orderBy('r.code')
      .orderBy('s.start_time')
      .execute();
    return { items: rows.map((a) => this.assignmentView(a)) };
  }

  private async assignmentOne(db: Db, institutionId: string, id: string) {
    if (!isUuid(id)) throw new CustomAPIError(404, 'TRN.ASSIGNMENT_NOT_FOUND');
    const a = await this.assignmentRows(db)
      .where('a.public_id', '=', uuidToBin(id))
      .where('a.institution_id', '=', institutionId)
      .executeTakeFirst();
    if (!a) throw new CustomAPIError(404, 'TRN.ASSIGNMENT_NOT_FOUND');
    return a;
  }

  /** BR-61: no overlapping active assignment shares the vehicle, a crew member or the route-session pair. */
  private async noClash(
    trx: Transaction<Database>,
    institutionId: string,
    a: {
      id?: string;
      route_id: string;
      session_id: string;
      vehicle_id: string;
      driver_crew_id: string;
      attendant_crew_id: string | null;
      from: string;
      to: string;
    },
  ) {
    let q = trx
      .selectFrom('transport_assignments')
      .select(['id', 'route_id', 'session_id', 'vehicle_id', 'driver_crew_id', 'attendant_crew_id'])
      .where('institution_id', '=', institutionId)
      .where('active', '=', 1)
      .where('effective_from', '<=', a.to)
      .where('effective_to', '>=', a.from)
      .forUpdate();
    if (a.id) q = q.where('id', '!=', a.id);
    const others = await q.execute();
    const crewOf = (o: (typeof others)[number]) => [
      String(o.driver_crew_id),
      o.attendant_crew_id ? String(o.attendant_crew_id) : null,
    ];
    for (const o of others) {
      if (String(o.route_id) === a.route_id && String(o.session_id) === a.session_id)
        throw new CustomAPIError(409, 'TRN.ROUTE_SESSION_TAKEN');
    }
    // The vehicle and the crew are booked for a session's days and hours: a bus runs several sessions
    // a day, but never two that share a day and overlap in time (an open end counts as 90 minutes).
    const sessionIds = [...new Set([a.session_id, ...others.map((o) => String(o.session_id))])];
    const sessions = new Map(
      (
        await trx
          .selectFrom('transport_sessions')
          .select(['id', 'start_time', 'end_time', 'days'])
          .where('id', 'in', sessionIds)
          .execute()
      ).map((x) => {
        const start = Number(x.start_time.slice(0, 2)) * 60 + Number(x.start_time.slice(3, 5));
        const end = x.end_time
          ? Number(x.end_time.slice(0, 2)) * 60 + Number(x.end_time.slice(3, 5))
          : start + 90;
        return [String(x.id), { start, end, days: new Set(x.days.split(',')) }];
      }),
    );
    const mine = sessions.get(a.session_id)!;
    const overlaps = (sid: string) => {
      const o = sessions.get(sid);
      return (
        !!o && [...o.days].some((d) => mine.days.has(d)) && o.start < mine.end && mine.start < o.end
      );
    };
    for (const o of others.filter((x) => overlaps(String(x.session_id)))) {
      if (String(o.vehicle_id) === a.vehicle_id)
        throw new CustomAPIError(409, 'TRN.VEHICLE_BOOKED');
      if (crewOf(o).includes(a.driver_crew_id)) throw new CustomAPIError(409, 'TRN.DRIVER_BOOKED');
      if (a.attendant_crew_id && crewOf(o).includes(a.attendant_crew_id))
        throw new CustomAPIError(409, 'TRN.ATTENDANT_BOOKED');
    }
  }

  private async resolveAssignment(
    trx: Transaction<Database>,
    institutionId: string,
    input: {
      routeId: string;
      sessionId: string;
      vehicleId: string;
      driverId: string;
      attendantId?: string | null | undefined;
    },
  ) {
    const route = await this.row(
      trx,
      'transport_routes',
      institutionId,
      input.routeId,
      'TRN.ROUTE_NOT_FOUND',
    );
    if (!Number(route.active)) throw new CustomAPIError(409, 'TRN.ROUTE_INACTIVE');
    const session = await this.row(
      trx,
      'transport_sessions',
      institutionId,
      input.sessionId,
      'TRN.SESSION_NOT_FOUND',
    );
    const vehicle = await this.row(
      trx,
      'transport_vehicles',
      institutionId,
      input.vehicleId,
      'TRN.VEHICLE_NOT_FOUND',
    );
    if (!Number(vehicle.active)) throw new CustomAPIError(409, 'TRN.VEHICLE_INACTIVE');
    const driver = await this.row(
      trx,
      'transport_crew',
      institutionId,
      input.driverId,
      'TRN.CREW_NOT_FOUND',
    );
    if (driver['role'] !== 'DRIVER' || !Number(driver.active))
      throw new ValidationError([{ field: 'driverId', code: 'TRN.NOT_DRIVER' }]);
    let attendant: Awaited<ReturnType<TransportService['row']>> | null = null;
    if (input.attendantId) {
      if (input.attendantId.toLowerCase() === input.driverId.toLowerCase())
        throw new ValidationError([{ field: 'attendantId', code: 'TRN.SAME_CREW' }]);
      attendant = await this.row(
        trx,
        'transport_crew',
        institutionId,
        input.attendantId,
        'TRN.CREW_NOT_FOUND',
      );
      if (attendant['role'] !== 'ATTENDANT' || !Number(attendant.active))
        throw new ValidationError([{ field: 'attendantId', code: 'TRN.NOT_ATTENDANT' }]);
    }
    return { route, session, vehicle, driver, attendant };
  }

  async createAssignment(
    p: Principal,
    input: {
      routeId: string;
      sessionId: string;
      vehicleId: string;
      driverId: string;
      attendantId?: string | null | undefined;
      from: string;
      to: string;
    },
  ) {
    const inst = await institutionOf(this.deps.db, p);
    if (!DAY.test(input.from) || !DAY.test(input.to))
      throw new ValidationError([{ field: 'from', code: 'VALIDATION.DATE' }]);
    if (input.to < input.from) throw new ValidationError([{ field: 'to', code: 'TRN.DATES' }]);
    const pub = newPublicIdPair();
    const at = this.now();
    await this.deps.db.transaction().execute(async (trx) => {
      const year = await yearFor(trx, inst.id, undefined);
      assertOpen(year);
      assertInYear(year, input.from, 'from');
      assertInYear(year, input.to, 'to');
      const r = await this.resolveAssignment(trx, inst.id, input);
      await this.noClash(trx, inst.id, {
        route_id: r.route.id,
        session_id: r.session.id,
        vehicle_id: r.vehicle.id,
        driver_crew_id: r.driver.id,
        attendant_crew_id: r.attendant?.id ?? null,
        from: input.from,
        to: input.to,
      });
      await trx
        .insertInto('transport_assignments')
        .values({
          public_id: pub.bin,
          institution_id: inst.id,
          year_id: year.id,
          route_id: r.route.id,
          session_id: r.session.id,
          vehicle_id: r.vehicle.id,
          driver_crew_id: r.driver.id,
          attendant_crew_id: r.attendant?.id ?? null,
          effective_from: input.from,
          effective_to: input.to,
          created_at: at,
          updated_at: at,
        })
        .execute();
      await recordAudit(trx, {
        institutionId: inst.id,
        action: 'VEHICLE_ASSIGNED',
        entityType: 'transport_assignment',
        entityRef: pub.id,
        after: { from: input.from, to: input.to },
      });
    });
    return this.assignmentView(await this.assignmentOne(this.deps.db, inst.id, pub.id));
  }

  async updateAssignment(
    p: Principal,
    id: string,
    expected: number,
    input: {
      vehicleId?: string | undefined;
      driverId?: string | undefined;
      attendantId?: string | null | undefined;
      to?: string | undefined;
      active?: boolean | undefined;
    },
  ) {
    const inst = await institutionOf(this.deps.db, p);
    await this.deps.db.transaction().execute(async (trx) => {
      const a = await this.assignmentOne(trx, inst.id, id);
      const year = await yearFor(trx, inst.id, undefined);
      const to = input.to ?? ymd(a.effective_to);
      if (!DAY.test(to)) throw new ValidationError([{ field: 'to', code: 'VALIDATION.DATE' }]);
      if (to < ymd(a.effective_from))
        throw new ValidationError([{ field: 'to', code: 'TRN.DATES' }]);
      if (input.to) assertInYear(year, to, 'to');
      const r = await this.resolveAssignment(trx, inst.id, {
        routeId: binToUuid(a.route_public_id),
        sessionId: binToUuid(a.session_public_id),
        vehicleId: input.vehicleId ?? binToUuid(a.vehicle_public_id),
        driverId: input.driverId ?? binToUuid(a.driver_public_id),
        attendantId:
          input.attendantId !== undefined
            ? input.attendantId
            : a.attendant_public_id
              ? binToUuid(a.attendant_public_id)
              : null,
      });
      const active = input.active ?? !!Number(a.active);
      if (active) {
        await this.noClash(trx, inst.id, {
          id: a.id,
          route_id: r.route.id,
          session_id: r.session.id,
          vehicle_id: r.vehicle.id,
          driver_crew_id: r.driver.id,
          attendant_crew_id: r.attendant?.id ?? null,
          from: ymd(a.effective_from),
          to,
        });
      }
      const u = await trx
        .updateTable('transport_assignments')
        .set({
          vehicle_id: r.vehicle.id,
          driver_crew_id: r.driver.id,
          attendant_crew_id: r.attendant?.id ?? null,
          effective_to: to,
          active: active ? 1 : 0,
          updated_at: this.now(),
          row_version: sql<number>`row_version + 1`,
        })
        .where('id', '=', a.id)
        .where('row_version', '=', expected)
        .executeTakeFirst();
      if (Number(u.numUpdatedRows) !== 1) throw new PreconditionFailedError();
      await recordAudit(trx, {
        institutionId: inst.id,
        action: 'VEHICLE_ASSIGNMENT_CHANGED',
        entityType: 'transport_assignment',
        entityRef: id,
        after: input,
      });
    });
    return this.assignmentView(await this.assignmentOne(this.deps.db, inst.id, id));
  }

  // --- passenger allocations (TRN-020…022) -----------------------------------------------------------------
  async allocations(
    p: Principal,
    f: {
      kind?: 'STUDENT' | 'STAFF' | undefined;
      routeId?: string | undefined;
      yearId?: string | undefined;
      assigned?: boolean | undefined;
      q?: string | undefined;
      cursor?: string | undefined;
    },
  ) {
    const inst = await institutionOf(this.deps.db, p);
    const year = await yearFor(this.deps.db, inst.id, f.yearId);
    const today = istBusinessDate(this.now());
    const db = this.deps.db;
    const kinds = f.kind === 'STAFF' ? ['TEACHER', 'PRINCIPAL', 'STAFF'] : ['STUDENT'];
    let q = db
      .selectFrom('member_profiles as m')
      .innerJoin('user_types as ut', 'ut.id', 'm.user_type_id')
      .leftJoin('transport_allocations as al', (j) =>
        j
          .onRef('al.profile_id', '=', 'm.id')
          .on('al.year_id', '=', year.id)
          .on('al.active', '=', 1)
          .on('al.effective_to', '>=', today),
      )
      .leftJoin('transport_routes as r', 'r.id', 'al.route_id')
      .leftJoin('transport_stops as st', 'st.id', 'al.stop_id')
      .leftJoin('enrolments as en', (j) =>
        j.onRef('en.student_profile_id', '=', 'm.id').on('en.year_id', '=', year.id),
      )
      .leftJoin('sections as s', 's.id', 'en.section_id')
      .leftJoin('classes as c', 'c.id', 's.class_id')
      .select([
        'm.id',
        'm.public_id',
        'm.first_name',
        'm.last_name',
        'm.admission_no',
        'ut.name as type_name',
        'c.name as class_name',
        's.name as section_name',
        'al.public_id as allocation_public_id',
        'al.effective_from',
        'al.effective_to',
        'al.row_version',
        'r.public_id as route_public_id',
        'r.code as route_code',
        'r.name as route_name',
        'st.public_id as stop_public_id',
        'st.name as stop_name',
      ])
      .where('m.institution_id', '=', inst.id)
      .where('m.status', '=', 'ACTIVE')
      .where('ut.category', 'in', kinds as never[]);
    if (f.assigned === true) q = q.where('al.id', 'is not', null);
    if (f.assigned === false) q = q.where('al.id', 'is', null);
    if (f.routeId && isUuid(f.routeId)) q = q.where('r.public_id', '=', uuidToBin(f.routeId));
    const text = (f.q ?? '').trim();
    if (text)
      q = q.where((eb) =>
        eb.or([
          eb('m.first_name', 'like', `%${text}%`),
          eb('m.last_name', 'like', `%${text}%`),
          eb('m.admission_no', 'like', `%${text}%`),
        ]),
      );
    if (f.cursor && /^\d+$/.test(f.cursor)) q = q.where('m.id', '>', f.cursor);
    const rows = await q.orderBy('m.id').limit(101).execute();
    const page = rows.slice(0, 100);
    const choices = await this.transportChoices(
      db,
      page.map((r) => String(r.id)),
    );
    return {
      year: yearView(year),
      items: page.map((r) => ({
        // Opted on the admission form or not, with the stop preferred; null: no choice on record.
        transport: choices.get(String(r.id)) ?? null,
        member: {
          id: binToUuid(r.public_id),
          name: nameOf(r.first_name, r.last_name),
          admissionNo: r.admission_no,
          class: r.class_name ?? null,
          section: r.section_name ?? null,
          type: r.type_name,
        },
        allocation: r.allocation_public_id
          ? {
              id: binToUuid(r.allocation_public_id),
              route: { id: binToUuid(r.route_public_id!), code: r.route_code, name: r.route_name },
              stop: { id: binToUuid(r.stop_public_id!), name: r.stop_name },
              from: ymd(r.effective_from!),
              to: ymd(r.effective_to!),
              version: r.row_version,
            }
          : null,
      })),
      nextCursor: rows.length > 100 ? String(page.at(-1)!.id) : null,
    };
  }

  /**
   * What each student chose about school transport on the admission form (client 2026-10-12): opted
   * or not, and the pick-up stop preferred — from the approved application that made them a
   * member. Students with no choice on record are left out.
   */
  private async transportChoices(db: Db, profileIds: readonly string[]) {
    const out = new Map<string, { opted: boolean; stop: string | null }>();
    if (!profileIds.length) return out;
    const rows = await db
      .selectFrom('admission_applications')
      .select([
        'member_profile_id',
        sql<string | null>`JSON_UNQUOTE(JSON_EXTRACT(data, '$.parents.transport'))`.as('opted'),
        sql<string | null>`JSON_UNQUOTE(JSON_EXTRACT(data, '$.parents.transportStop.name'))`.as(
          'stop',
        ),
      ])
      .where('member_profile_id', 'in', [...profileIds])
      .where('status', '=', 'APPROVED')
      .orderBy('id', 'desc')
      .execute();
    const seen = new Set<string>();
    for (const r of rows) {
      const id = String(r.member_profile_id);
      // The latest approved application decides.
      if (seen.has(id)) continue;
      seen.add(id);
      if (r.opted !== 'true' && r.opted !== 'false') continue;
      out.set(id, {
        opted: r.opted === 'true',
        stop: r.stop && r.stop !== 'null' ? r.stop : null,
      });
    }
    return out;
  }

  private async familyAccounts(db: Db, profileRowId: string) {
    const rows = await db
      .selectFrom('member_profiles as m')
      .leftJoin('guardianships as g', 'g.ward_profile_id', 'm.id')
      .leftJoin('member_profiles as gm', 'gm.id', 'g.guardian_profile_id')
      .select(['m.account_id', 'gm.account_id as guardian_account'])
      .where('m.id', '=', profileRowId)
      .execute();
    return rows
      .flatMap((r) => [r.account_id, r.guardian_account])
      .filter((a): a is string => a !== null && a !== undefined)
      .map(String);
  }

  /** TRN-021: allocate members to a route and stop; each one never twice over the same dates. */
  async allocate(
    p: Principal,
    input: {
      memberIds: readonly string[];
      routeId: string;
      stopId: string;
      from: string;
      to: string;
    },
  ) {
    const inst = await institutionOf(this.deps.db, p);
    if (!DAY.test(input.from) || !DAY.test(input.to))
      throw new ValidationError([{ field: 'from', code: 'VALIDATION.DATE' }]);
    if (input.to < input.from) throw new ValidationError([{ field: 'to', code: 'TRN.DATES' }]);
    const ids = [...new Set(input.memberIds.map((m) => m.toLowerCase()))];
    if (!ids.length || ids.length > 200 || ids.some((m) => !isUuid(m)))
      throw new ValidationError([{ field: 'memberIds', code: 'TRN.MEMBERS' }]);
    const at = this.now();
    const made: string[] = [];
    await this.deps.db.transaction().execute(async (trx) => {
      const year = await yearFor(trx, inst.id, undefined);
      assertOpen(year);
      assertInYear(year, input.from, 'from');
      assertInYear(year, input.to, 'to');
      const route = await this.row(
        trx,
        'transport_routes',
        inst.id,
        input.routeId,
        'TRN.ROUTE_NOT_FOUND',
      );
      if (!Number(route.active)) throw new CustomAPIError(409, 'TRN.ROUTE_INACTIVE');
      const stop = await this.row(
        trx,
        'transport_stops',
        inst.id,
        input.stopId,
        'TRN.STOP_NOT_FOUND',
      );
      const onRoute = await trx
        .selectFrom('transport_route_stops')
        .select('seq')
        .where('route_id', '=', route.id)
        .where('stop_id', '=', stop.id)
        .executeTakeFirst();
      if (!onRoute) throw new ValidationError([{ field: 'stopId', code: 'TRN.STOP_NOT_ON_ROUTE' }]);
      const members = await trx
        .selectFrom('member_profiles')
        .select(['id', 'public_id', 'first_name', 'last_name'])
        .where('institution_id', '=', inst.id)
        .where('status', '=', 'ACTIVE')
        .where(
          'public_id',
          'in',
          ids.map((m) => uuidToBin(m)),
        )
        .forUpdate()
        .execute();
      if (members.length !== ids.length)
        throw new ValidationError([{ field: 'memberIds', code: 'TRN.MEMBERS' }]);
      // Only students who opted for school transport on the admission form (client 2026-10-12).
      const choices = await this.transportChoices(
        trx,
        members.map((m) => String(m.id)),
      );
      const declined = members.filter((m) => choices.get(String(m.id))?.opted === false);
      if (declined.length) {
        throw new CustomAPIError(409, 'TRN.NOT_OPTED', {
          params: { names: declined.map((m) => nameOf(m.first_name, m.last_name)).join(', ') },
        });
      }
      for (const m of members) {
        const clash = await trx
          .selectFrom('transport_allocations')
          .select('id')
          .where('profile_id', '=', String(m.id))
          .where('active', '=', 1)
          .where('effective_from', '<=', input.to)
          .where('effective_to', '>=', input.from)
          .executeTakeFirst();
        if (clash) throw new CustomAPIError(409, 'TRN.ALREADY_ALLOCATED');
        const pub = newPublicIdPair();
        await trx
          .insertInto('transport_allocations')
          .values({
            public_id: pub.bin,
            institution_id: inst.id,
            year_id: year.id,
            profile_id: String(m.id),
            route_id: route.id,
            stop_id: stop.id,
            effective_from: input.from,
            effective_to: input.to,
            created_by: this.by(p),
            created_at: at,
          })
          .execute();
        made.push(pub.id);
        await notify(
          trx,
          {
            institutionId: inst.id,
            accountIds: await this.familyAccounts(trx, String(m.id)),
            about: [String(m.id)],
            surface: 'MEMBER',
            category: 'ACCOUNT',
            titleKey: 'NTF.TRANSPORT_ALLOCATED',
            params: { route: `${String(route['code'])} · ${String(route['name'])}` },
            body: `Stop: ${String(stop['name'])} · from ${input.from}`,
            link: '/transport',
          },
          at,
        );
      }
      await recordAudit(trx, {
        institutionId: inst.id,
        action: 'PASSENGERS_ALLOCATED',
        entityType: 'transport_route',
        entityRef: input.routeId,
        after: { members: members.length, from: input.from, to: input.to },
      });
    });
    return { allocated: made.length, ids: made };
  }

  /** A member of the caller's school (404 otherwise). */
  async memberFor(p: Principal, memberId: string) {
    const inst = await institutionOf(this.deps.db, p);
    const m = isUuid(memberId)
      ? await this.deps.db
          .selectFrom('member_profiles')
          .select(['id', 'first_name', 'last_name'])
          .where('institution_id', '=', inst.id)
          .where('public_id', '=', uuidToBin(memberId))
          .executeTakeFirst()
      : undefined;
    if (!m) throw new NotFoundError();
    return { inst, member: m };
  }

  /**
   * TRN-035: the transport desk changes a student's transport choice from the admission form when
   * the family changes its mind after admission (client 2026-10-12). The choice stays on the
   * approved application that holds it, the reason goes to the audit log. A student with no choice
   * on record is eligible already; one opted out must have their current allocation ended first.
   */
  async setTransportChoice(
    p: Principal,
    memberId: string,
    input: { opted: boolean; reason: string },
  ) {
    const { inst, member } = await this.memberFor(p, memberId);
    const reason = input.reason.trim();
    if (reason.length < 3)
      throw new ValidationError([{ field: 'reason', code: 'TRN.CHOICE_REASON' }]);
    const app = await this.deps.db
      .selectFrom('admission_applications')
      .select([
        'id',
        'public_id',
        sql<string | null>`JSON_UNQUOTE(JSON_EXTRACT(data, '$.parents.transport'))`.as('opted'),
      ])
      .where('institution_id', '=', inst.id)
      .where('member_profile_id', '=', String(member.id))
      .where('status', '=', 'APPROVED')
      .orderBy('id', 'desc')
      .executeTakeFirst();
    if (!app || (app.opted !== 'true' && app.opted !== 'false')) {
      throw new CustomAPIError(409, 'TRN.NO_TRANSPORT_CHOICE');
    }
    const before = app.opted === 'true';
    const today = istBusinessDate(this.now());
    if (!input.opted) {
      const current = await this.deps.db
        .selectFrom('transport_allocations')
        .select('id')
        .where('profile_id', '=', String(member.id))
        .where('active', '=', 1)
        .where('effective_to', '>=', today)
        .executeTakeFirst();
      if (current) throw new CustomAPIError(409, 'TRN.OPT_OUT_ALLOCATED');
    }
    const at = this.now();
    await this.deps.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('admission_applications')
        .set({
          data: sql`JSON_SET(data, '$.parents.transport', CAST(${input.opted ? 'true' : 'false'} AS JSON))`,
          updated_at: at,
          row_version: sql<number>`row_version + 1`,
        })
        .where('id', '=', app.id)
        .execute();
      await recordAudit(trx, {
        institutionId: inst.id,
        action: 'TRANSPORT_CHOICE_CHANGED',
        entityType: 'member',
        entityRef: memberId,
        before: { opted: before },
        after: { opted: input.opted, reason, application: binToUuid(app.public_id) },
      });
    });
    const now = await this.transportChoices(this.deps.db, [String(member.id)]);
    return { memberId: memberId.toLowerCase(), transport: now.get(String(member.id)) ?? null };
  }

  /** TRN-022: end an allocation (kept on record). */
  async endAllocation(p: Principal, id: string, input: { endDate: string; reason: string }) {
    const inst = await institutionOf(this.deps.db, p);
    if (!isUuid(id)) throw new CustomAPIError(404, 'TRN.ALLOCATION_NOT_FOUND');
    if (!DAY.test(input.endDate))
      throw new ValidationError([{ field: 'endDate', code: 'VALIDATION.DATE' }]);
    const reason = input.reason.trim();
    if (reason.length < 3 || reason.length > 200)
      throw new ValidationError([{ field: 'reason', code: 'TRN.CANCEL_REMARKS' }]);
    const a = await this.deps.db
      .selectFrom('transport_allocations as al')
      .innerJoin('transport_routes as r', 'r.id', 'al.route_id')
      .select([
        'al.id',
        'al.profile_id',
        'al.active',
        'al.effective_from',
        'al.effective_to',
        'r.code as route_code',
        'r.name as route_name',
      ])
      .where('al.public_id', '=', uuidToBin(id))
      .where('al.institution_id', '=', inst.id)
      .executeTakeFirst();
    if (!a) throw new CustomAPIError(404, 'TRN.ALLOCATION_NOT_FOUND');
    if (!Number(a.active)) throw new CustomAPIError(409, 'TRN.ALLOCATION_ENDED');
    const end = input.endDate < ymd(a.effective_from) ? ymd(a.effective_from) : input.endDate;
    if (end > ymd(a.effective_to))
      throw new ValidationError([{ field: 'endDate', code: 'TRN.DATES' }]);
    await this.deps.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('transport_allocations')
        .set({
          effective_to: end,
          active: end < istBusinessDate(this.now()) ? 0 : 1,
          end_reason: reason,
          ended_by: this.by(p),
          ended_at: this.now(),
          row_version: sql<number>`row_version + 1`,
        })
        .where('id', '=', a.id)
        .execute();
      await notify(
        trx,
        {
          institutionId: inst.id,
          accountIds: await this.familyAccounts(trx, String(a.profile_id)),
          about: [String(a.profile_id)],
          surface: 'MEMBER',
          category: 'ACCOUNT',
          titleKey: 'NTF.TRANSPORT_ENDED',
          params: { route: `${a.route_code} · ${a.route_name}`, date: end },
          body: reason,
          link: '/transport',
        },
        this.now(),
      );
      await recordAudit(trx, {
        institutionId: inst.id,
        action: 'ALLOCATION_ENDED',
        entityType: 'transport_allocation',
        entityRef: id,
        after: { end, reason },
      });
    });
    return { id: id.toLowerCase(), endDate: end, reason };
  }

  /** For the tenant check before a body is read. */
  async lookup(
    p: Principal,
    kind: 'route' | 'stop' | 'vehicle' | 'crew' | 'session' | 'assignment' | 'allocation',
    id: string,
  ) {
    const inst = await institutionOf(this.deps.db, p);
    const db = this.deps.db;
    if (kind === 'assignment') return void (await this.assignmentOne(db, inst.id, id));
    if (kind === 'allocation') {
      const a = isUuid(id)
        ? await db
            .selectFrom('transport_allocations')
            .select('id')
            .where('public_id', '=', uuidToBin(id))
            .where('institution_id', '=', inst.id)
            .executeTakeFirst()
        : undefined;
      if (!a) throw new CustomAPIError(404, 'TRN.ALLOCATION_NOT_FOUND');
      return;
    }
    const map = {
      route: ['transport_routes', 'TRN.ROUTE_NOT_FOUND'],
      stop: ['transport_stops', 'TRN.STOP_NOT_FOUND'],
      vehicle: ['transport_vehicles', 'TRN.VEHICLE_NOT_FOUND'],
      crew: ['transport_crew', 'TRN.CREW_NOT_FOUND'],
      session: ['transport_sessions', 'TRN.SESSION_NOT_FOUND'],
    } as const;
    await this.row(db, map[kind][0], inst.id, id, map[kind][1]);
  }

  /** Ensures a member id belongs to the school (used by the crew registration form). */
  async memberExists(institutionId: string, id: string) {
    if (!isUuid(id)) throw new NotFoundError();
    const m = await this.deps.db
      .selectFrom('member_profiles')
      .select('id')
      .where('public_id', '=', uuidToBin(id))
      .where('institution_id', '=', institutionId)
      .executeTakeFirst();
    if (!m) throw new NotFoundError();
  }
}
