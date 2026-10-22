/**
 * The rules shared by the teacher-assignment and timetable screens and their sheets (SRS 20.7–20.8;
 * BR-52; RNG-ACA-441, RNG-ACA-443; client 2026-10-14 and 2026-10-21).
 */
import {
  classTeacherProblem,
  isTeaching,
  lessonProblem,
  type LessonContext,
  type LiveClassTeacher,
} from '../services/teaching-rules';

const live: LiveClassTeacher[] = [
  { sectionId: '1', sectionLabel: 'Grade 7 A', teacherId: '10', teacherName: 'Meena' },
];
const ravi = { id: '11', name: 'Ravi' };

describe('class teachers', () => {
  it('keeps a section’s class teacher unless asked to replace them', () => {
    expect(
      classTeacherProblem(live, { id: '1', label: 'Grade 7 A' }, ravi, '2026-27', false),
    ).toEqual({
      code: 'ACA.CLASS_TEACHER_TAKEN',
      params: { section: 'Grade 7 A', year: '2026-27', name: 'Meena' },
    });
    expect(
      classTeacherProblem(live, { id: '1', label: 'Grade 7 A' }, ravi, '2026-27', true),
    ).toBeNull();
  });

  it('gives a teacher one class-section a year, also when replacing someone', () => {
    const meena = { id: '10', name: 'Meena' };
    expect(
      classTeacherProblem(live, { id: '2', label: 'Grade 7 B' }, meena, '2026-27', true),
    ).toEqual({
      code: 'ACA.CLASS_TEACHER_ONE_CLASS',
      params: { name: 'Meena', section: 'Grade 7 A', year: '2026-27' },
    });
    expect(
      classTeacherProblem(live, { id: '2', label: 'Grade 7 B' }, ravi, '2026-27', false),
    ).toBeNull();
  });

  it('counts only active teachers and principals', () => {
    expect(isTeaching({ status: 'ACTIVE', category: 'TEACHER' })).toBe(true);
    expect(isTeaching({ status: 'ACTIVE', category: 'PRINCIPAL' })).toBe(true);
    expect(isTeaching({ status: 'INACTIVE', category: 'TEACHER' })).toBe(false);
    expect(isTeaching({ status: 'ACTIVE', category: 'STUDENT' })).toBe(false);
  });
});

describe('lessons', () => {
  const ctx: LessonContext = {
    section: { label: 'Grade 7 A', className: 'Grade 7' },
    periods: new Map([
      ['p1', { isBreak: false }],
      ['brk', { isBreak: true }],
    ]),
    subjects: new Map([['math', { name: 'Mathematics' }]]),
    assigned: new Set(['math:10']),
  };
  const lesson = { day: 1, periodId: 'p1', subjectId: 'math', teacherId: '10' };

  it('accepts a mapped subject taught by its assigned teacher, once per day and period', () => {
    const seen = new Set<string>();
    expect(lessonProblem(ctx, lesson, seen)).toBeNull();
    expect(lessonProblem(ctx, lesson, seen)).toEqual({ code: 'ACA.ROW_REPEATED' });
    expect(lessonProblem(ctx, { ...lesson, day: 2 }, seen)).toBeNull();
  });

  it('refuses a day off the week, an unknown period and a break', () => {
    expect(lessonProblem(ctx, { ...lesson, day: 7 }, new Set())).toEqual({
      code: 'VALIDATION.FORMAT',
    });
    expect(lessonProblem(ctx, { ...lesson, periodId: null }, new Set())).toEqual({
      code: 'VALIDATION.FORMAT',
    });
    expect(lessonProblem(ctx, { ...lesson, periodId: 'brk' }, new Set())).toEqual({
      code: 'ACA.BREAK_PERIOD',
    });
  });

  it('refuses a subject the class doesn’t study, and a teacher not assigned to it there', () => {
    expect(
      lessonProblem(ctx, { ...lesson, subjectId: 'eng', subjectName: 'English' }, new Set()),
    ).toEqual({ code: 'ACA.SUBJECT_NOT_MAPPED', params: { subject: 'English', class: 'Grade 7' } });
    expect(lessonProblem(ctx, { ...lesson, subjectId: null }, new Set())).toEqual({
      code: 'ACA.SUBJECT_NOT_MAPPED',
      params: { subject: '', class: 'Grade 7' },
    });
    expect(lessonProblem(ctx, { ...lesson, teacherId: '11' }, new Set())).toEqual({
      code: 'ACA.TEACHER_NOT_ASSIGNED',
      params: { subject: 'Mathematics', section: 'Grade 7 A' },
    });
  });
});
