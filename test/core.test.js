import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  bytesToRestoreCode,
  decodeBase32,
  decrypt,
  encodeBase32,
  encrypt,
  generateToken,
  getOtpAuthUrl,
  getRestoreCode,
  normalizeSerial,
  prettifySerial,
  restoreCodeToBytes,
  TOTP,
} from '../src/index.js';

const SERIAL = 'US120910711868';
const SECRET = 'HA4GCYLGMFRWKNBYGI4TCZJQHFSGGMLFMNSTSYZSMFQTINDEHAZTSOJYGNQTOZTG';
const fixtures = JSON.parse(
  readFileSync(new URL('./python-vectors.json', import.meta.url), 'utf8'),
);

test('original python-bna token vectors and 30-second boundary', () => {
  const totp = new TOTP(SECRET);
  assert.equal(totp.at(1347279358), '93461643');
  assert.equal(totp.at(1347279359), '93461643');
  assert.equal(totp.at(1347279360), '86031001');
  assert.equal(generateToken(SECRET, 1347279359, { timeOffset: 1000 }), '86031001');
  assert.equal(generateToken(SECRET, 1347279360, { timeOffset: -1000 }), '93461643');
});

test('all RFC 6238 SHA-1 eight-digit test vectors, including leading zeroes', () => {
  const secret = encodeBase32(Buffer.from('12345678901234567890'));
  for (const [time, expected] of [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ])
    assert.equal(generateToken(secret, time), expected);
});

test('TOTP.now uses the local clock', (t) => {
  t.mock.method(Date, 'now', () => 1347279360000);
  assert.equal(new TOTP(SECRET).now(), '86031001');
});

test('original restore code and Python-generated restore fixtures', () => {
  assert.equal(getRestoreCode(SERIAL, SECRET), '4B91NQCYQ3');
  assert.equal(getRestoreCode(' us-1209-1071-1868 ', SECRET.toLowerCase()), '4B91NQCYQ3');
  for (const { serial, secret, code } of fixtures.restoreCodes) {
    assert.equal(getRestoreCode(serial, secret), code);
  }
});

test('raw RSA matches the upstream Python implementation for 30 messages', () => {
  for (const { input, encrypted } of fixtures.rsa) {
    assert.equal(encrypt(Buffer.from(input, 'hex')).toString('hex'), encrypted);
  }
  assert.equal(encrypt(Buffer.from([0])).length, 0);
  assert.deepEqual(encrypt(Buffer.from([1])), Buffer.from([1]));
  assert.throws(() => encrypt(Buffer.alloc(0)), /empty/);
  assert.throws(() => encrypt(Buffer.alloc(129, 255)), /too large/);
});

test('restore alphabet and inverse match Python', () => {
  const values = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
  assert.equal(bytesToRestoreCode(values), fixtures.alphabet);
  assert.deepEqual(restoreCodeToBytes(fixtures.alphabet), values);
  assert.deepEqual(restoreCodeToBytes(fixtures.alphabet.toLowerCase()), values);
  for (const invalid of ['I', 'L', 'O', 'S', '/', ' ', '']) {
    assert.throws(() => restoreCodeToBytes(invalid), /Invalid restore code/);
  }
});

test('XOR decrypt uses bytes and the shorter input length', () => {
  assert.deepEqual(
    decrypt(Buffer.from([0, 128, 255, 1]), Buffer.from([255, 128, 1])),
    Buffer.from([255, 0, 254]),
  );
  assert.deepEqual(decrypt(Buffer.alloc(0), Buffer.from([1])), Buffer.alloc(0));
  assert.throws(() => decrypt('abc', Buffer.alloc(3)), /Buffer or Uint8Array/);
});

test('serial normalization and upstream undashed prettify behavior', () => {
  assert.equal(prettifySerial(SERIAL.toLowerCase()), SERIAL);
  assert.equal(normalizeSerial(' us-1209-1071-1868 \n'), SERIAL);
  assert.equal(prettifySerial('eu-0000-0000-0001'), 'EU000000000001');
  for (const value of ['', 'US123', 'US12345678901x', '12123456789012']) {
    assert.throws(() => prettifySerial(value), /Serial must/);
  }
  assert.throws(() => normalizeSerial(null), /string/);
});

test('OTPAuth URL retains the original issuer, digits and secret', () => {
  const url = new URL(getOtpAuthUrl(SERIAL, SECRET));
  assert.equal(url.protocol, 'otpauth:');
  assert.equal(url.host, 'totp');
  assert.equal(url.pathname, `/Blizzard:${SERIAL}`);
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    secret: SECRET,
    issuer: 'Blizzard',
    digits: '8',
  });
  assert.equal(new URL(getOtpAuthUrl('us-1209-1071-1868', SECRET)).pathname, url.pathname);
});

test('RFC 4648 Base32 vectors and padded/unpadded lowercase decoding', () => {
  for (const [plain, encoded] of [
    ['f', 'MY======'],
    ['fo', 'MZXQ===='],
    ['foo', 'MZXW6==='],
    ['foob', 'MZXW6YQ='],
    ['fooba', 'MZXW6YTB'],
    ['foobar', 'MZXW6YTBOI======'],
  ]) {
    assert.equal(encodeBase32(Buffer.from(plain)), encoded);
    assert.equal(decodeBase32(encoded).toString(), plain);
    assert.equal(decodeBase32(encoded.toLowerCase().replace(/=+$/, '')).toString(), plain);
  }
  const allBytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
  assert.deepEqual(decodeBase32(encodeBase32(allBytes)), allBytes);
  assert.equal(encodeBase32(Buffer.alloc(0)), '');
});

test('invalid secrets and timestamps fail before generating tokens', () => {
  for (const secret of [
    '',
    'ABC!',
    'A',
    'ABC',
    'ABCDEF',
    'MY=',
    'MZ======',
    'MZXW6YTB=',
    '========',
  ]) {
    assert.throws(() => generateToken(secret, 59));
  }
  for (const time of [NaN, Infinity, -1, '59', Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => generateToken(SECRET, time));
  }
  assert.throws(() => generateToken(SECRET, 59, { timeOffset: NaN }));
});
