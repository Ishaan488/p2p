// Pure-JS primitives on purpose: the app is usually served over plain HTTP on
// the LAN, where browsers do not expose crypto.subtle.
import { gcm } from '@noble/ciphers/aes.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, concatBytes, hexToBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js';

export { bytesToHex, hexToBytes, randomBytes, utf8ToBytes };

export const randomHex = (bytes: number) => bytesToHex(randomBytes(bytes));

export function hmacHex(key: Uint8Array, text: string): string {
  return bytesToHex(hmac(sha256, key, utf8ToBytes(text)));
}

// "abcd-efgh ..." as typed by a person -> the canonical form both sides derive keys from
export function normalizePairCode(code: string): string {
  return code.replace(/[\s-]/g, '').toUpperCase();
}

export function deviceKeyFromCode(code: string, deviceId: string): Uint8Array {
  return hkdf(sha256, utf8ToBytes(normalizePairCode(code)), utf8ToBytes(deviceId), utf8ToBytes('p2p-link device key v1'), 32);
}

export function sessionKey(deviceKey: Uint8Array, clientNonce: Uint8Array, serverNonce: Uint8Array): Uint8Array {
  return hkdf(sha256, deviceKey, concatBytes(clientNonce, serverNonce), utf8ToBytes('p2p-link session v1'), 32);
}

// Mirrors requestSignature() on the server: method, path and the sorted query.
export function signRequest(key: Uint8Array, method: string, path: string, params: Record<string, string>): string {
  const query = Object.keys(params).sort().map(name => `${name}=${params[name]}`).join('&');
  return hmacHex(key, `${method}\n${path}\n${query}`);
}

const NONCE_LENGTH = 12;

// AES-256-GCM under a key derived from the session key. Sealed data is
// nonce || ciphertext || tag, and only opens with the same `context` it was
// sealed for (a request path, a transfer chunk, a frame number...).
export class Cipher {
  // Set to force the pure-JS implementation even where WebCrypto exists.
  static softwareOnly = false;

  private key: Uint8Array;
  private nativeKey: Promise<CryptoKey> | null = null;

  constructor(session: Uint8Array) {
    this.key = hkdf(sha256, session, undefined, utf8ToBytes('p2p-link encryption v1'), 32);
  }

  // WebCrypto is much faster, but only exists in secure contexts (the native
  // app, localhost). Plain-HTTP pages on the LAN use the JS implementation.
  private native(): Promise<CryptoKey> | null {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle || Cipher.softwareOnly) return null;
    this.nativeKey ||= subtle.importKey('raw', this.key as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt']);
    return this.nativeKey;
  }

  async seal(plaintext: Uint8Array, context: string): Promise<Uint8Array> {
    const nonce = randomBytes(NONCE_LENGTH);
    const aad = utf8ToBytes(context);
    const native = this.native();
    const ciphertext = native
      ? new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce as BufferSource, additionalData: aad as BufferSource }, await native, plaintext as BufferSource))
      : gcm(this.key, nonce, aad).encrypt(plaintext);
    return concatBytes(nonce, ciphertext);
  }

  // Throws if the data was tampered with or belongs to a different context.
  async open(sealed: Uint8Array, context: string): Promise<Uint8Array> {
    if (sealed.length < NONCE_LENGTH + 16) throw new Error('Could not decrypt');
    const nonce = sealed.subarray(0, NONCE_LENGTH);
    const ciphertext = sealed.subarray(NONCE_LENGTH);
    const aad = utf8ToBytes(context);
    const native = this.native();
    try {
      return native
        ? new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce as BufferSource, additionalData: aad as BufferSource }, await native, ciphertext as BufferSource))
        : gcm(this.key, nonce, aad).decrypt(ciphertext);
    } catch {
      throw new Error('Could not decrypt');
    }
  }
}

export const chunkContext = (transferId: string, chunkIndex: number) => `chunk\n${transferId}\n${chunkIndex}`;

// Incrementally computes the SHA-256 hex digest of a File in bounded 2MB slices
export async function computeFileHash(file: File, signal?: AbortSignal): Promise<string> {
  const hasher = sha256.create();
  const sliceSize = 2 * 1024 * 1024; // 2 MB slices keeps memory strictly O(1)
  const totalSlices = Math.ceil(file.size / sliceSize);
  for (let i = 0; i < totalSlices; i++) {
    signal?.throwIfAborted();
    const start = i * sliceSize;
    const end = Math.min(start + sliceSize, file.size);
    const slice = file.slice(start, end);
    const buf = new Uint8Array(await slice.arrayBuffer());
    hasher.update(buf);
  }
  return bytesToHex(hasher.digest());
}
