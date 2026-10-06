/**
 * Parallel sign-ups on a real MySQL (IDN-001…004 and the session start): six members signing up at
 * once each get their account, device, session and code. The live-code lookup, the mobile lookup, the
 * device binding and the session start lock index gaps that parallel sign-ups share; InnoDB may pick a
 * deadlock victim, and the transaction is run again (utils/retry) instead of failing with GEN.INTERNAL.
 */
import { sql } from 'kysely';
import { adminUrl } from './db';
import { schoolFixture } from './school';

describe.skipIf(!adminUrl)('parallel sign-ups on real MySQL', () => {
  it('six members signing up at once all succeed, each with one active device', async () => {
    const f = await schoolFixture('Signup School');
    try {
      const names = ['Ramesh', 'Sunita', 'Kavya', 'Divya', 'Mohan', 'Gita'];
      const payers = await Promise.all(names.map((n) => f.payer(n, 0)));
      expect(new Set(payers.map((p) => p.accountId)).size).toBe(names.length);
      const devices = await f.t.db
        .selectFrom('devices')
        .select(['account_id', sql<number>`COUNT(*)`.as('n')])
        .where(
          'account_id',
          'in',
          payers.map((p) => p.accountId),
        )
        .where('status', '=', 'ACTIVE')
        .groupBy('account_id')
        .execute();
      expect(devices).toHaveLength(names.length);
      expect(devices.every((d) => Number(d.n) === 1)).toBe(true);
      expect(f.h.lines.some((l) => JSON.stringify(l).includes('Deadlock found'))).toBe(false);
    } finally {
      await f.t.drop();
    }
  }, 180_000);
});
