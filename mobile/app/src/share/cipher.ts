import { gcm } from '@noble/ciphers/aes.js';
import { getRandomBytes } from 'expo-crypto';

import { fromBase64Url, NONCE_BYTES, shareAad, toBase64Url, type ShareCipher } from '@mac/share/cipher';
import type { ShareLink } from '@mac/share/link';

/** AES-256-GCM in JavaScript, since the phone's JavaScript has no WebCrypto; the Mac and the web app use theirs. */
export function phoneCipher(link: ShareLink): ShareCipher {
  const key = fromBase64Url(link.key);
  const aad = new TextEncoder().encode(shareAad(link.id));
  return {
    async open(sealed) {
      try {
        const bytes = fromBase64Url(sealed);
        const plain = gcm(key, bytes.subarray(0, NONCE_BYTES), aad).decrypt(bytes.subarray(NONCE_BYTES));
        return new TextDecoder().decode(plain);
      } catch {
        return null;
      }
    },
    async seal(text) {
      const nonce = getRandomBytes(NONCE_BYTES);
      const sealed = gcm(key, nonce, aad).encrypt(new TextEncoder().encode(text));
      const out = new Uint8Array(NONCE_BYTES + sealed.length);
      out.set(nonce);
      out.set(sealed, NONCE_BYTES);
      return toBase64Url(out);
    },
  };
}
