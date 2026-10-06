/**
 * Transport (SRS 22; migration 0056): stops, routes and their ordered stops, vehicles, crew, sessions,
 * vehicle assignments, passenger allocations, trips with stops, events and boardings.
 */
import type { ColumnType, Generated } from 'kysely';

type Ref = string;
type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type NullableTimestamp = ColumnType<
  Date | null,
  Date | string | null | undefined,
  Date | string | null
>;
type Day = ColumnType<Date | string, string, string>;
type Flag = ColumnType<number, number | undefined, number>;
type Version = ColumnType<number, number | undefined, number>;
type Decimal = ColumnType<string, number | string | undefined, number | string>;

export type RouteType = 'MORNING' | 'EVENING' | 'SPECIAL' | 'EMERGENCY';
export type CrewRole = 'DRIVER' | 'ATTENDANT';
export type TripDirection = 'PICKUP' | 'DROP';
export type TripStatus = 'SCHEDULED' | 'STARTED' | 'COMPLETED' | 'CANCELLED';
export type TripStopStatus = 'UPCOMING' | 'REACHED' | 'DEPARTED' | 'SKIPPED';
export type TripEvent =
  'SCHEDULED' | 'STARTED' | 'REACHED' | 'DEPARTED' | 'SKIPPED' | 'COMPLETED' | 'CANCELLED';
export type BoardingStatus = 'CHECKED_IN' | 'CHECKED_OUT' | 'NO_SHOW' | 'MISSED';

export interface TransportStopsTable {
  id: Generated<string>;
  public_id: Buffer;
  institution_id: Ref;
  name: string;
  landmark: string | null;
  lat: ColumnType<string | null, number | string | null | undefined, number | string | null>;
  lng: ColumnType<string | null, number | string | null | undefined, number | string | null>;
  active: Flag;
  created_at: Timestamp;
  updated_at: Timestamp;
  row_version: Version;
}

export interface TransportRoutesTable {
  id: Generated<string>;
  public_id: Buffer;
  institution_id: Ref;
  code: string;
  name: string;
  description: string | null;
  route_type: ColumnType<RouteType, RouteType | undefined, RouteType>;
  map_link: string | null;
  active: Flag;
  created_at: Timestamp;
  updated_at: Timestamp;
  row_version: Version;
}

export interface TransportRouteStopsTable {
  route_id: Ref;
  seq: number;
  stop_id: Ref;
  arrival: string | null;
  departure: string | null;
  distance_km: Decimal;
}

export interface TransportVehiclesTable {
  id: Generated<string>;
  public_id: Buffer;
  institution_id: Ref;
  name: string;
  registration: string;
  capacity: number;
  gps_enabled: Flag;
  gps_device: string | null;
  active: Flag;
  created_at: Timestamp;
  updated_at: Timestamp;
  row_version: Version;
}

export interface TransportCrewTable {
  id: Generated<string>;
  public_id: Buffer;
  institution_id: Ref;
  profile_id: Ref;
  role: CrewRole;
  licence_no: string | null;
  licence_expiry: ColumnType<Date | string | null, string | null | undefined, string | null>;
  employee_ref: string;
  active: Flag;
  created_at: Timestamp;
  updated_at: Timestamp;
  row_version: Version;
}

export interface TransportSessionsTable {
  id: Generated<string>;
  public_id: Buffer;
  institution_id: Ref;
  name: string;
  direction: TripDirection;
  start_time: string;
  end_time: string | null;
  days: string;
  active: Flag;
  created_at: Timestamp;
  updated_at: Timestamp;
  row_version: Version;
}

export interface TransportAssignmentsTable {
  id: Generated<string>;
  public_id: Buffer;
  institution_id: Ref;
  year_id: Ref;
  route_id: Ref;
  session_id: Ref;
  vehicle_id: Ref;
  driver_crew_id: Ref;
  attendant_crew_id: Ref | null;
  effective_from: Day;
  effective_to: Day;
  active: Flag;
  created_at: Timestamp;
  updated_at: Timestamp;
  row_version: Version;
}

export interface TransportAllocationsTable {
  id: Generated<string>;
  public_id: Buffer;
  institution_id: Ref;
  year_id: Ref;
  profile_id: Ref;
  route_id: Ref;
  stop_id: Ref;
  effective_from: Day;
  effective_to: Day;
  active: Flag;
  end_reason: string | null;
  ended_by: Buffer | null;
  ended_at: NullableTimestamp;
  created_by: Buffer | null;
  created_at: Timestamp;
  row_version: Version;
}

export interface TransportTripsTable {
  id: Generated<string>;
  public_id: Buffer;
  institution_id: Ref;
  assignment_id: Ref;
  route_id: Ref;
  session_id: Ref;
  vehicle_id: Ref;
  driver_crew_id: Ref;
  attendant_crew_id: Ref | null;
  trip_date: Day;
  direction: TripDirection;
  planned_start: string;
  status: ColumnType<TripStatus, TripStatus | undefined, TripStatus>;
  started_at: NullableTimestamp;
  completed_at: NullableTimestamp;
  cancelled_at: NullableTimestamp;
  cancel_remarks: string | null;
  created_at: Timestamp;
  row_version: Version;
}

export interface TransportTripStopsTable {
  id: Generated<string>;
  trip_id: Ref;
  seq: number;
  stop_id: Ref;
  planned_time: string | null;
  distance_km: Decimal;
  status: ColumnType<TripStopStatus, TripStopStatus | undefined, TripStopStatus>;
  reached_at: NullableTimestamp;
  departed_at: NullableTimestamp;
  skip_remarks: string | null;
}

export interface TransportTripEventsTable {
  id: Generated<string>;
  institution_id: Ref;
  trip_id: Ref;
  event: TripEvent;
  seq: number | null;
  actor: Buffer | null;
  remarks: string | null;
  at: Timestamp;
}

export interface TransportBoardingsTable {
  id: Generated<string>;
  institution_id: Ref;
  trip_id: Ref;
  profile_id: Ref;
  status: BoardingStatus;
  method: ColumnType<
    'QR' | 'NFC' | 'MANUAL',
    'QR' | 'NFC' | 'MANUAL' | undefined,
    'QR' | 'NFC' | 'MANUAL'
  >;
  stop_seq: number | null;
  allocated_stop_id: Ref | null;
  deviation: ColumnType<'YES' | 'NO', 'YES' | 'NO' | undefined, 'YES' | 'NO'>;
  actor: Buffer | null;
  at: Timestamp;
  row_version: Version;
}

export interface TransportTables {
  transport_stops: TransportStopsTable;
  transport_routes: TransportRoutesTable;
  transport_route_stops: TransportRouteStopsTable;
  transport_vehicles: TransportVehiclesTable;
  transport_crew: TransportCrewTable;
  transport_sessions: TransportSessionsTable;
  transport_assignments: TransportAssignmentsTable;
  transport_allocations: TransportAllocationsTable;
  transport_trips: TransportTripsTable;
  transport_trip_stops: TransportTripStopsTable;
  transport_trip_events: TransportTripEventsTable;
  transport_boardings: TransportBoardingsTable;
}
