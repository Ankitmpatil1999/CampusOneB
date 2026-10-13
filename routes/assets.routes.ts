import { Router, type Request, type RequestHandler } from 'express';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { defineRoute } from '../config/openapi-registry';
import type { Loggers } from '../controllers/logger';
import {
  authorize,
  memberOrConsole,
  requireSurface,
  requireTenant,
} from '../middlewares/auth.middleware';
import { idempotency } from '../middlewares/idempotency.middleware';
import type { Database } from '../models/ringpe_models';
import type { AssetsService } from '../services/assets.service';
import { AuthenticationError } from '../utils/CustomAPIError';
import { expectedVersion, setEtag } from '../utils/etag';

const money = z.object({ amount: z.string(), currency: z.literal('INR') });
const text = (max: number) =>
  z
    .string({ message: 'VALIDATION.REQUIRED' })
    .trim()
    .min(1, { message: 'VALIDATION.REQUIRED' })
    .max(max, { message: 'VALIDATION.FORMAT' });
const status = z.enum(['ACTIVE', 'INACTIVE'], { message: 'VALIDATION.FORMAT' });
const type = z.enum(['PHYSICAL', 'DIGITAL', 'SERVICE', 'OTHER'], { message: 'VALIDATION.FORMAT' });

const group = z
  .object({
    id: z.uuid(),
    name: z.string(),
    description: z.string().nullable(),
    status,
    assets: z.number().int(),
    vendors: z.number().int(),
    version: z.number().int(),
  })
  .meta({ id: 'AssetGroup' });
const asset = z
  .object({
    id: z.uuid(),
    group: z.object({ id: z.uuid(), name: z.string() }),
    name: z.string(),
    type,
    description: z.string().nullable(),
    status,
    version: z.number().int(),
  })
  .meta({ id: 'Asset' });
export const groupInputSchema = z
  .strictObject({
    name: text(60),
    description: z.string().trim().max(200).nullish(),
    status: status.optional(),
  })
  .meta({ id: 'AssetGroupInput' });
export const groupPatchSchema = groupInputSchema.partial().meta({ id: 'AssetGroupPatch' });
export const assetInputSchema = z
  .strictObject({
    groupId: z.uuid({ message: 'VALIDATION.FORMAT' }),
    name: text(80),
    type,
    description: z.string().trim().max(200).nullish(),
    status: status.optional(),
  })
  .meta({ id: 'AssetInput' });
export const assetPatchSchema = z
  .strictObject({
    name: text(80).optional(),
    type: type.optional(),
    description: z.string().trim().max(200).nullish(),
    status: status.optional(),
  })
  .meta({ id: 'AssetPatch' });
export const linkSchema = z
  .strictObject({ groupIds: z.array(z.uuid({ message: 'VALIDATION.FORMAT' })).max(200) })
  .meta({ id: 'VendorAssetGroups' });
const linkedSchema = z
  .object({
    linked: z.array(z.object({ id: z.uuid(), name: z.string(), status })),
    skipped: z.array(z.object({ groupId: z.string(), reason: z.enum(['INACTIVE', 'UNKNOWN']) })),
  })
  .meta({ id: 'VendorAssetGroupsSet' });
const vendorAssets = z
  .object({
    items: z.array(
      z.object({
        id: z.uuid(),
        name: z.string(),
        type,
        description: z.string().nullable(),
        group: z.object({ id: z.uuid(), name: z.string() }),
      }),
    ),
  })
  .meta({ id: 'VendorAssets' });
const invoices = z
  .object({
    items: z.array(
      z.object({
        reference: z.string(),
        merchant: z.object({ id: z.uuid(), name: z.string() }),
        invoiceNo: z.string(),
        asset: z.object({ id: z.string(), name: z.string().nullable() }).nullable(),
        amount: money,
        paidAt: z.string().nullable(),
        payer: z.string(),
      }),
    ),
  })
  .meta({ id: 'VendorInvoices' });

const doc = (d: Omit<Parameters<typeof defineRoute>[0], 'tags'>) =>
  defineRoute({ ...d, tags: ['Assets'] });
doc({
  id: 'INS-020',
  method: 'get',
  path: '/api/v1/console/asset-groups',
  summary: 'Asset groups with their asset and vendor counts',
  auth: 'config.view',
  responses: {
    200: {
      description: 'Groups',
      schema: z.object({ items: z.array(group) }).meta({ id: 'AssetGroups' }),
    },
  },
});
doc({
  id: 'INS-021',
  method: 'post',
  path: '/api/v1/console/asset-groups',
  summary: 'Create an asset group (name unique in the institution)',
  auth: 'config.edit',
  request: groupInputSchema,
  idempotent: 'required',
  responses: { 201: { description: 'Created' } },
});
doc({
  id: 'INS-022',
  method: 'patch',
  path: '/api/v1/console/asset-groups/{groupId}',
  summary: 'Rename, describe, activate or deactivate a group (If-Match)',
  auth: 'config.edit',
  request: groupPatchSchema,
  responses: { 200: { description: 'Group', schema: group } },
});
doc({
  id: 'INS-023',
  method: 'get',
  path: '/api/v1/console/assets',
  summary: 'Assets, by group and status',
  auth: 'config.view',
  responses: {
    200: {
      description: 'Assets',
      schema: z.object({ items: z.array(asset) }).meta({ id: 'Assets' }),
    },
  },
});
doc({
  id: 'INS-024',
  method: 'post',
  path: '/api/v1/console/assets',
  summary: 'Create an asset (type from the list; name unique in the group)',
  auth: 'config.edit',
  request: assetInputSchema,
  idempotent: 'required',
  responses: { 201: { description: 'Created' } },
});
doc({
  id: 'INS-025',
  method: 'patch',
  path: '/api/v1/console/assets/{assetId}',
  summary: 'Edit, activate or deactivate an asset (If-Match)',
  auth: 'config.edit',
  request: assetPatchSchema,
  responses: { 200: { description: 'Asset', schema: asset } },
});
doc({
  id: 'INS-026',
  method: 'put',
  path: '/api/v1/console/merchants/{merchantId}/asset-groups',
  summary:
    "Set a vendor's asset groups; an inactive group is neither linked nor de-linked (reported as skipped)",
  auth: 'merchants.edit',
  request: linkSchema,
  responses: { 200: { description: 'Linked', schema: linkedSchema } },
});
doc({
  id: 'INS-037',
  method: 'get',
  path: '/api/v1/console/merchants/{merchantId}/asset-groups',
  summary: "A vendor's linked asset groups (a regular merchant has none)",
  auth: 'merchants.view',
  responses: { 200: { description: 'Linked', schema: linkedSchema } },
});
doc({
  id: 'PAY-015',
  method: 'get',
  path: '/api/v1/merchant/assets',
  summary: 'The approved assets of my linked groups (vendors)',
  auth: 'member|business.assets',
  responses: { 200: { description: 'Assets', schema: vendorAssets } },
});
doc({
  id: 'MER-013',
  method: 'get',
  path: '/api/v1/console/vendor-invoices',
  summary: 'Vendor invoices paid: invoice number (once per vendor), asset, amount, payer',
  auth: 'merchants.view',
  responses: { 200: { description: 'Invoices', schema: invoices } },
});

/** Mounted under /api/v1. */
export function assetsRoutes(deps: {
  db: Kysely<Database>;
  assets: AssetsService;
  loggers: Loggers;
}): Router {
  const router = Router();
  const L = deps.loggers;
  // The app's member, or the web console with one of the sub-tasks (a vendor merchant; client 2026-10-13).
  const either = (...subTasks: string[]) => memberOrConsole(subTasks, L);
  const once = idempotency({ db: deps.db, mode: 'required' });
  const wrap =
    (fn: RequestHandler): RequestHandler =>
    async (req, res, next) => {
      try {
        await fn(req, res, next);
      } catch (e) {
        next(e);
      }
    };
  const principal = (req: Request) => {
    if (!req.principal) throw new AuthenticationError();
    return req.principal;
  };
  const param = (req: Request, k: string) => String(req.params[k]);
  const console = [requireSurface(L, 'console'), requireTenant(L)];
  const q = (req: Request, k: string) =>
    typeof req.query[k] === 'string' ? (req.query[k] as string) : undefined;
  const statusOf = (req: Request) => status.optional().parse(q(req, 'status'));

  router.get(
    '/console/asset-groups',
    ...console,
    authorize('config.view', L),
    wrap(async (req, res) => {
      res.json(await deps.assets.groups(principal(req), { status: statusOf(req) }));
    }),
  );
  router.post(
    '/console/asset-groups',
    ...console,
    authorize('config.edit', L),
    once,
    wrap(async (req, res) => {
      res
        .status(201)
        .json(
          await deps.assets.createGroup(principal(req), groupInputSchema.parse(req.body ?? {})),
        );
    }),
  );
  router.patch(
    '/console/asset-groups/:groupId',
    ...console,
    authorize('config.edit', L),
    wrap(async (req, res) => {
      const out = await deps.assets.updateGroup(
        principal(req),
        param(req, 'groupId'),
        expectedVersion(req),
        groupPatchSchema.parse(req.body ?? {}),
      );
      setEtag(res, out.version);
      res.json(out);
    }),
  );
  router.get(
    '/console/assets',
    ...console,
    authorize('config.view', L),
    wrap(async (req, res) => {
      res.json(
        await deps.assets.assets(principal(req), {
          groupId: q(req, 'groupId'),
          status: statusOf(req),
        }),
      );
    }),
  );
  router.post(
    '/console/assets',
    ...console,
    authorize('config.edit', L),
    once,
    wrap(async (req, res) => {
      res
        .status(201)
        .json(
          await deps.assets.createAsset(principal(req), assetInputSchema.parse(req.body ?? {})),
        );
    }),
  );
  router.patch(
    '/console/assets/:assetId',
    ...console,
    authorize('config.edit', L),
    wrap(async (req, res) => {
      const out = await deps.assets.updateAsset(
        principal(req),
        param(req, 'assetId'),
        expectedVersion(req),
        assetPatchSchema.parse(req.body ?? {}),
      );
      setEtag(res, out.version);
      res.json(out);
    }),
  );
  router.get(
    '/console/merchants/:merchantId/asset-groups',
    ...console,
    authorize('merchants.view', L),
    wrap(async (req, res) => {
      res.json(await deps.assets.vendorGroups(principal(req), param(req, 'merchantId')));
    }),
  );
  router.put(
    '/console/merchants/:merchantId/asset-groups',
    ...console,
    authorize('merchants.edit', L),
    wrap(async (req, res) => {
      res.json(
        await deps.assets.linkVendor(
          principal(req),
          param(req, 'merchantId'),
          linkSchema.parse(req.body ?? {}),
        ),
      );
    }),
  );
  router.get(
    '/merchant/assets',
    either('business.assets'),
    wrap(async (req, res) => {
      res.json(await deps.assets.vendorAssets(principal(req)));
    }),
  );
  router.get(
    '/console/vendor-invoices',
    ...console,
    authorize('merchants.view', L),
    wrap(async (req, res) => {
      res.json(
        await deps.assets.vendorInvoices(principal(req), {
          merchantId: q(req, 'merchantId'),
          from: q(req, 'from'),
          to: q(req, 'to'),
        }),
      );
    }),
  );
  return router;
}
