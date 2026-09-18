import crypto, { createHmac } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { encodeBase32, toBytes } from './base32.js';
import { ENROLL_HOSTS, REGIONS } from './constants.js';
import { decrypt, encrypt, restoreCodeToBytes } from './crypto.js';
import { prettifySerial } from './utils.js';

export class HTTPError extends Error {
  constructor(message, response, options) {
    super(message, options);
    this.name = 'HTTPError';
    this.response = response;
    this.status = response?.status ?? response?.statusCode;
  }
}

export class ProtocolError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProtocolError';
  }
}

function requireSize(response, size, label) {
  const data = toBytes(response, label);
  if (data.length !== size) {
    throw new ProtocolError(`Bad ${label} (${data.length} bytes; expected ${size})`);
  }
  return data;
}

// Legacy binary API, preserved for compatibility with python-bna.
// Current browser enrollment uses ModernAPIClient in modern.js.
export class APIClient {
  constructor({ region = 'US', host, timeout = 15_000 } = {}) {
    this.region = region.toUpperCase();
    const address = host || ENROLL_HOSTS[this.region] || ENROLL_HOSTS.default;
    this.baseUrl = new URL(address.includes('://') ? address : `http://${address}`);
    if (
      !['http:', 'https:'].includes(this.baseUrl.protocol) ||
      this.baseUrl.username ||
      this.baseUrl.password ||
      this.baseUrl.pathname !== '/' ||
      this.baseUrl.search ||
      this.baseUrl.hash
    ) {
      throw new TypeError(
        'host must be an HTTP(S) origin without credentials, path, query or fragment',
      );
    }
    if (!Number.isSafeInteger(timeout) || timeout <= 0) {
      throw new RangeError('timeout must be a positive integer in milliseconds');
    }
    this.host = this.baseUrl.host;
    this.timeout = timeout;
  }

  async post(path, data = Buffer.alloc(0)) {
    const url = new URL(path, this.baseUrl);
    if (url.origin !== this.baseUrl.origin)
      throw new TypeError('Request path must use the configured host');
    const body = typeof data === 'string' ? Buffer.from(data, 'latin1') : toBytes(data, 'data');
    const transport = url.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
      const request = transport.request(
        url,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': body.length },
        },
        (response) => {
          if (response.statusCode !== 200) {
            const error = new HTTPError(`${this.host} returned status ${response.statusCode}`, {
              status: response.statusCode,
              statusCode: response.statusCode,
              headers: response.headers,
            });
            response.destroy();
            reject(error);
            return;
          }
          let length = 0;
          const chunks = [];
          response.on('data', (chunk) => {
            length += chunk.length;
            if (length > 1024 * 1024) {
              const error = new ProtocolError('Response exceeds the 1 MiB limit');
              response.destroy();
              reject(error);
            } else {
              chunks.push(chunk);
            }
          });
          response.on('end', () => resolve(Buffer.concat(chunks)));
          response.on('error', reject);
          response.on('aborted', () => reject(new ProtocolError('Response ended prematurely')));
        },
      );
      const timer = setTimeout(
        () => request.destroy(new Error(`Request timed out after ${this.timeout} ms`)),
        this.timeout,
      );
      request.on('close', () => clearTimeout(timer));
      request.on('error', reject);
      request.end(body);
    });
  }

  enroll(data) {
    return this.post('/enrollment/enroll.htm', data);
  }

  async getTime() {
    const response = requireSize(await this.post('/enrollment/time.htm'), 8, 'time response');
    const milliseconds = response.readBigUInt64BE();
    if (milliseconds > BigInt(Number.MAX_SAFE_INTEGER))
      throw new ProtocolError('Server time exceeds the safe integer range');
    return Number(milliseconds);
  }

  async initiatePaperRestore(serial) {
    return requireSize(
      await this.post('/enrollment/initiatePaperRestore.htm', serial),
      32,
      'challenge response',
    );
  }

  async validatePaperRestore(serial, encryptedData) {
    try {
      return await this.post(
        '/enrollment/validatePaperRestore.htm',
        Buffer.concat([Buffer.from(serial, 'ascii'), toBytes(encryptedData, 'encryptedData')]),
      );
    } catch (error) {
      if (error instanceof HTTPError && error.status === 600) {
        throw new HTTPError('Invalid serial or restore key', error.response, { cause: error });
      }
      throw error;
    }
  }
}

export async function requestNewSerial(region = 'US', model = 'Motorola RAZR v3', options = {}) {
  const normalizedRegion = region.toUpperCase();
  if (!REGIONS.includes(normalizedRegion)) throw new TypeError('region must be CN, EU, KR or US');
  if (typeof model !== 'string') throw new TypeError('model must be a string');
  const client = options.client ?? new APIClient({ ...options, region: normalizedRegion });
  const oneTimePad = crypto.randomBytes(37);
  // Wire layout: version (1), random pad (37), region (2), model (16).
  const message = Buffer.alloc(56);
  message[0] = 1;
  oneTimePad.copy(message, 1);
  message.write(normalizedRegion, 38, 2, 'ascii');
  Buffer.from(model, 'utf8').copy(message, 40, 0, 16);
  const response = requireSize(await client.enroll(encrypt(message)), 45, 'enrollment response');
  // Response layout: server time (8), then XOR-protected secret (20) and serial (17).
  const decrypted = decrypt(response.subarray(8), oneTimePad);
  // Decode as UTF-8: high-bit bytes must not be masked into valid serial digits.
  const serial = decrypted.subarray(20).toString('utf8');
  if (!/^(CN|EU|KR|US)-[0-9]{4}-[0-9]{4}-[0-9]{4}$/.test(serial)) {
    throw new ProtocolError('Invalid serial in enrollment response');
  }
  return { serial, secret: encodeBase32(decrypted.subarray(0, 20)) };
}

export async function getTimeOffset(region = 'US', options = {}) {
  const client = options.client ?? new APIClient({ ...options, region });
  const serverTime = await client.getTime();
  return serverTime - Date.now();
}

export async function restore(serial, restoreCode, options = {}) {
  const normalized = prettifySerial(serial);
  if (!REGIONS.includes(normalized.slice(0, 2))) throw new TypeError('Unsupported serial region');
  if (typeof restoreCode !== 'string' || restoreCode.length !== 10) {
    throw new TypeError('Invalid restore code (should be 10 characters)');
  }
  const code = restoreCodeToBytes(restoreCode);
  const client = options.client ?? new APIClient({ ...options, region: normalized.slice(0, 2) });
  const challenge = requireSize(
    await client.initiatePaperRestore(normalized),
    32,
    'challenge response',
  );
  const hash = createHmac('sha1', code).update(normalized, 'ascii').update(challenge).digest();
  const oneTimePad = crypto.randomBytes(20);
  const response = requireSize(
    await client.validatePaperRestore(normalized, encrypt(Buffer.concat([hash, oneTimePad]))),
    20,
    'restore response',
  );
  return encodeBase32(decrypt(response, oneTimePad));
}
