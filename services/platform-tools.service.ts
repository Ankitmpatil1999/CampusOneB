/**
 * The operator's platform tools (SRS 6.30, 6.31, 18.5; IDN-070…076, INT-009/010; FR-PLT-01/03; NFR-01;
 * OI-GAS-20, OI-INT-04/08; prototype o.languages, o.logs, o.partners).
 *
 * - **Languages:** add, switch on or off, choose the default (it stays on). English comes from the
 *   registers and is not edited here.
 * - **Translations:** every register key with its English text and each language's text — machine draft
 *   or reviewed — filtered by screen (the key's prefix), text or what a language still lacks. Editing a
 *   text marks it reviewed; its placeholders must match the English ones.
 * - **Log analyser:** the request log by user, institution, time, endpoint, status or correlation id;
 *   never bodies or query values; an entry shows the audit events of the same request.
 * - **Messaging channels:** the platform's switch and template set per channel. The provider is
 *   configuration; a channel without an integrated provider can't be switched on, and in-app stays on.
 */
import { sql, type Kysely } from 'kysely';
import { englishBundle } from '../config/registers';
import type { Database, MessagingChannel } from '../models/ringpe_models';
import { CustomAPIError, PreconditionFailedError, ValidationError } from '../utils/CustomAPIError';
import { binToUuid, isUuid, uuidToBin } from '../utils/idGenerator';
import type { Principal } from '../utils/principal';
import { recordAudit } from './audit.service';
import type { I18nService } from './i18n.service';

const placeholders = (t: string) =>
  [...new Set([...t.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!))].sort();
const nameOf = (first: string | null | undefined, last: string | null | undefined) =>
  [first, last].filter(Boolean).join(' ');
const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);
const CHANNELS: readonly MessagingChannel[] = ['IN_APP', 'SMS', 'EMAIL', 'WHATSAPP', 'PUSH'];

export class PlatformToolsService {
  constructor(
    private readonly deps: {
      readonly db: Kysely<Database>;
      readonly i18n?: I18nService;
      /** The configured providers (config.notify): 'log' is the test sender. */
      readonly providers: {
        readonly sms: string;
        readonly email: string;
        /** 'off': no push provider configured (PUSH_PROVIDER), so push can't be switched on. */
        readonly push?: string;
      };
      readonly now?: () => Date;
    },
  ) {}

  private now() {
    return this.deps.now?.() ?? new Date();
  }

  private by(p: Principal) {
    return isUuid(p.subject) ? uuidToBin(p.subject) : null;
  }

  // --- IDN-070…072: languages --------------------------------------------------------------------------------
  async languages() {
    const keys = Object.keys(englishBundle());
    const rows = await this.deps.db
      .selectFrom('languages as l')
      .select([
        'l.code',
        'l.name',
        'l.native_name',
        'l.enabled',
        'l.is_default',
        'l.row_version',
        (eb) =>
          eb
            .selectFrom('translations as t')
            .select(sql<number>`COUNT(*)`.as('n'))
            .whereRef('t.lang_code', '=', 'l.code')
            .where('t.source', '=', 'HUMAN')
            .as('human'),
        (eb) =>
          eb
            .selectFrom('translations as t')
            .select(sql<number>`COUNT(*)`.as('n'))
            .whereRef('t.lang_code', '=', 'l.code')
            .where('t.source', '=', 'MACHINE')
            .as('machine'),
      ])
      .orderBy('l.is_default', 'desc')
      .orderBy('l.code')
      .execute();
    return {
      keys: keys.length,
      items: rows.map((l) => {
        const human = Number(l.human ?? 0);
        const machine = Number(l.machine ?? 0);
        return {
          code: l.code,
          name: l.name,
          nativeName: l.native_name,
          enabled: !!Number(l.enabled),
          isDefault: !!Number(l.is_default),
          version: Number(l.row_version),
          translations:
            l.code === 'en'
              ? { reviewed: keys.length, machine: 0, missing: 0 }
              : { reviewed: human, machine, missing: Math.max(0, keys.length - human - machine) },
        };
      }),
    };
  }

  async addLanguage(p: Principal, input: { code: string; name: string; native: string }) {
    const code = input.code.trim().toLowerCase();
    const name = input.name.trim();
    const native = input.native.trim();
    if (
      !/^[a-z]{2,3}(-[a-z0-9]{2,4})?$/.test(code) ||
      name.length < 2 ||
      name.length > 40 ||
      !native ||
      native.length > 40
    ) {
      throw new ValidationError([{ field: 'code', code: 'I18N.LANGUAGE_CODE' }]);
    }
    try {
      await this.deps.db
        .insertInto('languages')
        .values({ code, name, native_name: native, enabled: 0, is_default: 0 } as never)
        .execute();
    } catch (e) {
      if ((e as { errno?: number }).errno === 1062)
        throw new CustomAPIError(409, 'I18N.LANGUAGE_EXISTS');
      throw e;
    }
    await recordAudit(this.deps.db, {
      institutionId: null,
      action: 'LANGUAGE_ADDED',
      entityType: 'language',
      entityRef: code,
      after: { name },
    });
    return (await this.languages()).items.find((l) => l.code === code)!;
  }

  async updateLanguage(
    p: Principal,
    code: string,
    input: { enabled?: boolean | undefined; isDefault?: boolean | undefined },
    expected: number,
  ) {
    await this.deps.db.transaction().execute(async (trx) => {
      const l = await trx
        .selectFrom('languages')
        .selectAll()
        .where('code', '=', code)
        .forUpdate()
        .executeTakeFirst();
      if (!l) throw new CustomAPIError(404, 'I18N.LANGUAGE_NOT_FOUND');
      if (Number(l.row_version) !== expected) throw new PreconditionFailedError();
      const enabled = input.enabled ?? !!Number(l.enabled);
      const isDefault = input.isDefault ?? !!Number(l.is_default);
      if (isDefault && !enabled) throw new CustomAPIError(409, 'I18N.DEFAULT_ENABLED');
      if (!!Number(l.is_default) && input.isDefault === false)
        throw new CustomAPIError(409, 'I18N.DEFAULT_ENABLED');
      if (isDefault && !Number(l.is_default)) {
        await trx
          .updateTable('languages')
          .set({ is_default: 0, row_version: sql<number>`row_version + 1` } as never)
          .where('is_default', '=', 1 as never)
          .execute();
      }
      await trx
        .updateTable('languages')
        .set({
          enabled: enabled ? 1 : 0,
          is_default: isDefault ? 1 : 0,
          row_version: sql<number>`row_version + 1`,
        } as never)
        .where('code', '=', code)
        .execute();
      await recordAudit(trx, {
        institutionId: null,
        action: 'LANGUAGE_CHANGED',
        entityType: 'language',
        entityRef: code,
        after: { enabled, isDefault },
      });
    });
    this.deps.i18n?.invalidate();
    return (await this.languages()).items.find((l) => l.code === code)!;
  }

  // --- IDN-073 / IDN-074: translations --------------------------------------------------------------------
  async translations(f: {
    screen?: string | undefined;
    missingIn?: string | undefined;
    q?: string | undefined;
    cursor?: string | undefined;
  }) {
    const english = englishBundle();
    const langs = (
      await this.deps.db
        .selectFrom('languages')
        .select('code')
        .where('code', '!=', 'en')
        .orderBy('code')
        .execute()
    ).map((l) => l.code);
    let keys = Object.keys(english).sort();
    if (f.screen) keys = keys.filter((k) => k.split('.')[0] === f.screen);
    const text = (f.q ?? '').trim().toLowerCase();
    const rows = await this.deps.db
      .selectFrom('translations')
      .select(['lang_code', 'msg_key', 'text', 'source', 'reviewed_at', 'row_version'])
      .execute();
    const byKey = new Map<string, Map<string, (typeof rows)[number]>>();
    for (const r of rows) {
      const m = byKey.get(r.msg_key) ?? new Map<string, (typeof rows)[number]>();
      m.set(r.lang_code, r);
      byKey.set(r.msg_key, m);
    }
    if (f.missingIn) keys = keys.filter((k) => !byKey.get(k)?.has(f.missingIn!));
    if (text) {
      keys = keys.filter(
        (k) =>
          k.toLowerCase().includes(text) ||
          english[k]!.toLowerCase().includes(text) ||
          [...(byKey.get(k)?.values() ?? [])].some((r) => r.text.toLowerCase().includes(text)),
      );
    }
    const total = keys.length;
    if (f.cursor) keys = keys.filter((k) => k > f.cursor!);
    const page = keys.slice(0, 50);
    return {
      languages: langs,
      screens: [...new Set(Object.keys(english).map((k) => k.split('.')[0]!))].sort(),
      total,
      items: page.map((k) => ({
        key: k,
        screen: k.split('.')[0],
        en: english[k],
        placeholders: placeholders(english[k]!),
        texts: Object.fromEntries(
          langs.map((l) => {
            const r = byKey.get(k)?.get(l);
            return [
              l,
              r
                ? {
                    text: r.text,
                    source: r.source,
                    reviewedAt: iso(r.reviewed_at),
                    version: r.row_version,
                  }
                : null,
            ];
          }),
        ),
      })),
      nextCursor: keys.length > 50 ? page.at(-1)! : null,
    };
  }

  async setTranslation(
    p: Principal,
    key: string,
    input: {
      texts: Readonly<Record<string, string>>;
      versions: Readonly<Record<string, number | null>>;
    },
  ) {
    const { texts, versions } = input;
    const english = englishBundle();
    const en = english[key];
    if (en === undefined) throw new CustomAPIError(404, 'I18N.KEY_NOT_FOUND');
    const langs = new Set(
      (await this.deps.db.selectFrom('languages').select('code').execute()).map((l) => l.code),
    );
    const want = placeholders(en);
    const errors = [];
    for (const [lang, t] of Object.entries(texts)) {
      if (lang === 'en' || !langs.has(lang)) {
        errors.push({ field: `texts.${lang}`, code: 'I18N.LANGUAGE_NOT_FOUND' });
        continue;
      }
      const value = t.trim();
      if (!value || value.length > 2000) {
        errors.push({ field: `texts.${lang}`, code: 'I18N.TEXT_LENGTH' });
        continue;
      }
      if (placeholders(value).join(',') !== want.join(',')) {
        errors.push({
          field: `texts.${lang}`,
          code: 'I18N.PLACEHOLDERS',
          params: { lang, names: want.map((x) => `{${x}}`).join(' ') || '—' },
        });
      }
    }
    if (errors.length) throw new ValidationError(errors);
    const at = this.now();
    await this.deps.db.transaction().execute(async (trx) => {
      // Optimistic locking per language: each edited text must be the version the editor read.
      const current = new Map(
        (
          await trx
            .selectFrom('translations')
            .select(['lang_code', 'row_version'])
            .where('msg_key', '=', key)
            .where('lang_code', 'in', Object.keys(texts))
            .forUpdate()
            .execute()
        ).map((r) => [r.lang_code, Number(r.row_version)]),
      );
      for (const lang of Object.keys(texts)) {
        if (!(lang in versions)) throw new CustomAPIError(428, 'GEN.PRECONDITION_REQUIRED');
        if ((current.get(lang) ?? null) !== versions[lang]) throw new PreconditionFailedError();
      }
      for (const [lang, t] of Object.entries(texts)) {
        await trx
          .insertInto('translations')
          .values({
            lang_code: lang,
            msg_key: key,
            text: t.trim(),
            source: 'HUMAN',
            reviewed_at: at,
            reviewed_by: this.by(p),
            updated_at: at,
          } as never)
          .onDuplicateKeyUpdate({
            text: t.trim(),
            source: 'HUMAN',
            reviewed_at: at,
            reviewed_by: this.by(p),
            updated_at: at,
            row_version: sql<number>`row_version + 1`,
          } as never)
          .execute();
      }
      await recordAudit(trx, {
        institutionId: null,
        action: 'TRANSLATION_EDITED',
        entityType: 'translation',
        entityRef: key,
        after: { languages: Object.keys(texts) },
      });
    });
    this.deps.i18n?.invalidate();
    return (await this.translations({ q: key })).items.find((i) => i.key === key)!;
  }

  // --- IDN-075 / IDN-076: the log analyser ----------------------------------------------------------------
  async logs(f: {
    user?: string | undefined;
    institutionId?: string | undefined;
    from?: string | undefined;
    to?: string | undefined;
    endpoint?: string | undefined;
    status?: string | undefined;
    correlationId?: string | undefined;
    cursor?: string | undefined;
  }) {
    const to = f.to ? new Date(f.to) : this.now();
    const from = f.from ? new Date(f.from) : new Date(to.getTime() - 86_400_000);
    if (
      Number.isNaN(from.getTime()) ||
      Number.isNaN(to.getTime()) ||
      to < from ||
      to.getTime() - from.getTime() > 31 * 86_400_000
    ) {
      throw new ValidationError([{ field: 'from', code: 'LOG.RANGE', params: { days: 31 } }]);
    }
    const day = (d: Date) =>
      new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(d);
    let q = this.deps.db
      .selectFrom('request_log as r')
      .leftJoin('platform_accounts as a', 'a.public_id', 'r.actor')
      .leftJoin('institutions as i', 'i.public_id', 'r.institution')
      .select([
        'r.id',
        'r.at',
        'r.correlation_id',
        'r.method',
        'r.route',
        'r.path',
        'r.status',
        'r.latency_ms',
        'r.surface',
        'r.actor',
        'r.problem_code',
        'a.first_name',
        'a.last_name',
        'i.name as institution_name',
      ])
      .where('r.logged_on', '>=', day(from))
      .where('r.logged_on', '<=', day(to))
      .where('r.at', '>=', from)
      .where('r.at', '<=', to);
    if (f.user && isUuid(f.user)) q = q.where('r.actor', '=', uuidToBin(f.user));
    if (f.institutionId && isUuid(f.institutionId))
      q = q.where('r.institution', '=', uuidToBin(f.institutionId));
    if (f.endpoint) q = q.where('r.route', 'like', `%${f.endpoint.trim()}%`);
    if (f.status) {
      const s = f.status.trim().toLowerCase();
      if (/^[1-5]xx$/.test(s))
        q = q
          .where('r.status', '>=', Number(s[0]) * 100)
          .where('r.status', '<', Number(s[0]) * 100 + 100);
      else if (/^\d{3}$/.test(s)) q = q.where('r.status', '=', Number(s));
    }
    if (f.correlationId) q = q.where('r.correlation_id', '=', f.correlationId.trim());
    if (f.cursor && /^\d+$/.test(f.cursor)) q = q.where('r.id', '<', f.cursor);
    const rows = await q.orderBy('r.id', 'desc').limit(101).execute();
    const page = rows.slice(0, 100);
    return {
      from: from.toISOString(),
      to: to.toISOString(),
      items: page.map((r) => ({
        id: String(r.id),
        at: iso(r.at),
        correlationId: r.correlation_id,
        method: r.method,
        route: r.route,
        path: r.path,
        status: r.status,
        latencyMs: r.latency_ms,
        surface: r.surface,
        user: r.actor
          ? { id: binToUuid(r.actor), name: nameOf(r.first_name, r.last_name) || null }
          : null,
        institution: r.institution_name ?? null,
        problemCode: r.problem_code,
      })),
      nextCursor: rows.length > 100 ? String(page.at(-1)!.id) : null,
    };
  }

  async log(id: string) {
    if (!/^\d+$/.test(id)) throw new CustomAPIError(404, 'LOG.NOT_FOUND');
    const r = await this.deps.db
      .selectFrom('request_log as r')
      .leftJoin('platform_accounts as a', 'a.public_id', 'r.actor')
      .leftJoin('institutions as i', 'i.public_id', 'r.institution')
      .selectAll('r')
      .select(['a.first_name', 'a.last_name', 'i.name as institution_name'])
      .where('r.id', '=', id)
      .executeTakeFirst();
    if (!r) throw new CustomAPIError(404, 'LOG.NOT_FOUND');
    const activity =
      r.correlation_id && isUuid(r.correlation_id)
        ? await this.deps.db
            .selectFrom('audit_log')
            .select(['action', 'entity_type', 'occurred_at'])
            .where('correlation_id', '=', uuidToBin(r.correlation_id))
            .orderBy('occurred_at')
            .limit(50)
            .execute()
        : [];
    return {
      id: String(r.id),
      at: iso(r.at),
      correlationId: r.correlation_id,
      method: r.method,
      route: r.route,
      path: r.path,
      status: r.status,
      latencyMs: r.latency_ms,
      surface: r.surface,
      user: r.actor
        ? { id: binToUuid(r.actor), name: nameOf(r.first_name, r.last_name) || null }
        : null,
      institution: r.institution_name ?? null,
      clientAddress: r.ip_prefix,
      userAgent: r.user_agent,
      // Query parameter names only, never values or bodies (OI-INT-08).
      queryKeys: r.query_keys ? r.query_keys.split(',') : [],
      problemCode: r.problem_code,
      activity: activity.map((a) => ({
        action: a.action,
        entity: a.entity_type,
        at: iso(a.occurred_at),
      })),
    };
  }

  // --- INT-009 / INT-010: messaging channels --------------------------------------------------------------
  private providerOf(channel: MessagingChannel) {
    if (channel === 'IN_APP') return { provider: 'in-app', testMode: false, integrated: true };
    if (channel === 'SMS')
      return {
        provider: this.deps.providers.sms,
        testMode: this.deps.providers.sms === 'log',
        integrated: true,
      };
    if (channel === 'EMAIL')
      return {
        provider: this.deps.providers.email,
        testMode: this.deps.providers.email === 'log',
        integrated: true,
      };
    const push = this.deps.providers.push ?? 'off';
    if (channel === 'PUSH' && push !== 'off')
      return { provider: push, testMode: push === 'log', integrated: true };
    return { provider: null, testMode: false, integrated: false };
  }

  async channels() {
    const rows = await this.deps.db.selectFrom('messaging_channels').selectAll().execute();
    return {
      items: CHANNELS.map((c) => {
        const r = rows.find((x) => x.channel === c);
        return {
          channel: c,
          ...this.providerOf(c),
          enabled: !!Number(r?.enabled ?? 0),
          templateSet: r?.template_set ?? 'default',
          updatedAt: iso(r?.updated_at),
          version: r?.row_version ?? 0,
        };
      }),
    };
  }

  /** Whether the platform lets a channel send now (used by dispatchers). */
  async channelOn(channel: MessagingChannel) {
    const r = await this.deps.db
      .selectFrom('messaging_channels')
      .select('enabled')
      .where('channel', '=', channel)
      .executeTakeFirst();
    return !!Number(r?.enabled ?? 0) && this.providerOf(channel).integrated;
  }

  async setChannel(
    p: Principal,
    channel: string,
    expected: number,
    input: { enabled: boolean; templateSet?: string | undefined },
  ) {
    const c = CHANNELS.find((x) => x === channel.toUpperCase());
    if (!c) throw new CustomAPIError(404, 'INT.CHANNEL_NOT_FOUND');
    if (input.enabled && !this.providerOf(c).integrated) {
      throw new CustomAPIError(409, 'INT.PROVIDER_NOT_INTEGRATED', { params: { channel: c } });
    }
    if (c === 'IN_APP' && !input.enabled) throw new CustomAPIError(409, 'INT.IN_APP_REQUIRED');
    const set = input.templateSet?.trim();
    if (set !== undefined && (!set || set.length > 40))
      throw new ValidationError([{ field: 'templateSet', code: 'VALIDATION.FORMAT' }]);
    const r = await this.deps.db
      .updateTable('messaging_channels')
      .set({
        enabled: input.enabled ? 1 : 0,
        ...(set ? { template_set: set } : {}),
        updated_by: this.by(p),
        updated_at: this.now(),
        row_version: sql<number>`row_version + 1`,
      })
      .where('channel', '=', c)
      .where('row_version', '=', expected)
      .executeTakeFirst();
    if (Number(r.numUpdatedRows) !== 1) throw new PreconditionFailedError();
    await recordAudit(this.deps.db, {
      institutionId: null,
      action: 'MESSAGING_CHANNEL_CHANGED',
      entityType: 'messaging_channel',
      entityRef: c,
      after: input,
    });
    return (await this.channels()).items.find((x) => x.channel === c)!;
  }
}
