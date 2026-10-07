import { describe, expect, it } from 'vitest';

import { DECLARATION, matches, token } from '../scripts/testflight.mjs';
import { decoded, esKey } from './esKey.mjs';

describe('the App Store Connect token', () => {
  it('is an ES256 token for the API, signed by the key and good for 20 minutes', () => {
    const key = esKey();
    const jwt = token({ key: key.pem, keyId: 'ABC123DEFG', issuerId: 'issuer' }, 1_000_000);
    const [header, claims] = jwt.split('.');
    expect(decoded(header)).toEqual({ alg: 'ES256', kid: 'ABC123DEFG', typ: 'JWT' });
    expect(decoded(claims)).toEqual({ iss: 'issuer', iat: 1000, exp: 2200, aud: 'appstoreconnect-v1' });
    expect(key.signed(jwt)).toBe(true);
  });
});

describe('the export compliance declaration', () => {
  const declaration = (attributes: object) => ({
    attributes: { ...DECLARATION, appEncryptionDeclarationState: 'APPROVED', ...attributes },
  });

  it('is reused when it says what the app does and Apple has not turned it down', () => {
    expect(matches(declaration({}))).toBe(true);
    expect(matches(declaration({ appEncryptionDeclarationState: 'CREATED' }))).toBe(true);
  });

  it('is made again when an old one says otherwise or was rejected', () => {
    expect(matches(declaration({ availableOnFrenchStore: true }))).toBe(false);
    expect(matches(declaration({ containsThirdPartyCryptography: false }))).toBe(false);
    expect(matches(declaration({ appEncryptionDeclarationState: 'REJECTED' }))).toBe(false);
  });
});
