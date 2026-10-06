import type { Request, RequestHandler } from 'express';
import {
  customFieldChangeSchema,
  customFieldCreateSchema,
  customFieldsQuerySchema,
  userTypeChangeSchema,
  userTypeCreateSchema,
} from '../schemas/institution-setup.schema';
import type { InstitutionSetupService } from '../services/institution-setup.service';
import { AuthenticationError } from '../utils/CustomAPIError';
import { expectedVersion, setEtag } from '../utils/etag';

export function institutionSetupController(service: InstitutionSetupService) {
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

  return {
    userTypes: wrap(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.json(await service.userTypes(principal(req)));
    }),
    createUserType: wrap(async (req, res) => {
      const body = userTypeCreateSchema.parse(req.body ?? {});
      res.status(201).json(await service.createUserType(principal(req), body));
    }),
    changeUserType: wrap(async (req, res) => {
      const body = userTypeChangeSchema.parse(req.body ?? {});
      res.json(
        await service.changeUserType(
          principal(req),
          String(req.params['userTypeId']),
          expectedVersion(req),
          body,
        ),
      );
    }),
    fields: wrap(async (req, res) => {
      const { entity } = customFieldsQuerySchema.parse(req.query);
      res.setHeader('Cache-Control', 'no-store');
      res.json(await service.customFields(principal(req), entity));
    }),
    createField: wrap(async (req, res) => {
      const body = customFieldCreateSchema.parse(req.body ?? {});
      const out = await service.createField(principal(req), body);
      setEtag(res, out.version);
      res.status(201).json(out);
    }),
    changeField: wrap(async (req, res) => {
      const body = customFieldChangeSchema.parse(req.body ?? {});
      const out = await service.changeField(
        principal(req),
        String(req.params['fieldId']),
        expectedVersion(req),
        body,
      );
      setEtag(res, out.version);
      res.json(out);
    }),
  };
}
