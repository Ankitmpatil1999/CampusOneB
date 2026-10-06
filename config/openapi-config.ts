import { stringify } from 'yaml';
import { buildOpenApiDocument } from './openapi-registry';

// Importing the route modules registers their operations.
import '../app';
import '../routes/health.routes';
import '../routes/platform.routes';
import '../routes';

/** The API version tracks the OpenAPI contract, not the build. */
export const API_CONTRACT_VERSION = '1.1.0-phase2';

export function renderOpenApiYaml(): string {
  return stringify(buildOpenApiDocument({ version: API_CONTRACT_VERSION }), {
    lineWidth: 0,
    sortMapEntries: false,
    // Shared sub-objects are written out in full: aliases would trip YAML readers' alias limits.
    aliasDuplicateObjects: false,
  });
}
