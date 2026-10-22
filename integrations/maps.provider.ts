/**
 * Maps for transport (client 2026-10-21: Google Maps). The server needs one thing from a map service:
 * the road distance between consecutive stops of a route, asked for when the transport desk presses
 * "Calculate distances" — never per trip or per parent, so the bill stays inside Google's free
 * monthly use. "How far is the bus" is worked out here from the stops' distances and the bus's
 * position (TransportLiveService), with no call to Google.
 *
 * - `google`: the Routes API (computeRoutes, DRIVE, no traffic) with plain `fetch` (no SDK, as the
 *   Razorpay and push integrations). At most 10 stops between the ends per request, so each call is
 *   billed as "Compute Routes Essentials"; a longer route is asked in overlapping parts. The key
 *   (GOOGLE_MAPS_SERVER_KEY) stays on the server and is never logged.
 * - `test`: the straight-line distance × TEST_ROAD_FACTOR, shown as an estimate (development and
 *   tests; refused in production).
 * - `off`: no distances (the transport desk types them, as before).
 */
export type MapsProvider = 'off' | 'test' | 'google';

export interface LatLng {
  readonly lat: number;
  readonly lng: number;
}

export interface MapsRouter {
  readonly provider: Exclude<MapsProvider, 'off'>;
  /** The road distance in km of each leg between consecutive points (`points.length - 1` legs). */
  legs(points: readonly LatLng[]): Promise<number[]>;
}

/** A failure of the map service itself (not the caller's data); the message never holds the key. */
export class MapsServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MapsServiceError';
  }
}

const EARTH_KM = 6371.0088;
const rad = (d: number) => (d * Math.PI) / 180;

/** The great-circle distance between two points, in km. */
export function haversineKm(a: LatLng, b: LatLng): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Roads are rarely straight: test mode multiplies the straight line by this. */
export const TEST_ROAD_FACTOR = 1.3;

const km = (n: number) => Math.round(n * 100) / 100;

export const ROUTES_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes';
/** 10 intermediate stops keep a request on the cheaper "Essentials" price (11 legs). */
export const MAX_INTERMEDIATES = 10;

/** The points split into overlapping parts of at most `maxLegs` legs (each part ends where the next starts). */
export function partsOf<T>(points: readonly T[], maxLegs: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < points.length - 1; i += maxLegs) {
    out.push(points.slice(i, Math.min(points.length, i + maxLegs + 1)));
  }
  return out;
}

const waypoint = (p: LatLng) => ({ location: { latLng: { latitude: p.lat, longitude: p.lng } } });

export function googleRouter(opts: {
  readonly key: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}): MapsRouter {
  const doFetch = opts.fetch ?? fetch;
  return {
    provider: 'google',
    async legs(points) {
      if (points.length < 2) return [];
      const out: number[] = [];
      for (const part of partsOf(points, MAX_INTERMEDIATES + 1)) {
        let res: Response;
        try {
          res = await doFetch(ROUTES_URL, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Goog-Api-Key': opts.key,
              'X-Goog-FieldMask': 'routes.legs.distanceMeters',
            },
            body: JSON.stringify({
              origin: waypoint(part[0]!),
              destination: waypoint(part.at(-1)!),
              intermediates: part.slice(1, -1).map(waypoint),
              travelMode: 'DRIVE',
              routingPreference: 'TRAFFIC_UNAWARE',
              units: 'METRIC',
            }),
            signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
          });
        } catch (e) {
          throw new MapsServiceError(
            `Routes API not reached: ${e instanceof Error ? e.name : 'error'}`,
          );
        }
        if (!res.ok) throw new MapsServiceError(`Routes API answered ${res.status}`);
        const body = (await res.json()) as {
          routes?: { legs?: { distanceMeters?: number }[] }[];
        };
        const legs = body.routes?.[0]?.legs;
        if (!legs || legs.length !== part.length - 1) {
          throw new MapsServiceError('Routes API found no road route between the stops');
        }
        // A leg of 0 m has no distanceMeters in the answer.
        for (const l of legs) out.push(km((l.distanceMeters ?? 0) / 1000));
      }
      return out;
    },
  };
}

export function testRouter(): MapsRouter {
  return {
    provider: 'test',
    legs(points) {
      const out: number[] = [];
      for (let i = 1; i < points.length; i++) {
        out.push(km(haversineKm(points[i - 1]!, points[i]!) * TEST_ROAD_FACTOR));
      }
      return Promise.resolve(out);
    },
  };
}

/** The router for MAPS_PROVIDER, or null when maps are off. */
export function createMapsRouter(
  provider: MapsProvider,
  opts: { readonly serverKey: string | null; readonly fetch?: typeof fetch },
): MapsRouter | null {
  if (provider === 'test') return testRouter();
  if (provider === 'google' && opts.serverKey) {
    return googleRouter({ key: opts.serverKey, ...(opts.fetch ? { fetch: opts.fetch } : {}) });
  }
  return null;
}
