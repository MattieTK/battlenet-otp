import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { runCli } from '../src/cli.js';
import { ConfigStore, getDefaultConfigPath, parseConfig } from '../src/config.js';
import { encodeBase32 } from '../src/index.js';

const bin = fileURLToPath(new URL('../bin/bna.js', import.meta.url));
const SERIAL = 'US120910711868';
const SECOND = 'EU000000000001';
const SECRET = 'HA4GCYLGMFRWKNBYGI4TCZJQHFSGGMLFMNSTSYZSMFQTINDEHAZTSOJYGNQTOZTG';

function configFor(
  t,
  contents = `[${SERIAL}]\nsecret = ${SECRET}\n\n[bna]\ndefault_serial = ${SERIAL}\n`,
) {
  const directory = mkdtempSync(join(tmpdir(), 'javascript-bna-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'bna.conf');
  if (contents !== null) writeFileSync(path, contents);
  return path;
}

function cli(path, ...args) {
  return spawnSync(process.execPath, [bin, '--config', path, ...args], {
    encoding: 'utf8',
    timeout: 10_000,
  });
}

async function run(path, args, services) {
  let stdout = '';
  let stderr = '';
  const status = await runCli(['--config', path, ...args], {
    stdout: {
      write: (data) => {
        stdout += data;
      },
    },
    stderr: {
      write: (data) => {
        stderr += data;
      },
    },
    services,
  });
  return { status, stdout, stderr };
}

test('CLI reads existing Python config for tokens, restore codes, URLs, secrets and listing', (t) => {
  const path = configFor(t);
  for (const args of [[], ['show'], ['us-1209-1071-1868']]) {
    const result = cli(path, ...args);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^\d{8}\n$/);
  }
  assert.equal(cli(path, 'show-restore-code').stdout, '4B91NQCYQ3\n');
  assert.equal(cli(path, 'show-secret').stdout, `${SECRET}\n`);
  assert.equal(cli(path, 'list').stdout, `${SERIAL} (default)\n1 authenticators\n`);
  const url = cli(path, 'show-url').stdout;
  assert.equal(url.endsWith('\n'), false);
  assert.equal(new URL(url).searchParams.get('secret'), SECRET);
});

test('help and version do not create config files or directories', (t) => {
  const path = configFor(t, null);
  assert.match(cli(path, '--help').stdout, /show-restore-code/);
  assert.equal(cli(path, '--version').stdout, 'javascript-bna 1.0.0\n');
  assert.equal(existsSync(path), false);
});

test('new, restore, default switching and deletion persist compatible INI', async (t) => {
  const path = configFor(t, null);
  const services = {
    requestNewSerial: async (region) => {
      assert.equal(region, 'EU');
      return { serial: 'EU-0000-0000-0001', secret: SECRET };
    },
    restore: async (serial, code) => {
      assert.equal(serial, SERIAL);
      assert.equal(code, '4B91NQCYQ3');
      return SECRET;
    },
  };
  let result = await run(path, ['new', '--region', 'EU', '--no-set-default'], services);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(new ConfigStore(path).getDefaultSerial(), SECOND);
  result = await run(path, ['restore', 'us-1209-1071-1868', '4B91NQCYQ3'], services);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(new ConfigStore(path).getDefaultSerial(), SECOND);
  assert.equal(cli(path, 'set-default', SERIAL).status, 0);
  assert.equal(new ConfigStore(path).getDefaultSerial(), SERIAL);
  assert.equal(cli(path, 'delete', SERIAL).status, 0);
  assert.equal(new ConfigStore(path).getDefaultSerial(), '');
  assert.match(cli(path).stderr, /do not have a default/);
  assert.equal(cli(path, 'set-default', SECOND).status, 0);
  assert.equal(cli(path, 'delete', SECOND).status, 0);
  assert.equal(cli(path, 'list').stdout, '0 authenticators\n');
  assert.match(cli(path).stderr, /do not have any configured/);
});

test('new defaults to replacing the current default, restore obeys --set-default', async (t) => {
  const path = configFor(t);
  const services = {
    requestNewSerial: async () => ({ serial: SECOND, secret: SECRET }),
    restore: async () => SECRET,
  };
  assert.equal((await run(path, ['new'], services)).status, 0);
  assert.equal(new ConfigStore(path).getDefaultSerial(), SECOND);
  assert.equal(cli(path, 'delete', SERIAL).status, 0);
  assert.equal(
    (await run(path, ['restore', SERIAL, '4B91NQCYQ3', '--set-default'], services)).status,
    0,
  );
  assert.equal(new ConfigStore(path).getDefaultSerial(), SERIAL);
});

test('new --no-set-default preserves an existing default', async (t) => {
  const path = configFor(t);
  const result = await run(path, ['new', '--no-set-default'], {
    requestNewSerial: async () => ({ serial: SECOND, secret: SECRET }),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(new ConfigStore(path).getDefaultSerial(), SERIAL);
});

test('duplicate restore is caught after normalization and before a network call', async (t) => {
  const path = configFor(t);
  const before = readFileSync(path, 'utf8');
  const result = await run(path, ['restore', 'us-1209-1071-1868', '4B91NQCYQ3'], {
    restore: async () => assert.fail('must not contact server'),
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /already exists/);
  assert.equal(readFileSync(path, 'utf8'), before);
});

test('network failure leaves config unchanged and prints a concise error', async (t) => {
  const path = configFor(t);
  const before = readFileSync(path, 'utf8');
  const result = await run(path, ['new'], {
    requestNewSerial: async () => {
      throw new Error('Connection failed');
    },
  });
  assert.equal(result.status, 1);
  assert.equal(result.stderr, 'Error: Connection failed\n');
  assert.equal(readFileSync(path, 'utf8'), before);
});

test('old 40-character hex secrets migrate to Base32 and remain readable', (t) => {
  const hex = '0123456789abcdef0123456789abcdef01234567';
  const path = configFor(t, `[${SERIAL}]\nsecret = ${hex}\n[bna]\ndefault_serial = ${SERIAL}\n`);
  const result = cli(path, 'show-secret');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Converting/);
  const expected = encodeBase32(Buffer.from(hex, 'hex'));
  assert.equal(result.stdout, `${expected}\n`);
  assert.equal(new ConfigStore(path).getSecret(SERIAL), expected);
  assert.equal(cli(path, 'show-secret').stderr, '');
});

test('writes are atomic and use owner-only POSIX permissions where supported', (t) => {
  const path = configFor(t, null);
  new ConfigStore(path).addSerial(SERIAL, SECRET);
  if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(join(path, '..')), ['bna.conf']);
  assert.equal(new ConfigStore(path).getDefaultSerial(), SERIAL);
});

test('invalid arguments do not change the configuration or reveal secrets', (t) => {
  const path = configFor(t);
  const before = readFileSync(path, 'utf8');
  for (const args of [
    ['bogus'],
    ['delete'],
    ['new', SERIAL],
    ['show', '--region', 'EU'],
    ['show', '--interactive', '--no-interactive'],
    ['new', '--set-default', '--no-set-default'],
    ['--unknown'],
    ['show', SECOND],
    ['--config'],
  ]) {
    const result = cli(path, ...args);
    assert.equal(result.status, 1, JSON.stringify(args));
    assert.match(result.stderr, /^Error:/);
    assert.equal(result.stderr.includes(SECRET), false);
  }
  assert.equal(readFileSync(path, 'utf8'), before);
});

test('malformed INI errors identify lines without disclosing stored values', (t) => {
  const path = configFor(t, `[${SERIAL}]\nsecret = ${SECRET}\nsecret = ${SECRET}\n`);
  const result = cli(path, 'list');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /line 3/);
  assert.equal(result.stderr.includes(SECRET), false);
  assert.throws(() => parseConfig('[bna]\n[bna]\n'), /Duplicate/);
  assert.throws(() => parseConfig('no section'), /line 1/);
});

test('Python-style comments, CRLF, case-insensitive options and DEFAULT secrets work', (t) => {
  const path = configFor(
    t,
    `; comment\r\n[DEFAULT]\r\nSecret: ${SECRET}\r\n# comment\r\n[${SERIAL}]\r\n[bna]\r\nDEFAULT_SERIAL = ${SERIAL}\r\n`,
  );
  const config = new ConfigStore(path);
  assert.deepEqual(config.serials(), [SERIAL]);
  assert.equal(config.getSecret(SERIAL), SECRET);
  assert.equal(config.getDefaultSerial(), SERIAL);
});

test('default config locations honor XDG and Windows AppData', () => {
  assert.equal(
    getDefaultConfigPath({ HOME: '/home/test', XDG_CONFIG_HOME: '/custom' }, 'linux'),
    join('/custom', 'bna', 'bna.conf'),
  );
  assert.equal(
    getDefaultConfigPath({ HOME: '/home/test' }, 'linux'),
    join('/home/test', '.config', 'bna', 'bna.conf'),
  );
  assert.equal(
    getDefaultConfigPath({ APPDATA: '/roaming' }, 'win32'),
    join('/roaming', 'bna', 'bna.conf'),
  );
});

test(
  'interactive tokens refresh and Ctrl-C exits cleanly',
  { skip: process.platform === 'win32', timeout: 10_000 },
  async (t) => {
    const path = configFor(t);
    const child = spawn(process.execPath, [bin, '--config', path, 'show', '--interactive']);
    t.after(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
    });
    const closed = once(child, 'close');
    let output = '';
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.stdout.on('data', (chunk) => {
        output += chunk;
        if ((output.match(/\r\d{8}/g) ?? []).length >= 2) resolve();
      });
    });
    child.kill('SIGINT');
    const [code] = await closed;
    assert.equal(code, 0);
    assert.match(output, /Ctrl-C to exit/);
    assert.equal(output.endsWith('\n'), true);
  },
);
