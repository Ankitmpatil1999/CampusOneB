/**
 * A refusal answered to a counter (merchant phone PAY-012, terminal MER-005) never carries the
 * payer's balance or shortfall; other refusals pass through unchanged.
 */
import { renderMessage } from '../config/registers';
import { forCounter, PaymentRefusedError } from '../services/payment-engine.service';
import { CustomAPIError } from '../utils/CustomAPIError';

describe('forCounter', () => {
  it('replaces a short balance with the counter message, keeping the step and attempt', () => {
    const e = new PaymentRefusedError(
      {
        check: 'V13',
        stage: 'balance',
        code: 'PAY.INSUFFICIENT_BALANCE',
        status: 409,
        params: { balance: '₹25.00', shortfall: '₹35.00' },
      },
      { id: '01a10381-ffe8-7563-ac76-9e4129246632', reference: 'RPNF0000000001' },
    );
    const out = forCounter(e) as CustomAPIError;
    expect(out).toBeInstanceOf(CustomAPIError);
    expect(out.code).toBe('PAY.CARD_BALANCE_SHORT');
    expect(out.statusCode).toBe(409);
    expect(out.params).toEqual({});
    expect(out.extensions).toMatchObject({
      check: 'V13',
      attempt: { reference: 'RPNF0000000001' },
    });
    expect(renderMessage('PAY.CARD_BALANCE_SHORT')).not.toMatch(/₹/);
  });

  it('passes every other refusal through as it is', () => {
    const other = new CustomAPIError(409, 'PAY.NONCE_REPLAY');
    expect(forCounter(other)).toBe(other);
    const plain = new Error('boom');
    expect(forCounter(plain)).toBe(plain);
  });
});
