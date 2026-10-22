/**
 * The rules a class teacher, a subject teacher and a lesson keep (SRS 20.7–20.8; BR-52; RNG-ACA-441,
 * RNG-ACA-443), shared by the manual screens (teaching.service.ts) and the sheets
 * (teaching-uploads.service.ts) so the two never drift apart. Pure: the callers load the year's state
 * and turn a problem into their own error (a refusal on a screen, a refused row in a sheet).
 */

export const DAYS = [
  { day: 1, label: 'Monday' },
  { day: 2, label: 'Tuesday' },
  { day: 3, label: 'Wednesday' },
  { day: 4, label: 'Thursday' },
  { day: 5, label: 'Friday' },
  { day: 6, label: 'Saturday' },
] as const;

/** The user-type categories a class, a subject or a lesson can be given to. */
export const TEACHING_CATEGORIES = ['TEACHER', 'PRINCIPAL'] as const;

/** A refusal: a register key and its placeholders. */
export interface Problem {
  readonly code: string;
  readonly params?: Readonly<Record<string, string>>;
}

/** An active teacher or principal of the institution. */
export const isTeaching = (m: { readonly status: string; readonly category: string }) =>
  m.status === 'ACTIVE' && (TEACHING_CATEGORIES as readonly string[]).includes(m.category);

/** A live class-teacher assignment of the year. */
export interface LiveClassTeacher {
  readonly sectionId: string;
  readonly sectionLabel: string;
  readonly teacherId: string;
  readonly teacherName: string;
}

/**
 * Giving `section` to `teacher` for the year: a section's class teacher is replaced only when asked
 * (the old one is kept as history), and a teacher leads one class-section a year (client 2026-10-14),
 * also when replacing someone.
 */
export function classTeacherProblem(
  live: readonly LiveClassTeacher[],
  section: { readonly id: string; readonly label: string },
  teacher: { readonly id: string; readonly name: string },
  year: string,
  replace: boolean,
): Problem | null {
  const cur = live.find((a) => a.sectionId === section.id);
  if (cur && !replace) {
    return {
      code: 'ACA.CLASS_TEACHER_TAKEN',
      params: { section: section.label, year, name: cur.teacherName },
    };
  }
  const theirs = live.find((a) => a.teacherId === teacher.id && a.sectionId !== section.id);
  return theirs ? oneClassProblem(teacher.name, theirs.sectionLabel, year) : null;
}

/** A teacher who would lead a second class-section in the year. */
export const oneClassProblem = (name: string, section: string, year: string): Problem => ({
  code: 'ACA.CLASS_TEACHER_ONE_CLASS',
  params: { name, section, year },
});

/** A subject is taught only in a class it is mapped to. */
export const subjectNotMapped = (subject: string, className: string): Problem => ({
  code: 'ACA.SUBJECT_NOT_MAPPED',
  params: { subject, class: className },
});

/** What a section's week is checked against. */
export interface LessonContext {
  readonly section: { readonly label: string; readonly className: string };
  /** The bell schedule, by period id. */
  readonly periods: ReadonlyMap<string, { readonly isBreak: boolean }>;
  /** The subjects mapped to the section's class, by subject id. */
  readonly subjects: ReadonlyMap<string, { readonly name: string }>;
  /** The section's live subject teachers, as `subjectId:teacherId`. */
  readonly assigned: ReadonlySet<string>;
}

/**
 * One lesson of a section's week: a school day, a teaching period (never a break), one lesson per
 * day and period (`seen` collects the cells used so far), a subject of the class, taught by a teacher
 * assigned to it there. A teacher in two places in one period is checked by the caller against the
 * whole year.
 */
export function lessonProblem(
  ctx: LessonContext,
  x: {
    readonly day: number;
    readonly periodId: string | null;
    readonly subjectId: string | null;
    readonly teacherId: string | null;
    /** The subject as the caller knows it, for the "not mapped" refusal. */
    readonly subjectName?: string;
  },
  seen: Set<string>,
): Problem | null {
  if (!DAYS.some((d) => d.day === x.day)) return { code: 'VALIDATION.FORMAT' };
  const pd = x.periodId ? ctx.periods.get(x.periodId) : undefined;
  if (!pd) return { code: 'VALIDATION.FORMAT' };
  if (pd.isBreak) return { code: 'ACA.BREAK_PERIOD' };
  const cell = `${x.day}:${x.periodId}`;
  if (seen.has(cell)) return { code: 'ACA.ROW_REPEATED' };
  seen.add(cell);
  const sub = x.subjectId ? ctx.subjects.get(x.subjectId) : undefined;
  if (!sub) return subjectNotMapped(x.subjectName ?? '', ctx.section.className);
  if (!x.teacherId || !ctx.assigned.has(`${x.subjectId}:${x.teacherId}`)) {
    return {
      code: 'ACA.TEACHER_NOT_ASSIGNED',
      params: { subject: sub.name, section: ctx.section.label },
    };
  }
  return null;
}
