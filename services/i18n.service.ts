/**
 * Translation bundles (PLT-009, FR-PLT-01, OI-GAS-20): the default (English) bundle comes from the
 * registers; other enabled languages fall back to English key by key. Translated texts come from the
 * translations table: machine drafts seeded now (client 2026-10-02, served with `machineDraft`),
 * reviewed and edited later through the translation upload (maker-checker, 6.30).
 */
import { createHash } from 'node:crypto';
import type { Kysely } from 'kysely';
import { englishBundle } from '../config/registers';
import type { Database } from '../models/ringpe_models';

export interface LanguageBundle {
  readonly etag: string;
  readonly body: string;
}

export interface LanguageOption {
  readonly code: string;
  readonly name: string;
  readonly nativeName: string;
  readonly isDefault: boolean;
}

export class I18nService {
  private readonly cache = new Map<string, LanguageBundle>();

  /** Drops cached bundles after a language or translation change (IDN-072/074). */
  invalidate(lang?: string) {
    if (lang) this.cache.delete(lang);
    else this.cache.clear();
  }

  constructor(private readonly db: Kysely<Database>) {}

  /** Enabled languages in picker order (client, Q18: Kannada next to English everywhere). */
  async languages(): Promise<LanguageOption[]> {
    const rows = await this.db
      .selectFrom('languages')
      .select(['code', 'name', 'native_name', 'is_default'])
      .where('enabled', '=', 1)
      .orderBy('sort_order')
      .orderBy('code')
      .execute();
    return rows.map((r) => ({
      code: r.code,
      name: r.name,
      nativeName: r.native_name,
      isDefault: Boolean(r.is_default),
    }));
  }

  /** The bundle for an enabled language, or undefined when it is unknown or switched off. */
  async bundle(lang: string): Promise<LanguageBundle | undefined> {
    const language = await this.db
      .selectFrom('languages')
      .select(['code', 'enabled', 'is_default'])
      .where('code', '=', lang)
      .executeTakeFirst();
    if (!language || !language.enabled) return undefined;
    const cached = this.cache.get(lang);
    if (cached) return cached;
    const english = englishBundle();
    const rows =
      lang === 'en'
        ? []
        : await this.db
            .selectFrom('translations')
            .select(['msg_key', 'text', 'source'])
            .where('lang_code', '=', lang)
            .execute();
    const translated = Object.fromEntries(rows.map((r) => [r.msg_key, r.text]));
    // Register keys fall back to English one by one; app screen keys (ui.*) travel as translated.
    const doc = {
      lang,
      fallback: 'en',
      complete: lang === 'en' || Object.keys(english).every((k) => k in translated),
      machineDraft: rows.some((r) => r.source === 'MACHINE'),
      messages: { ...english, ...translated },
    };
    const body = JSON.stringify(doc);
    const etag = `"${createHash('sha256').update(body).digest('base64url').slice(0, 27)}"`;
    const bundle = { etag, body };
    this.cache.set(lang, bundle);
    return bundle;
  }
}
