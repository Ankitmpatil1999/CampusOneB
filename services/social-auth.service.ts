/**
 * Sign-in providers for members (CR-03, SRS 6.38.2, RNG-IDN-354..364; IDN-004/005).
 *
 * Authorization-code flow with PKCE: `start` signs the provider, the redirect and the code
 * challenge into a short-lived state; `callback` checks the state and the verifier, resolves the
 * provider identity, and either signs the linked account in on this phone (the new-phone code
 * still applies) or returns a sign-up ticket. The wizard then still collects the mobile (with its
 * code), consent, terms and the personal details; PAN and password become optional.
 *
 * Test mode (client Q17, SOCIAL_MODE=test; refused in production): the app shows the test
 * provider's account chooser and sends `test.<base64url {email,name}>` as the code. Live mode
 * refuses until the provider client ids are configured.
 */
import { createHash } from 'node:crypto';
import type { Kysely } from 'kysely';
import { LIMITS } from '../config/registers';
import type { Database } from '../models/ringpe_models';
import { accountRepository } from '../repositories/account.repository';
import { CustomAPIError, ValidationError } from '../utils/CustomAPIError';
import type { FieldCipher } from '../utils/fieldEncryption';
import type { FlowTokens } from '../utils/flow-tokens';
import { PATTERNS } from '../utils/validators';
import type { DeviceInfo, MemberAuthService, SignInResult } from './member-auth.service';
import type { ClientContext } from './session.service';
import { defaultValues, type SettingValues } from './settings.service';

export interface SocialConfig {
  readonly mode: 'test' | 'live';
  readonly providers: readonly string[];
}

export interface SocialIdentity {
  readonly subject: string;
  readonly email: string;
  readonly firstName: string;
  readonly lastName: string;
}

export type SocialCallbackResult =
  | SignInResult
  | {
      readonly kind: 'signup';
      readonly signupTicket: string;
      readonly expiresAt: Date;
      readonly prefill: {
        readonly provider: string;
        readonly email: string;
        readonly firstName: string;
        readonly lastName: string;
      };
    };

const NAMES: Readonly<Record<string, string>> = { google: 'Google', apple: 'Apple' };
const STATE_SECONDS = 600;
const PKCE = /^[A-Za-z0-9._~-]{43,128}$/;

const s256 = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');

export class SocialAuthService {
  constructor(
    private readonly deps: {
      readonly db: Kysely<Database>;
      readonly cipher: FieldCipher;
      readonly flows: FlowTokens;
      readonly memberAuth: MemberAuthService;
      readonly config: SocialConfig;
      readonly settings?: { values(): Promise<SettingValues> };
    },
  ) {}

  /** Enabled providers with their display names (for the welcome screen). */
  providers() {
    return this.deps.config.providers
      .filter((p) => p in NAMES)
      .map((id) => ({ id, name: NAMES[id] ?? id, mode: this.deps.config.mode }));
  }

  private enabled(provider: string): string {
    const name = NAMES[provider];
    if (!name || !this.deps.config.providers.includes(provider)) {
      throw new CustomAPIError(422, 'IDN.PROVIDER_DISABLED', {
        params: { provider: name ?? provider },
      });
    }
    return name;
  }

  /** IDN-004: the state that carries the provider, the redirect and the PKCE challenge. */
  async start(provider: string, input: { redirectUri: string; codeChallenge: string }) {
    const name = this.enabled(provider);
    if (!PKCE.test(input.codeChallenge)) {
      throw new ValidationError([{ field: 'codeChallenge', code: 'VALIDATION.FORMAT' }]);
    }
    const { token: state, expiresAt } = await this.deps.flows.issue(
      'social-state',
      { p: provider, cc: input.codeChallenge, ru: input.redirectUri },
      STATE_SECONDS,
    );
    if (this.deps.config.mode !== 'test') {
      // Live providers arrive with their client ids (provider set-up, client Q17).
      throw new CustomAPIError(422, 'IDN.PROVIDER_DISABLED', { params: { provider: name } });
    }
    const sep = input.redirectUri.includes('?') ? '&' : '?';
    return {
      mode: 'test' as const,
      state,
      expiresAt,
      authorizationUrl: `${input.redirectUri}${sep}provider=${provider}&state=${encodeURIComponent(state)}&test=1`,
    };
  }

  /** IDN-005: exchange the code; sign the linked account in, or return a sign-up ticket. */
  async callback(
    provider: string,
    input: { code: string; state: string; codeVerifier: string; device: DeviceInfo },
    client: ClientContext = {},
  ): Promise<SocialCallbackResult> {
    this.enabled(provider);
    const claims = await this.deps.flows.verify('social-state', input.state);
    if (
      !claims ||
      claims['p'] !== provider ||
      typeof claims['cc'] !== 'string' ||
      !PKCE.test(input.codeVerifier) ||
      s256(input.codeVerifier) !== claims['cc']
    ) {
      throw new CustomAPIError(401, 'IDN.SOCIAL_STATE_INVALID');
    }
    const identity = this.identity(input.code);
    const subjectHash = this.deps.cipher.blindIndex(
      'social_subject',
      `${provider}:${identity.subject}`,
    );
    const linked = await accountRepository.findBySocial(this.deps.db, provider, subjectHash);
    if (linked) return this.deps.memberAuth.signInOnDevice(linked, input.device, client);

    const values = this.deps.settings ? await this.deps.settings.values() : defaultValues();
    const minutes = values[LIMITS.signupSessionMinutes.key] ?? LIMITS.signupSessionMinutes.value;
    const { token, expiresAt } = await this.deps.flows.issue(
      'social-signup',
      { p: provider, sh: subjectHash.toString('base64url'), em: identity.email },
      minutes * 60,
    );
    return {
      kind: 'signup',
      signupTicket: token,
      expiresAt,
      prefill: {
        provider,
        email: identity.email,
        firstName: identity.firstName,
        lastName: identity.lastName,
      },
    };
  }

  /** The provider identity behind a code. Test mode: `test.<base64url {email, name}>`. */
  private identity(code: string): SocialIdentity {
    if (this.deps.config.mode !== 'test' || !code.startsWith('test.')) {
      throw new CustomAPIError(401, 'IDN.SOCIAL_STATE_INVALID');
    }
    let parsed: { email?: unknown; name?: unknown };
    try {
      parsed = JSON.parse(
        Buffer.from(code.slice(5), 'base64url').toString('utf8'),
      ) as typeof parsed;
    } catch {
      throw new CustomAPIError(401, 'IDN.SOCIAL_STATE_INVALID');
    }
    const email = typeof parsed.email === 'string' ? parsed.email.trim().toLowerCase() : '';
    if (!PATTERNS.email.test(email)) {
      throw new ValidationError([{ field: 'email', code: 'VALIDATION.EMAIL' }]);
    }
    const name = typeof parsed.name === 'string' ? parsed.name.trim().replace(/\s+/g, ' ') : '';
    const [first = '', ...rest] = name.split(' ');
    return { subject: `test:${email}`, email, firstName: first, lastName: rest.join(' ') };
  }
}
