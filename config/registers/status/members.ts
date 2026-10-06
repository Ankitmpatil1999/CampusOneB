/**
 * Member and academic-year statuses (RC-01, RC-22; CR-08, CR-13). Members are never deleted: they
 * are Active, Inactive or Suspended, and sessions end when a member stops being Active
 * (RNG-IDN-400). An academic year is Open or Closed, and one year per institution is designated
 * current.
 */
import { NEW, type StatusDomain } from './types';

export type MemberStatus = 'ACTIVE' | 'INACTIVE' | 'SUSPENDED';

/** RC-01: institution profile status (27.2 "1 / 0" → three values). */
export const MEMBER_PROFILE: StatusDomain<MemberStatus> = {
  domain: 'member_profile',
  srsDomain: 'Institution profile (status)',
  rc: 'RC-01',
  values: [
    {
      code: 'ACTIVE',
      registerValue: '1',
      labelKey: 'status.member_profile.active',
      label: 'Active',
      tone: 'ok',
      terminal: false,
    },
    {
      code: 'INACTIVE',
      registerValue: '0',
      labelKey: 'status.member_profile.inactive',
      label: 'Inactive',
      tone: 'neutral',
      terminal: false,
    },
    {
      code: 'SUSPENDED',
      registerValue: null,
      labelKey: 'status.member_profile.suspended',
      label: 'Suspended',
      tone: 'bad',
      terminal: false,
    },
  ],
  transitions: [
    { from: NEW, to: 'ACTIVE', operation: 'member onboarded (single, sheet or staff)' },
    { from: 'ACTIVE', to: 'INACTIVE', operation: 'deactivate, or a de-link approved' },
    { from: 'INACTIVE', to: 'ACTIVE', operation: 'activate' },
    { from: 'ACTIVE', to: 'SUSPENDED', operation: 'suspend with a reason (maker-checker)' },
    { from: 'SUSPENDED', to: 'ACTIVE', operation: 'lift the suspension' },
    { from: 'SUSPENDED', to: 'INACTIVE', operation: 'deactivate' },
  ],
};

export type AcademicYearStatus = 'OPEN' | 'CLOSED';

/** RC-22: academic year Open · Closed, plus one current year per institution. */
export const ACADEMIC_YEAR: StatusDomain<AcademicYearStatus> = {
  domain: 'academic_year',
  srsDomain: 'Academic year (status)',
  rc: 'RC-22',
  values: [
    {
      code: 'OPEN',
      registerValue: '1',
      labelKey: 'status.academic_year.open',
      label: 'Open',
      tone: 'ok',
      terminal: false,
    },
    {
      code: 'CLOSED',
      registerValue: '0',
      labelKey: 'status.academic_year.closed',
      label: 'Closed',
      tone: 'neutral',
      terminal: true,
    },
  ],
  transitions: [
    { from: NEW, to: 'OPEN', operation: 'Institution Administrator adds the year' },
    { from: 'OPEN', to: 'CLOSED', operation: 'Institution Administrator closes the year' },
  ],
};
