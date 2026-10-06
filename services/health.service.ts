/**
 * Health (brief §7.3). `live`: the process is up (no dependency checks). `ready`: every required
 * dependency answers within the timeout. `startup`: initialisation finished. Dependencies that are
 * not configured in this environment are reported as such and do not fail readiness.
 */
export type DependencyName = 'mysql' | 'redis' | 'objectStorage' | 'kms';
export type DependencyState = 'up' | 'down' | 'not_configured';

export interface DependencyCheck {
  readonly name: DependencyName;
  /** A down required dependency makes the service not ready. */
  readonly required: boolean;
  /** `undefined` = not configured in this environment. */
  readonly check?: () => Promise<void>;
}

export interface DependencyStatus {
  readonly name: DependencyName;
  readonly status: DependencyState;
  readonly required: boolean;
  readonly latencyMs?: number;
}

export interface ReadinessReport {
  readonly status: 'ok' | 'unavailable';
  readonly checks: readonly DependencyStatus[];
}

export class HealthService {
  private started = false;
  private readonly startedAt = Date.now();

  constructor(
    private readonly checks: readonly DependencyCheck[],
    private readonly opts: { timeoutMs: number; version: string; commit: string },
  ) {}

  markStarted(): void {
    this.started = true;
  }

  get isStarted(): boolean {
    return this.started;
  }

  async readiness(): Promise<ReadinessReport> {
    const results = await Promise.all(this.checks.map((c) => this.run(c)));
    const down = results.some((r) => r.required && r.status === 'down');
    return { status: down || !this.started ? 'unavailable' : 'ok', checks: results };
  }

  async details(): Promise<
    ReadinessReport & { version: string; commit: string; uptimeSeconds: number }
  > {
    return {
      ...(await this.readiness()),
      version: this.opts.version,
      commit: this.opts.commit,
      uptimeSeconds: Math.round((Date.now() - this.startedAt) / 1000),
    };
  }

  private async run(c: DependencyCheck): Promise<DependencyStatus> {
    if (!c.check) return { name: c.name, status: 'not_configured', required: c.required };
    const t0 = performance.now();
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        c.check(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('timeout')), this.opts.timeoutMs);
        }),
      ]);
      return { name: c.name, status: 'up', required: c.required, latencyMs: elapsed(t0) };
    } catch {
      return { name: c.name, status: 'down', required: c.required, latencyMs: elapsed(t0) };
    } finally {
      clearTimeout(timer);
    }
  }
}

const elapsed = (t0: number) => Math.round((performance.now() - t0) * 10) / 10;
