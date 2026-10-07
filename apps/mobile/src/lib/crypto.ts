// Pure-JS primitives on purpose: the app is usually served over plain HTTP on
// the LAN, where browsers do not expose crypto.subtle.
import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, concatBytes, hexToBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js';

export { bytesToHex, hexToBytes, randomBytes };

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
