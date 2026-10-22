import { Router, type Request, type RequestHandler } from 'express';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { defineRoute } from '../config/openapi-registry';
import type { Loggers } from '../controllers/logger';
import {
  authorize,
  memberOrConsole,
  requireSurface,
  requireTenant,
} from '../middlewares/auth.middleware';
import { idempotency } from '../middlewares/idempotency.middleware';
import type { Database } from '../models/ringpe_models';
import type { TransportFeesService } from '../services/transport-fees.service';
import type { TransportLiveService } from '../services/transport-live.service';
import type { TransportService } from '../services/transport.service';
import type { TripsService } from '../services/trips.service';
import { AuthenticationError } from '../utils/CustomAPIError';
import { expectedVersion, setEtag } from '../utils/etag';

const date = z.iso.date({ message: 'VALIDATION.DATE' });
const uuid = z.string().max(40);
const time = z.string().max(5);
const name = z.string({ message: 'TRN.NAME' }).max(80, { message: 'TRN.NAME' });
const routeType = z.enum(['MORNING', 'EVENING', 'SPECIAL', 'EMERGENCY'], {
  message: 'VALIDATION.FORMAT',
});

export const stopSchema = z
  .strictObject({
    name,
    landmark: z.string().max(100).nullable().optional(),
    lat: z.number().nullable().optional(),
    lng: z.number().nullable().optional(),
    active: z.boolean().optional(),
  })
  .meta({ id: 'TransportStopInput' });
export const routeSchema = z
  .strictObject({
    code: z.string({ message: 'TRN.ROUTE_DETAILS' }).max(10, { message: 'TRN.ROUTE_DETAILS' }),
    name,
    description: z.string().max(200).nullable().optional(),
    type: routeType.optional(),
    mapLink: z.string().max(300).nullable().optional(),
    active: z.boolean().optional(),
  })
  .meta({ id: 'TransportRouteInput' });
export const routeStopsSchema = z
  .strictObject({
    stops: z
      .array(
        z.strictObject({
          stopId: uuid,
          seq: z.number().int().min(0).max(99),
          arrival: time.nullable().optional(),
          departure: time.nullable().optional(),
          distanceKm: z.number().optional(),
        }),
      )
      .max(60),
  })
  .meta({ id: 'RouteStops' });
export const vehicleSchema = z
  .strictObject({
    name,
    registration: z
      .string({ message: 'TRN.REGISTRATION' })
      .max(20, { message: 'TRN.REGISTRATION' }),
    capacity: z.number({ message: 'TRN.CAPACITY' }).int({ message: 'TRN.CAPACITY' }),
    gpsEnabled: z.boolean().optional(),
    gpsDevice: z.string().max(60).nullable().optional(),
    active: z.boolean().optional(),
  })
  .meta({ id: 'VehicleInput' });
export const crewSchema = z
  .strictObject({
    memberId: uuid,
    role: z.enum(['DRIVER', 'ATTENDANT'], { message: 'VALIDATION.FORMAT' }),
    licenceNo: z.string().max(30).nullable().optional(),
    licenceExpiry: date.nullable().optional(),
    employeeRef: z.string().max(30),
  })
  .meta({ id: 'CrewInput' });
export const crewEditSchema = z
  .strictObject({
    licenceNo: z.string().max(30).nullable().optional(),
    licenceExpiry: date.nullable().optional(),
    employeeRef: z.string().max(30).optional(),
    active: z.boolean().optional(),
  })
  .meta({ id: 'CrewEdit' });
export const sessionSchema = z
  .strictObject({
    name,
    direction: z.enum(['PICKUP', 'DROP'], { message: 'VALIDATION.FORMAT' }),
    startTime: time,
    endTime: time.nullable().optional(),
    days: z.array(z.string().max(3)).max(7),
    active: z.boolean().optional(),
  })
  .meta({ id: 'TransportSessionInput' });
export const assignmentSchema = z
  .strictObject({
    routeId: uuid,
    sessionId: uuid,
    vehicleId: uuid,
    driverId: uuid,
    attendantId: uuid.nullable().optional(),
    from: date,
    to: date,
  })
  .meta({ id: 'VehicleAssignmentInput' });
export const assignmentEditSchema = z
  .strictObject({
    vehicleId: uuid.optional(),
    driverId: uuid.optional(),
    attendantId: uuid.nullable().optional(),
    to: date.optional(),
    active: z.boolean().optional(),
  })
  .meta({ id: 'VehicleAssignmentEdit' });
export const allocateSchema = z
  .strictObject({
    memberIds: z.array(uuid).min(1).max(200),
    routeId: uuid,
    stopId: uuid,
    from: date,
    to: date,
  })
  .meta({ id: 'PassengerAllocationInput' });
export const allocationEndSchema = z
  .strictObject({ endDate: date, reason: z.string().max(200) })
  .meta({ id: 'PassengerAllocationEnd' });
export const transportChoiceSchema = z
  .strictObject({
    opted: z.boolean({ message: 'VALIDATION.REQUIRED' }),
    reason: z.string({ message: 'TRN.CHOICE_REASON' }).max(200, { message: 'TRN.CHOICE_REASON' }),
  })
  .meta({ id: 'TransportChoiceChange' });
export const tripCancelSchema = z
  .strictObject({
    remarks: z
      .string({ message: 'TRN.CANCEL_REMARKS' })
      .max(300, { message: 'TRN.CANCEL_REMARKS' }),
  })
  .meta({ id: 'TripCancellation' });
export const stopEventSchema = z
  .strictObject({
    seq: z.number().int().min(0),
    event: z.enum(['REACHED', 'DEPARTED', 'SKIPPED'], { message: 'VALIDATION.FORMAT' }),
    remarks: z.string().max(200).nullable().optional(),
  })
  .meta({ id: 'TripStopEvent' });
export const boardingSchema = z
  .strictObject({
    memberId: uuid,
    stopSeq: z.number().int().min(0).nullable().optional(),
    event: z.enum(['CHECKED_IN', 'CHECKED_OUT', 'NO_SHOW', 'MISSED'], {
      message: 'VALIDATION.FORMAT',
    }),
    method: z.enum(['QR', 'NFC', 'MANUAL']).optional(),
  })
  .meta({ id: 'TripBoarding' });

// Maps, live tracking and the transport fee by distance (client 2026-10-21).
const coordinate = (max: number) =>
  z.number({ message: 'TRN.POSITION' }).min(-max, { message: 'TRN.POSITION' }).max(max, {
    message: 'TRN.POSITION',
  });
export const positionsSchema = z
  .strictObject({
    points: z
      .array(
        z.strictObject({
          lat: coordinate(90),
          lng: coordinate(180),
          accuracy: z.number().min(0).nullable().optional(),
          speed: z.number().nullable().optional(),
          heading: z.number().nullable().optional(),
          at: z.iso.datetime({ offset: true, message: 'TRN.POSITION' }),
        }),
      )
      .min(1, { message: 'TRN.POSITION' })
      .max(100, { message: 'TRN.POSITION' }),
  })
  .meta({ id: 'TripPositions' });
export const feeRuleSchema = z
  .strictObject({
    active: z.boolean({ message: 'VALIDATION.REQUIRED' }),
    // Per km of the round trip, or by distance range (client 2026-10-22).
    mode: z.enum(['PER_KM', 'RANGE'], { message: 'VALIDATION.FORMAT' }).optional(),
    ratePaisePerKm: z
      .number({ message: 'TRN.FEE_RATE' })
      .int({ message: 'TRN.FEE_RATE' })
      .optional(),
    ranges: z
      .array(
        z.strictObject({
          uptoKm: z.number({ message: 'TRN.FEE_RANGES' }),
          yearlyPaise: z.number({ message: 'TRN.FEE_RANGES' }).int({ message: 'TRN.FEE_RANGES' }),
        }),
      )
      .max(20, { message: 'TRN.FEE_RANGES' })
      .optional(),
    dueDay: z.number({ message: 'TRN.FEE_DUE_DAY' }).int({ message: 'TRN.FEE_DUE_DAY' }),
  })
  .meta({ id: 'TransportFeeRule' });

const routesQuery = z.object({ active: z.enum(['true', 'false']).optional() });
const allocationsQuery = z.object({
  kind: z.enum(['STUDENT', 'STAFF']).optional(),
  routeId: uuid.optional(),
  yearId: uuid.optional(),
  assigned: z.enum(['true', 'false']).optional(),
  q: z.string().max(60).optional(),
  cursor: z.string().max(40).optional(),
});
const tripsQuery = z.object({
  date: date.optional(),
  status: z.enum(['SCHEDULED', 'STARTED', 'COMPLETED', 'CANCELLED']).optional(),
  routeId: uuid.optional(),
  vehicleId: uuid.optional(),
  cursor: z.string().max(40).optional(),
});
const rangeQuery = z.object({ from: date.optional(), to: date.optional() });
const dateQuery = z.object({ date: date.optional() });
const forQuery = z.object({ for: uuid.optional() });

const doc = (d: Omit<Parameters<typeof defineRoute>[0], 'tags'>) =>
  defineRoute({ ...d, tags: ['Transport'] });
const master = (
  ids: [string, string, string],
  path: string,
  noun: string,
  create: z.ZodType,
  edit: z.ZodType,
  extra = '',
) => {
  doc({
    id: ids[0],
    method: 'get',
    path: `/api/v1/console/${path}`,
    summary: `${noun} of the school${extra}`,
    auth: 'transport.view',
    responses: { 200: { description: noun } },
  });
  doc({
    id: ids[1],
    method: 'post',
    path: `/api/v1/console/${path}`,
    summary: `Add ${noun.toLowerCase()}`,
    auth: 'transport.edit',
    request: create,
    idempotent: 'required',
    responses: { 201: { description: noun } },
  });
  doc({
    id: ids[2],
    method: 'patch',
    path: `/api/v1/console/${path}/{${noun === 'Crew' ? 'crewId' : noun === 'Vehicles' ? 'vehicleId' : noun === 'Stops' ? 'stopId' : noun === 'Sessions' ? 'sessionId' : 'routeId'}}`,
    summary: `Edit or deactivate (never deleted, OI-TRN-29); If-Match`,
    auth: 'transport.edit',
    request: edit,
    responses: { 200: { description: noun } },
  });
};
master(
  ['TRN-001', 'TRN-002', 'TRN-003'],
  'routes',
  'Routes',
  routeSchema,
  routeSchema.partial(),
  ' with their ordered stops, distance and passengers (?active)',
);
doc({
  id: 'TRN-004',
  method: 'put',
  path: '/api/v1/console/routes/{routeId}/stops',
  summary:
    'Replace the ordered stop list: sequence from 0 without gaps, no stop twice, times and distance from the previous stop; If-Match (the route version)',
  auth: 'transport.edit',
  request: routeStopsSchema,
  responses: { 200: { description: 'Route' } },
});
master(
  ['TRN-005', 'TRN-006', 'TRN-007'],
  'stops',
  'Stops',
  stopSchema,
  stopSchema.partial(),
  ' (a stop on an active route stays active)',
);
master(
  ['TRN-008', 'TRN-009', 'TRN-010'],
  'vehicles',
  'Vehicles',
  vehicleSchema,
  vehicleSchema.partial(),
  ' (registration unique, capacity, GPS device)',
);
master(
  ['TRN-011', 'TRN-012', 'TRN-013'],
  'crew',
  'Crew',
  crewSchema,
  crewEditSchema,
  ': drivers (licence with a future expiry) and attendants, employee reference unique (BR-60)',
);
master(
  ['TRN-014', 'TRN-015', 'TRN-016'],
  'transport-sessions',
  'Sessions',
  sessionSchema,
  sessionSchema.partial(),
  ': pickup or drop, start time and the days it runs (OI-TRN-09)',
);
doc({
  id: 'TRN-017',
  method: 'get',
  path: '/api/v1/console/vehicle-assignments',
  summary: 'Route × session × vehicle × crew with effective dates',
  auth: 'transport.view',
  responses: { 200: { description: 'Assignments' } },
});
doc({
  id: 'TRN-018',
  method: 'post',
  path: '/api/v1/console/vehicle-assignments',
  summary:
    'Assign a route and session to a vehicle with a driver and an attendant for dates inside the year; never double-booking the vehicle or crew in overlapping sessions, or the route-session pair (BR-61)',
  auth: 'transport.edit',
  request: assignmentSchema,
  idempotent: 'required',
  responses: { 201: { description: 'Assignment' } },
});
doc({
  id: 'TRN-019',
  method: 'patch',
  path: '/api/v1/console/vehicle-assignments/{assignmentId}',
  summary: 'Change the vehicle or crew, end earlier, or deactivate; If-Match',
  auth: 'transport.edit',
  request: assignmentEditSchema,
  responses: { 200: { description: 'Assignment' } },
});
doc({
  id: 'TRN-020',
  method: 'get',
  path: '/api/v1/console/passenger-allocations',
  summary:
    'Students (CR-09 columns) or staff with their allocation for the year, assigned or not, by route, with search and paging',
  auth: 'transport.view',
  query: allocationsQuery,
  responses: { 200: { description: 'Allocations' } },
});
doc({
  id: 'TRN-021',
  method: 'post',
  path: '/api/v1/console/passenger-allocations',
  summary:
    'Allocate members to a route and a stop on it for dates inside the year (never two at once); each member and family is told',
  auth: 'transport.edit',
  request: allocateSchema,
  idempotent: 'required',
  responses: { 201: { description: 'Allocated' } },
});
doc({
  id: 'TRN-022',
  method: 'post',
  path: '/api/v1/console/passenger-allocations/{allocationId}/end',
  summary: 'End an allocation on a date with a reason (kept on record)',
  auth: 'transport.edit',
  request: allocationEndSchema,
  responses: { 200: { description: 'Ended' } },
});
doc({
  id: 'TRN-035',
  method: 'put',
  path: '/api/v1/console/transport-choices/{memberId}',
  summary:
    'Change a student’s school transport choice from the admission form — opted or not — when the family changes its mind (client 2026-10-12); the reason is kept in the audit log',
  auth: 'transport.edit',
  request: transportChoiceSchema,
  responses: { 200: { description: 'The choice as it now stands' } },
});
doc({
  id: 'TRN-023',
  method: 'get',
  path: '/api/v1/console/trips',
  summary:
    'Trips of a date with status counts and progress — the next stop, the last stop and passengers on board and boarded — filtered on the server (OI-TRN-16)',
  auth: 'transport.view',
  query: tripsQuery,
  responses: { 200: { description: 'Trips' } },
});
doc({
  id: 'TRN-024',
  method: 'get',
  path: '/api/v1/console/trips/{tripId}',
  summary: 'A trip with its stops, passengers and boarding, and the event timeline',
  auth: 'transport.view',
  responses: { 200: { description: 'Trip' } },
});
doc({
  id: 'TRN-025',
  method: 'post',
  path: '/api/v1/console/trips/{tripId}/cancellation',
  summary: 'Cancel a scheduled trip with remarks; passengers and families are told',
  auth: 'transport.edit',
  request: tripCancelSchema,
  idempotent: 'required',
  responses: { 200: { description: 'Trip' } },
});
doc({
  id: 'TRN-026',
  method: 'get',
  path: '/api/v1/console/transport/reports/{reportKind}',
  summary:
    'daily-summary, route-performance, vehicle-utilisation, driver-performance, attendant-performance, allocation, cancelled-trips, trip-stops — over a date range',
  auth: 'transport.view',
  query: rangeQuery,
  responses: { 200: { description: 'Report' } },
});
doc({
  id: 'TRN-027',
  method: 'get',
  path: '/api/v1/crew/trips',
  summary: 'The driver’s or attendant’s trips of a date',
  auth: 'member',
  query: dateQuery,
  responses: { 200: { description: 'Trips' } },
});
doc({
  id: 'TRN-028',
  method: 'get',
  path: '/api/v1/crew/trips/{tripId}',
  summary: 'The trip with its ordered stops and the passengers at each stop',
  auth: 'member',
  responses: { 200: { description: 'Trip' } },
});
doc({
  id: 'TRN-029',
  method: 'post',
  path: '/api/v1/crew/trips/{tripId}/start',
  summary: 'Start a scheduled trip; passengers and families are told',
  auth: 'member',
  idempotent: 'required',
  responses: { 200: { description: 'Trip' } },
});
doc({
  id: 'TRN-030',
  method: 'post',
  path: '/api/v1/crew/trips/{tripId}/stop-events',
  summary: 'A stop reached, departed or skipped (remarks), in order (BR-62)',
  auth: 'member',
  request: stopEventSchema,
  idempotent: 'required',
  responses: { 200: { description: 'Trip' } },
});
doc({
  id: 'TRN-031',
  method: 'post',
  path: '/api/v1/crew/trips/{tripId}/boardings',
  summary:
    'Record a passenger boarded, got off, no show or missed (RC-25); a stop other than the allocated one is a deviation',
  auth: 'member',
  request: boardingSchema,
  idempotent: 'required',
  responses: { 200: { description: 'Trip' } },
});
doc({
  id: 'TRN-032',
  method: 'post',
  path: '/api/v1/crew/trips/{tripId}/completion',
  summary: 'Complete a started trip once the final stop is reached',
  auth: 'member',
  idempotent: 'required',
  responses: { 200: { description: 'Trip' } },
});
doc({
  id: 'TRN-033',
  method: 'get',
  path: '/api/v1/crew/history',
  summary: 'The crew member’s past trips',
  auth: 'member',
  query: rangeQuery,
  responses: { 200: { description: 'Trips' } },
});
doc({
  id: 'TRN-034',
  method: 'get',
  path: '/api/v1/me/transport',
  summary:
    'The allocation, today’s trips and their progress for the member (for: a child on the account)',
  auth: 'member|teaching.view,principal.view',
  query: forQuery,
  responses: { 200: { description: 'Transport' } },
});

doc({
  id: 'TRN-036',
  method: 'post',
  path: '/api/v1/crew/trips/{tripId}/positions',
  summary:
    'The crew’s phone sends the bus’s position while the trip runs (client 2026-10-21): up to 100 fixes; inaccurate, early or future ones are not used, a resent one adds nothing; a stop the bus comes near is told once; 409 TRN.TRIP_NOT_RUNNING once the trip is no longer Started (stop sharing)',
  auth: 'member',
  request: positionsSchema,
  responses: { 200: { description: 'Accepted fixes and the interval to send at' } },
});
doc({
  id: 'TRN-037',
  method: 'get',
  path: '/api/v1/me/transport/live',
  summary:
    'Where the bus is (client 2026-10-21): for a passenger of the route — a student, a staff member — or a parent (for: a child on the account), while a trip of the route runs today: the bus’s position, its trail, the stops and about how many minutes to the member’s stop',
  auth: 'member|teaching.view,principal.view',
  query: forQuery,
  responses: { 200: { description: 'Live transport' } },
});
doc({
  id: 'TRN-038',
  method: 'post',
  path: '/api/v1/console/routes/{routeId}/distances',
  summary:
    'The road distance from each stop of the route to the next through the map service (every stop placed on the map first); nothing is saved — the stops are saved with TRN-004',
  auth: 'transport.edit',
  responses: { 200: { description: 'Distances' } },
});
doc({
  id: 'TRN-039',
  method: 'get',
  path: '/api/v1/console/maps',
  summary:
    'What the console’s maps load with: the map provider, the browser key (restricted to the site in Google Cloud) and how often live positions refresh',
  auth: 'transport.view',
  responses: { 200: { description: 'Maps' } },
});
doc({
  id: 'TRN-040',
  method: 'get',
  path: '/api/v1/console/transport/fee-rule',
  summary:
    'The transport fee by distance (client 2026-10-21): on or off, the yearly rate per km of the round trip, the due day, and the current year’s months',
  auth: 'transport.view',
  responses: { 200: { description: 'Fee rule' } },
});
doc({
  id: 'TRN-041',
  method: 'put',
  path: '/api/v1/console/transport/fee-rule',
  summary:
    'Set the transport fee by distance (Institution Administrator); dues already raised don’t change; If-Match ("v0" before it was first saved)',
  auth: 'transport.fees',
  request: feeRuleSchema,
  responses: { 200: { description: 'Fee rule' } },
});
doc({
  id: 'TRN-042',
  method: 'post',
  path: '/api/v1/console/transport/fee-rule/apply',
  summary:
    'Raise the transport dues of every allocation of the current year still in force (for a rule switched on after the buses were allocated); re-runnable — months already charged are left alone',
  auth: 'transport.fees',
  idempotent: 'required',
  responses: { 200: { description: 'Dues raised' } },
});

export function transportRoutes(deps: {
  db: Kysely<Database>;
  transport: TransportService;
  trips: TripsService;
  live: TransportLiveService;
  fees: TransportFeesService;
  loggers: Loggers;
}): Router {
  const router = Router();
  const L = deps.loggers;
  const once = idempotency({ db: deps.db, mode: 'required' });
  const member = requireSurface(L, 'member');
  // The app's member, or the web console with one of the sub-tasks (a teacher or the principal on
  // the web, client 2026-10-12/13).
  const either = (...subTasks: string[]) => memberOrConsole(subTasks, L);
  const console = [requireSurface(L, 'console'), requireTenant(L)];
  const view = authorize('transport.view', L);
  const edit = authorize('transport.edit', L);
  const feesSet = authorize('transport.fees', L);
  const T = deps.transport;
  const wrap =
    (fn: RequestHandler): RequestHandler =>
    async (req, res, next) => {
      try {
        await fn(req, res, next);
      } catch (e) {
        next(e);
      }
    };
  const principal = (req: Request) => {
    if (!req.principal) throw new AuthenticationError();
    return req.principal;
  };
  const param = (req: Request, k: string) => String(req.params[k]);
  const json = (fn: (req: Request) => Promise<unknown>, code = 200): RequestHandler =>
    wrap(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      const out = await fn(req);
      const v = (out as { version?: unknown } | null)?.version;
      if (typeof v === 'number') setEtag(res, v);
      res.status(code).json(out);
    });

  // masters
  router.get(
    '/console/routes',
    ...console,
    view,
    json((req) => {
      const q = routesQuery.parse(req.query);
      return T.routes(principal(req), {
        active: q.active === undefined ? undefined : q.active === 'true',
      });
    }),
  );
  router.post(
    '/console/routes',
    ...console,
    edit,
    once,
    json((req) => T.createRoute(principal(req), routeSchema.parse(req.body ?? {})), 201),
  );
  router.patch(
    '/console/routes/:routeId',
    ...console,
    edit,
    json(async (req) => {
      await T.lookup(principal(req), 'route', param(req, 'routeId'));
      return T.updateRoute(
        principal(req),
        param(req, 'routeId'),
        expectedVersion(req),
        routeSchema.partial().parse(req.body ?? {}),
      );
    }),
  );
  router.put(
    '/console/routes/:routeId/stops',
    ...console,
    edit,
    json(async (req) => {
      await T.lookup(principal(req), 'route', param(req, 'routeId'));
      return T.setRouteStops(
        principal(req),
        param(req, 'routeId'),
        expectedVersion(req),
        routeStopsSchema.parse(req.body ?? {}).stops,
      );
    }),
  );
  router.get(
    '/console/stops',
    ...console,
    view,
    json((req) => T.stops(principal(req))),
  );
  router.post(
    '/console/stops',
    ...console,
    edit,
    once,
    json((req) => T.createStop(principal(req), stopSchema.parse(req.body ?? {})), 201),
  );
  router.patch(
    '/console/stops/:stopId',
    ...console,
    edit,
    json(async (req) => {
      await T.lookup(principal(req), 'stop', param(req, 'stopId'));
      return T.updateStop(
        principal(req),
        param(req, 'stopId'),
        expectedVersion(req),
        stopSchema.partial().parse(req.body ?? {}),
      );
    }),
  );
  router.get(
    '/console/vehicles',
    ...console,
    view,
    json((req) => T.vehicles(principal(req))),
  );
  router.post(
    '/console/vehicles',
    ...console,
    edit,
    once,
    json((req) => T.createVehicle(principal(req), vehicleSchema.parse(req.body ?? {})), 201),
  );
  router.patch(
    '/console/vehicles/:vehicleId',
    ...console,
    edit,
    json(async (req) => {
      await T.lookup(principal(req), 'vehicle', param(req, 'vehicleId'));
      return T.updateVehicle(
        principal(req),
        param(req, 'vehicleId'),
        expectedVersion(req),
        vehicleSchema.partial().parse(req.body ?? {}),
      );
    }),
  );
  router.get(
    '/console/crew',
    ...console,
    view,
    json((req) => T.crew(principal(req))),
  );
  router.post(
    '/console/crew',
    ...console,
    edit,
    once,
    json((req) => T.createCrew(principal(req), crewSchema.parse(req.body ?? {})), 201),
  );
  router.patch(
    '/console/crew/:crewId',
    ...console,
    edit,
    json(async (req) => {
      await T.lookup(principal(req), 'crew', param(req, 'crewId'));
      return T.updateCrew(
        principal(req),
        param(req, 'crewId'),
        expectedVersion(req),
        crewEditSchema.parse(req.body ?? {}),
      );
    }),
  );
  router.get(
    '/console/transport-sessions',
    ...console,
    view,
    json((req) => T.sessions(principal(req))),
  );
  router.post(
    '/console/transport-sessions',
    ...console,
    edit,
    once,
    json((req) => T.createSession(principal(req), sessionSchema.parse(req.body ?? {})), 201),
  );
  router.patch(
    '/console/transport-sessions/:sessionId',
    ...console,
    edit,
    json(async (req) => {
      await T.lookup(principal(req), 'session', param(req, 'sessionId'));
      return T.updateSession(
        principal(req),
        param(req, 'sessionId'),
        expectedVersion(req),
        sessionSchema.partial().parse(req.body ?? {}),
      );
    }),
  );

  // assignments and allocations
  router.get(
    '/console/vehicle-assignments',
    ...console,
    view,
    json((req) => T.assignments(principal(req))),
  );
  router.post(
    '/console/vehicle-assignments',
    ...console,
    edit,
    once,
    json((req) => T.createAssignment(principal(req), assignmentSchema.parse(req.body ?? {})), 201),
  );
  router.patch(
    '/console/vehicle-assignments/:assignmentId',
    ...console,
    edit,
    json(async (req) => {
      await T.lookup(principal(req), 'assignment', param(req, 'assignmentId'));
      return T.updateAssignment(
        principal(req),
        param(req, 'assignmentId'),
        expectedVersion(req),
        assignmentEditSchema.parse(req.body ?? {}),
      );
    }),
  );
  router.get(
    '/console/passenger-allocations',
    ...console,
    view,
    json((req) => {
      const q = allocationsQuery.parse(req.query);
      return T.allocations(principal(req), {
        ...q,
        assigned: q.assigned === undefined ? undefined : q.assigned === 'true',
      });
    }),
  );
  router.post(
    '/console/passenger-allocations',
    ...console,
    edit,
    once,
    json((req) => T.allocate(principal(req), allocateSchema.parse(req.body ?? {})), 201),
  );
  router.post(
    '/console/passenger-allocations/:allocationId/end',
    ...console,
    edit,
    json(async (req) => {
      await T.lookup(principal(req), 'allocation', param(req, 'allocationId'));
      return T.endAllocation(
        principal(req),
        param(req, 'allocationId'),
        allocationEndSchema.parse(req.body ?? {}),
      );
    }),
  );

  router.put(
    '/console/transport-choices/:memberId',
    ...console,
    edit,
    json(async (req) => {
      // The member is found in the caller's school before the body is read.
      await T.memberFor(principal(req), param(req, 'memberId'));
      return T.setTransportChoice(
        principal(req),
        param(req, 'memberId'),
        transportChoiceSchema.parse(req.body ?? {}),
      );
    }),
  );

  // trips and reports
  router.get(
    '/console/trips',
    ...console,
    view,
    json((req) => deps.trips.list(principal(req), tripsQuery.parse(req.query))),
  );
  router.get(
    '/console/trips/:tripId',
    ...console,
    view,
    json((req) => deps.trips.trip(principal(req), param(req, 'tripId'))),
  );
  router.post(
    '/console/trips/:tripId/cancellation',
    ...console,
    edit,
    once,
    json(async (req) => {
      await deps.trips.lookup(principal(req), param(req, 'tripId'));
      return deps.trips.cancel(
        principal(req),
        param(req, 'tripId'),
        tripCancelSchema.parse(req.body ?? {}),
      );
    }),
  );
  router.get(
    '/console/transport/reports/:reportKind',
    ...console,
    view,
    json((req) =>
      deps.trips.report(principal(req), param(req, 'reportKind'), rangeQuery.parse(req.query)),
    ),
  );

  // the crew and the family
  router.get(
    '/crew/trips',
    member,
    json((req) => deps.trips.crewTrips(principal(req), dateQuery.parse(req.query))),
  );
  router.get(
    '/crew/history',
    member,
    json((req) => deps.trips.crewHistory(principal(req), rangeQuery.parse(req.query))),
  );
  router.get(
    '/crew/trips/:tripId',
    member,
    json((req) => deps.trips.crewTripDetail(principal(req), param(req, 'tripId'))),
  );
  router.post(
    '/crew/trips/:tripId/start',
    member,
    once,
    json((req) => deps.trips.start(principal(req), param(req, 'tripId'))),
  );
  router.post(
    '/crew/trips/:tripId/stop-events',
    member,
    once,
    json((req) =>
      deps.trips.stopEvent(
        principal(req),
        param(req, 'tripId'),
        stopEventSchema.parse(req.body ?? {}),
      ),
    ),
  );
  router.post(
    '/crew/trips/:tripId/boardings',
    member,
    once,
    json((req) =>
      deps.trips.board(principal(req), param(req, 'tripId'), boardingSchema.parse(req.body ?? {})),
    ),
  );
  router.post(
    '/crew/trips/:tripId/completion',
    member,
    once,
    json((req) => deps.trips.complete(principal(req), param(req, 'tripId'))),
  );
  router.get(
    '/me/transport',
    either('teaching.view', 'principal.view'),
    json((req) => deps.trips.mine(principal(req), forQuery.parse(req.query))),
  );

  // maps, live tracking and the transport fee by distance (client 2026-10-21)
  router.post(
    '/crew/trips/:tripId/positions',
    member,
    json((req) =>
      deps.live.ingest(
        principal(req),
        param(req, 'tripId'),
        positionsSchema.parse(req.body ?? {}).points,
      ),
    ),
  );
  router.get(
    '/me/transport/live',
    either('teaching.view', 'principal.view'),
    json((req) => deps.live.mine(principal(req), forQuery.parse(req.query))),
  );
  router.post(
    '/console/routes/:routeId/distances',
    ...console,
    edit,
    json((req) => deps.live.distances(principal(req), param(req, 'routeId'))),
  );
  router.get(
    '/console/maps',
    ...console,
    view,
    json((req) => deps.live.mapsConfig(principal(req))),
  );
  router.get(
    '/console/transport/fee-rule',
    ...console,
    view,
    json((req) => deps.fees.rule(principal(req))),
  );
  router.put(
    '/console/transport/fee-rule',
    ...console,
    feesSet,
    json((req) =>
      deps.fees.setRule(principal(req), expectedVersion(req), feeRuleSchema.parse(req.body ?? {})),
    ),
  );
  router.post(
    '/console/transport/fee-rule/apply',
    ...console,
    feesSet,
    once,
    json((req) => deps.fees.apply(principal(req))),
  );
  return router;
}
