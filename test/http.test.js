import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import test from 'node:test';
import {
  APIClient,
  decrypt,
  encodeBase32,
  getTimeOffset,
  HTTPError,
  ProtocolError,
  requestNewSerial,
  restore,
} from '../src/index.js';

const fixture = JSON.parse(readFileSync(new URL('./python-vectors.json', import.meta.url), 'utf8'));
const secret = Buffer.from('0123456789abcdef0123456789abcdef01234567', 'hex');

async function serverFor(t, respond, options = {}) {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const record = {
      path: request.url,
      method: request.method,
      headers: request.headers,
      body: Buffer.concat(chunks),
    };
    requests.push(record);
    respond(record, response);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  const client = new APIClient({ host: `http://127.0.0.1:${server.address().port}`, ...options });
  return { client, requests };
}

test('enrollment sends Python-identical RSA bytes and decodes serial/secret over HTTP', async (t) => {
  const otp = Buffer.from(fixture.enrollment.otp, 'hex');
  t.mock.method(crypto, 'randomBytes', (length) => {
    assert.equal(length, 37);
    return otp;
  });
  const { client, requests } = await serverFor(t, (_, response) => {
    const plaintext = Buffer.concat([secret, Buffer.from('US-1209-1071-1868')]);
    response.end(Buffer.concat([Buffer.alloc(8), decrypt(plaintext, otp)]));
  });
  assert.deepEqual(await requestNewSerial('us', 'Motorola RAZR v3', { client }), {
    serial: 'US-1209-1071-1868',
    secret: encodeBase32(secret),
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'POST');
  assert.equal(requests[0].path, '/enrollment/enroll.htm');
  assert.equal(requests[0].body.toString('hex'), fixture.enrollment.encrypted);
  assert.equal(Number(requests[0].headers['content-length']), requests[0].body.length);
});

test('restore challenge and HMAC/RSA request match Python over both HTTP steps', async (t) => {
  const otp = Buffer.from(fixture.restore.otp, 'hex');
  t.mock.method(crypto, 'randomBytes', (length) => {
    assert.equal(length, 20);
    return otp;
  });
  const { client, requests } = await serverFor(t, ({ path }, response) => {
    if (path.endsWith('initiatePaperRestore.htm'))
      response.end(Buffer.from(fixture.restore.challenge, 'hex'));
    else response.end(decrypt(secret, otp));
  });
  assert.equal(
    await restore('us-1209-1071-1868', fixture.restore.code.toLowerCase(), { client }),
    encodeBase32(secret),
  );
  assert.equal(requests.length, 2);
  assert.equal(requests[0].body.toString(), fixture.restore.serial);
  assert.equal(requests[1].path, '/enrollment/validatePaperRestore.htm');
  assert.deepEqual(
    requests[1].body,
    Buffer.concat([
      Buffer.from(fixture.restore.serial),
      Buffer.from(fixture.restore.encrypted, 'hex'),
    ]),
  );
});

test('server time is big-endian milliseconds; offset sign is preserved', async (t) => {
  const local = 1700000000000;
  t.mock.method(Date, 'now', () => local);
  const { client, requests } = await serverFor(t, (_, response) => {
    const data = Buffer.alloc(8);
    data.writeBigUInt64BE(BigInt(local - 1500));
    response.end(data);
  });
  assert.equal(await getTimeOffset('US', { client }), -1500);
  assert.equal(requests[0].path, '/enrollment/time.htm');
  assert.equal(requests[0].body.length, 0);
});

test('non-200 statuses preserve response metadata and invalid restore status 600 is mapped', async (t) => {
  const { client } = await serverFor(t, ({ path }, response) => {
    response.writeHead(path.endsWith('validatePaperRestore.htm') ? 600 : 503);
    response.end();
  });
  await assert.rejects(
    client.getTime(),
    (error) => error instanceof HTTPError && error.status === 503 && error.response.status === 503,
  );
  await assert.rejects(client.validatePaperRestore(fixture.restore.serial, Buffer.from([255])), {
    name: 'HTTPError',
    message: 'Invalid serial or restore key',
    status: 600,
  });
});

test('malformed response lengths fail instead of silently truncating', async (t) => {
  const { client } = await serverFor(t, (_, response) => response.end(Buffer.alloc(7)));
  await assert.rejects(client.getTime(), /Bad time response/);
  await assert.rejects(
    client.initiatePaperRestore(fixture.restore.serial),
    /Bad challenge response/,
  );
  await assert.rejects(requestNewSerial('US', undefined, { client }), /Bad enrollment response/);
  await assert.rejects(
    restore(fixture.restore.serial, fixture.restore.code, {
      client: {
        initiatePaperRestore: async () => Buffer.alloc(32),
        validatePaperRestore: async () => Buffer.alloc(19),
      },
    }),
    /Bad restore response/,
  );
});

test('unexpected and non-ASCII enrollment serials are rejected', async (t) => {
  t.mock.method(crypto, 'randomBytes', (length) => Buffer.alloc(length));
  for (const value of [
    Buffer.from('ZZ-1209-1071-1868'),
    Buffer.from('US-1209-1071-1868').map((x) => x | 128),
  ]) {
    await assert.rejects(
      requestNewSerial('US', undefined, {
        client: { enroll: async () => Buffer.concat([Buffer.alloc(8), secret, value]) },
      }),
      /Invalid serial in enrollment response/,
    );
  }
});

test('invalid caller inputs fail without making any network requests', async () => {
  await assert.rejects(requestNewSerial('XX'), /region must/);
  await assert.rejects(restore('US120910711868', 'ABC'), /10 characters/);
  await assert.rejects(restore('US120910711868', 'IIIIIIIIII'), /characters/);
  await assert.rejects(restore('XX120910711868', '4B91NQCYQ3'), /Unsupported/);
  const client = new APIClient();
  await assert.rejects(client.post('https://example.com/'), /configured host/);
  for (const host of ['ftp://localhost', 'http://user:pass@localhost', 'http://localhost/path']) {
    assert.throws(() => new APIClient({ host }), /HTTP\(S\) origin/);
  }
  assert.throws(() => new APIClient({ timeout: 0 }), /timeout/);
  assert.equal(new APIClient({ region: 'cn' }).host, 'mobile-service.battlenet.com.cn');
  assert.equal(new APIClient({ region: 'EU' }).host, 'mobile-service.blizzard.com');
});

test('request timeout closes stalled connections', async (t) => {
  const { client } = await serverFor(t, () => {}, { timeout: 100 });
  await assert.rejects(client.getTime(), /timed out/);
});

test('oversized responses are bounded', async (t) => {
  const { client } = await serverFor(t, (_, response) =>
    response.end(Buffer.alloc(1024 * 1024 + 1)),
  );
  await assert.rejects(client.post('/large'), (error) => error instanceof ProtocolError);
});

test('incomplete responses and unsafe timestamps fail clearly', async (t) => {
  const { client } = await serverFor(t, ({ path }, response) => {
    if (path === '/truncated') {
      response.writeHead(200, { 'Content-Length': 20 });
      response.write(Buffer.alloc(1));
      setImmediate(() => response.destroy());
    } else {
      response.end(Buffer.alloc(8, 255));
    }
  });
  await assert.rejects(client.post('/truncated'));
  await assert.rejects(client.getTime(), /safe integer range/);
});
