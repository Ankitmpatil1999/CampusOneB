import {
  ALL_STATUS_DOMAINS,
  INSTITUTION,
  JOB_RUN,
  LIMITS,
  NEW,
  allLimits,
  allMessages,
  checkTransition,
  nextStates,
  renderMessage,
  renderStatusSeedSql,
  validateCatalogue,
  validateDomain,
} from '../config/registers/index';

describe('status register', () => {
  it.each(ALL_STATUS_DOMAINS.map((d) => [d.domain, d]))('%s is well formed', (_name, domain) => {
    expect(validateDomain(domain)).toEqual([]);
  });

  it('has unique domain keys', () => {
    const keys = ALL_STATUS_DOMAINS.map((d) => d.domain);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('allows only registered transitions (RNG-GOV-009)', () => {
    expect(checkTransition(INSTITUTION, 'PENDING_ACTIVATION', 'ACTIVE')).toMatchObject({
      ok: true,
    });
    expect(checkTransition(INSTITUTION, 'ACTIVE', 'PENDING_ACTIVATION')).toEqual({
      ok: false,
      reason: 'NOT_ALLOWED',
    });
    expect(checkTransition(INSTITUTION, NEW, 'PENDING_ACTIVATION')).toMatchObject({ ok: true });
    expect(checkTransition(INSTITUTION, NEW, 'ACTIVE')).toEqual({
      ok: false,
      reason: 'NOT_ALLOWED',
    });
  });

  it('refuses transitions out of a terminal value (RNG-GOV-012)', () => {
    expect(checkTransition(INSTITUTION, 'CANCELLED', 'ACTIVE')).toEqual({
      ok: false,
      reason: 'TERMINAL',
    });
    expect(checkTransition(JOB_RUN, 'SUCCESS', 'FAILED')).toEqual({
      ok: false,
      reason: 'TERMINAL',
    });
  });

  it('refuses unknown values', () => {
    expect(checkTransition(INSTITUTION, 'ACTIVE', 'TRIAL' as never)).toEqual({
      ok: false,
      reason: 'UNKNOWN_VALUE',
    });
  });

  it('lists next states', () => {
    expect(nextStates(INSTITUTION, 'ACTIVE').sort()).toEqual(['CANCELLED', 'SUSPENDED']);
  });

  it('maps the registered value of a 27.2 domain', () => {
    expect(INSTITUTION.values.find((v) => v.code === 'ACTIVE')?.registerValue).toBe('1');
  });

  it('flags a value with neither a 27.2 row nor a register change', () => {
    const broken = { ...JOB_RUN, rc: null };
    expect(validateDomain(broken).length).toBeGreaterThan(0);
  });

  it('renders seed SQL without creation transitions and with escaped quotes', () => {
    const sql = renderStatusSeedSql([
      {
        ...JOB_RUN,
        transitions: [...JOB_RUN.transitions, { from: 'STARTED', to: 'FAILED', operation: "it's" }],
      },
    ]);
    expect(sql).toContain(
      "INSERT INTO ref_status_values (domain, code, label_key, tone, is_terminal, sort_order, register_value, srs_ref, rc_ref) VALUES ('job_run', 'STARTED'",
    );
    expect(sql).toContain("'it''s'");
    expect(sql).not.toContain("'(new)'");
  });
});

describe('message register', () => {
  it('is consistent (keys, classes, 27.5 ids, placeholders)', () => {
    expect(validateCatalogue(allMessages())).toEqual([]);
  });

  it('keeps class K wording verbatim from 27.5', () => {
    for (const m of allMessages().filter((x) => x.class === 'K' && !x.placeholders)) {
      expect(m.en).toBe(m.srsText);
    }
  });

  it('renders placeholders', () => {
    expect(renderMessage('FILE.TOO_LARGE', { limit: '2 MB' })).toBe('The file must be under 2 MB.');
    expect(renderMessage('VALIDATION.PASSWORD', { min: 8, max: 15 })).toContain('between 8 and 15');
  });

  it('detects catalogue problems', () => {
    expect(
      validateCatalogue([
        {
          key: 'bad key',
          register: 'MSG-X-1',
          srsText: null,
          class: 'N',
          type: 'error',
          en: 'Hello {who}',
          approval: 'pending',
        },
      ]),
    ).toEqual(['bad key bad key', 'bad key: class N with a 27.5 id', 'bad key: undeclared {who}']);
  });
});

describe('limits register', () => {
  it('has unique keys', () => {
    const keys = allLimits().map((l) => l.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('records the 27.4 value for every proposed or adopted change', () => {
    for (const l of allLimits().filter((x) => x.basis !== 'register')) {
      expect(l.refs.length).toBeGreaterThan(0);
    }
  });

  it('carries the CR-07 upload limit and the SRS session lifetimes', () => {
    expect(LIMITS.fileMaxBytes.value).toBe(2_097_152);
    expect(LIMITS.sessionConsoleHours.value).toBe(24);
    expect(LIMITS.sessionMemberMobileDays.value).toBe(365);
    expect(LIMITS.otpDigits.value).toBe(4);
  });
});
