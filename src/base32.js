// RFC 4648 Base32: each character represents five bits.
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function toBytes(value, name = 'value') {
  if (!(value instanceof Uint8Array)) {
    throw new TypeError(`${name} must be a Buffer or Uint8Array`);
  }
  return Buffer.from(value);
}

export function encodeBase32(bytes) {
  const data = toBytes(bytes);
  let availableBits = 0;
  let bitBuffer = 0;
  let encodedText = '';
  for (const byte of data) {
    bitBuffer = (bitBuffer << 8) | byte;
    availableBits += 8;
    while (availableBits >= 5) {
      availableBits -= 5;
      encodedText += ALPHABET[(bitBuffer >>> availableBits) & 31];
    }
    // Keep only the leftover bits before reading the next input.
    bitBuffer &= (1 << availableBits) - 1;
  }
  if (availableBits > 0) {
    encodedText += ALPHABET[(bitBuffer << (5 - availableBits)) & 31];
  }
  return encodedText.padEnd(Math.ceil(encodedText.length / 8) * 8, '=');
}

export function decodeBase32(secret) {
  if (typeof secret !== 'string' || !secret.length) {
    throw new TypeError('secret must be a non-empty Base32 string');
  }
  const encoded = secret.toUpperCase();
  if (!/^[A-Z2-7]+={0,6}$/.test(encoded)) {
    throw new TypeError('Invalid Base32 secret');
  }
  const unpadded = encoded.replace(/=+$/, '');
  const remainder = unpadded.length % 8;
  if (
    ![0, 2, 4, 5, 7].includes(remainder) ||
    (encoded.includes('=') && encoded.length !== Math.ceil(unpadded.length / 8) * 8)
  ) {
    throw new TypeError('Invalid Base32 length or padding');
  }
  let availableBits = 0;
  let bitBuffer = 0;
  const decodedBytes = [];
  for (const character of unpadded) {
    bitBuffer = (bitBuffer << 5) | ALPHABET.indexOf(character);
    availableBits += 5;
    if (availableBits >= 8) {
      availableBits -= 8;
      decodedBytes.push((bitBuffer >>> availableBits) & 255);
    }
    // Keep only the leftover bits before reading the next input.
    bitBuffer &= (1 << availableBits) - 1;
  }
  if (bitBuffer !== 0) {
    throw new TypeError('Invalid Base32 trailing bits');
  }
  return Buffer.from(decodedBytes);
}
