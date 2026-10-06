import { renderReferenceSeedSql, PAYMENT_CHANNELS } from '../db/reference-seed';
import { createDatabase } from '../models/database';
import { migrationsDir, waitForSchema, type Runtime } from '../config/bootstrap';
import { readMigrationDir } from '../db/migrator';
import { capturingLoggers, testConfig, waitForLine } from './helpers';
import {
  AuthenticationError,
  AuthorizationError,
  BadRequestError,
  ConflictError,
  InternalError,
  NotFoundError,
  PayloadTooLargeError,
  PreconditionFailedError,
  RateLimitError,
  ServiceUnavailableError,
  UnsupportedMediaTypeError,
  ValidationError,
} from '../utils/CustomAPIError';
import { buildProblem } from '../utils/apiResponse';
import { isUuidV7, newPublicId } from '../utils/idGenerator';

describe('reference seeds', () => {
  const sql = renderReferenceSeedSql();

  it('seeds the status registers, payment channels 1–8 and the launch languages', () => {
    expect(sql).toContain('INSERT INTO ref_status_values (domain, code');
    expect(sql).toContain("'institution', 'PENDING_ACTIVATION'");
    expect(PAYMENT_CHANNELS.map((c) => c.mode)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(sql).toContain("('DYNAMIC_QR', 6, 'channel.dynamic_qr')");
    // Seven launch languages, Kannada next to English (client, Q18).
    expect(sql).toContain("('en', 'English', 'English', TRUE, TRUE, 10)");
    expect(sql).toContain("('kn', 'Kannada', 'ಕನ್ನಡ', TRUE, FALSE, 20)");
    expect(sql).toContain("('mr', 'Marathi', 'मराठी', TRUE, FALSE, 70)");
  });

  it('is idempotent SQL (every insert upserts)', () => {
    const inserts = sql.split('\n').filter((l) => l.startsWith('INSERT'));
    expect(inserts.length).toBeGreaterThan(20);
    expect(inserts.every((l) => l.includes('ON DUPLICATE KEY UPDATE'))).toBe(true);
  });
});

describe('typed errors', () => {
  it.each([
    [new BadRequestError(), 400, 'GEN.BAD_REQUEST'],
    [
      new ValidationError([{ field: 'mobile', code: 'VALIDATION.MOBILE' }]),
      422,
      'VALIDATION.FAILED',
    ],
    [new AuthenticationError(), 401, 'AUTH.UNAUTHENTICATED'],
    [new AuthorizationError(), 403, 'AUTH.FORBIDDEN'],
    [new NotFoundError(), 404, 'GEN.NOT_FOUND'],
    [new ConflictError('GEN.IDEMPOTENCY_IN_PROGRESS'), 409, 'GEN.IDEMPOTENCY_IN_PROGRESS'],
    [new PreconditionFailedError(), 412, 'GEN.CONFLICT_VERSION'],
    [new PayloadTooLargeError(), 413, 'GEN.PAYLOAD_TOO_LARGE'],
    [new UnsupportedMediaTypeError(), 415, 'GEN.UNSUPPORTED_MEDIA_TYPE'],
    [new RateLimitError(60), 429, 'GEN.RATE_LIMITED'],
    [new ServiceUnavailableError(), 503, 'GEN.UNAVAILABLE'],
    [new InternalError(new Error('x')), 500, 'GEN.INTERNAL'],
  ])('%s → %i %s', (err, status, code) => {
    expect(err.statusCode).toBe(status);
    expect(err.code).toBe(code);
  });

  it('carries Retry-After on 429 and 503', () => {
    expect(new RateLimitError(30).headers).toEqual({ 'Retry-After': '30' });
    expect(new ServiceUnavailableError().headers['Retry-After']).toBe('30');
  });
});

describe('problem details', () => {
  it('renders placeholders into the title and detail', () => {
    const p = buildProblem({
      status: 413,
      code: 'FILE.TOO_LARGE',
      correlationId: 'c1',
      params: { limit: '2 MB' },
    });
    expect(p.detail).toBe('The file must be under 2 MB.');
    expect(p.title).toBe(p.detail);
  });

  it('falls back to the generic format message for an unknown field code', () => {
    const p = buildProblem({
      status: 422,
      code: 'VALIDATION.FAILED',
      correlationId: 'c1',
      errors: [{ field: 'x', code: 'NOT.REGISTERED' }],
    });
    expect(p.errors?.[0]?.message).toBe('This value is not in the expected format.');
  });
});

describe('ids', () => {
  it('issues time-ordered UUIDv7 public ids', () => {
    const a = newPublicId();
    const b = newPublicId();
    expect(isUuidV7(a)).toBe(true);
    expect(a < b).toBe(true);
    expect(isUuidV7('4f6c8e2a-1b3d-4e5f-9a7b-8c9d0e1f2a3b')).toBe(false);
  });
});

describe('database handle', () => {
  it('fails the ping quickly when MySQL is unreachable and closes cleanly', async () => {
    const { loggers } = capturingLoggers();
    const handle = createDatabase({ url: 'mysql://u:p@127.0.0.1:1/none', poolSize: 1 }, loggers);
    await expect(handle.ping(2000)).rejects.toThrow();
    await handle.close();
  });

  it('times the ping out', async () => {
    const { loggers } = capturingLoggers();
    // 10.255.255.1 is unroutable: the connection hangs until the timeout fires.
    const handle = createDatabase(
      { url: 'mysql://u:p@10.255.255.1:3306/none', poolSize: 1 },
      loggers,
    );
    await expect(handle.ping(100)).rejects.toThrow(/timed out/);
    // The pool keeps waiting for the hung connect (up to its 10 s connect timeout); shutdown's
    // grace period covers that in production, so the test does not wait for it.
    void handle.close().catch(() => undefined);
  });
});

describe('start-up schema gate (PLT-003)', () => {
  const files = readMigrationDir(migrationsDir());

  const fakeRuntime = (rows: { version: string; checksum: string }[] | Error) => {
    const { loggers, lines } = capturingLoggers();
    const runtime = {
      config: testConfig(),
      loggers,
      database: {
        db: {
          selectFrom: () => ({
            select: () => ({
              execute: async () => {
                if (rows instanceof Error) throw rows;
                return rows;
              },
            }),
          }),
        },
      },
    } as unknown as Runtime;
    return { runtime, lines };
  };

  it('finds the repository migrations, numbered without gaps', () => {
    expect(files.length).toBeGreaterThanOrEqual(5);
    expect(files.map((f) => f.version)).toEqual(
      files.map((_, i) => String(i + 1).padStart(4, '0')),
    );
  });

  it('opens when every migration is applied unchanged', async () => {
    const { runtime } = fakeRuntime(
      files.map((f) => ({ version: f.version, checksum: f.checksum })),
    );
    const ready = await new Promise<boolean>((resolve) => {
      const stop = waitForSchema(runtime, () => resolve(true), 10);
      setTimeout(() => {
        stop();
        resolve(false);
      }, 1000);
    });
    expect(ready).toBe(true);
  });

  it('stays closed and logs while migrations are pending or the check fails', async () => {
    for (const rows of [[], new Error('db down')] as const) {
      const { runtime, lines } = fakeRuntime(rows as never);
      let opened = false;
      const stop = waitForSchema(runtime, () => (opened = true), 10);
      await new Promise((r) => setTimeout(r, 50));
      stop();
      expect(opened).toBe(false);
      await waitForLine(lines, (l) => String(l['message']).startsWith('schema'));
    }
  });
});
