import { Router } from 'express';
import type { Kysely } from 'kysely';
import { defineRoute } from '../config/openapi-registry';
import { singleFileUpload, uploadErrors } from '../controllers/file.controller';
import type { Loggers } from '../controllers/logger';
import { membersController } from '../controllers/members.controller';
import {
  authorize,
  authorizeAny,
  requireSurface,
  requireTenant,
} from '../middlewares/auth.middleware';
import { idempotency } from '../middlewares/idempotency.middleware';
import type { Database } from '../models/campusone_models';
import {
  classInputSchema,
  classSchema,
  classUpdateSchema,
  classesSchema,
  commitResultSchema,
  commitSchema,
  delinkResultSchema,
  delinkSchema,
  eligibilityResultSchema,
  eligibilitySchema,
  familyLookupResultSchema,
  familyLookupSchema,
  memberDetailSchema,
  memberHistorySchema,
  memberListSchema,
  memberUpdateSchema,
  onboardResultSchema,
  onboardSchema,
  schoolRecordQuerySchema,
  searchResultSchema,
  sectionInputSchema,
  sessionEndResultSchema,
  sessionEndSchema,
  staffResultSchema,
  staffSchema,
  statusChangeSchema,
  statusResultSchema,
  uploadResultSchema,
  uploadSchema,
  yearActionSchema,
  yearInputSchema,
  yearSchema,
  yearsSchema,
} from '../schemas/members.schema';
import type { AcademicsService } from '../services/academics.service';
import type { MemberUploadsService } from '../services/member-uploads.service';
import type { MembersService } from '../services/members.service';

const tags = ['Members'];
const aca = ['Academic structure'];
const doc = (d: Parameters<typeof defineRoute>[0]) => defineRoute(d);

doc({
  id: 'IDN-044',
  method: 'get',
  path: '/api/v1/console/members',
  summary:
    'Members by tab (students, parents, staff & teachers, merchants): search, grade and section for the current year, user type, department, status and filterable institution fields; counts per tab and status; paged by name (cf.<field id>=<value> filters)',
  tags,
  auth: 'members.view',
  responses: { 200: { description: 'Members', schema: memberListSchema } },
});
doc({
  id: 'IDN-045',
  method: 'get',
  path: '/api/v1/console/members/{memberId}',
  summary:
    'A member: identity (read-only), contact, grade and section, guardians or children, console roles, status, pending requests, institution fields, and a student’s school transport',
  tags,
  auth: 'members.view',
  responses: { 200: { description: 'Member', schema: memberDetailSchema } },
});
doc({
  id: 'IDN-046',
  method: 'patch',
  path: '/api/v1/console/members/{memberId}',
  summary:
    'Edit department, e-mail, joining date, grade and section (this year) and institution fields (If-Match); identity fields change only through a correction request (CR-06)',
  tags,
  auth: 'members.edit',
  request: memberUpdateSchema,
  responses: { 200: { description: 'Member', schema: memberDetailSchema } },
});
doc({
  id: 'IDN-047',
  method: 'post',
  path: '/api/v1/console/members/eligibility',
  summary:
    'Onboarding step 1: who this mobile is here; one used at another institution may join too (elsewhere, never named; client 2026-10-27)',
  tags,
  auth: 'members.onboard',
  request: eligibilitySchema,
  responses: { 200: { description: 'Eligibility', schema: eligibilityResultSchema } },
});
doc({
  id: 'IDN-090',
  method: 'post',
  path: '/api/v1/console/members/family-lookup',
  summary:
    'Who a mobile belongs to here, for the forms that enter a parent (client 2026-10-22): the family — its children here, its parents, the parents and address as its latest admission had them — or a staff member working here. No Aadhaar or PAN.',
  tags,
  auth: 'members.onboard,admissions.edit,admissions.approve',
  request: familyLookupSchema,
  responses: { 200: { description: 'Who holds the mobile', schema: familyLookupResultSchema } },
});
doc({
  id: 'IDN-048',
  method: 'post',
  path: '/api/v1/console/members',
  summary:
    'Onboard one student, with grade, section and parents (client 2026-10-19: every other role through staff onboarding, IDN-053; another user type is refused, IDN.STUDENTS_ONLY); linked to the CampusOne account of the mobile, or linked when it signs up',
  tags,
  auth: 'members.onboard',
  request: onboardSchema,
  responses: { 201: { description: 'Onboarded', schema: onboardResultSchema } },
});
doc({
  id: 'IDN-049',
  method: 'post',
  path: '/api/v1/console/members/uploads',
  summary:
    'Upload a filled-in template (CSV, 2 MB): every row is checked and reported; nothing is created until it is committed',
  tags,
  auth: 'members.onboard',
  request: uploadSchema,
  requestContentType: 'multipart/form-data',
  responses: { 201: { description: 'Row report', schema: uploadResultSchema } },
});
doc({
  id: 'IDN-050',
  method: 'get',
  path: '/api/v1/console/members/uploads/{uploadId}',
  summary: 'An upload with its row report',
  tags,
  auth: 'members.onboard',
  responses: { 200: { description: 'Row report', schema: uploadResultSchema } },
});
doc({
  id: 'IDN-051',
  method: 'post',
  path: '/api/v1/console/members/uploads/{uploadId}/commit',
  summary:
    'Onboard the rows in one transaction: all (only when none was rejected) or the accepted rows only',
  tags,
  auth: 'members.onboard',
  request: commitSchema,
  responses: { 200: { description: 'Committed', schema: commitResultSchema } },
});
doc({
  id: 'IDN-052',
  method: 'get',
  path: '/api/v1/console/members/uploads/templates/{kind}',
  summary:
    'The template (CSV): kind members has the admission form columns (client 2026-10-19), required ones marked *, staff the staff columns with each one’s console role — a role’s name, or None (client 2026-10-22); the institution fields follow as extra columns',
  tags,
  auth: 'members.onboard',
  responses: { 200: { description: 'Template', contentType: 'text/csv' } },
});
doc({
  id: 'IDN-053',
  method: 'post',
  path: '/api/v1/console/staff',
  summary:
    'Onboard staff (18 or older): a CampusOne account is created when the mobile has none, with a temporary password shown once in the answer (or e-mailed when idn.staff.passwordShownOnce is 0) and changed at first sign-in; employee ID EMP… when not given; the console role chosen is given with the profile (client 2026-10-22; needs members.roles)',
  tags,
  auth: 'members.onboard',
  request: staffSchema,
  responses: { 201: { description: 'Onboarded', schema: staffResultSchema } },
});
doc({
  id: 'IDN-054',
  method: 'post',
  path: '/api/v1/console/members/{memberId}/status-changes',
  summary:
    'Activate or deactivate (immediate), lift or request a suspension (reason; a checker decides unless an Institution Administrator applies it, ADR-0015); never delete (CR-08); sessions end when a member stops being Active',
  tags,
  auth: 'members.status',
  request: statusChangeSchema,
  responses: {
    200: { description: 'Changed', schema: statusResultSchema },
    202: { description: 'Waiting for a checker', schema: statusResultSchema },
  },
});
doc({
  id: 'IDN-087',
  method: 'get',
  path: '/api/v1/me/school-record',
  summary:
    'The member’s own school record, or a child’s (for): member and admission numbers, class, dates, status, guardians with masked mobiles and the school’s own fields that have a value',
  tags,
  auth: 'member',
  query: schoolRecordQuerySchema,
  responses: { 200: { description: 'School record' } },
});
doc({
  id: 'IDN-086',
  method: 'post',
  path: '/api/v1/console/members/{memberId}/session-ends',
  summary:
    'Sign the member out of the app on every device (a lost or shared phone), with a reason (setting `ins.lifecycle.reasonMinLength`); recorded in the audit log; the member can sign in again (security review S-02)',
  tags,
  auth: 'members.status',
  request: sessionEndSchema,
  responses: { 200: { description: 'Signed out', schema: sessionEndResultSchema } },
});
doc({
  id: 'IDN-055',
  method: 'post',
  path: '/api/v1/console/members/{memberId}/delink-requests',
  summary:
    'De-link a member (Inactive, unlinked from the account; the record stays) — a checker decides unless an Institution Administrator applies it',
  tags,
  auth: 'members.delink',
  request: delinkSchema,
  responses: {
    200: { description: 'De-linked', schema: delinkResultSchema },
    202: { description: 'Waiting for a checker', schema: delinkResultSchema },
  },
});
doc({
  id: 'IDN-058',
  method: 'get',
  path: '/api/v1/console/members/{memberId}/history',
  summary: 'What changed for the member, by whom and why (before and after)',
  tags,
  auth: 'members.view',
  responses: { 200: { description: 'History', schema: memberHistorySchema } },
});
doc({
  id: 'IDN-059',
  method: 'get',
  path: '/api/v1/console/search',
  summary: 'Console search: members by name, admission or employee number, or mobile',
  tags,
  auth: 'home.view',
  responses: { 200: { description: 'Results', schema: searchResultSchema } },
});
doc({
  id: 'ACA-001',
  method: 'get',
  path: '/api/v1/console/academic-years',
  summary:
    'Academic years, Open or Closed, with the current year flagged (RC-22); also readable with admissions.view (the counsellor’s screens)',
  tags: aca,
  auth: 'academics.view,admissions.view',
  responses: { 200: { description: 'Years', schema: yearsSchema } },
});
doc({
  id: 'ACA-002',
  method: 'post',
  path: '/api/v1/console/academic-years',
  summary:
    'Add a year (label 2026-27; dates never overlap another year); the first year becomes current',
  tags: aca,
  auth: 'academics.edit',
  request: yearInputSchema,
  responses: { 201: { description: 'Year', schema: yearSchema } },
});
doc({
  id: 'ACA-003',
  method: 'post',
  path: '/api/v1/console/academic-years/{yearId}/status',
  summary: 'Make an Open year current, or close a year (reason recorded)',
  tags: aca,
  auth: 'academics.year',
  request: yearActionSchema,
  responses: { 200: { description: 'Year', schema: yearSchema } },
});
doc({
  id: 'ACA-009',
  method: 'get',
  path: '/api/v1/console/classes',
  summary:
    'Classes in order with their sections and the students placed this year; also readable with admissions.view (the counsellor’s screens)',
  tags: aca,
  auth: 'academics.view,admissions.view',
  responses: { 200: { description: 'Classes', schema: classesSchema } },
});
doc({
  id: 'ACA-010',
  method: 'post',
  path: '/api/v1/console/classes',
  summary: 'Add a class with its sections (unique name)',
  tags: aca,
  auth: 'academics.edit',
  request: classInputSchema,
  responses: { 201: { description: 'Class', schema: classSchema } },
});
doc({
  id: 'ACA-011',
  method: 'patch',
  path: '/api/v1/console/classes/{classId}',
  summary:
    'Rename or reorder a class and set its sections (a section that held students is kept) — If-Match',
  tags: aca,
  auth: 'academics.edit',
  request: classUpdateSchema,
  responses: { 200: { description: 'Class', schema: classSchema } },
});
doc({
  id: 'ACA-012',
  method: 'post',
  path: '/api/v1/console/classes/{classId}/sections',
  summary: 'Add a section to a class',
  tags: aca,
  auth: 'academics.edit',
  request: sectionInputSchema,
  responses: { 201: { description: 'Class', schema: classSchema } },
});
doc({
  id: 'ACA-013',
  method: 'patch',
  path: '/api/v1/console/sections/{sectionId}',
  summary: 'Rename a section or change its capacity',
  tags: aca,
  auth: 'academics.edit',
  request: sectionInputSchema,
  responses: { 200: { description: 'Class', schema: classSchema } },
});

/** Mounted under /api/v1. Console sessions; the institution comes from the session. */
export function membersRoutes(deps: {
  db: Kysely<Database>;
  members: MembersService;
  uploads: MemberUploadsService;
  academics: AcademicsService;
  loggers: Loggers;
}): Router {
  const c = membersController(deps.members, deps.uploads, deps.academics);
  const router = Router();
  const L = deps.loggers;
  const con = [requireSurface(L, 'console'), requireTenant(L)];
  const can = (subTask: string) => authorize(subTask, L);
  const once = idempotency({ db: deps.db, mode: 'required' });

  router.get('/me/school-record', requireSurface(L, 'member'), c.schoolRecord);
  router.get('/console/members', ...con, can('members.view'), c.list);
  router.post('/console/members/eligibility', ...con, can('members.onboard'), c.eligibility);
  router.post(
    '/console/members/family-lookup',
    ...con,
    authorizeAny(['members.onboard', 'admissions.edit', 'admissions.approve'], L),
    c.familyLookup,
  );
  router.get(
    '/console/members/uploads/templates/:kind',
    ...con,
    can('members.onboard'),
    c.template,
  );
  router.post(
    '/console/members/uploads',
    ...con,
    can('members.onboard'),
    once,
    singleFileUpload,
    uploadErrors,
    c.upload,
  );
  router.get('/console/members/uploads/:uploadId', ...con, can('members.onboard'), c.uploadStatus);
  router.post(
    '/console/members/uploads/:uploadId/commit',
    ...con,
    can('members.onboard'),
    once,
    c.commit,
  );
  router.post('/console/members', ...con, can('members.onboard'), once, c.onboard);
  router.post('/console/staff', ...con, can('members.onboard'), once, c.staff);
  router.get('/console/members/:memberId', ...con, can('members.view'), c.detail);
  router.patch('/console/members/:memberId', ...con, can('members.edit'), c.update);
  router.post(
    '/console/members/:memberId/status-changes',
    ...con,
    can('members.status'),
    once,
    c.status,
  );
  router.post(
    '/console/members/:memberId/session-ends',
    ...con,
    can('members.status'),
    once,
    c.endSessions,
  );
  router.post(
    '/console/members/:memberId/delink-requests',
    ...con,
    can('members.delink'),
    once,
    c.delink,
  );
  router.get('/console/members/:memberId/history', ...con, can('members.view'), c.history);
  router.get('/console/search', ...con, can('home.view'), c.search);

  const lookup = authorizeAny(['academics.view', 'admissions.view'], L);
  router.get('/console/academic-years', ...con, lookup, c.years);
  router.post('/console/academic-years', ...con, can('academics.edit'), once, c.createYear);
  router.post(
    '/console/academic-years/:yearId/status',
    ...con,
    can('academics.year'),
    once,
    c.yearAction,
  );
  router.get('/console/classes', ...con, lookup, c.classes);
  router.post('/console/classes', ...con, can('academics.edit'), once, c.createClass);
  router.patch('/console/classes/:classId', ...con, can('academics.edit'), c.updateClass);
  router.post(
    '/console/classes/:classId/sections',
    ...con,
    can('academics.edit'),
    once,
    c.addSection,
  );
  router.patch('/console/sections/:sectionId', ...con, can('academics.edit'), c.updateSection);
  return router;
}
