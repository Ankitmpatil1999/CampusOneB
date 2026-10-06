/**
 * Academic structure in the console (20.2, 20.4; ACA-001…003, ACA-009…013; prototype c.structure
 * "Classes & sections" and the year picker; RC-22, CR-13). Years never overlap; one Open year is
 * current and a Closed year accepts no new placements. Classes keep their order; a section that
 * ever held a student is kept.
 */
import type { Kysely } from 'kysely';
import { ACADEMIC_YEAR, LIMITS } from '../config/registers';
import type { Database } from '../models/ringpe_models';
import { academicsRepository as repo } from '../repositories/academics.repository';
import { institutionsRepository } from '../repositories/institutions.repository';
import {
  CustomAPIError,
  NotFoundError,
  PreconditionFailedError,
  ValidationError,
} from '../utils/CustomAPIError';
import { binToUuid, isUuid, newPublicIdPair, uuidToBin } from '../utils/idGenerator';
import type { Principal } from '../utils/principal';
import { recordAudit } from './audit.service';
import { dateOnly } from './billing.service';
import { defaultValues, type SettingValues } from './settings.service';

const YEAR_LABEL = Object.fromEntries(ACADEMIC_YEAR.values.map((v) => [v.code, v.label]));

/** "2026-27" for a year starting in 2026. */
export const yearLabel = (startYear: number) =>
  `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;

/** The Indian school year (April–March) that contains `date`. */
export function schoolYearOf(date: string) {
  const y = Number(date.slice(0, 4));
  const start = Number(date.slice(5, 7)) >= 4 ? y : y - 1;
  return {
    label: yearLabel(start),
    startsOn: `${start}-04-01`,
    endsOn: `${start + 1}-03-31`,
  };
}

export interface SectionInput {
  readonly id?: string | undefined;
  readonly name: string;
  readonly capacity?: number | null | undefined;
}

export class AcademicsService {
  constructor(
    private readonly deps: {
      readonly db: Kysely<Database>;
      readonly settings?: { values(): Promise<SettingValues> };
    },
  ) {}

  private async limit(l: { key: string; value: number }) {
    const v = this.deps.settings ? await this.deps.settings.values() : defaultValues();
    return v[l.key] ?? l.value;
  }

  private async own(p: Principal, db: Kysely<Database> = this.deps.db, lock = false) {
    if (!p.institutionId || !isUuid(p.institutionId)) throw new NotFoundError();
    const row = await institutionsRepository.byPublicId(db, uuidToBin(p.institutionId), lock);
    if (!row) throw new NotFoundError();
    return row;
  }

  private by(p: Principal) {
    return isUuid(p.subject) ? uuidToBin(p.subject) : null;
  }

  // --- ACA-001 … ACA-003: academic years -----------------------------------------------------------
  async years(p: Principal) {
    const inst = await this.own(p);
    const rows = await repo.years(this.deps.db, inst.id);
    return {
      items: rows.map((y) => ({
        id: binToUuid(y.public_id),
        label: y.label,
        startsOn: dateOnly(y.starts_on)!,
        endsOn: dateOnly(y.ends_on)!,
        status: y.status,
        current: Boolean(Number(y.is_current)),
        version: y.row_version,
      })),
    };
  }

  async createYear(p: Principal, input: { label: string; startsOn: string; endsOn: string }) {
    if (!/^\d{4}-\d{2}$/.test(input.label)) {
      throw new ValidationError([{ field: 'label', code: 'VALIDATION.FORMAT' }]);
    }
    if (input.endsOn <= input.startsOn) {
      throw new ValidationError([{ field: 'endsOn', code: 'VALIDATION.RANGE' }]);
    }
    const pub = newPublicIdPair();
    await this.deps.db.transaction().execute(async (trx) => {
      const inst = await this.own(p, trx, true);
      if ((await repo.years(trx, inst.id)).some((y) => y.label === input.label)) {
        throw new CustomAPIError(409, 'ACA.YEAR_TAKEN', { params: { label: input.label } });
      }
      const clash = await repo.overlapping(trx, inst.id, input.startsOn, input.endsOn);
      if (clash[0]) {
        throw new CustomAPIError(409, 'ACA.YEAR_OVERLAP', { params: { label: clash[0].label } });
      }
      const hasCurrent = Boolean(await repo.currentYear(trx, inst.id));
      await repo.insertYear(trx, {
        publicId: pub.bin,
        institutionId: inst.id,
        label: input.label,
        startsOn: input.startsOn,
        endsOn: input.endsOn,
        current: !hasCurrent,
      });
      await recordAudit(trx, {
        institutionId: inst.id,
        action: 'ACADEMIC_YEAR_CREATED',
        entityType: 'academic_year',
        entityRef: pub.id,
        after: input,
      });
    });
    return (await this.years(p)).items.find((y) => y.id === pub.id)!;
  }

  async yearAction(
    p: Principal,
    yearId: string,
    input: { action: 'MAKE_CURRENT' | 'CLOSE'; reason: string },
  ) {
    if (!isUuid(yearId)) throw new NotFoundError();
    const min = await this.limit(LIMITS.lifecycleReasonMinLength);
    if (input.reason.trim().length < min) {
      throw new ValidationError([
        { field: 'reason', code: 'IDN.REASON_TOO_SHORT', params: { min } },
      ]);
    }
    await this.deps.db.transaction().execute(async (trx) => {
      const inst = await this.own(p, trx, true);
      const y = await repo.yearByPublicId(trx, inst.id, uuidToBin(yearId), true);
      if (!y) throw new NotFoundError();
      const ok =
        input.action === 'CLOSE'
          ? await repo.closeYear(trx, y.id)
          : await repo.makeCurrent(trx, inst.id, y.id);
      if (!ok) {
        throw new CustomAPIError(409, 'ACA.TRANSITION_INVALID', {
          params: { label: y.label, status: (YEAR_LABEL[y.status] ?? y.status).toLowerCase() },
        });
      }
      await recordAudit(trx, {
        institutionId: inst.id,
        action: input.action === 'CLOSE' ? 'ACADEMIC_YEAR_CLOSED' : 'ACADEMIC_YEAR_MADE_CURRENT',
        entityType: 'academic_year',
        entityRef: yearId,
        reason: input.reason.trim(),
      });
    });
    return (await this.years(p)).items.find((y) => y.id === yearId)!;
  }

  // --- ACA-009 … ACA-013: classes and sections -----------------------------------------------------
  async classes(p: Principal) {
    const inst = await this.own(p);
    const year = await repo.currentYear(this.deps.db, inst.id);
    const [classes, sections, counts] = await Promise.all([
      repo.classes(this.deps.db, inst.id),
      repo.sections(this.deps.db, inst.id),
      year ? repo.sectionCounts(this.deps.db, inst.id, year.id) : Promise.resolve([]),
    ]);
    return {
      year: year ? { id: binToUuid(year.public_id), label: year.label } : null,
      items: classes.map((c) => {
        const secs = sections.filter((s) => String(s.class_id) === String(c.id));
        const sectionViews = secs.map((s) => ({
          id: binToUuid(s.public_id),
          name: s.name,
          capacity: s.capacity,
          students: Number(counts.find((x) => String(x.section_id) === String(s.id))?.n ?? 0),
        }));
        return {
          id: binToUuid(c.public_id),
          name: c.name,
          order: c.sort_order,
          sections: sectionViews,
          students: sectionViews.reduce((n, s) => n + s.students, 0),
          version: c.row_version,
        };
      }),
    };
  }

  private checkSections(sections: readonly SectionInput[]) {
    const names = sections.map((s) => s.name.trim().toLowerCase());
    if (names.some((n) => !n) || new Set(names).size !== names.length) {
      throw new ValidationError([{ field: 'sections', code: 'ACA.SECTION_NAMES' }]);
    }
  }

  async createClass(
    p: Principal,
    input: { name: string; order?: number | undefined; sections: readonly SectionInput[] },
  ) {
    this.checkSections(input.sections);
    const pub = newPublicIdPair();
    await this.deps.db.transaction().execute(async (trx) => {
      const inst = await this.own(p, trx, true);
      if (await repo.classNameTaken(trx, inst.id, input.name.trim())) {
        throw new CustomAPIError(409, 'ACA.CLASS_NAME_TAKEN', {
          errors: [{ field: 'name', code: 'ACA.CLASS_NAME_TAKEN' }],
        });
      }
      const classId = await repo.insertClass(trx, {
        publicId: pub.bin,
        institutionId: inst.id,
        name: input.name.trim(),
        order: input.order ?? (await repo.nextOrder(trx, inst.id)),
      });
      for (const s of input.sections) {
        await repo.insertSection(trx, {
          publicId: newPublicIdPair().bin,
          institutionId: inst.id,
          classId,
          name: s.name.trim(),
          capacity: s.capacity ?? null,
        });
      }
      await recordAudit(trx, {
        institutionId: inst.id,
        action: 'CLASS_CREATED',
        entityType: 'class',
        entityRef: pub.id,
        after: { name: input.name.trim(), sections: input.sections.map((s) => s.name.trim()) },
      });
    });
    return (await this.classes(p)).items.find((c) => c.id === pub.id)!;
  }

  /** Rename or reorder a class and set its sections (added, renamed, or removed if never used). */
  async updateClass(
    p: Principal,
    classId: string,
    expected: number,
    input: { name: string; order: number; sections: readonly SectionInput[] },
  ) {
    if (!isUuid(classId)) throw new NotFoundError();
    this.checkSections(input.sections);
    await this.deps.db.transaction().execute(async (trx) => {
      const inst = await this.own(p, trx, true);
      const c = await repo.classByPublicId(trx, inst.id, uuidToBin(classId), true);
      if (!c) throw new NotFoundError();
      if (c.row_version !== expected) throw new PreconditionFailedError();
      if (await repo.classNameTaken(trx, inst.id, input.name.trim(), c.id)) {
        throw new CustomAPIError(409, 'ACA.CLASS_NAME_TAKEN', {
          errors: [{ field: 'name', code: 'ACA.CLASS_NAME_TAKEN' }],
        });
      }
      const existing = (await repo.sections(trx, inst.id)).filter(
        (s) => String(s.class_id) === String(c.id),
      );
      const keep = new Set(input.sections.map((s) => s.id).filter(Boolean) as string[]);
      for (const s of existing) {
        if (keep.has(binToUuid(s.public_id))) continue;
        if (await repo.sectionUsed(trx, s.id)) {
          throw new CustomAPIError(409, 'ACA.SECTION_IN_USE', { params: { name: s.name } });
        }
        await repo.deleteSection(trx, s.id);
      }
      for (const s of input.sections) {
        const old = s.id ? existing.find((x) => binToUuid(x.public_id) === s.id) : undefined;
        if (s.id && !old)
          throw new ValidationError([{ field: 'sections', code: 'VALIDATION.FORMAT' }]);
        if (old) await repo.renameSection(trx, old.id, s.name.trim(), s.capacity ?? null);
        else {
          await repo.insertSection(trx, {
            publicId: newPublicIdPair().bin,
            institutionId: inst.id,
            classId: c.id,
            name: s.name.trim(),
            capacity: s.capacity ?? null,
          });
        }
      }
      if (
        !(await repo.updateClass(trx, c.id, expected, {
          name: input.name.trim(),
          order: input.order,
        }))
      ) {
        throw new PreconditionFailedError();
      }
      await recordAudit(trx, {
        institutionId: inst.id,
        action: 'CLASS_CHANGED',
        entityType: 'class',
        entityRef: classId,
        before: { name: c.name, order: c.sort_order },
        after: {
          name: input.name.trim(),
          order: input.order,
          sections: input.sections.map((s) => s.name.trim()),
        },
      });
    });
    return (await this.classes(p)).items.find((x) => x.id === classId)!;
  }

  /** ACA-012: add one section to a class. */
  async addSection(
    p: Principal,
    classId: string,
    input: { name: string; capacity?: number | null | undefined },
  ) {
    if (!isUuid(classId)) throw new NotFoundError();
    const pub = newPublicIdPair();
    await this.deps.db.transaction().execute(async (trx) => {
      const inst = await this.own(p, trx, true);
      const c = await repo.classByPublicId(trx, inst.id, uuidToBin(classId), true);
      if (!c) throw new NotFoundError();
      const names = (await repo.sections(trx, inst.id))
        .filter((s) => String(s.class_id) === String(c.id))
        .map((s) => s.name.toLowerCase());
      if (!input.name.trim() || names.includes(input.name.trim().toLowerCase())) {
        throw new ValidationError([{ field: 'name', code: 'ACA.SECTION_NAMES' }]);
      }
      await repo.insertSection(trx, {
        publicId: pub.bin,
        institutionId: inst.id,
        classId: c.id,
        name: input.name.trim(),
        capacity: input.capacity ?? null,
      });
      await repo.touchClass(trx, c.id);
    });
    return (await this.classes(p)).items.find((x) => x.id === classId)!;
  }

  /** ACA-013: rename a section or change its capacity. */
  async updateSection(
    p: Principal,
    sectionId: string,
    input: { name: string; capacity?: number | null | undefined },
  ) {
    if (!isUuid(sectionId)) throw new NotFoundError();
    let classPublicId = '';
    await this.deps.db.transaction().execute(async (trx) => {
      const inst = await this.own(p, trx, true);
      const s = await repo.sectionByPublicId(trx, inst.id, uuidToBin(sectionId));
      if (!s) throw new NotFoundError();
      const clash = (await repo.sections(trx, inst.id)).some(
        (x) =>
          String(x.class_id) === String(s.class_id) &&
          String(x.id) !== String(s.id) &&
          x.name.toLowerCase() === input.name.trim().toLowerCase(),
      );
      if (!input.name.trim() || clash) {
        throw new ValidationError([{ field: 'name', code: 'ACA.SECTION_NAMES' }]);
      }
      await repo.renameSection(trx, s.id, input.name.trim(), input.capacity ?? s.capacity ?? null);
      await repo.touchClass(trx, s.class_id);
      const c = (await repo.classes(trx, inst.id)).find((x) => String(x.id) === String(s.class_id));
      classPublicId = c ? binToUuid(c.public_id) : '';
    });
    return (await this.classes(p)).items.find((x) => x.id === classPublicId)!;
  }
}
