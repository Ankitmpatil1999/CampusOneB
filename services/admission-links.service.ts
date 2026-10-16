/**
 * Admission links and the public landing (SRS 7.8, 19.2; INS-027…029, ADM-001; prototype
 * c.admissionqr, p.admission).
 *
 * - The institution generates a link: a random token shared as a URL and a QR. Generating again
 *   replaces it — the old link stops working and stays in the history (RC-34).
 * - The landing shows only what a family needs (RNG-GOV-007): the institution's name and city, the
 *   academic years open for admission with their entry fees, the classes with their age bands, the
 *   institution's own fields for applications, and the document rules.
 */
import { randomBytes } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { LIMITS } from '../config/registers';
import type { MessageSender } from '../integrations/sms.provider';
import type { Database } from '../models/ringpe_models';
import { institutionsRepository } from '../repositories/institutions.repository';
import { CustomAPIError, NotFoundError, ValidationError } from '../utils/CustomAPIError';
import { istBusinessDate } from '../utils/format';
import { binToUuid, isUuid, newPublicIdPair, uuidToBin } from '../utils/idGenerator';
import { toMoneyDto } from '../utils/money';
import type { Principal } from '../utils/principal';
import { qrSvg } from '../utils/qr';
import { recordAudit } from './audit.service';
import { activeFields } from './custom-values.service';
import { logoUrlOf } from './institution-logo';
import { defaultValues, type SettingValues } from './settings.service';

const day = (d: Date | string) => istBusinessDate(new Date(d));
const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);

/**
 * The class's place from Nursery (0) by its name: Nursery/Pre-KG 0, LKG 1, UKG 2, Grade/Class/Std n
 * → n + 2; null when the name says nothing (no age check then).
 */
export function classOrder(name: string): number | null {
  const n = name.trim().toLowerCase();
  if (/^(nursery|pre[- ]?kg|pre[- ]?nursery|play ?group)\b/.test(n)) return 0;
  if (/^(lkg|lower kg|jr\.? ?kg|junior kg)\b/.test(n)) return 1;
  if (/^(ukg|upper kg|sr\.? ?kg|senior kg)\b/.test(n)) return 2;
  const m = /^(?:grade|class|std\.?|standard)?\s*(\d{1,2})(?:st|nd|rd|th)?\b/.exec(n);
  if (m) {
    const g = Number(m[1]);
    return g >= 1 && g <= 12 ? g + 2 : null;
  }
  return null;
}

export class AdmissionLinksService {
  constructor(
    private readonly deps: {
      readonly db: Kysely<Database>;
      readonly email?: MessageSender;
      readonly webUrl: string;
      readonly settings?: { values(): Promise<SettingValues> };
      readonly now?: () => Date;
    },
  ) {}

  private now() {
    return this.deps.now?.() ?? new Date();
  }

  async limit(l: { key: string; value: number }) {
    const v = this.deps.settings ? await this.deps.settings.values() : defaultValues();
    return Number(v[l.key] ?? l.value);
  }

  private async inst(p: Principal) {
    if (!p.institutionId || !isUuid(p.institutionId)) throw new NotFoundError();
    const i = await institutionsRepository.byPublicId(this.deps.db, uuidToBin(p.institutionId));
    if (!i) throw new NotFoundError();
    return i;
  }

  urlOf(token: string) {
    return `${this.deps.webUrl}/admissions/${token}`;
  }

  private view(l: {
    public_id: Buffer;
    token: string;
    status: 'ACTIVE' | 'REPLACED';
    expires_at: Date | string | null;
    created_at: Date | string;
    replaced_at: Date | string | null;
    year_label: string | null;
  }) {
    const url = this.urlOf(l.token);
    const active = l.status === 'ACTIVE';
    return {
      id: binToUuid(l.public_id),
      status: l.status,
      url: active ? url : null,
      qrSvg: active ? qrSvg(url) : null,
      year: l.year_label,
      expiresAt: iso(l.expires_at),
      expired: !!l.expires_at && new Date(l.expires_at).getTime() <= this.now().getTime(),
      createdAt: iso(l.created_at),
      replacedAt: iso(l.replaced_at),
    };
  }

  private rows(institutionId: string) {
    return this.deps.db
      .selectFrom('admission_links as l')
      .leftJoin('academic_years as y', 'y.id', 'l.year_id')
      .select([
        'l.id',
        'l.public_id',
        'l.token',
        'l.status',
        'l.expires_at',
        'l.created_at',
        'l.replaced_at',
        'y.label as year_label',
      ])
      .where('l.institution_id', '=', institutionId);
  }

  // --- INS-027 --------------------------------------------------------------------------------------
  async links(p: Principal) {
    const i = await this.inst(p);
    const rows = await this.rows(i.id).orderBy('l.id', 'desc').limit(50).execute();
    const current = rows.find((r) => r.status === 'ACTIVE');
    return {
      current: current ? this.view(current) : null,
      history: rows.filter((r) => r.status !== 'ACTIVE').map((r) => this.view(r)),
    };
  }

  // --- INS-028 --------------------------------------------------------------------------------------
  async generate(p: Principal, input: { yearId?: string | null; expiresAt?: string | null }) {
    const i = await this.inst(p);
    let yearRowId: string | null = null;
    if (input.yearId) {
      if (!isUuid(input.yearId)) {
        throw new ValidationError([{ field: 'yearId', code: 'VALIDATION.FORMAT' }]);
      }
      const y = await this.deps.db
        .selectFrom('academic_years')
        .select(['id', 'status'])
        .where('institution_id', '=', i.id)
        .where('public_id', '=', uuidToBin(input.yearId))
        .executeTakeFirst();
      if (!y || y.status === 'CLOSED') throw new CustomAPIError(422, 'ADM.YEAR_NOT_OPEN');
      yearRowId = String(y.id);
    }
    const at = this.now();
    if (input.expiresAt && new Date(input.expiresAt).getTime() <= at.getTime()) {
      throw new ValidationError([{ field: 'expiresAt', code: 'VALIDATION.DATE' }]);
    }
    const pub = newPublicIdPair();
    const token = randomBytes(32).toString('base64url');
    await this.deps.db.transaction().execute(async (trx) => {
      await trx
        .selectFrom('institutions')
        .select('id')
        .where('id', '=', i.id)
        .forUpdate()
        .execute();
      await trx
        .updateTable('admission_links')
        .set({ status: 'REPLACED', replaced_at: at })
        .where('institution_id', '=', i.id)
        .where('status', '=', 'ACTIVE')
        .execute();
      await trx
        .insertInto('admission_links')
        .values({
          public_id: pub.bin,
          institution_id: i.id,
          token,
          year_id: yearRowId,
          expires_at: input.expiresAt ? new Date(input.expiresAt) : null,
          created_by: isUuid(p.subject) ? uuidToBin(p.subject) : null,
          created_at: at,
        })
        .execute();
      await recordAudit(trx, {
        institutionId: i.id,
        action: 'ADMISSION_LINK_GENERATED',
        entityType: 'admission_link',
        entityRef: pub.id,
        after: { expiresAt: input.expiresAt ?? null },
      });
    });
    return (await this.links(p)).current!;
  }

  // --- INS-029 --------------------------------------------------------------------------------------
  async email(p: Principal, linkId: string, input: { emails: readonly string[] }) {
    const i = await this.inst(p);
    if (!isUuid(linkId)) throw new NotFoundError();
    const l = await this.rows(i.id)
      .where('l.public_id', '=', uuidToBin(linkId))
      .where('l.status', '=', 'ACTIVE')
      .executeTakeFirst();
    if (!l) throw new NotFoundError();
    const sent: string[] = [];
    for (const to of new Set(input.emails)) {
      if (!this.deps.email) break;
      await this.deps.email.send({
        to,
        purpose: 'admission.link',
        text: `Admissions are open at ${i.name}.\nApply online: ${this.urlOf(l.token)}\nYou can save your progress and come back later.`,
      });
      sent.push(to);
    }
    return { sent: sent.length };
  }

  // --- public: the link ----------------------------------------------------------------------------
  /** The institution behind a link token; replaced or unknown links and expired ones are refused. */
  async context(token: string) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new CustomAPIError(404, 'ADM.LINK_INVALID');
    const l = await this.deps.db
      .selectFrom('admission_links as l')
      .innerJoin('institutions as i', 'i.id', 'l.institution_id')
      .select([
        'l.id',
        'l.status',
        'l.expires_at',
        'l.year_id',
        'i.id as institution_id',
        'i.public_id as institution_public_id',
        'i.name',
        'i.short_name',
        'i.city',
        'i.status as institution_status',
      ])
      .where('l.token', '=', token)
      .executeTakeFirst();
    if (!l || l.status !== 'ACTIVE' || l.institution_status !== 'ACTIVE') {
      throw new CustomAPIError(404, 'ADM.LINK_INVALID');
    }
    if (l.expires_at && new Date(l.expires_at).getTime() <= this.now().getTime()) {
      throw new CustomAPIError(410, 'ADM.LINK_EXPIRED');
    }
    return {
      linkRowId: String(l.id),
      institutionId: String(l.institution_id),
      institutionPublicId: binToUuid(l.institution_public_id),
      name: l.name,
      shortName: l.short_name,
      city: l.city,
      yearRowId: l.year_id ? String(l.year_id) : null,
    };
  }

  /** Years open for admission: not closed, not over; a year already started takes mid-term joiners. */
  async openYears(institutionId: string) {
    const today = istBusinessDate(this.now());
    const rows = await this.deps.db
      .selectFrom('academic_years as y')
      .leftJoin('entry_fees as f', (j) =>
        j.onRef('f.year_id', '=', 'y.id').onRef('f.institution_id', '=', 'y.institution_id'),
      )
      .select([
        'y.id',
        'y.public_id',
        'y.label',
        'y.starts_on',
        'y.ends_on',
        'f.application_fee_paise',
        'f.admission_fee_paise',
      ])
      .where('y.institution_id', '=', institutionId)
      .where('y.status', '=', 'OPEN')
      .where('y.ends_on', '>=', today)
      .orderBy('y.starts_on', 'desc')
      .execute();
    return rows.map((y) => ({
      rowId: String(y.id),
      id: binToUuid(y.public_id),
      label: y.label,
      startsOn: day(y.starts_on),
      endsOn: day(y.ends_on),
      kind: day(y.starts_on) <= today ? ('MID_TERM' as const) : ('REGULAR' as const),
      fees:
        y.application_fee_paise === null || y.application_fee_paise === undefined
          ? null
          : {
              applicationFee: toMoneyDto(Number(y.application_fee_paise)),
              // The family may pay it with the form or later (client 2026-10-12).
              applicationMandatory: false,
              admissionFee: toMoneyDto(Number(y.admission_fee_paise ?? 0)),
            },
    }));
  }

  /** Age band of a class (BR-50, 27.4 §19): null when the class name gives no order. */
  async band(className: string) {
    const order = classOrder(className);
    if (order === null) return null;
    const min = (await this.limit(LIMITS.admAgeNurseryMin)) + order;
    return { min, max: min + (await this.limit(LIMITS.admAgeBandYears)) };
  }

  // --- ADM-001 --------------------------------------------------------------------------------------
  async landing(token: string) {
    const c = await this.context(token);
    return this.formSetup(c.institutionId, c, c.yearRowId);
  }

  /**
   * ADM-035: what the counsellor's application form needs (client 2026-10-15: the same steps,
   * fields and rules as the public form) — the landing's years, classes, institution fields, stops
   * and rules for the signed-in institution, with no link.
   */
  async consoleForm(p: Principal) {
    const i = await this.inst(p);
    return this.formSetup(
      String(i.id),
      { name: i.name, shortName: i.short_name, city: i.city },
      null,
    );
  }

  private async formSetup(
    institutionId: string,
    inst: { name: string; shortName: string | null; city: string | null },
    yearRowId: string | null,
  ) {
    const c = { institutionId, ...inst, yearRowId };
    const years = await this.openYears(c.institutionId);
    const classes = await this.deps.db
      .selectFrom('classes')
      .select(['public_id', 'name', 'sort_order'])
      .where('institution_id', '=', c.institutionId)
      .orderBy('sort_order')
      .orderBy('name')
      .execute();
    const fields = await activeFields(this.deps.db, c.institutionId, 'ADMISSION_APPLICATION');
    // The school's pick-up stops, for a family opting for transport (client 2026-10-12).
    const stops = await this.deps.db
      .selectFrom('transport_stops')
      .select(['public_id', 'name', 'landmark'])
      .where('institution_id', '=', c.institutionId)
      .where('active', '=', 1)
      .orderBy('name')
      .execute();
    const refs = await this.limit(LIMITS.admReferencesMax);
    const docMax = await this.limit(LIMITS.fileMaxBytes);
    return {
      institution: {
        name: c.name,
        shortName: c.shortName,
        city: c.city,
        // The school's logo for the admission pages (client 2026-10-15).
        logoUrl: await logoUrlOf(this.deps.db, c.institutionId),
      },
      preselectedYearId: years.find((y) => y.rowId === c.yearRowId)?.id ?? null,
      years: years.map(({ rowId: _r, ...y }) => y),
      classes: await Promise.all(
        classes.map(async (k) => ({
          id: binToUuid(k.public_id),
          name: k.name,
          ageBand: await this.band(k.name),
        })),
      ),
      customFields: fields.map((f) => ({
        id: f.id,
        label: f.label,
        type: f.type,
        required: !!f.required,
        options: f.options.map((o) => ({ id: o.id, label: o.label })),
      })),
      transportStops: stops.map((s) => ({
        id: binToUuid(s.public_id),
        name: s.name,
        landmark: s.landmark,
      })),
      rules: {
        ageMeasuredOn: 'June 1 of the year’s start; the joining date for a mid-term admission',
        documents: { maxBytes: docMax, types: ['PDF', 'JPG', 'PNG'] },
        references: { max: refs, midTermMin: 1 },
      },
    };
  }

  /** How many applications an institution has started (landing KPI for the console screen). */
  async counts(institutionId: string) {
    const r = await this.deps.db
      .selectFrom('admission_applications')
      .select(sql<number>`COUNT(*)`.as('n'))
      .where('institution_id', '=', institutionId)
      .where('source', '=', 'PUBLIC')
      .executeTakeFirst();
    return { publicApplications: Number(r?.n ?? 0) };
  }
}
