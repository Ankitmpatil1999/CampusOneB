/**
 * Maps for transport without the network (client 2026-10-21): the Google Routes request (key in a
 * header, only the legs' distances asked for, at most 10 stops between the ends so each call is an
 * "Essentials" one, longer routes in overlapping parts), its failures, the test-mode estimate; the
 * transport fee's arithmetic (months of the year, monthly parts in whole rupees, both ways × the yearly
 * rate) and the live view's helpers (thinning a trail, minutes to a stop).
 */
import {
  createMapsRouter,
  googleRouter,
  haversineKm,
  MapsServiceError,
  partsOf,
  ROUTES_URL,
  TEST_ROAD_FACTOR,
} from '../integrations/maps.provider';
import {
  monthlyParts,
  monthsOf,
  transportLabel,
  yearlyFee,
} from '../services/transport-fees.service';
import { etaMinutes, thin } from '../services/transport-live.service';

const p = (i: number) => ({ lat: 13.9 + i * 0.01, lng: 75.5 + i * 0.01 });

describe('the map service', () => {
  it('measures the great-circle distance', () => {
    // Shivamogga to Bengaluru, about 247 km in a straight line.
    const km = haversineKm({ lat: 13.9299, lng: 75.5681 }, { lat: 12.9716, lng: 77.5946 });
    expect(km).toBeGreaterThan(240);
    expect(km).toBeLessThan(255);
    expect(haversineKm(p(0), p(0))).toBe(0);
  });

  it('splits a long route into overlapping parts', () => {
    expect(partsOf([1, 2, 3], 11)).toEqual([[1, 2, 3]]);
    const parts = partsOf(
      Array.from({ length: 25 }, (_, i) => i),
      11,
    );
    expect(parts.map((x) => [x[0], x.at(-1), x.length])).toEqual([
      [0, 11, 12],
      [11, 22, 12],
      [22, 24, 3],
    ]);
    expect(partsOf([1], 11)).toEqual([]);
  });

  it('asks Google for the legs only, with the key in a header, ten stops between the ends at most', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const body = JSON.parse(String(init.body)) as { intermediates: unknown[] };
      const legs = Array.from({ length: body.intermediates.length + 1 }, (_, i) =>
        i === 0 ? {} : { distanceMeters: 1234 },
      );
      return new Response(JSON.stringify({ routes: [{ legs }] }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const router = googleRouter({ key: 'secret-key', fetch });
    const points = Array.from({ length: 14 }, (_, i) => p(i));
    const legs = await router.legs(points);
    expect(legs).toHaveLength(13);
    expect(legs[0]).toBe(0); // a leg of 0 m has no distanceMeters
    expect(legs[1]).toBe(1.23);
    expect(calls).toHaveLength(2);
    const first = calls[0]!;
    expect(first.url).toBe(ROUTES_URL);
    const headers = first.init.headers as Record<string, string>;
    expect(headers['X-Goog-Api-Key']).toBe('secret-key');
    expect(headers['X-Goog-FieldMask']).toBe('routes.legs.distanceMeters');
    const body = JSON.parse(String(first.init.body)) as {
      origin: unknown;
      intermediates: unknown[];
      travelMode: string;
      routingPreference: string;
    };
    expect(body.intermediates).toHaveLength(10);
    expect(body).toMatchObject({ travelMode: 'DRIVE', routingPreference: 'TRAFFIC_UNAWARE' });
    expect(body.origin).toEqual({ location: { latLng: { latitude: 13.9, longitude: 75.5 } } });
    expect(String(first.init.body)).not.toContain('secret-key');
  });

  it('fails as the map service, never with the key, when Google refuses or finds no route', async () => {
    const answer = (status: number, body: unknown) =>
      (async () =>
        new Response(JSON.stringify(body), { status })) as unknown as typeof globalThis.fetch;
    const refused = googleRouter({ key: 'secret-key', fetch: answer(403, { error: {} }) });
    await expect(refused.legs([p(0), p(1)])).rejects.toThrow(MapsServiceError);
    await expect(refused.legs([p(0), p(1)])).rejects.not.toThrow(/secret-key/);
    const empty = googleRouter({ key: 'k', fetch: answer(200, {}) });
    await expect(empty.legs([p(0), p(1)])).rejects.toThrow(/no road route/);
    const down = googleRouter({
      key: 'k',
      fetch: (async () => {
        throw new TypeError('fetch failed');
      }) as unknown as typeof globalThis.fetch,
    });
    await expect(down.legs([p(0), p(1)])).rejects.toThrow(MapsServiceError);
    expect(await refused.legs([p(0)])).toEqual([]);
  });

  it('estimates in test mode, and is off without a provider or a key', async () => {
    const test = createMapsRouter('test', { serverKey: null })!;
    expect(test.provider).toBe('test');
    const [leg] = await test.legs([p(0), p(1)]);
    expect(leg).toBeCloseTo(haversineKm(p(0), p(1)) * TEST_ROAD_FACTOR, 2);
    expect(createMapsRouter('off', { serverKey: 'k' })).toBeNull();
    expect(createMapsRouter('google', { serverKey: null })).toBeNull();
    expect(createMapsRouter('google', { serverKey: 'k' })?.provider).toBe('google');
  });
});

describe('the transport fee by distance', () => {
  it('lists the months of an academic year', () => {
    expect(monthsOf('2026-06-01', '2027-03-31')).toEqual([
      '2026-06-01',
      '2026-07-01',
      '2026-08-01',
      '2026-09-01',
      '2026-10-01',
      '2026-11-01',
      '2026-12-01',
      '2027-01-01',
      '2027-02-01',
      '2027-03-01',
    ]);
    expect(monthsOf('2026-04-15', '2026-04-20')).toEqual(['2026-04-01']);
  });

  it('charges both ways at the yearly rate, in whole rupees, split by month', () => {
    // 4.25 km × 2 × ₹1,500 a km = ₹12,750 a year.
    expect(yearlyFee(4.25, 150_000)).toBe(1_275_000);
    expect(yearlyFee(0, 150_000)).toBe(0);
    expect(yearlyFee(1.333, 100_00)).toBe(26_700); // ₹266.60 → ₹267
    const parts = monthlyParts(1_275_000, 10);
    expect(parts.slice(0, 9).every((x) => x === 127_500)).toBe(true);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(1_275_000);
    const odd = monthlyParts(1_000_000, 12);
    expect(odd[0]).toBe(83_300);
    expect(odd[11]).toBe(1_000_000 - 83_300 * 11);
    expect(odd.every((x) => x % 100 === 0)).toBe(true);
    expect(monthlyParts(500, 0)).toEqual([]);
  });

  it('labels a month’s due', () => {
    expect(transportLabel('2026-10-01')).toBe('Transport Oct 2026');
    expect(transportLabel('2027-01-01', true)).toBe('Transport Jan 2027 (extra)');
    expect(transportLabel('2027-01-01', true).length).toBeLessThanOrEqual(30);
  });
});

describe('the live view', () => {
  it('thins a long trail, keeping the last point', () => {
    const trail = Array.from({ length: 1001 }, (_, i) => i);
    const out = thin(trail, 300);
    expect(out.length).toBeLessThanOrEqual(301);
    expect(out[0]).toBe(0);
    expect(out.at(-1)).toBe(1000);
    expect(thin([1, 2, 3], 300)).toEqual([1, 2, 3]);
  });

  it('works out minutes to a stop from the bus, the next stop and the stops after it', () => {
    const bus = { lat: 13.94, lng: 75.56 };
    // The bus at the next stop, 3 km of stops after it, at 18 km/h: 10 minutes.
    expect(etaMinutes(bus, bus, 3, 18)).toBe(10);
    expect(etaMinutes(null, bus, 3, 18)).toBeNull();
    expect(etaMinutes(bus, { lat: null, lng: null }, 3, 18)).toBeNull();
    // Never "0 minutes" while the stop is still ahead.
    expect(etaMinutes(bus, bus, 0, 18)).toBe(1);
  });
});
