import type { Request, RequestHandler } from 'express';
import {
  classInputSchema,
  classUpdateSchema,
  commitSchema,
  delinkSchema,
  eligibilitySchema,
  memberUpdateSchema,
  membersQuerySchema,
  onboardSchema,
  searchQuerySchema,
  schoolRecordQuerySchema,
  sectionInputSchema,
  sessionEndSchema,
  staffSchema,
  statusChangeSchema,
  uploadKindSchema,
  yearActionSchema,
  yearInputSchema,
} from '../schemas/members.schema';
import type { AcademicsService } from '../services/academics.service';
import type { MemberUploadsService } from '../services/member-uploads.service';
import type { MembersService } from '../services/members.service';
import { AuthenticationError, ValidationError } from '../utils/CustomAPIError';
import { expectedVersion, setEtag } from '../utils/etag';

export function membersController(
  members: MembersService,
  uploads: MemberUploadsService,
  academics: AcademicsService,
) {
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
  const param = (req: Request, name: string) => String(req.params[name]);
  const fresh = (res: Parameters<RequestHandler>[1]) => res.setHeader('Cache-Control', 'no-store');

  return {
    // --- members ------------------------------------------------------------------------------------
    list: wrap(async (req, res) => {
      const q = membersQuerySchema.parse(req.query);
      // Custom-field filters arrive as cf.<field id>=<option label | Yes | No>.
      const cf = Object.fromEntries(
        Object.entries(req.query)
          .filter(([k, v]) => k.startsWith('cf.') && typeof v === 'string')
          .map(([k, v]) => [k.slice(3), String(v)]),
      );
      fresh(res);
      res.json(await members.list(principal(req), { ...q, cf }));
    }),
    detail: wrap(async (req, res) => {
      const out = await members.detail(principal(req), param(req, 'memberId'));
      fresh(res);
      setEtag(res, out.version);
      res.json(out);
    }),
    update: wrap(async (req, res) => {
      const body = memberUpdateSchema.parse(req.body ?? {});
      const out = await members.update(
        principal(req),
        param(req, 'memberId'),
        expectedVersion(req),
        body,
      );
      setEtag(res, out.version);
      res.json(out);
    }),
    eligibility: wrap(async (req, res) => {
      fresh(res);
      res.json(await members.eligibility(principal(req), eligibilitySchema.parse(req.body ?? {})));
    }),
    onboard: wrap(async (req, res) => {
      const body = onboardSchema.parse(req.body ?? {});
      res.status(201).json(await members.onboard(principal(req), body));
    }),
    staff: wrap(async (req, res) => {
      const body = staffSchema.parse(req.body ?? {});
      // Shown once: an idempotent replay answers without the temporary password.
      res.locals['idempotencyOmit'] = ['temporaryPassword'];
      res.status(201).json(await members.onboardStaff(principal(req), body));
    }),
    status: wrap(async (req, res) => {
      const body = statusChangeSchema.parse(req.body ?? {});
      const out = await members.changeStatus(principal(req), param(req, 'memberId'), body);
      res.status(out.approvalId ? 202 : 200).json(out);
    }),
    schoolRecord: wrap(async (req, res) => {
      const q = schoolRecordQuerySchema.parse(req.query);
      res.setHeader('Cache-Control', 'no-store');
      res.json(await members.schoolRecord(principal(req), q.for));
    }),
    endSessions: wrap(async (req, res) => {
      const body = sessionEndSchema.parse(req.body ?? {});
      res.json(await members.endSessions(principal(req), param(req, 'memberId'), body));
    }),
    delink: wrap(async (req, res) => {
      const body = delinkSchema.parse(req.body ?? {});
      const out = await members.delinkRequest(principal(req), param(req, 'memberId'), body);
      res.status(out.approvalId ? 202 : 200).json(out);
    }),
    history: wrap(async (req, res) => {
      fresh(res);
      res.json(await members.history(principal(req), param(req, 'memberId')));
    }),
    search: wrap(async (req, res) => {
      const { q } = searchQuerySchema.parse(req.query);
      fresh(res);
      res.json(await members.search(principal(req), q));
    }),

    // --- sheets -------------------------------------------------------------------------------------
    template: wrap(async (req, res) => {
      const kind = uploadKindSchema.parse(param(req, 'kind').toUpperCase());
      const out = await uploads.template(principal(req), kind);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${out.fileName}"`);
      res.send(String.fromCharCode(0xfeff) + out.csv);
    }),
    upload: wrap(async (req, res) => {
      const kind = uploadKindSchema.safeParse(
        String((req.body as Record<string, unknown> | undefined)?.['kind'] ?? '').toUpperCase(),
      );
      if (!kind.success) throw new ValidationError([{ field: 'kind', code: 'VALIDATION.FORMAT' }]);
      if (!req.file) throw new ValidationError([{ field: 'file', code: 'UPL.FILE_REQUIRED' }]);
      const out = await uploads.upload(principal(req), {
        kind: kind.data,
        fileName: req.file.originalname || 'upload.csv',
        content: req.file.buffer.toString('utf8'),
      });
      res.status(201).json(out);
    }),
    uploadStatus: wrap(async (req, res) => {
      fresh(res);
      res.json(await uploads.status(principal(req), param(req, 'uploadId')));
    }),
    commit: wrap(async (req, res) => {
      const body = commitSchema.parse(req.body ?? {});
      res.locals['idempotencyOmit'] = ['passwords'];
      res.json(await uploads.commit(principal(req), param(req, 'uploadId'), body));
    }),

    // --- academic structure -------------------------------------------------------------------------
    years: wrap(async (req, res) => {
      fresh(res);
      res.json(await academics.years(principal(req)));
    }),
    createYear: wrap(async (req, res) => {
      res
        .status(201)
        .json(await academics.createYear(principal(req), yearInputSchema.parse(req.body ?? {})));
    }),
    yearAction: wrap(async (req, res) => {
      const body = yearActionSchema.parse(req.body ?? {});
      res.json(await academics.yearAction(principal(req), param(req, 'yearId'), body));
    }),
    classes: wrap(async (req, res) => {
      fresh(res);
      res.json(await academics.classes(principal(req)));
    }),
    createClass: wrap(async (req, res) => {
      const out = await academics.createClass(
        principal(req),
        classInputSchema.parse(req.body ?? {}),
      );
      setEtag(res, out.version);
      res.status(201).json(out);
    }),
    updateClass: wrap(async (req, res) => {
      const body = classUpdateSchema.parse(req.body ?? {});
      const out = await academics.updateClass(
        principal(req),
        param(req, 'classId'),
        expectedVersion(req),
        body,
      );
      setEtag(res, out.version);
      res.json(out);
    }),
    addSection: wrap(async (req, res) => {
      const body = sectionInputSchema.parse(req.body ?? {});
      res.status(201).json(await academics.addSection(principal(req), param(req, 'classId'), body));
    }),
    updateSection: wrap(async (req, res) => {
      const body = sectionInputSchema.parse(req.body ?? {});
      res.json(await academics.updateSection(principal(req), param(req, 'sectionId'), body));
    }),
  };
}
