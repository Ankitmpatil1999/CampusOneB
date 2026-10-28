/**
 * Notification events (client 2026-10-16: "Email trigger configuration as in the old application").
 *
 * The earlier application had one template per event (TUTION_FEE_ASSIGNED, FEE_ALERT,
 * ATTENDANCE_ALERT, HOMEWORK_ALERT, TRANSPORT_ALERT, MARKSHEET_ALERT, ANNOUNCEMENT_ALERT,
 * DIRECT_MESSAGE, STUDENT_CLASS_ALLOCATED) sent to the student and the parent, and per-school channel
 * switches. Here every in-app notice belongs to one event; for each event a school chooses whether it
 * is also e-mailed and whether it raises the phone alert (client: every event on by default). The
 * in-app notice itself is always kept.
 */
import type { MessageKey } from './index';

export type CommEventKey =
  | 'FEE_ASSIGNED'
  | 'FEE_DUE'
  | 'ATTENDANCE'
  | 'HOMEWORK'
  | 'RESULTS'
  | 'CLASS'
  | 'TRANSPORT'
  | 'BUS_NEAR'
  | 'BUS_TODAY'
  | 'CHECK_IN_OUT'
  | 'FEE_PAID'
  | 'TEACHING'
  | 'PASSES'
  | 'SETTLEMENTS'
  | 'LEAVE'
  | 'ANNOUNCEMENT'
  | 'MESSAGE'
  | 'WALLET_CREDIT'
  | 'PAYMENTS'
  | 'CARDS'
  | 'TICKETS'
  | 'APPROVALS'
  | 'STAFF_WORK';

export interface CommEventDefinition {
  readonly key: CommEventKey;
  readonly label: string;
  /** Who gets it, as the settings page says. */
  readonly description: string;
  /** The in-app notices (title keys) that belong to it. */
  readonly titles: readonly MessageKey[];
  readonly emailByDefault: boolean;
  readonly alertByDefault: boolean;
}

const ev = (
  key: CommEventKey,
  label: string,
  description: string,
  titles: readonly MessageKey[],
): CommEventDefinition => ({
  key,
  label,
  description,
  titles,
  emailByDefault: true,
  alertByDefault: true,
});

export const COMM_EVENTS: readonly CommEventDefinition[] = [
  ev(
    'FEE_ASSIGNED',
    'Fee assigned',
    'A student’s fee for the year is set: the student and parents',
    ['NTF.FEE_ASSIGNED'],
  ),
  // The payment link of "Collect fees · Send link" (client 2026-10-22) is a call to pay a fee due: it
  // goes by SMS and e-mail from the desk's action itself; the event switches its phone alert.
  ev(
    'FEE_DUE',
    'Fee due reminder',
    'A fee is due — a reminder before the due date, or a payment link from the school: the student and parents',
    ['NTF.FEE_DUE', 'NTF.FEE_PAY_LINK', 'NTF.ADMISSION_PAY_LINK'],
  ),
  ev('ATTENDANCE', 'Absent', 'A student is marked absent: the student and parents', ['NTF.ABSENT']),
  // Client 2026-10-22: a check-in or check-out at the gate, the front desk or the teacher's reader.
  {
    ...ev(
      'CHECK_IN_OUT',
      'Checked in or out',
      'A card tap or the front desk checks someone in or out: the person and, for a student, the parents',
      ['NTF.CHECKED_IN', 'NTF.CHECKED_OUT'],
    ),
    emailByDefault: false,
  },
  ev(
    'FEE_PAID',
    'Fee received or changed',
    'A fee payment is taken, or a fee’s amount or due date is changed: the student and parents',
    ['NTF.FEE_RECEIVED', 'NTF.FEE_CHANGED'],
  ),
  ev(
    'TEACHING',
    'Teaching assignments',
    'A teacher is given or loses a class, subject or co-ordination: the teacher',
    ['NTF.TEACHING_ASSIGNED', 'NTF.TEACHING_ENDED'],
  ),
  ev(
    'PASSES',
    'Passes and coupons',
    'A pass or coupons are issued or cancelled: the holder and parents',
    ['NTF.PASS_ISSUED', 'NTF.PASS_CANCELLED', 'NTF.COUPONS_ISSUED', 'NTF.COUPONS_CANCELLED'],
  ),
  ev('SETTLEMENTS', 'Settlement paid', 'The school paid a merchant’s settlement: the merchant', [
    'NTF.SETTLEMENT_PAID',
  ]),
  ev(
    'HOMEWORK',
    'Homework and classwork',
    'Set, reminded or reviewed: the student and parents; submitted: the teacher',
    [
      'NTF.HOMEWORK_SET',
      'NTF.HOMEWORK_REMINDER',
      'NTF.HOMEWORK_REVIEWED',
      'NTF.HOMEWORK_SUBMITTED',
    ],
  ),
  ev('RESULTS', 'Exam results', 'Results are published: the student and parents', [
    'NTF.RESULTS_PUBLISHED',
  ]),
  ev(
    'CLASS',
    'Class allocation',
    'A student is placed in a class: the student and parents, and the class teacher',
    ['NTF.CLASS_PLACED', 'NTF.CLASS_STUDENT_ADDED'],
  ),
  ev(
    'TRANSPORT',
    'Transport',
    'Bus allocated or ended, trip started or cancelled: the passengers and parents',
    ['NTF.TRANSPORT_ALLOCATED', 'NTF.TRANSPORT_ENDED', 'NTF.TRIP_STARTED', 'NTF.TRIP_CANCELLED'],
  ),
  // Live tracking (client 2026-10-21/22): an e-mail would arrive after the bus has gone, so it is
  // off by default (the school can turn it on); the phone alert is on.
  {
    ...ev(
      'BUS_NEAR',
      'Bus on the way',
      'The bus is near or at a passenger’s stop, or its trip is complete: the passengers and parents',
      ['NTF.BUS_NEAR_STOP', 'NTF.BUS_AT_STOP', 'NTF.TRIP_COMPLETED'],
    ),
    emailByDefault: false,
  },
  // Client 2026-10-22: every school day, the day's bus, times and crew; daily, so no e-mail by default.
  {
    ...ev(
      'BUS_TODAY',
      'Today’s bus',
      'Each morning, the day’s pick-up and drop times, bus and driver: the passengers and parents',
      ['NTF.TRANSPORT_TODAY'],
    ),
    emailByDefault: false,
  },
  ev('LEAVE', 'Leave', 'Leave requested, reviewed or decided: the people concerned', [
    'NTF.LEAVE_REQUESTED',
    'NTF.LEAVE_FOR_DECISION',
    'NTF.LEAVE_REVIEWED',
    'NTF.LEAVE_DECIDED',
    'NTF.LEAVE_WITHDRAWN',
  ]),
  ev(
    'ANNOUNCEMENT',
    'Announcements',
    'Announcements and their reminders: their audience (e-mail when the announcement chose it)',
    ['NTF.ANNOUNCEMENT', 'NTF.ANNOUNCEMENT_REMINDER'],
  ),
  ev('MESSAGE', 'Direct messages', 'A message from a teacher or a parent: the receiver', [
    'NTF.DIRECT_MESSAGE',
  ]),
  ev(
    'WALLET_CREDIT',
    'Money added',
    'Bank transfers, refunds and allowances into a wallet: the holder and parents',
    [
      'NTF.MONEY_ADDED',
      'NTF.WARD_MONEY_ADDED',
      'NTF.CREDIT_HELD',
      'NTF.REFUND_PROCESSED',
      'NTF.ALLOWANCE_CREDITED',
      'NTF.ALLOWANCE_EXPIRED',
    ],
  ),
  ev(
    'PAYMENTS',
    'Payments and transfers',
    'Each payment or transfer: the payer, payee and parents',
    [
      'NTF.PAYMENT_SENT',
      'NTF.PAYMENT_RECEIVED',
      'NTF.TRANSFER_SENT',
      'NTF.TRANSFER_RECEIVED',
      'NTF.WARD_PAYMENT',
      'NTF.WARD_TRANSFER',
    ],
  ),
  ev('CARDS', 'Card blocked or active', 'A card is blocked or made active again: its holder', [
    'NTF.CARD_ACTIVE',
    'NTF.CARD_BLOCKED',
  ]),
  ev(
    'TICKETS',
    'Support tickets',
    'A ticket is raised: the support desk; updated: the person who raised it',
    ['NTF.TICKET_RAISED', 'NTF.TICKET_UPDATED'],
  ),
  ev(
    'APPROVALS',
    'Approvals',
    'A request waits for approval, or was decided: the approver or the requester',
    [
      'NTF.APPROVAL_RAISED',
      'NTF.APPROVAL_APPROVED',
      'NTF.APPROVAL_REJECTED',
      'NTF.CORRECTION_APPROVED',
      'NTF.CORRECTION_REJECTED',
    ],
  ),
  // Client 2026-10-19: the staff app's notices (Accounts, Co-ordinator, Counsellor).
  ev(
    'STAFF_WORK',
    'Staff work',
    'An application submitted or ready for approval, an admission or school fee paid: the staff who handle it',
    [
      'NTF.ADMISSION_SUBMITTED',
      'NTF.ADMISSION_FEE_PAID',
      'NTF.ADMISSION_READY',
      'NTF.FEE_PAID_ONLINE',
    ],
  ),
];

const BY_TITLE = new Map<string, CommEventDefinition>(
  COMM_EVENTS.flatMap((e) => e.titles.map((t) => [t, e] as const)),
);

/** The event an in-app notice belongs to (every NTF.* key has one; a test keeps it so). */
export function commEventOf(titleKey: string): CommEventDefinition | undefined {
  return BY_TITLE.get(titleKey);
}

export function commEvent(key: string): CommEventDefinition | undefined {
  return COMM_EVENTS.find((e) => e.key === key);
}
