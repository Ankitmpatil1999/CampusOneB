/**
 * The year roll-over (SRS 20.40.1; RC-23; RNG-ACA-451…455; OI-ACA-59 proposal). A roll-over is
 * proposed from the class order, amended per student, then committed as a whole; each student's
 * outcome is promoted, repeated or left — a leaver is recorded, never deleted.
 */
import { NEW, type StatusDomain } from './types';

export const ROLLOVER: StatusDomain<'PROPOSED' | 'COMMITTED'> = {
  domain: 'rollover',
  srsDomain: null,
  rc: 'RC-23',
  values: [
    {
      code: 'PROPOSED',
      registerValue: null,
      labelKey: 'status.rollover.proposed',
      label: 'Proposed',
      tone: 'warn',
      terminal: false,
    },
    {
      code: 'COMMITTED',
      registerValue: null,
      labelKey: 'status.rollover.committed',
      label: 'Committed',
      tone: 'ok',
      terminal: true,
    },
  ],
  transitions: [
    {
      from: NEW,
      to: 'PROPOSED',
      operation: 'the roll-over proposal is drawn from the class order (ACA-031)',
    },
    {
      from: 'PROPOSED',
      to: 'COMMITTED',
      operation: 'committed as a whole into the next year (ACA-033)',
    },
  ],
};

export const ROLLOVER_OUTCOME: StatusDomain<'PROMOTED' | 'REPEATED' | 'LEFT'> = {
  domain: 'rollover_outcome',
  srsDomain: null,
  rc: 'RC-23',
  values: [
    {
      code: 'PROMOTED',
      registerValue: null,
      labelKey: 'status.rolloverOutcome.promoted',
      label: 'Promoted',
      tone: 'ok',
      terminal: true,
    },
    {
      code: 'REPEATED',
      registerValue: null,
      labelKey: 'status.rolloverOutcome.repeated',
      label: 'Repeated',
      tone: 'warn',
      terminal: true,
    },
    {
      code: 'LEFT',
      registerValue: null,
      labelKey: 'status.rolloverOutcome.left',
      label: 'Left',
      tone: 'neutral',
      terminal: true,
    },
  ],
  transitions: [
    { from: NEW, to: 'PROMOTED', operation: 'the roll-over moves the student to the next class' },
    { from: NEW, to: 'REPEATED', operation: 'the student repeats the class (an amendment)' },
    {
      from: NEW,
      to: 'LEFT',
      operation: 'the student leaves: no class in the new year, kept on record (an amendment)',
    },
  ],
};

/**
 * A student's mark (27.2 adopted CREATED · VALID; RC-37 adds VALID → CREATED): saved marks are Created,
 * validated or published marks are Valid, and editing a Valid mark returns it to Created until it is
 * validated again (prototype m.t.marks).
 */
export const MARK: StatusDomain<'CREATED' | 'VALID'> = {
  domain: 'mark',
  srsDomain: 'Student mark',
  rc: 'RC-37',
  values: [
    {
      code: 'CREATED',
      registerValue: 'CREATED',
      labelKey: 'status.mark.created',
      label: 'Created',
      tone: 'warn',
      terminal: false,
    },
    {
      code: 'VALID',
      registerValue: 'VALID',
      labelKey: 'status.mark.valid',
      label: 'Valid',
      tone: 'ok',
      terminal: false,
    },
  ],
  transitions: [
    { from: NEW, to: 'CREATED', operation: 'the teacher saves the marks grid (ACA-053)' },
    {
      from: 'CREATED',
      to: 'VALID',
      operation: 'validated by the coordinator (ACA-040) or the teacher publishing (ACA-054)',
    },
    { from: 'VALID', to: 'CREATED', operation: 'the teacher changes a validated mark (ACA-053)' },
  ],
};

/**
 * A student's homework record (27.2 "Assignment-student record", adopted): New when the homework is set
 * for the student, Done when they submit. Seen stays in the register; no screen sets it (27.3).
 * The student sees Pending (Overdue once the due time has passed) or Submitted.
 */
export const HOMEWORK_STUDENT: StatusDomain<'NEW' | 'SEEN' | 'DONE'> = {
  domain: 'homework_student',
  srsDomain: 'Assignment-student record',
  rc: null,
  values: [
    {
      code: 'NEW',
      registerValue: 'NEW',
      labelKey: 'status.homeworkStudent.new',
      label: 'Pending',
      tone: 'warn',
      terminal: false,
    },
    {
      code: 'SEEN',
      registerValue: 'SEEN',
      labelKey: 'status.homeworkStudent.seen',
      label: 'Seen',
      tone: 'info',
      terminal: false,
    },
    {
      code: 'DONE',
      registerValue: 'DONE',
      labelKey: 'status.homeworkStudent.done',
      label: 'Submitted',
      tone: 'ok',
      terminal: true,
    },
  ],
  transitions: [
    {
      from: NEW,
      to: 'NEW',
      operation: 'the teacher sets homework for the whole class or chosen students (ACA-049)',
    },
    { from: 'NEW', to: 'DONE', operation: 'the student submits (ACA-069)' },
    {
      from: 'NEW',
      to: 'SEEN',
      operation: 'the status update (API level only; no screen calls it)',
    },
  ],
};

/** A homework submission (27.2 "Assignment submission", adopted): Submitted, then Reviewed with a grade. */
export const SUBMISSION: StatusDomain<'SUBMITTED' | 'REVIEWED'> = {
  domain: 'homework_submission',
  srsDomain: 'Assignment submission',
  rc: null,
  values: [
    {
      code: 'SUBMITTED',
      registerValue: 'submitted',
      labelKey: 'status.submission.submitted',
      label: 'Submitted',
      tone: 'info',
      terminal: false,
    },
    {
      code: 'REVIEWED',
      registerValue: 'reviewed',
      labelKey: 'status.submission.reviewed',
      label: 'Reviewed',
      tone: 'ok',
      terminal: false,
    },
  ],
  transitions: [
    { from: NEW, to: 'SUBMITTED', operation: 'the student submits a file or a link (ACA-069)' },
    {
      from: 'SUBMITTED',
      to: 'REVIEWED',
      operation: 'the teacher records a grade and feedback (ACA-051)',
    },
    {
      from: 'REVIEWED',
      to: 'REVIEWED',
      operation: 'the teacher reviews again; the grade and feedback are replaced (ACA-051)',
    },
  ],
};

/** A student's leave request (27.2, adopted; withdrawal offered while pending, OI-ACA-45). */
export const STUDENT_LEAVE: StatusDomain<'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED'> = {
  domain: 'student_leave',
  srsDomain: 'Student leave request',
  rc: null,
  values: [
    {
      code: 'PENDING',
      registerValue: 'PENDING',
      labelKey: 'status.studentLeave.pending',
      label: 'Pending',
      tone: 'warn',
      terminal: false,
    },
    {
      code: 'APPROVED',
      registerValue: 'APPROVED',
      labelKey: 'status.studentLeave.approved',
      label: 'Approved',
      tone: 'ok',
      terminal: true,
    },
    {
      code: 'REJECTED',
      registerValue: 'REJECTED',
      labelKey: 'status.studentLeave.rejected',
      label: 'Rejected',
      tone: 'bad',
      terminal: true,
    },
    {
      code: 'CANCELLED',
      registerValue: 'CANCELLED',
      labelKey: 'status.studentLeave.cancelled',
      label: 'Withdrawn',
      tone: 'neutral',
      terminal: true,
    },
  ],
  transitions: [
    {
      from: NEW,
      to: 'PENDING',
      operation: 'the student or a guardian applies (ACA-073); the class teacher is told',
    },
    {
      from: 'PENDING',
      to: 'APPROVED',
      operation: 'the class teacher approves (ACA-056); the family is told',
    },
    {
      from: 'PENDING',
      to: 'REJECTED',
      operation: 'the class teacher rejects with remarks (ACA-056); the family is told',
    },
    {
      from: 'PENDING',
      to: 'CANCELLED',
      operation: 'the student or a guardian withdraws it (ACA-074)',
    },
  ],
};

/** A staff leave request's coordinator status (27.2, adopted; unset until the coordinator decides). */
export const STAFF_LEAVE_COORDINATOR: StatusDomain<'APPROVED' | 'REJECTED'> = {
  domain: 'staff_leave_coordinator',
  srsDomain: 'Teacher leave request (coordinator status)',
  rc: null,
  values: [
    {
      code: 'APPROVED',
      registerValue: 'APPROVED',
      labelKey: 'status.staffLeaveCoordinator.approved',
      label: 'Recommended',
      tone: 'info',
      terminal: true,
    },
    {
      code: 'REJECTED',
      registerValue: 'REJECTED',
      labelKey: 'status.staffLeaveCoordinator.rejected',
      label: 'Rejected by the coordinator',
      tone: 'bad',
      terminal: true,
    },
  ],
  transitions: [
    { from: NEW, to: 'APPROVED', operation: 'the academic coordinator recommends (ACA-043)' },
    {
      from: NEW,
      to: 'REJECTED',
      operation: 'the academic coordinator rejects with feedback (ACA-043)',
    },
  ],
};

/** A staff leave request's final status (27.2, adopted; the principal after the coordinator, OI-ACA-51). */
export const STAFF_LEAVE: StatusDomain<'APPROVED' | 'REJECTED' | 'CANCELLED'> = {
  domain: 'staff_leave',
  srsDomain: 'Teacher leave request (final status)',
  rc: null,
  values: [
    {
      code: 'APPROVED',
      registerValue: 'APPROVED',
      labelKey: 'status.staffLeave.approved',
      label: 'Approved',
      tone: 'ok',
      terminal: true,
    },
    {
      code: 'REJECTED',
      registerValue: 'REJECTED',
      labelKey: 'status.staffLeave.rejected',
      label: 'Rejected',
      tone: 'bad',
      terminal: true,
    },
    {
      code: 'CANCELLED',
      registerValue: 'CANCELLED',
      labelKey: 'status.staffLeave.cancelled',
      label: 'Cancelled',
      tone: 'neutral',
      terminal: true,
    },
  ],
  transitions: [
    {
      from: NEW,
      to: 'APPROVED',
      operation: 'the principal approves after the coordinator recommended (ACA-062)',
    },
    {
      from: NEW,
      to: 'REJECTED',
      operation: 'the principal rejects with a reason after the coordinator recommended (ACA-062)',
    },
    {
      from: NEW,
      to: 'CANCELLED',
      operation: 'the staff member cancels a request no one has reviewed (ACA-059)',
    },
  ],
};

export const TEACHING_DOMAINS = [
  ROLLOVER,
  ROLLOVER_OUTCOME,
  MARK,
  HOMEWORK_STUDENT,
  SUBMISSION,
  STUDENT_LEAVE,
  STAFF_LEAVE_COORDINATOR,
  STAFF_LEAVE,
] as const;
