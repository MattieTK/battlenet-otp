import { createHmac } from 'node:crypto';
import { decodeBase32 } from './base32.js';

const TOKEN_PERIOD_SECONDS = 30;
const TOKEN_DIGITS = 8;

// RFC 6238 TOTP: turn a 30-second time step into an eight-digit SHA-1 code.
// Timestamps are Unix seconds; offsets from getTimeOffset() are milliseconds.
export function generateToken(secret, timestamp = Date.now() / 1000, { timeOffset = 0 } = {}) {
  if (!Number.isFinite(timestamp) || !Number.isFinite(timeOffset)) {
    throw new TypeError('timestamp and timeOffset must be finite numbers');
  }
  const adjustedSeconds = timestamp + timeOffset / 1000;
  if (adjustedSeconds < 0 || adjustedSeconds > Number.MAX_SAFE_INTEGER) {
    throw new RangeError('timestamp is outside the supported range');
  }
  // The HMAC input is the time step encoded as an unsigned 64-bit integer.
  const timeStep = Math.floor(adjustedSeconds / TOKEN_PERIOD_SECONDS);
  const counterBytes = Buffer.alloc(8);
  counterBytes.writeBigUInt64BE(BigInt(timeStep));
  const digest = createHmac('sha1', decodeBase32(secret)).update(counterBytes).digest();

  // RFC 4226 dynamic truncation: select four bytes, then clear the sign bit.
  const truncationOffset = digest[digest.length - 1] & 0x0f;
  const truncatedDigest = digest.readUInt32BE(truncationOffset) & 0x7fffffff;
  const tokenNumber = truncatedDigest % 10 ** TOKEN_DIGITS;
  return String(tokenNumber).padStart(TOKEN_DIGITS, '0');
}

export class TOTP {
  constructor(secret) {
    decodeBase32(secret);
    this.secret = secret.toUpperCase();
  }

  at(timestamp, options) {
    return generateToken(this.secret, timestamp, options);
  }

  now(options) {
    return this.at(Date.now() / 1000, options);
  }
}
