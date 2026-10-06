import { redact, redactText } from '../utils/redact';

describe('redact', () => {
  it('removes secrets by key, case- and separator-insensitively', () => {
    const out = redact({
      password: 'P@ssw0rd!',
      Refresh_Token: 'abc',
      otp: '1234',
      nested: { clientSecret: 'x', tpin: '9999', ok: 'visible' },
      headers: { authorization: 'Bearer abc.def.ghi', Cookie: '__Host-rp_at=xyz' },
    });
    expect(out).toEqual({
      password: '[REDACTED]',
      Refresh_Token: '[REDACTED]',
      otp: '[REDACTED]',
      nested: { clientSecret: '[REDACTED]', tpin: '[REDACTED]', ok: 'visible' },
      headers: { authorization: '[REDACTED]', Cookie: '[REDACTED]' },
    });
  });

  it('masks mobiles and e-mails by key', () => {
    expect(redact({ mobile: '9876543210', email: 'priya.k@school.in' })).toEqual({
      mobile: '******3210',
      email: 'p***@school.in',
    });
  });

  it('removes identity numbers by key (PAN, Aadhaar, bank account)', () => {
    expect(
      redact({ pan: 'ABCDE1234F', aadhaar: '123412341234', accountNumber: '00112233' }),
    ).toEqual({
      pan: '[REDACTED]',
      aadhaar: '[REDACTED]',
      accountNumber: '[REDACTED]',
    });
  });

  it('scrubs identifiers from free text', () => {
    const text = redactText(
      'payer 9876543210 PAN ABCDE1234F id 1234 5678 9012 token Bearer eyJhbGciOi.abc.def',
    );
    expect(text).not.toContain('9876543210');
    expect(text).toContain('******3210');
    expect(text).toContain('[PAN]');
    expect(text).toContain('[ID-NUMBER]');
    expect(text).toContain('Bearer [REDACTED]');
  });

  it('handles cycles, depth, arrays and buffers', () => {
    const a: Record<string, unknown> = { name: 'a' };
    a['self'] = a;
    const deep = { l1: { l2: { l3: { l4: { l5: { l6: { l7: 1 } } } } } } };
    const out = redact({
      a,
      deep,
      list: Array.from({ length: 25 }, (_, i) => i),
      buf: Buffer.alloc(3),
    }) as Record<string, unknown>;
    expect((out['a'] as Record<string, unknown>)['self']).toBe('[Circular]');
    expect(JSON.stringify(out['deep'])).toContain('[Truncated]');
    expect((out['list'] as unknown[]).length).toBe(21);
    expect(out['buf']).toBe('[3 bytes]');
  });
});
