import { Buffer } from 'node:buffer';
import { generateKeyPairSync, verify } from 'node:crypto';

/** A fresh P-256 key, as Apple's .p8 keys are, and a check of a token it signed. */
export function esKey() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return {
    pem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    signed: (jwt) => {
      const [header, claims, signature] = jwt.split('.');
      return verify(
        'sha256',
        Buffer.from(`${header}.${claims}`),
        { key: publicKey, dsaEncoding: 'ieee-p1363' },
        Buffer.from(signature, 'base64url'),
      );
    },
  };
}

export function decoded(part) {
  return JSON.parse(Buffer.from(part, 'base64url').toString());
}
