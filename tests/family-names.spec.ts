/**
 * The same person on a shared mobile (client 2026-10-22): a sibling's parent is joined only when the
 * names agree as people write them.
 */
import { sameName } from '../services/members.service';

const n = (first: string | null, last: string | null = null) => ({ first, last });

describe('the same person on a shared mobile', () => {
  it('takes the same name written differently', () => {
    expect(sameName(n('Ramesh', 'Kumar'), n('RAMESH', 'KUMAR'))).toBe(true);
    expect(sameName(n('Ramesh S.', 'Kumar'), n('Ramesh', 'Kumar'))).toBe(true);
    expect(sameName(n('Ravi'), n('Ravi', 'Rao'))).toBe(true);
    expect(sameName(n('ರಮೇಶ್', 'ಕುಮಾರ್'), n('ರಮೇಶ್ ', ' ಕುಮಾರ್'))).toBe(true);
  });

  it('tells different people apart', () => {
    expect(sameName(n('Suresh', 'Patil'), n('Ramesh', 'Kumar'))).toBe(false);
    expect(sameName(n('Ramesh', 'Kumar'), n('Ramesh', 'Gowda'))).toBe(false);
    expect(sameName(n(''), n('Ramesh'))).toBe(false);
    expect(sameName(n(null), n(null))).toBe(false);
  });
});
