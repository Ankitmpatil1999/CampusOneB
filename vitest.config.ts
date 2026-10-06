import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    watch: false,
    // Integration suites set up a database per file; under a full parallel run hooks need longer.
    hookTimeout: 240_000,
    globals: true,
    environment: 'node',
    include: ['tests/**/*.spec.ts'],
    reporters: ['default'],
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage',
      reportOnFailure: true,
      // The brief's gates (CLAUDE.md "Tests"): services at least 80 %, the §9.11 checks 100 %. They
      // hold only with the integration suite, which needs a database (CI provides one).
      thresholds: {
        'services/**/*.ts': { statements: 80, lines: 80 },
        'services/payment-checks.ts': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
      },
      include: [
        'app.ts',
        'config/**/*.ts',
        'controllers/**/*.ts',
        'db/**/*.ts',
        'middlewares/**/*.ts',
        'models/**/*.ts',
        'routes/**/*.ts',
        'schedulers/**/*.ts',
        'schemas/**/*.ts',
        'services/**/*.ts',
        'utils/**/*.ts',
      ],
    },
  },
});
