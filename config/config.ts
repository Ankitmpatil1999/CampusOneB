/**
 * Configuration validated at start-up (brief §7.3: fail fast). Every key is documented in
 * `.env.example`. Defaults for limits come from the limits register
 * (`config/registers`, docs/01 §5); values are never echoed in errors (they may be secrets).
 */
import { z } from 'zod';
import { LIMITS } from './registers';

const csv = z
  .string()
  .default('')
  .transform((s) =>
    s
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean),
  );
const bool = (def: boolean) =>
  z
    .enum(['true', 'false'])
    .default(def ? 'true' : 'false')
    .transform((v) => v === 'true');
const port = (def: number) => z.coerce.number().int().min(1).max(65535).default(def);
const mysqlUrl = z.string().regex(/^mysql:\/\/[^\s]+$/, 'must be a mysql:// connection URL');

/**
 * A web address people open: http(s), a real host, the scheme written once. "https://http://x"
 * parses as a URL whose host is "http" and made every link the API sends broken (2026-10-13).
 */
const webAddress = (withPath: boolean) => (raw: string) => {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    if (/^https?$/i.test(u.hostname) || raw.indexOf('://') !== raw.lastIndexOf('://')) return false;
    if (u.search || u.hash || u.username || u.password) return false;
    return withPath || u.pathname === '/';
  } catch {
    return false;
  }
};

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    APP_ENV: z.enum(['local', 'ci', 'dev', 'uat', 'prod']).default('local'),
    APP_VERSION: z.string().default('0.0.0-local'),
    GIT_COMMIT: z.string().default('unknown'),

    HTTP_HOST: z.string().default('0.0.0.0'),
    HTTP_PORT: port(3000),
    WORKER_HEALTH_PORT: port(3001),
    TRUST_PROXY: z.string().default('loopback'),
    INTERNAL_ALLOWLIST: csv,
    TRUST_INBOUND_CORRELATION_ID: bool(false),
    CORS_ORIGINS: csv.refine((list) => list.every(webAddress(false)), {
      message: 'must list origins such as https://school.example.in or https://192.168.1.10:4200',
    }),
    // Web session cookies are `__Host-` and Secure, which browsers keep only over HTTPS or on
    // localhost. A plain-HTTP test server on the LAN (client 2026-10-06) needs them without: unset,
    // they are Secure everywhere except development. Production always keeps them Secure.
    COOKIE_SECURE: z
      .enum(['true', 'false'])
      .optional()
      .transform((v) => (v === undefined ? undefined : v === 'true')),
    API_DOCS_ENABLED: bool(false),

    // HTTPS served by the API itself (reference server.js: USE_HTTPS, KEY_PATH, CERTIFICATE_PATH,
    // CERT_PASSPHRASE; TLS 1.2 or newer). Leave it off when a load balancer or reverse proxy ends
    // TLS in front of the API. CERTIFICATE_PATH is the full chain (certificate + intermediates).
    USE_HTTPS: bool(false),
    KEY_PATH: z.string().trim().optional(),
    CERTIFICATE_PATH: z.string().trim().optional(),
    CERT_PASSPHRASE: z.string().optional(),
    // With USE_HTTPS: a plain-HTTP port that only redirects to the HTTPS address (e.g. 80).
    HTTP_REDIRECT_PORT: z.coerce.number().int().min(1).max(65535).optional(),
    // The built web application (CampusOne_Web_App: npm run build → dist/browser). Set, the API
    // serves it on the same address, so the console, terminals and API share one HTTPS origin.
    WEB_ROOT: z.string().trim().optional(),

    LOG_LEVEL: z.enum(['error', 'warn', 'info', 'http', 'verbose', 'debug']).default('info'),
    LOG_DIR: z.string().optional(),
    LOG_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(365),

    DATABASE_URL: mysqlUrl,
    DB_POOL_SIZE: z.coerce.number().int().min(1).max(200).default(20),
    DB_MIGRATOR_URL: mysqlUrl.optional(),

    REDIS_URL: z
      .string()
      .regex(/^rediss?:\/\/[^\s]+$/, 'must be a redis:// or rediss:// URL')
      .optional(),

    AUTH_ISSUER: z.string().default('campusone'),
    // ES256 private keys (JWK set; the first key signs, the rest still verify during rotation).
    // The back office has its own keys and audience (ADR-0011). Local: `npm run keys:generate`.
    AUTH_SIGNING_KEYS_FILE: z.string().optional(),
    AUTH_OPS_SIGNING_KEYS_FILE: z.string().optional(),
    // Field encryption and blind-index keys (ADR-0012); KMS wrapping arrives with Q3.
    FIELD_KEYS_FILE: z.string().optional(),

    // One-time codes go to the log instead of a phone in development only (never in production).
    OTP_DEV_ECHO: bool(false),
    // Test environments: return one-time codes in the API response so the apps show them on the
    // sign-in screens until an SMS provider is connected (client, Q17). Unset, it is on in
    // development — any test server, on this machine or the LAN (client 2026-10-06) — and off
    // otherwise. Production refuses it unless OTP_TEST_SHOW_CODE_IN_PRODUCTION confirms it (client
    // 2026-10-06: "enable now, will change later"); switch both off before real people use it.
    OTP_TEST_SHOW_CODE: z
      .enum(['true', 'false'])
      .optional()
      .transform((v) => (v === undefined ? undefined : v === 'true')),
    OTP_TEST_SHOW_CODE_IN_PRODUCTION: bool(false),
    SMS_PROVIDER: z.enum(['log', 'kaleyra']).default('log'),
    SOCIAL_MODE: z.enum(['test', 'live']).default('test'),
    BANK_VERIFY_MODE: z.enum(['test', 'live']).default('test'),
    // The sponsor bank that holds the virtual accounts (C-11, Q14 M12): example values until chosen.
    VA_BANK_NAME: z.string().trim().min(2).default('Example Bank (example)'),
    VA_BANK_IFSC: z
      .string()
      .trim()
      .regex(/^[A-Z]{4}0[A-Z0-9]{6}$/)
      .default('EXMP0000001'),
    // The fee-financing partner (13.11–13.12, OQ-03): an example until the client names it. test =
    // registrations are acknowledged at once and decisions arrive on the signed webhook; live = the
    // partner's API once known. Refused in production: test.
    FINANCING_PARTNER_MODE: z.enum(['test', 'live']).default('test'),
    // The online payment gateway for application and admission fees (Q17: Razorpay, 2026-10-09):
    // test = in-app test checkout; live = Razorpay with the keys below (its rzp_test_ keys in
    // development). Refused in production: test, and Razorpay test keys.
    PAYMENT_GATEWAY_MODE: z.enum(['test', 'live']).default('test'),
    RAZORPAY_KEY_ID: z.string().trim().max(64).optional(),
    RAZORPAY_SECRET: z.string().trim().max(128).optional(),
    RAZORPAY_WEBHOOK_SECRET: z.string().trim().max(128).optional(),
    // Kept for reference with Razorpay support; not sent to the API.
    RAZORPAY_MERCHANT_ID: z.string().trim().max(64).optional(),
    ACCOUNTING_MODE: z.enum(['test', 'off']).default('test'),
    FINANCING_PARTNER_NAME: z.string().trim().min(2).max(120).default('Example Finance (example)'),
    // Address of the web application, for links sent by e-mail (staff password reset).
    // The web app's development server is HTTPS (npm start, client 2026-10-12).
    PUBLIC_WEB_URL: z.string().trim().default('https://localhost:4200').refine(webAddress(true), {
      message: 'must be the address people open, e.g. https://school.example.in (the scheme once)',
    }),
    SOCIAL_PROVIDERS: z.string().default('google,apple'),
    EMAIL_PROVIDER: z.enum(['log', 'smtp']).default('log'),
    // SMTP (client 2026-10-16: the earlier application's mail server). 587 = STARTTLS (secure
    // false), 465 = TLS from the start (secure true). EMAIL_USER / EMAIL_PASS keep the earlier
    // application's names. The certificate is always checked; EMAIL_TLS_VERIFY=false is for a
    // test server only and is refused in production.
    EMAIL_SMTP_HOST: z.string().trim().max(200).default('mail.sabadotechnologies.com'),
    EMAIL_SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
    EMAIL_SMTP_SECURE: bool(false),
    EMAIL_USER: z.string().trim().max(200).optional(),
    EMAIL_PASS: z.string().max(200).optional(),
    EMAIL_FROM: z.string().trim().max(200).optional(),
    EMAIL_FROM_NAME: z.string().trim().min(1).max(100).default('CampusOne'),
    EMAIL_TLS_VERIFY: bool(true),
    // Phone pushes (client 2026-10-19; integrations/push.provider.ts): `fcm` = Firebase Cloud
    // Messaging with the project's service-account key file (kept out of the repository, like the
    // keys in keys/); `log` writes them to the app log (refused in production); `off` sends none.
    PUSH_PROVIDER: z.enum(['off', 'log', 'fcm']).default('off'),
    PUSH_FCM_SERVICE_ACCOUNT_FILE: z.string().trim().max(500).optional(),
    // Google Maps for transport (client 2026-10-21; integrations/maps.provider.ts): `google` =
    // road distances through the Routes API with GOOGLE_MAPS_SERVER_KEY; `test` = straight-line
    // estimates, shown as such (refused in production); `off` = none. GOOGLE_MAPS_BROWSER_KEY is
    // the key the console's map loads with (restrict it to the server's address in Google Cloud).
    MAPS_PROVIDER: z.enum(['off', 'test', 'google']).default('off'),
    GOOGLE_MAPS_SERVER_KEY: z.string().trim().max(200).optional(),
    GOOGLE_MAPS_BROWSER_KEY: z.string().trim().max(200).optional(),

    // Uploads (CR-07): private storage and antivirus scan.
    STORAGE_PROVIDER: z.enum(['local', 's3']).default('local'),
    UPLOAD_DIR: z.string().default('uploads'),
    FILE_SCAN_MODE: z.enum(['skip', 'clamav']).default('skip'),
    FILE_URL_TTL_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),

    RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().min(1).default(60),
    // Per network address: a school's Wi-Fi puts hundreds of phones behind one (S-05).
    RATE_LIMIT_GLOBAL_MAX: z.coerce.number().int().min(1).default(3000),
    // Per signed-in session (surface and account).
    RATE_LIMIT_SESSION_MAX: z.coerce.number().int().min(1).default(300),
    RATE_LIMIT_AUTH_MAX: z.coerce.number().int().min(1).default(20),
    RATE_LIMIT_EXEMPT_IPS: csv,

    JSON_BODY_LIMIT_BYTES: z.coerce.number().int().min(1024).default(LIMITS.jsonBodyMaxBytes.value),
    HEALTH_CHECK_TIMEOUT_MS: z.coerce.number().int().min(100).default(2000),
    SHUTDOWN_GRACE_SECONDS: z.coerce.number().int().min(1).max(120).default(20),
  })
  .superRefine((env, ctx) => {
    const problem = (path: string, message: string) =>
      ctx.addIssue({ code: 'custom', path: [path], message });
    if (env.USE_HTTPS) {
      if (env.PUBLIC_WEB_URL.startsWith('http://')) {
        problem('PUBLIC_WEB_URL', 'must start with https:// when USE_HTTPS is on');
      }
      if (!env.KEY_PATH) problem('KEY_PATH', 'is required with USE_HTTPS (the private key file)');
      if (!env.CERTIFICATE_PATH) {
        problem('CERTIFICATE_PATH', 'is required with USE_HTTPS (the certificate chain file)');
      }
      if (env.HTTP_REDIRECT_PORT === env.HTTP_PORT) {
        problem('HTTP_REDIRECT_PORT', 'must differ from HTTP_PORT');
      }
    } else if (env.HTTP_REDIRECT_PORT) {
      problem('HTTP_REDIRECT_PORT', 'needs USE_HTTPS=true');
    }
    if (env.EMAIL_PROVIDER === 'smtp') {
      if (!env.EMAIL_USER || !env.EMAIL_PASS)
        problem('EMAIL_USER', 'and EMAIL_PASS are required with EMAIL_PROVIDER=smtp');
      const from = env.EMAIL_FROM || env.EMAIL_USER || '';
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(from))
        problem('EMAIL_FROM', 'must be an e-mail address (default: EMAIL_USER)');
    }
    if (env.PUSH_PROVIDER === 'fcm' && !env.PUSH_FCM_SERVICE_ACCOUNT_FILE)
      problem('PUSH_FCM_SERVICE_ACCOUNT_FILE', 'is required with PUSH_PROVIDER=fcm');
    if (env.MAPS_PROVIDER === 'google' && !env.GOOGLE_MAPS_SERVER_KEY)
      problem('GOOGLE_MAPS_SERVER_KEY', 'is required with MAPS_PROVIDER=google');
    if (env.NODE_ENV !== 'production') return;
    if (env.PUSH_PROVIDER === 'log')
      problem('PUSH_PROVIDER', 'must be fcm or off in production (log only writes the app log)');
    if (env.MAPS_PROVIDER === 'test')
      problem(
        'MAPS_PROVIDER',
        'must be google or off in production (test only estimates distances)',
      );
    if (env.API_DOCS_ENABLED) problem('API_DOCS_ENABLED', 'must be false in production');
    if (!env.REDIS_URL) problem('REDIS_URL', 'is required in production (several instances)');
    if (env.CORS_ORIGINS.length === 0) problem('CORS_ORIGINS', 'is required in production');
    if (env.COOKIE_SECURE === false) {
      problem('COOKIE_SECURE', 'must be true in production (sessions only over HTTPS)');
    }
    if (env.CORS_ORIGINS.some((o) => !o.startsWith('https://'))) {
      problem('CORS_ORIGINS', 'must list https origins only in production');
    }
    if (!env.AUTH_SIGNING_KEYS_FILE) problem('AUTH_SIGNING_KEYS_FILE', 'is required in production');
    if (!env.AUTH_OPS_SIGNING_KEYS_FILE) {
      problem('AUTH_OPS_SIGNING_KEYS_FILE', 'is required in production');
    }
    if (!env.FIELD_KEYS_FILE) problem('FIELD_KEYS_FILE', 'is required in production');
    if (env.OTP_DEV_ECHO) problem('OTP_DEV_ECHO', 'must be false in production');
    if (env.OTP_TEST_SHOW_CODE && !env.OTP_TEST_SHOW_CODE_IN_PRODUCTION) {
      problem(
        'OTP_TEST_SHOW_CODE',
        'must be false in production (a test server may confirm it with OTP_TEST_SHOW_CODE_IN_PRODUCTION=true)',
      );
    }
    if (!env.PUBLIC_WEB_URL.startsWith('https://'))
      problem('PUBLIC_WEB_URL', 'must be the https address of the web application in production');
    if (env.BANK_VERIFY_MODE === 'test')
      problem('BANK_VERIFY_MODE', 'must be live in production (test bank-account checks)');
    if (env.PAYMENT_GATEWAY_MODE === 'test')
      problem('PAYMENT_GATEWAY_MODE', 'must be live in production (test checkout)');
    if (env.PAYMENT_GATEWAY_MODE === 'live') {
      if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_SECRET)
        problem('RAZORPAY_KEY_ID', 'and RAZORPAY_SECRET are required for the live gateway');
      else if (env.RAZORPAY_KEY_ID.startsWith('rzp_test_'))
        problem(
          'RAZORPAY_KEY_ID',
          'must be a live key in production (rzp_test_ is Razorpay test mode)',
        );
      if (!env.RAZORPAY_WEBHOOK_SECRET)
        problem('RAZORPAY_WEBHOOK_SECRET', 'is required in production (payment webhooks)');
    }
    if (env.ACCOUNTING_MODE === 'test')
      problem(
        'ACCOUNTING_MODE',
        'must be off in production until the accounting package is chosen (test package)',
      );
    // FINANCING-OFF (client 2026-10-22): the fee financing partner is commented out in the whole application; uncomment to bring it back.
    // if (env.FINANCING_PARTNER_MODE === 'test')
    //   problem('FINANCING_PARTNER_MODE', 'must be live in production (test financing partner)');
    if (env.SOCIAL_MODE === 'test')
      problem('SOCIAL_MODE', 'must be live in production (test sign-in providers)');
    if (env.SMS_PROVIDER === 'log')
      problem('SMS_PROVIDER', 'must be a real provider in production');
    if (env.EMAIL_PROVIDER === 'log') {
      problem('EMAIL_PROVIDER', 'must be a real provider in production');
    }
    if (!env.EMAIL_TLS_VERIFY) {
      problem('EMAIL_TLS_VERIFY', "must be true in production (the mail server's certificate)");
    }
    if (env.STORAGE_PROVIDER === 'local') {
      problem('STORAGE_PROVIDER', 'must be object storage in production');
    }
    if (env.FILE_SCAN_MODE === 'skip') problem('FILE_SCAN_MODE', 'must scan uploads in production');
    // Local development may use the MySQL root login (client choice, 2026-10-02); production
    // must connect as the least-privilege app user (brief §6.4: the app user has no DDL).
    if (/^mysql:\/\/root[:@]/i.test(env.DATABASE_URL)) {
      problem('DATABASE_URL', 'must not use the root account in production');
    }
  });

export type Env = z.infer<typeof envSchema>;

export interface Config {
  readonly nodeEnv: Env['NODE_ENV'];
  readonly appEnv: Env['APP_ENV'];
  readonly version: string;
  readonly commit: string;
  readonly http: {
    readonly host: string;
    readonly port: number;
    readonly workerHealthPort: number;
    readonly trustProxy: string;
    readonly internalAllowlist: readonly string[];
    readonly trustInboundCorrelationId: boolean;
    readonly corsOrigins: readonly string[];
    /** `__Host-` Secure session cookies (false only on a plain-HTTP development server). */
    readonly secureCookies: boolean;
    readonly apiDocsEnabled: boolean;
    readonly jsonBodyLimitBytes: number;
    /** The built web application served on the same address, when set. */
    readonly webRoot?: string;
  };
  /** HTTPS served by the API (USE_HTTPS); absent when TLS ends in front of it. */
  readonly tls?: {
    readonly keyPath: string;
    readonly certPath: string;
    readonly passphrase?: string;
    readonly redirectPort?: number;
  };
  readonly log: {
    readonly level: Env['LOG_LEVEL'];
    readonly dir?: string;
    readonly retentionDays: number;
  };
  readonly db: { readonly url: string; readonly poolSize: number; readonly migratorUrl?: string };
  readonly redis: { readonly url?: string };
  readonly auth: {
    readonly issuer: string;
    readonly signingKeysFile?: string;
    readonly opsSigningKeysFile?: string;
  };
  readonly fieldKeysFile?: string;
  /** Social sign-in (CR-03): test = the in-app test provider (client Q17); live = real providers. */
  /** Bank-account check (penny drop): test answers at once (client Q17); live = the provider. */
  readonly bankVerifyMode: Env['BANK_VERIFY_MODE'];
  /** The bank holding the virtual accounts (example values until the client names it). */
  readonly vaBank: { readonly name: string; readonly ifsc: string; readonly example: boolean };
  /** The fee-financing partner (OQ-03): test until the client names it; refused in production. */
  readonly financing: {
    readonly mode: Env['FINANCING_PARTNER_MODE'];
    readonly partnerName: string;
  };
  /** Vouchers to the accounting package (OQ-04): test, or off (vouchers wait); test refused in production. */
  readonly accountingMode: Env['ACCOUNTING_MODE'];
  /** The online payment gateway (Q17): test, or live (Razorpay); test refused in production. */
  readonly paymentGatewayMode: Env['PAYMENT_GATEWAY_MODE'];
  /** Razorpay keys for the live gateway (never logged); null without them. */
  readonly razorpay: {
    readonly keyId: string;
    readonly keySecret: string;
    readonly webhookSecret: string | null;
  } | null;
  /** Address of the web application (links in e-mails). */
  readonly publicWebUrl: string;
  readonly social: {
    readonly mode: Env['SOCIAL_MODE'];
    readonly providers: readonly string[];
  };
  readonly notify: {
    readonly otpDevEcho: boolean;
    readonly otpTestShowCode: boolean;
    readonly sms: Env['SMS_PROVIDER'];
    readonly email: Env['EMAIL_PROVIDER'];
    /** SMTP settings (EMAIL_PROVIDER=smtp); the password is never logged. */
    readonly smtp: {
      readonly host: string;
      readonly port: number;
      readonly secure: boolean;
      readonly user: string | null;
      readonly pass: string | null;
      readonly from: string | null;
      readonly fromName: string;
      readonly tlsVerify: boolean;
    };
    readonly push: Env['PUSH_PROVIDER'];
    /** Firebase service-account key file (PUSH_PROVIDER=fcm). */
    readonly pushServiceAccountFile: string | null;
  };
  /** Google Maps for transport (client 2026-10-21). */
  readonly maps: {
    readonly provider: Env['MAPS_PROVIDER'];
    /** Routes API key, server side only (never sent to a client). */
    readonly serverKey: string | null;
    /** The console's Maps JavaScript key (public by nature; restricted to the site in Google Cloud). */
    readonly browserKey: string | null;
  };
  readonly files: {
    readonly storage: Env['STORAGE_PROVIDER'];
    readonly uploadDir: string;
    readonly scanMode: Env['FILE_SCAN_MODE'];
    readonly urlTtlSeconds: number;
  };
  readonly rateLimit: {
    readonly windowMs: number;
    readonly globalMax: number;
    readonly sessionMax: number;
    readonly authMax: number;
    readonly exemptIps: readonly string[];
  };
  readonly health: { readonly timeoutMs: number };
  readonly shutdownGraceMs: number;
}

export class ConfigError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

/** Parses and validates the environment. Problems name the key, never its value. */
export function loadConfig(source: Readonly<Record<string, string | undefined>>): Config {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    );
  }
  const e = parsed.data;
  return {
    nodeEnv: e.NODE_ENV,
    appEnv: e.APP_ENV,
    version: e.APP_VERSION,
    commit: e.GIT_COMMIT,
    http: {
      host: e.HTTP_HOST,
      port: e.HTTP_PORT,
      workerHealthPort: e.WORKER_HEALTH_PORT,
      trustProxy: e.TRUST_PROXY,
      internalAllowlist: e.INTERNAL_ALLOWLIST.length ? e.INTERNAL_ALLOWLIST : ['127.0.0.1', '::1'],
      trustInboundCorrelationId: e.TRUST_INBOUND_CORRELATION_ID,
      corsOrigins: e.CORS_ORIGINS,
      secureCookies: e.COOKIE_SECURE ?? e.NODE_ENV !== 'development',
      apiDocsEnabled: e.API_DOCS_ENABLED,
      jsonBodyLimitBytes: e.JSON_BODY_LIMIT_BYTES,
      ...(e.WEB_ROOT ? { webRoot: e.WEB_ROOT } : {}),
    },
    ...(e.USE_HTTPS && e.KEY_PATH && e.CERTIFICATE_PATH
      ? {
          tls: {
            keyPath: e.KEY_PATH,
            certPath: e.CERTIFICATE_PATH,
            ...(e.CERT_PASSPHRASE ? { passphrase: e.CERT_PASSPHRASE } : {}),
            ...(e.HTTP_REDIRECT_PORT ? { redirectPort: e.HTTP_REDIRECT_PORT } : {}),
          },
        }
      : {}),
    log: {
      level: e.LOG_LEVEL,
      ...(e.LOG_DIR ? { dir: e.LOG_DIR } : {}),
      retentionDays: e.LOG_RETENTION_DAYS,
    },
    db: {
      url: e.DATABASE_URL,
      poolSize: e.DB_POOL_SIZE,
      ...(e.DB_MIGRATOR_URL ? { migratorUrl: e.DB_MIGRATOR_URL } : {}),
    },
    redis: e.REDIS_URL ? { url: e.REDIS_URL } : {},
    auth: {
      issuer: e.AUTH_ISSUER,
      ...(e.AUTH_SIGNING_KEYS_FILE ? { signingKeysFile: e.AUTH_SIGNING_KEYS_FILE } : {}),
      ...(e.AUTH_OPS_SIGNING_KEYS_FILE ? { opsSigningKeysFile: e.AUTH_OPS_SIGNING_KEYS_FILE } : {}),
    },
    ...(e.FIELD_KEYS_FILE ? { fieldKeysFile: e.FIELD_KEYS_FILE } : {}),
    bankVerifyMode: e.BANK_VERIFY_MODE,
    vaBank: {
      name: e.VA_BANK_NAME,
      ifsc: e.VA_BANK_IFSC,
      example: e.VA_BANK_IFSC === 'EXMP0000001',
    },
    financing: { mode: e.FINANCING_PARTNER_MODE, partnerName: e.FINANCING_PARTNER_NAME },
    paymentGatewayMode: e.PAYMENT_GATEWAY_MODE,
    razorpay:
      e.RAZORPAY_KEY_ID && e.RAZORPAY_SECRET
        ? {
            keyId: e.RAZORPAY_KEY_ID,
            keySecret: e.RAZORPAY_SECRET,
            webhookSecret: e.RAZORPAY_WEBHOOK_SECRET || null,
          }
        : null,
    accountingMode: e.ACCOUNTING_MODE,
    publicWebUrl: e.PUBLIC_WEB_URL.replace(/\/+$/, ''),
    social: {
      mode: e.SOCIAL_MODE,
      providers: e.SOCIAL_PROVIDERS.split(',')
        .map((p) => p.trim().toLowerCase())
        .filter(Boolean),
    },
    notify: {
      otpDevEcho: e.OTP_DEV_ECHO,
      otpTestShowCode: e.OTP_TEST_SHOW_CODE ?? e.NODE_ENV === 'development',
      sms: e.SMS_PROVIDER,
      email: e.EMAIL_PROVIDER,
      smtp: {
        host: e.EMAIL_SMTP_HOST,
        port: e.EMAIL_SMTP_PORT,
        secure: e.EMAIL_SMTP_SECURE,
        user: e.EMAIL_USER || null,
        pass: e.EMAIL_PASS || null,
        from: e.EMAIL_FROM || e.EMAIL_USER || null,
        fromName: e.EMAIL_FROM_NAME,
        tlsVerify: e.EMAIL_TLS_VERIFY,
      },
      push: e.PUSH_PROVIDER,
      pushServiceAccountFile: e.PUSH_FCM_SERVICE_ACCOUNT_FILE || null,
    },
    maps: {
      provider: e.MAPS_PROVIDER,
      serverKey: e.GOOGLE_MAPS_SERVER_KEY || null,
      browserKey: e.GOOGLE_MAPS_BROWSER_KEY || null,
    },
    files: {
      storage: e.STORAGE_PROVIDER,
      uploadDir: e.UPLOAD_DIR,
      scanMode: e.FILE_SCAN_MODE,
      urlTtlSeconds: e.FILE_URL_TTL_SECONDS,
    },
    rateLimit: {
      windowMs: e.RATE_LIMIT_WINDOW_SECONDS * 1000,
      globalMax: e.RATE_LIMIT_GLOBAL_MAX,
      sessionMax: e.RATE_LIMIT_SESSION_MAX,
      authMax: e.RATE_LIMIT_AUTH_MAX,
      exemptIps: e.RATE_LIMIT_EXEMPT_IPS,
    },
    health: { timeoutMs: e.HEALTH_CHECK_TIMEOUT_MS },
    shutdownGraceMs: e.SHUTDOWN_GRACE_SECONDS * 1000,
  };
}
