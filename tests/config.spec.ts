import { ConfigError, loadConfig } from '../config/config';

const base = { DATABASE_URL: 'mysql://app:s3cret-pw@localhost:3306/campusone' };

describe('loadConfig', () => {
  it('applies defaults, including limits from the register', () => {
    const c = loadConfig(base);
    expect(c.http.port).toBe(3000);
    expect(c.http.jsonBodyLimitBytes).toBe(1024 * 1024);
    expect(c.http.internalAllowlist).toEqual(['127.0.0.1', '::1']);
    expect(c.rateLimit.windowMs).toBe(60_000);
    expect(c.redis.url).toBeUndefined();
  });

  it('fails fast and names the problem keys without echoing values', () => {
    try {
      loadConfig({ DATABASE_URL: 'postgres://u:topsecret@x/db', HTTP_PORT: '99999' });
      throw new Error('expected failure');
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      const msg = (e as ConfigError).message;
      expect(msg).toContain('DATABASE_URL');
      expect(msg).toContain('HTTP_PORT');
      expect(msg).not.toContain('topsecret');
    }
  });

  it('requires a database URL', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  });

  it('enforces production rules', () => {
    try {
      loadConfig({
        ...base,
        NODE_ENV: 'production',
        API_DOCS_ENABLED: 'true',
        CORS_ORIGINS: 'http://x',
        PUBLIC_WEB_URL: 'http://console.example.in',
      });
      throw new Error('expected failure');
    } catch (e) {
      const problems = (e as ConfigError).problems.join('\n');
      expect(problems).toContain('API_DOCS_ENABLED');
      expect(problems).toContain('REDIS_URL');
      expect(problems).toContain('CORS_ORIGINS');
      expect(problems).toContain('AUTH_SIGNING_KEYS_FILE');
      expect(problems).toContain('AUTH_OPS_SIGNING_KEYS_FILE');
      expect(problems).toContain('FIELD_KEYS_FILE');
      expect(problems).toContain('SMS_PROVIDER');
      expect(problems).toContain('EMAIL_PROVIDER');
      expect(problems).toContain('STORAGE_PROVIDER');
      expect(problems).toContain('FILE_SCAN_MODE');
      expect(problems).toContain('PUBLIC_WEB_URL');
    }
  });

  it('refuses the MySQL root account in production but allows it locally', () => {
    const rootUrl = { DATABASE_URL: 'mysql://root:root@127.0.0.1:3306/campusone' };
    expect(() => loadConfig({ ...base, ...rootUrl })).not.toThrow();
    expect(() =>
      loadConfig({
        ...base,
        ...rootUrl,
        NODE_ENV: 'production',
        REDIS_URL: 'rediss://cache:6380',
        CORS_ORIGINS: 'https://console.campusone.in',
        AUTH_SIGNING_KEYS_FILE: '/run/secrets/signing-keys.json',
        AUTH_OPS_SIGNING_KEYS_FILE: '/run/secrets/ops-signing-keys.json',
        FIELD_KEYS_FILE: '/run/secrets/field-keys.json',
        SMS_PROVIDER: 'kaleyra',
        EMAIL_PROVIDER: 'smtp',
        EMAIL_USER: 'noreply@campusone.example.in',
        EMAIL_PASS: 'test-only',
        STORAGE_PROVIDER: 's3',
        FILE_SCAN_MODE: 'clamav',
      }),
    ).toThrow(/DATABASE_URL: must not use the root account in production/);
  });

  it('shows one-time codes on test servers by default, never in production unless confirmed', () => {
    // Unset: on in development (this machine or a LAN test server), off in tests.
    expect(loadConfig({ ...base, NODE_ENV: 'development' }).notify.otpTestShowCode).toBe(true);
    expect(loadConfig({ ...base, NODE_ENV: 'test' }).notify.otpTestShowCode).toBe(false);
    expect(
      loadConfig({ ...base, NODE_ENV: 'development', OTP_TEST_SHOW_CODE: 'false' }).notify
        .otpTestShowCode,
    ).toBe(false);
    const production = {
      ...base,
      NODE_ENV: 'production',
      REDIS_URL: 'rediss://cache:6380',
      CORS_ORIGINS: 'https://console.campusone.in',
      AUTH_SIGNING_KEYS_FILE: '/run/secrets/signing-keys.json',
      AUTH_OPS_SIGNING_KEYS_FILE: '/run/secrets/ops-signing-keys.json',
      FIELD_KEYS_FILE: '/run/secrets/field-keys.json',
      SMS_PROVIDER: 'kaleyra',
      EMAIL_PROVIDER: 'smtp',
      EMAIL_USER: 'noreply@campusone.example.in',
      EMAIL_PASS: 'test-only',
      STORAGE_PROVIDER: 's3',
      FILE_SCAN_MODE: 'clamav',
      SOCIAL_MODE: 'live',
      BANK_VERIFY_MODE: 'live',
      FINANCING_PARTNER_MODE: 'live',
      PAYMENT_GATEWAY_MODE: 'live',
      RAZORPAY_KEY_ID: 'rzp_live_example',
      RAZORPAY_SECRET: 'example-secret',
      RAZORPAY_WEBHOOK_SECRET: 'example-webhook-secret',
      ACCOUNTING_MODE: 'off',
      PUBLIC_WEB_URL: 'https://app.campusone.in',
    };
    expect(loadConfig(production).notify.otpTestShowCode).toBe(false);
    expect(() => loadConfig({ ...production, OTP_TEST_SHOW_CODE: 'true' })).toThrow(
      /OTP_TEST_SHOW_CODE: must be false in production/,
    );
    // A production-mode test server may show them when both keys say so (client 2026-10-06).
    expect(
      loadConfig({
        ...production,
        OTP_TEST_SHOW_CODE: 'true',
        OTP_TEST_SHOW_CODE_IN_PRODUCTION: 'true',
      }).notify.otpTestShowCode,
    ).toBe(true);
  });

  it('keeps session cookies Secure except on a plain-HTTP development server', () => {
    expect(loadConfig({ ...base, NODE_ENV: 'development' }).http.secureCookies).toBe(false);
    expect(loadConfig({ ...base, NODE_ENV: 'test' }).http.secureCookies).toBe(true);
    expect(
      loadConfig({ ...base, NODE_ENV: 'development', COOKIE_SECURE: 'true' }).http.secureCookies,
    ).toBe(true);
    expect(() => loadConfig({ ...base, NODE_ENV: 'production', COOKIE_SECURE: 'false' })).toThrow(
      /COOKIE_SECURE: must be true in production/,
    );
  });

  it('accepts a complete production configuration', () => {
    const c = loadConfig({
      ...base,
      NODE_ENV: 'production',
      APP_ENV: 'prod',
      REDIS_URL: 'rediss://cache:6380',
      CORS_ORIGINS: 'https://console.campusone.in, https://ops.campusone.in',
      AUTH_SIGNING_KEYS_FILE: '/run/secrets/signing-keys.json',
      AUTH_OPS_SIGNING_KEYS_FILE: '/run/secrets/ops-signing-keys.json',
      FIELD_KEYS_FILE: '/run/secrets/field-keys.json',
      SMS_PROVIDER: 'kaleyra',
      EMAIL_PROVIDER: 'smtp',
      EMAIL_USER: 'noreply@campusone.example.in',
      EMAIL_PASS: 'test-only',
      STORAGE_PROVIDER: 's3',
      FILE_SCAN_MODE: 'clamav',
      SOCIAL_MODE: 'live',
      BANK_VERIFY_MODE: 'live',
      FINANCING_PARTNER_MODE: 'live',
      PAYMENT_GATEWAY_MODE: 'live',
      RAZORPAY_KEY_ID: 'rzp_live_example',
      RAZORPAY_SECRET: 'example-secret',
      RAZORPAY_WEBHOOK_SECRET: 'example-webhook-secret',
      ACCOUNTING_MODE: 'off',
      PUBLIC_WEB_URL: 'https://app.campusone.in/',
    });
    expect(c.social).toEqual({ mode: 'live', providers: ['google', 'apple'] });
    expect(c.http.corsOrigins).toEqual(['https://console.campusone.in', 'https://ops.campusone.in']);
    expect(c.redis.url).toBe('rediss://cache:6380');
    expect(c.publicWebUrl).toBe('https://app.campusone.in');
    expect(c.razorpay).toEqual({
      keyId: 'rzp_live_example',
      keySecret: 'example-secret',
      webhookSecret: 'example-webhook-secret',
    });
  });

  it('refuses Razorpay test keys or missing keys in production, and allows them locally', () => {
    const prod = {
      ...base,
      NODE_ENV: 'production',
      APP_ENV: 'prod',
      REDIS_URL: 'rediss://cache:6380',
      CORS_ORIGINS: 'https://console.campusone.in',
      AUTH_SIGNING_KEYS_FILE: '/run/secrets/signing-keys.json',
      AUTH_OPS_SIGNING_KEYS_FILE: '/run/secrets/ops-signing-keys.json',
      FIELD_KEYS_FILE: '/run/secrets/field-keys.json',
      SMS_PROVIDER: 'kaleyra',
      EMAIL_PROVIDER: 'smtp',
      EMAIL_USER: 'noreply@campusone.example.in',
      EMAIL_PASS: 'test-only',
      STORAGE_PROVIDER: 's3',
      FILE_SCAN_MODE: 'clamav',
      SOCIAL_MODE: 'live',
      BANK_VERIFY_MODE: 'live',
      FINANCING_PARTNER_MODE: 'live',
      PAYMENT_GATEWAY_MODE: 'live',
      ACCOUNTING_MODE: 'off',
      PUBLIC_WEB_URL: 'https://app.campusone.in/',
    };
    expect(() =>
      loadConfig({
        ...prod,
        RAZORPAY_KEY_ID: 'rzp_test_example',
        RAZORPAY_SECRET: 's',
        RAZORPAY_WEBHOOK_SECRET: 'w',
      }),
    ).toThrow(/RAZORPAY_KEY_ID/);
    expect(() => loadConfig(prod)).toThrow(/RAZORPAY_KEY_ID/);
    const local = loadConfig({
      ...base,
      PAYMENT_GATEWAY_MODE: 'live',
      RAZORPAY_KEY_ID: 'rzp_test_example',
      RAZORPAY_SECRET: 's',
    });
    expect(local.razorpay).toEqual({
      keyId: 'rzp_test_example',
      keySecret: 's',
      webhookSecret: null,
    });
  });
});
