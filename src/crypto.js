import { createHash } from 'node:crypto';
import { decodeBase32, toBytes } from './base32.js';
import { RESTORE_ALPHABET, RSA_KEY, RSA_MOD } from './constants.js';
import { normalizeSerial } from './utils.js';

// This legacy wire protocol uses raw RSA, without PKCS#1 padding. Return the
// shortest big-endian byte representation, matching the original Python code.
export function encrypt(data) {
  const bytes = toBytes(data, 'data');
  if (!bytes.length) {
    throw new TypeError('data must not be empty');
  }
  let base = BigInt(`0x${bytes.toString('hex')}`);
  if (base >= RSA_MOD) {
    throw new RangeError('RSA message is too large');
  }
  let exponent = RSA_KEY;
  let result = 1n;
  // Square-and-multiply computes message^exponent modulo the RSA modulus.
  while (exponent > 0n) {
    if (exponent & 1n) {
      result = (result * base) % RSA_MOD;
    }
    exponent >>= 1n;
    base = (base * base) % RSA_MOD;
  }
  if (result === 0n) {
    return Buffer.alloc(0);
  }
  const hex = result.toString(16);
  return Buffer.from(hex.length % 2 ? `0${hex}` : hex, 'hex');
}

// Here "one-time pad" means random bytes XORed with the legacy server response.
// It is unrelated to the eight-digit one-time password shown to the user.
export function decrypt(response, oneTimePad) {
  const data = toBytes(response, 'response');
  const pad = toBytes(oneTimePad, 'otp');
  const result = Buffer.alloc(Math.min(data.length, pad.length));
  for (let index = 0; index < result.length; index++) {
    result[index] = data[index] ^ pad[index];
  }
  return result;
}

export function bytesToRestoreCode(digest) {
  // Each character encodes the lowest five bits using Blizzard's alphabet.
  return Array.from(toBytes(digest, 'digest'), (byte) => RESTORE_ALPHABET[byte & 31]).join('');
}

export function restoreCodeToBytes(code) {
  if (typeof code !== 'string' || !/^[0-9A-HJKMNPQRTUVWXYZ]+$/i.test(code)) {
    throw new TypeError('Invalid restore code characters');
  }
  return Buffer.from(Array.from(code.toUpperCase(), (char) => RESTORE_ALPHABET.indexOf(char)));
}

export function getRestoreCode(serial, secret) {
  const digest = createHash('sha1')
    .update(normalizeSerial(serial), 'utf8')
    .update(decodeBase32(secret))
    .digest();
  return bytesToRestoreCode(digest.subarray(-10));
}
