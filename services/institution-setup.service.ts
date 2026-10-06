/**
 * Institution set-up from the console (SRS 7.3, 7.12.1; INS-014…019; prototype c.roles, c.fields).
 *
 * - User types and departments (FR-INS-03, OI-ONB-04): every user type has at least one
 *   department; a name is fixed once members use the type; a department with members can't be
 *   removed. The category, not the name, decides behaviour.
 * - Institution-defined fields (CR-12, RNG-ONB-101…115): the prototype's nine types and four
 *   entities (OI-ONB-14/15), a configurable number of active fields per entity (OI-ONB-16), the
 *   identity-document acknowledgement (RNG-ONB-114), type and entity fixed once values exist
 *   (RNG-ONB-113), deactivation instead of deletion (RNG-ONB-111/112).
 */
import type { Kysely } from 'kysely';
import {
  CF_ENTITIES,
  CF_FILTER_TYPES,
  CF_NO_UNIQUE_TYPES,
  CF_OPTION_TYPES,
  CF_TYPES,
  ID_DOCUMENT_WORDS,
  LIMITS,
  type CfEntity,
  type CfType,
} from '../config/registers';
import type { Database, UserTypeCategory } from '../models/ringpe_models';
import { institutionsRepository } from '../repositories/institutions.repository';
import {
  customFieldsRepository as fields,
  userTypesRepository as types,
} from '../repositories/institution-setup.repository';
import {
  CustomAPIError,
  NotFoundError,
  PreconditionFailedError,
  ValidationError,
} from '../utils/CustomAPIError';
import { binToUuid, isUuid, newPublicIdPair, uuidToBin } from '../utils/idGenerator';
import type { Principal } from '../utils/principal';
import { PATTERNS } from '../utils/validators';
import { recordAudit } from './audit.service';
import { defaultValues, type SettingValues } from './settings.service';

export interface UserTypeInput {
  readonly name: string;
  readonly category?: UserTypeCategory | undefined;
  readonly departments: readonly string[];
}

export interface UserTypeChange {
  readonly name?: string | undefined;
  readonly addDepartments?: readonly string[] | undefined;
  /** Department ids. */
  readonly removeDepartments?: readonly string[] | undefined;
}

export interface FieldInput {
  readonly entity: CfEntity;
  readonly label: string;
  readonly type: CfType;
  readonly options?: readonly string[] | undefined;
  readonly required: boolean;
  readonly unique: boolean;
  readonly listColumn: boolean;
  readonly filter: boolean;
  readonly active: boolean;
  readonly noIdDocAck: boolean;
}

export type FieldChange = Partial<Omit<FieldInput, 'noIdDocAck'>> & {
  readonly noIdDocAck?: boolean | undefined;
};

const bool = (v: unknown) => v === true || v === 1 || v === '1';
const personName = (first: string | null, last: string | null) =>
  [first, last].filter(Boolean).join(' ') || null;

export class InstitutionSetupService {
  private readonly now: () => Date;

  constructor(
    private readonly deps: {
      readonly db: Kysely<Database>;
      readonly settings?: { values(): Promise<SettingValues> };
      readonly now?: () => Date;
    },
  ) {
    this.now = deps.now ?? (() => new Date());
  }

  private async limit(l: { key: string; value: number }): Promise<number> {
    const v = this.deps.settings ? await this.deps.settings.values() : defaultValues();
    return v[l.key] ?? l.value;
  }

  /** The console session's institution (never from the request). */
  private async institution(p: Principal) {
    if (!p.institutionId || !isUuid(p.institutionId)) throw new NotFoundError();
    const row = await institutionsRepository.byPublicId(this.deps.db, uuidToBin(p.institutionId));
    if (!row) throw new NotFoundError();
    if (row.status === 'CANCELLED') {
      throw new CustomAPIError(409, 'INS.FROZEN', { params: { institution: row.name } });
    }
    return row;
  }

  private actor(p: Principal) {
    return isUuid(p.subject) ? uuidToBin(p.subject) : null;
  }

  // --- INS-014 ------------------------------------------------------------------------------------
  async userTypes(p: Principal) {
    const inst = await this.institution(p);
    const [list, depts] = await Promise.all([
      types.list(this.deps.db, inst.id),
      types.departments(this.deps.db, inst.id),
    ]);
    return {
      items: list.map((t) => ({
        id: binToUuid(t.public_id),
        name: t.name,
        category: t.category,
        status: t.status,
        members: Number(t.members ?? 0),
        departments: depts
          .filter((d) => d.user_type_id === t.id)
          .map((d) => ({
            id: binToUuid(d.public_id),
            name: d.name,
            members: Number(d.members ?? 0),
          })),
        version: t.row_version,
      })),
    };
  }

  private checkName(name: string) {
    if (!PATTERNS.userTypeName.test(name)) {
      throw new ValidationError([
        { field: 'name', code: 'INS.USER_TYPE_NAME_FORMAT', params: { name } },
      ]);
    }
    if (name.length < 3 || name.length > 40) {
      throw new ValidationError([{ field: 'name', code: 'VALIDATION.FORMAT' }]);
    }
  }

  private checkDepartments(names: readonly string[], field: string) {
    const seen = new Set<string>();
    for (const d of names) {
      if (!PATTERNS.userTypeName.test(d) || d.length > 40) {
        throw new ValidationError([
          { field, code: 'INS.DEPARTMENT_NAME_FORMAT', params: { name: d } },
        ]);
      }
      if (seen.has(d.toLowerCase())) {
        throw new CustomAPIError(409, 'INS.DEPARTMENT_TAKEN', { params: { name: d } });
      }
      seen.add(d.toLowerCase());
    }
  }

  // --- INS-015 ------------------------------------------------------------------------------------
  async createUserType(p: Principal, input: UserTypeInput) {
    const name = input.name.trim();
    const departments = input.departments.map((d) => d.trim()).filter(Boolean);
    this.checkName(name);
    if (departments.length === 0) throw new CustomAPIError(422, 'INS.DEPARTMENT_REQUIRED');
    this.checkDepartments(departments, 'departments');
    const inst = await this.institution(p);
    const ut = newPublicIdPair();
    await this.deps.db.transaction().execute(async (trx) => {
      if (await types.nameTaken(trx, inst.id, name)) {
        throw new CustomAPIError(409, 'INS.USER_TYPE_TAKEN', { params: { name } });
      }
      const id = await types.insert(trx, {
        publicId: ut.bin,
        institutionId: inst.id,
        name,
        category: input.category ?? 'OTHER',
        by: this.actor(p),
      });
      for (const d of departments) {
        await types.addDepartment(trx, {
          publicId: newPublicIdPair().bin,
          institutionId: inst.id,
          userTypeId: id,
          name: d,
        });
      }
      await recordAudit(trx, {
        institutionId: inst.id,
        action: 'USER_TYPE_CREATED',
        entityType: 'user_type',
        entityRef: ut.id,
        after: { name, category: input.category ?? 'OTHER', departments },
      });
    });
    return this.userTypes(p);
  }

  // --- INS-016 ------------------------------------------------------------------------------------
  async changeUserType(p: Principal, publicId: string, expected: number, input: UserTypeChange) {
    if (!isUuid(publicId)) throw new NotFoundError();
    const inst = await this.institution(p);
    const add = (input.addDepartments ?? []).map((d) => d.trim()).filter(Boolean);
    this.checkDepartments(add, 'addDepartments');
    await this.deps.db.transaction().execute(async (trx) => {
      const t = await types.byPublicId(trx, inst.id, uuidToBin(publicId));
      if (!t) throw new NotFoundError();
      if (t.row_version !== expected) throw new PreconditionFailedError();
      const all = (await types.list(trx, inst.id)).find((x) => x.id === t.id);
      const depts = (await types.departments(trx, inst.id)).filter((d) => d.user_type_id === t.id);
      let name: string | undefined;
      if (input.name !== undefined && input.name.trim() !== t.name) {
        name = input.name.trim();
        if (Number(all?.members ?? 0) > 0)
          throw new CustomAPIError(409, 'INS.USER_TYPE_NAME_FIXED');
        this.checkName(name);
        if (await types.nameTaken(trx, inst.id, name, t.id)) {
          throw new CustomAPIError(409, 'INS.USER_TYPE_TAKEN', { params: { name } });
        }
      }
      const remove = depts.filter((d) =>
        (input.removeDepartments ?? []).includes(binToUuid(d.public_id)),
      );
      for (const d of remove) {
        if (Number(d.members ?? 0) > 0) {
          throw new CustomAPIError(409, 'INS.DEPARTMENT_IN_USE', {
            params: { department: d.name },
          });
        }
      }
      const kept = depts.filter((d) => !remove.includes(d));
      for (const d of add) {
        if (kept.some((k) => k.name.toLowerCase() === d.toLowerCase())) {
          throw new CustomAPIError(409, 'INS.DEPARTMENT_TAKEN', { params: { name: d } });
        }
      }
      if (kept.length + add.length === 0) throw new CustomAPIError(422, 'INS.DEPARTMENT_REQUIRED');
      if (!(await types.rename(trx, t.id, expected, name))) throw new PreconditionFailedError();
      for (const d of remove) await types.removeDepartment(trx, inst.id, d.id);
      for (const d of add) {
        await types.addDepartment(trx, {
          publicId: newPublicIdPair().bin,
          institutionId: inst.id,
          userTypeId: t.id,
          name: d,
        });
      }
      await recordAudit(trx, {
        institutionId: inst.id,
        action: 'USER_TYPE_UPDATED',
        entityType: 'user_type',
        entityRef: publicId,
        before: { name: t.name, departments: depts.map((d) => d.name) },
        after: { name: name ?? t.name, added: add, removed: remove.map((d) => d.name) },
      });
    });
    return this.userTypes(p);
  }

  // --- INS-017 ------------------------------------------------------------------------------------
  async customFields(p: Principal, entity?: CfEntity) {
    const inst = await this.institution(p);
    const [list, options, max] = await Promise.all([
      fields.list(this.deps.db, inst.id, entity),
      fields.options(this.deps.db, inst.id),
      this.limit(LIMITS.customFieldsMaxActivePerEntity),
    ]);
    return {
      maxActivePerEntity: max,
      items: list.map((f) => ({
        id: binToUuid(f.public_id),
        entity: f.entity,
        entityLabel: CF_ENTITIES[f.entity],
        label: f.label,
        type: f.data_type,
        typeLabel: CF_TYPES[f.data_type].label,
        options: options.filter((o) => o.field_id === f.id && bool(o.active)).map((o) => o.label),
        required: bool(f.is_required),
        unique: bool(f.is_unique),
        listColumn: bool(f.list_column),
        filter: bool(f.filterable),
        position: f.position,
        status: f.status,
        values: Number(f.values ?? 0),
        definedBy: personName(f.first_name, f.last_name),
        definedAt: new Date(f.created_at).toISOString(),
        version: f.row_version,
      })),
    };
  }

  /** The rules of the definition screen (prototype cp.fd.save; RNG-ONB-105/106/114). */
  private checkDefinition(d: {
    label: string;
    type: CfType;
    options?: readonly string[] | undefined;
    unique: boolean;
    filter: boolean;
  }) {
    if (d.label.length < 2 || d.label.length > 40) {
      throw new ValidationError([{ field: 'label', code: 'VALIDATION.FORMAT' }]);
    }
    if (ID_DOCUMENT_WORDS.test(d.label)) {
      throw new ValidationError([{ field: 'label', code: 'CF.ID_DOCUMENT_LABEL' }]);
    }
    const options = (d.options ?? []).map((o) => o.trim()).filter(Boolean);
    if (CF_OPTION_TYPES.includes(d.type)) {
      if (options.length < 2) {
        throw new ValidationError([{ field: 'options', code: 'CF.OPTIONS_TOO_FEW' }]);
      }
      if (new Set(options.map((o) => o.toLowerCase())).size !== options.length) {
        throw new ValidationError([{ field: 'options', code: 'CF.OPTIONS_DUPLICATE' }]);
      }
      if (options.some((o) => o.length > 60)) {
        throw new ValidationError([{ field: 'options', code: 'VALIDATION.FORMAT' }]);
      }
    } else if (options.length > 0) {
      throw new ValidationError([{ field: 'options', code: 'CF.OPTIONS_NOT_ALLOWED' }]);
    }
    if (d.filter && !CF_FILTER_TYPES.includes(d.type)) {
      throw new ValidationError([{ field: 'filter', code: 'CF.FILTER_TYPE' }]);
    }
    if (d.unique && CF_NO_UNIQUE_TYPES.includes(d.type)) {
      throw new ValidationError([{ field: 'unique', code: 'CF.UNIQUE_TYPE' }]);
    }
    return options;
  }

  // --- INS-018 ------------------------------------------------------------------------------------
  async createField(p: Principal, input: FieldInput) {
    if (!input.noIdDocAck) {
      throw new ValidationError([{ field: 'noIdDocAck', code: 'CF.ACK_REQUIRED' }]);
    }
    const label = input.label.trim();
    const options = this.checkDefinition({ ...input, label });
    const inst = await this.institution(p);
    const max = await this.limit(LIMITS.customFieldsMaxActivePerEntity);
    const now = this.now();
    const f = newPublicIdPair();
    await this.deps.db.transaction().execute(async (trx) => {
      if (await fields.labelTaken(trx, inst.id, input.entity, label)) {
        throw new CustomAPIError(409, 'CF.LABEL_TAKEN', {
          params: { entity: CF_ENTITIES[input.entity], label },
        });
      }
      if (input.active && (await fields.activeCount(trx, inst.id, input.entity)) >= max) {
        throw new CustomAPIError(409, 'CF.LIMIT_REACHED', {
          params: { entity: CF_ENTITIES[input.entity], max },
        });
      }
      const id = await fields.insert(trx, {
        publicId: f.bin,
        institutionId: inst.id,
        entity: input.entity,
        label,
        type: input.type,
        required: input.required,
        unique: input.unique,
        listColumn: input.listColumn,
        filter: input.filter,
        position: await fields.nextPosition(trx, inst.id, input.entity),
        active: input.active,
        by: this.actor(p),
        now,
      });
      if (options.length) await fields.setOptions(trx, inst.id, id, options);
      await recordAudit(trx, {
        institutionId: inst.id,
        action: 'CUSTOM_FIELD_CREATED',
        entityType: 'custom_field',
        entityRef: f.id,
        after: { entity: input.entity, label, type: input.type },
      });
    });
    const out = await this.customFields(p);
    return out.items.find((x) => x.id === f.id)!;
  }

  // --- INS-019 ------------------------------------------------------------------------------------
  async changeField(p: Principal, publicId: string, expected: number, input: FieldChange) {
    if (!isUuid(publicId)) throw new NotFoundError();
    const onlyStatus = Object.keys(input).every((k) => k === 'active');
    if (!onlyStatus && input.noIdDocAck !== true) {
      throw new ValidationError([{ field: 'noIdDocAck', code: 'CF.ACK_REQUIRED' }]);
    }
    const inst = await this.institution(p);
    const max = await this.limit(LIMITS.customFieldsMaxActivePerEntity);
    const now = this.now();
    await this.deps.db.transaction().execute(async (trx) => {
      const f = await fields.byPublicId(trx, inst.id, uuidToBin(publicId));
      if (!f) throw new NotFoundError();
      if (f.row_version !== expected) throw new PreconditionFailedError();
      const values = await fields.valueCount(trx, f.id);
      const entity = input.entity ?? f.entity;
      const type = input.type ?? f.data_type;
      if (values > 0 && (entity !== f.entity || type !== f.data_type)) {
        throw new CustomAPIError(409, 'CF.TYPE_FIXED');
      }
      const label = input.label?.trim() ?? f.label;
      const current = (await fields.options(trx, inst.id))
        .filter((o) => o.field_id === f.id && bool(o.active))
        .map((o) => o.label);
      const unique = input.unique ?? bool(f.is_unique);
      const options = onlyStatus
        ? current
        : this.checkDefinition({
            label,
            type,
            options: input.options ?? (CF_OPTION_TYPES.includes(type) ? current : []),
            unique,
            filter: input.filter ?? bool(f.filterable),
          });
      if (
        (input.label !== undefined || input.entity !== undefined) &&
        (await fields.labelTaken(trx, inst.id, entity, label, f.id))
      ) {
        throw new CustomAPIError(409, 'CF.LABEL_TAKEN', {
          params: { entity: CF_ENTITIES[entity], label },
        });
      }
      const active = input.active ?? f.status === 'ACTIVE';
      const becomesActive = active && (f.status !== 'ACTIVE' || entity !== f.entity);
      if (becomesActive && (await fields.activeCount(trx, inst.id, entity, f.id)) >= max) {
        throw new CustomAPIError(409, 'CF.LIMIT_REACHED', {
          params: { entity: CF_ENTITIES[entity], max },
        });
      }
      if (unique && !bool(f.is_unique) && (await fields.hasDuplicateValues(trx, f.id))) {
        throw new CustomAPIError(409, 'CF.UNIQUE_CONFLICT');
      }
      const ok = await fields.update(trx, f.id, expected, {
        entity,
        label,
        data_type: type,
        ...(input.required !== undefined ? { is_required: input.required } : {}),
        is_unique: unique,
        ...(input.listColumn !== undefined ? { list_column: input.listColumn } : {}),
        ...(input.filter !== undefined ? { filterable: input.filter } : {}),
        status: active ? 'ACTIVE' : 'INACTIVE',
        deactivated_at: active ? null : f.status === 'ACTIVE' ? now : f.deactivated_at,
        ...(onlyStatus ? {} : { no_id_doc_ack_at: now }),
        ...(entity !== f.entity
          ? { position: await fields.nextPosition(trx, inst.id, entity) }
          : {}),
      });
      if (!ok) throw new PreconditionFailedError();
      if (!onlyStatus)
        await fields.setOptions(trx, inst.id, f.id, CF_OPTION_TYPES.includes(type) ? options : []);
      await recordAudit(trx, {
        institutionId: inst.id,
        action: onlyStatus
          ? active
            ? 'CUSTOM_FIELD_REACTIVATED'
            : 'CUSTOM_FIELD_DEACTIVATED'
          : 'CUSTOM_FIELD_UPDATED',
        entityType: 'custom_field',
        entityRef: publicId,
        before: { label: f.label, status: f.status },
        after: { label, status: active ? 'ACTIVE' : 'INACTIVE', values },
      });
    });
    const out = await this.customFields(p);
    return out.items.find((x) => x.id === publicId)!;
  }
}
