/**
 * The login details in the approval e-mail (client 2026-10-23): a one-time password for an account the
 * admission made; a number already registered with CampusOne signs in with its existing login and
 * creates no new account (client 2026-10-27).
 */
import { loginText } from '../services/admissions.service';

const login = (
  person: 'FATHER' | 'MOTHER',
  name: string,
  mobile: string,
  password: string | null,
) => ({ person, name, mobile, password, email: null }) as const;

describe('the login details of a family’s CampusOne accounts', () => {
  it('gives a new account its one-time password and tells an existing one to use its own login', () => {
    const text = loginText([
      login('FATHER', 'Ramesh Hegde', '9845001122', 'Rabc12345a@1'),
      login('MOTHER', 'Asha Hegde', '9845001133', null),
    ]);
    expect(text).toContain(
      'Sign in to the CampusOne app with the mobile number and the one-time password',
    );
    expect(text).toContain(
      '• Ramesh Hegde (father): mobile 9845001122, one-time password Rabc12345a@1',
    );
    expect(text).toContain(
      '• Asha Hegde (mother): mobile 9845001133 is already registered with CampusOne — sign in with your existing login (this mobile number and your password). Please don’t create a new account.',
    );
  });

  it('speaks of no one-time password when every number is registered already', () => {
    const text = loginText([login('MOTHER', 'Asha Hegde', '9845001133', null)]);
    expect(text.split('\n')[0]).toBe(
      'Your CampusOne login details. Sign in to the CampusOne app with your existing login.',
    );
    expect(text).not.toContain('one-time password');
  });
});
