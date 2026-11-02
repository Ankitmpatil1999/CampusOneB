/**
 * k6 payment burst for a staging API (docs/03 §1, §11.3). Each virtual user is one payer with its own
 * access token and PIN; all pay one merchant's static QR. Prepare the payers and tokens with the same
 * steps as payments-burst.load.spec.ts and pass them in a JSON file:
 *
 *   k6 run -e BASE=https://staging.example -e PAYERS=payers.json -e QR="campusone://pay/s/…" \
 *     tests/load/payments-burst.k6.js
 *
 * payers.json: [{ "token": "<access token>", "pin": "4826" }, …]
 */
/* global __ENV, __VU, __ITER, open */
import http from 'k6/http';
import { check } from 'k6';
import { SharedArray } from 'k6/data';
import { uuidv4 } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';

const payers = new SharedArray('payers', () => JSON.parse(open(__ENV.PAYERS)));

export const options = {
  scenarios: {
    lunch: {
      executor: 'constant-arrival-rate',
      rate: Number(__ENV.RATE || 25), // payments per second into one merchant (design point)
      timeUnit: '1s',
      duration: __ENV.DURATION || '60s',
      preAllocatedVUs: 100,
      maxVUs: 300,
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    'http_req_duration{name:pay}': ['p(95)<700'],
  },
};

export default function () {
  const p = payers[(__VU * 997 + __ITER) % payers.length];
  const res = http.post(
    `${__ENV.BASE}/api/v1/me/payments`,
    JSON.stringify({
      qrPayload: __ENV.QR,
      amount: { amount: '1.00', currency: 'INR' },
      pin: p.pin,
    }),
    {
      headers: {
        Authorization: `Bearer ${p.token}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': uuidv4(),
      },
      tags: { name: 'pay' },
    },
  );
  check(res, { 'paid or refused for balance': (r) => r.status === 201 || r.status === 409 });
}
