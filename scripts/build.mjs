// Production build: bundles the API, the worker and the database CLI to dist/ with esbuild
// (node_modules stay external) and copies the migrations next to the bundle.
import { cpSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'esbuild';

const root = join(import.meta.dirname, '..');
const dist = join(root, 'dist');

rmSync(dist, { recursive: true, force: true });
await build({
  absWorkingDir: root,
  entryPoints: { server: 'server.ts', worker: 'worker.ts', db: 'scripts/db.ts' },
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  packages: 'external',
  sourcemap: true,
  logLevel: 'info',
});
cpSync(join(root, 'db', 'migrations'), join(dist, 'db', 'migrations'), { recursive: true });
console.log('built dist/server.js, dist/worker.js, dist/db.js and dist/db/migrations');
