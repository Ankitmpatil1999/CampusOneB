/**
 * Writes config/openapi.yaml from the route definitions (committed; a unit test
 * fails when it is stale).
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderOpenApiYaml } from '../config/openapi-config';

const target = join(import.meta.dirname, '..', 'config', 'openapi.yaml');
writeFileSync(target, renderOpenApiYaml());
console.log(`wrote ${target}`);
