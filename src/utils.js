import { decodeBase32 } from './base32.js';

export function normalizeSerial(serial) {
  if (typeof serial !== 'string') throw new TypeError('serial must be a string');
  return serial.toUpperCase().replaceAll('-', '').trim();
}

export function prettifySerial(serial) {
  const normalized = normalizeSerial(serial);
  if (!/^[A-Z]{2}[0-9]{12}$/.test(normalized)) {
    throw new TypeError('Serial must contain a two-letter region and 12 digits');
  }
  // Despite its name, python-bna 5.1.0 returns an undashed serial here.
  return normalized;
}

export function getOtpAuthUrl(serial, secret) {
  decodeBase32(secret);
  const name = normalizeSerial(serial);
  if (!name) throw new TypeError('serial must not be empty');
  return `otpauth://totp/Blizzard:${encodeURIComponent(name)}?secret=${encodeURIComponent(secret.toUpperCase())}&issuer=Blizzard&digits=8`;
}
