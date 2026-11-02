/**
 * Cards carried over from the earlier application (client 2026-10-23): the value read off such a card
 * — that application's encrypted token, base64 "U2FsdGVkX1…" — is found by its SHA-256; CampusOne's own
 * tokens are not.
 */
import { createHash } from 'node:crypto';
import { LEGACY_CARD_VALUE, legacyCardHash } from '../services/cards.service';

const CUG = 'U2FsdGVkX1+iHwx1dvayNs1hBmdPsYCkB8aDTE74fQzQPbFs3xMgnbZ8dhbzHVda';

describe('cards carried over from the earlier application', () => {
  it('recognises the earlier application’s value and hashes it as it is', () => {
    expect(LEGACY_CARD_VALUE.test(CUG)).toBe(true);
    expect(legacyCardHash(` ${CUG} `)).toEqual(createHash('sha256').update(CUG).digest());
  });

  it('leaves CampusOne’s tokens and anything else alone', () => {
    expect(legacyCardHash('NFCAB12CD34EF567')).toBeNull();
    expect(legacyCardHash(CUG.toLowerCase())).toBeNull();
    expect(legacyCardHash('U2FsdGVkX1short')).toBeNull();
  });
});
