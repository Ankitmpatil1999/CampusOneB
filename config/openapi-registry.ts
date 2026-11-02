/**
 * OpenAPI 3.1 from the zod schemas (D-13, brief §7.4). Each route file declares its operations
 * with `defineRoute`; `buildOpenApiDocument` assembles the committed `config/openapi.yaml`
 * (regenerate with `npm run openapi`; a test fails when it is stale).
 */
import { z } from 'zod';
import { problemSchema } from '../utils/apiResponse';

type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

export interface RouteResponse {
  readonly description: string;
  readonly schema?: z.ZodType;
  readonly contentType?: string;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface RouteDefinition {
  /** Catalogue id from docs/05 (e.g. PLT-001). */
  readonly id: string;
  readonly method: HttpMethod;
  /** Express-style path; `:param` becomes `{param}`. */
  readonly path: string;
  readonly summary: string;
  readonly tags: readonly string[];
  /** `public`, `internal`, or the sub-task required (`task.subtask`). */
  readonly auth: string;
  readonly idempotent?: 'required' | 'optional';
  readonly request?: z.ZodType;
  /**
   * Query parameters, typed. When absent, the summary's ?name mentions (and "cursor") are
   * documented as optional string parameters, so every filter a route takes is visible.
   */
  readonly query?: z.ZodObject;
  /** Request media type (default application/json), e.g. multipart/form-data for uploads. */
  readonly requestContentType?: string;
  /** Distinguishes a second operation that implements the same catalogue id (operationId `ID-suffix`). */
  readonly operationSuffix?: string;
  readonly responses: Readonly<Record<number, RouteResponse>>;
}

const routes = new Map<string, RouteDefinition>();

export function defineRoute(def: RouteDefinition): RouteDefinition {
  const key = `${def.method} ${def.path}`;
  const existing = routes.get(key);
  if (existing && existing.id !== def.id) throw new Error(`Route ${key} defined twice`);
  routes.set(key, def);
  return def;
}

export function registeredRoutes(): RouteDefinition[] {
  return [...routes.values()].sort(
    (a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method),
  );
}

const toOpenApiPath = (p: string) => p.replace(/:([A-Za-z0-9_]+)/g, '{$1}');

/** JSON Schema of a zod schema, with registered ids turned into component references. */
/** Requests are described as clients send them (input), responses as returned (output). */
function jsonSchema(
  schema: z.ZodType,
  components: Record<string, unknown>,
  io: 'input' | 'output' = 'output',
): unknown {
  const raw = z.toJSONSchema(schema, { target: 'draft-2020-12', reused: 'inline', io });
  // Single-schema conversion references shared parts as #/$defs/<id>; OpenAPI wants components.
  const out = JSON.parse(
    JSON.stringify(raw).replace(/"#\/\$defs\//g, '"#/components/schemas/'),
  ) as Record<string, unknown>;
  const defs = (out['$defs'] ?? {}) as Record<string, unknown>;
  for (const [id, s] of Object.entries(defs)) components[id] = s;
  delete out['$defs'];
  delete out['$schema'];
  const meta = z.globalRegistry.get(schema);
  if (meta?.id) {
    const self = `#/components/schemas/${meta.id}`;
    // zod may return the root itself as a reference into its definitions (already copied above);
    // writing that reference over the definition would leave the component pointing at itself.
    const onlyRef = out['$ref'] === self && Object.keys(out).length === 1;
    if (!onlyRef) components[meta.id] = out;
    return { $ref: self };
  }
  return out;
}

export function buildOpenApiDocument(info: { version: string }): Record<string, unknown> {
  const components: Record<string, unknown> = {};
  const problemRef = jsonSchema(problemSchema, components);
  const paths: Record<string, Record<string, unknown>> = {};

  for (const r of registeredRoutes()) {
    const responses: Record<string, unknown> = {};
    for (const [status, resp] of Object.entries(r.responses)) {
      responses[status] = {
        description: resp.description,
        ...(resp.schema
          ? {
              content: {
                [resp.contentType ?? 'application/json']: {
                  schema: jsonSchema(resp.schema, components),
                },
              },
            }
          : resp.contentType
            ? { content: { [resp.contentType]: { schema: { type: 'string' } } } }
            : {}),
      };
    }
    responses['default'] = {
      description: 'Error (RFC 9457 problem details)',
      content: { 'application/problem+json': { schema: problemRef } },
    };
    const op: Record<string, unknown> = {
      operationId: r.operationSuffix ? `${r.id}-${r.operationSuffix}` : r.id,
      summary: r.summary,
      tags: r.tags,
      'x-campusone-auth': r.auth,
      responses,
    };
    if (r.auth !== 'public' && r.auth !== 'internal')
      op['security'] = [{ bearer: [] }, { cookie: [] }];
    const parameters: Record<string, unknown>[] = [];
    // Path parameters are always required strings (record ids, tokens).
    for (const m of r.path.matchAll(/[:{]([A-Za-z0-9_]+)\}?/g)) {
      parameters.push({ name: m[1], in: 'path', required: true, schema: { type: 'string' } });
    }
    if (r.query) {
      for (const [name, s] of Object.entries(r.query.shape as Record<string, z.ZodType>)) {
        parameters.push({
          name,
          in: 'query',
          required: !s.safeParse(undefined).success,
          schema: jsonSchema(s, components, 'input'),
        });
      }
    } else {
      const named = new Set([...r.summary.matchAll(/\?([A-Za-z][A-Za-z0-9]*)/g)].map((m) => m[1]!));
      if (/\bcursor\b/.test(r.summary)) named.add('cursor');
      for (const name of named) {
        parameters.push({ name, in: 'query', required: false, schema: { type: 'string' } });
      }
    }
    if (r.idempotent) {
      parameters.push({
        name: 'Idempotency-Key',
        in: 'header',
        required: r.idempotent === 'required',
        schema: { type: 'string', maxLength: 100 },
      });
    }
    if (parameters.length) op['parameters'] = parameters;
    if (r.request) {
      op['requestBody'] = {
        required: true,
        content: {
          [r.requestContentType ?? 'application/json']: {
            schema: jsonSchema(r.request, components, 'input'),
          },
        },
      };
    }
    const path = toOpenApiPath(r.path);
    paths[path] = { ...(paths[path] ?? {}), [r.method]: op };
  }

  return {
    openapi: '3.1.1',
    info: {
      title: 'CampusOne API',
      version: info.version,
      description:
        'Campus wallets, payments and school management. Errors use RFC 9457 problem+json; money is a decimal string with "currency": "INR".',
    },
    servers: [{ url: '/' }],
    paths,
    components: {
      schemas: Object.fromEntries(
        Object.entries(components).sort(([a], [b]) => a.localeCompare(b)),
      ),
      securitySchemes: {
        bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT (ES256)' },
        cookie: { type: 'apiKey', in: 'cookie', name: '__Host-rp_at' },
      },
    },
  };
}
