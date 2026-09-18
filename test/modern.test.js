import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { get } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { browserCommand, startBrowserLogin } from '../src/browser-login.js';
import { ConfigStore } from '../src/config.js';
import { enrollWithBrowser } from '../src/enroll.js';
import {
  buildBattleNetLoginUrl,
  renderLoginPage,
  renderConfirmationPage,
  renderReceivedPage,
} from '../src/login-page.js';
import { encodeBase32, getOtpAuthUrl, ModernAPIClient, parseSsoInput } from '../src/index.js';

const SSO = 'EU-synthetic-login-token-1234567890';
const BEARER = 'synthetic-bearer-token';
const payload = {
  serial: 'US-1234-5678-9012',
  restoreCode: '4B91NQCYQ3',
  deviceSecret: '0123456789abcdef0123456789abcdef01234567',
  timeMs: 1700000000000,
  requireHealup: false,
};

test('SSO extraction accepts only expected tokens and loopback redirect URLs', () => {
  assert.equal(parseSsoInput(SSO), SSO);
  assert.equal(parseSsoInput(`http://localhost/?ST=${SSO}`), SSO);
  assert.equal(
    parseSsoInput(`https://account.battle.net/login/en/localhost?ST=${SSO}&flowTrackingId=`),
    SSO,
  );
  assert.equal(parseSsoInput(`https://eu.account.battle.net/login/en/localhost?ST=${SSO}`), SSO);
  for (const value of [
    'bad',
    `https://evil.example/?ST=${SSO}`,
    `http://account.battle.net/login/en/localhost?ST=${SSO}`,
    `https://account.battle.net.evil.example/login/en/localhost?ST=${SSO}`,
    'http://localhost/',
    '\r\nBad: header',
  ]) {
    assert.throws(() => parseSsoInput(value));
  }
});

test('modern SSO and enrollment use the documented endpoints and preserve recovery before returning', async () => {
  const requests = [];
  const client = new ModernAPIClient({
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return Response.json(
        requests.length === 1 ? { access_token: BEARER, token_type: 'bearer' } : payload,
      );
    },
  });
  const bearer = await client.exchangeSsoToken(SSO);
  let backup;
  const result = await client.enroll(bearer, {
    saveRecovery: async (value) => {
      backup = value;
    },
  });
  assert.deepEqual(backup, payload);
  assert.equal(requests[0].url, 'https://oauth.battle.net/oauth/sso');
  assert.equal(new URLSearchParams(requests[0].options.body).get('token'), SSO);
  assert.equal(new URLSearchParams(requests[0].options.body).get('scope'), 'auth.authenticator');
  assert.equal(
    requests[1].url,
    'https://authenticator-rest-api.bnet-identity.blizzard.net/v1/authenticator',
  );
  assert.equal(requests[1].options.headers.Authorization, `Bearer ${BEARER}`);
  assert.equal(requests[1].options.redirect, 'error');
  assert.equal(result.serial, 'US123456789012');
  assert.equal(result.secret, encodeBase32(Buffer.from(payload.deviceSecret, 'hex')));
  const url = new URL(getOtpAuthUrl(result.serial, result.secret));
  assert.equal(url.searchParams.get('digits'), '8');
});

test('modern failures do not echo tokens, headers or response bodies', async () => {
  const client = new ModernAPIClient({
    fetchImpl: async () => Response.json({ secret: BEARER }, { status: 409 }),
  });
  await assert.rejects(
    client.enroll(BEARER),
    (error) => error.status === 409 && !error.message.includes(BEARER),
  );
  const offline = new ModernAPIClient({
    fetchImpl: async () => {
      throw new Error(SSO);
    },
  });
  await assert.rejects(offline.exchangeSsoToken(SSO), (error) => !error.message.includes(SSO));
});

test('malformed successful enrollment responses are backed up before validation fails', async () => {
  const invalid = { ...payload, deviceSecret: 'invalid' };
  let backup;
  const client = new ModernAPIClient({ fetchImpl: async () => Response.json(invalid) });
  await assert.rejects(
    client.enroll(BEARER, {
      saveRecovery: async (value) => {
        backup = value;
      },
    }),
    /device secret/,
  );
  assert.deepEqual(backup, invalid);
  const noToken = new ModernAPIClient({ fetchImpl: async () => Response.json({}) });
  await assert.rejects(noToken.exchangeSsoToken(SSO), /bearer token/);
});

test('login links use a complete loopback callback and reject remote destinations', () => {
  const callback = 'http://localhost:43210/login/example/callback';
  const loginUrl = new URL(buildBattleNetLoginUrl(callback));
  assert.equal(loginUrl.origin, 'https://account.battle.net');
  assert.equal(loginUrl.searchParams.get('ref'), callback);
  assert.equal(
    new URL(buildBattleNetLoginUrl(callback.replace('localhost', '127.0.0.1'))).searchParams.get(
      'ref',
    ),
    callback.replace('localhost', '127.0.0.1'),
  );
  for (const invalid of [
    'https://evil.example/callback',
    'http://localhost.evil.example:1234/',
    'http://user:password@localhost:1234/',
    'http://localhost:1234/?ST=secret',
    'http://localhost:1234/#token',
    'http://localhost/',
  ]) {
    assert.throws(() => buildBattleNetLoginUrl(invalid));
  }
});

test('readable HTML templates escape inserted text and require no remote assets or scripts', () => {
  const html = renderLoginPage({
    formPath: '/login/"<example>',
    loginUrl: 'https://account.battle.net/',
    errorMessage: '<script>bad()</script> {{formPath}} $&',
  });
  assert.match(html, /action="\/login\/&quot;&lt;example&gt;"/);
  assert.match(html, /&lt;script&gt;bad\(\)&lt;\/script&gt; {{formPath}} \$&amp;/);
  for (const page of [
    renderLoginPage({ formPath: '/login/example', loginUrl: 'https://account.battle.net/' }),
    renderConfirmationPage('/login/example/confirm'),
    renderReceivedPage(),
  ]) {
    assert.doesNotMatch(page, /{{[a-zA-Z]+}}/);
    assert.doesNotMatch(page, /<script|<link|<img/);
    assert.match(page, /<style>[\s\S]*color-scheme/);
  }
});

function postForm(url, fields = {}, origin = new URL(url).origin) {
  return fetch(url, {
    method: 'POST',
    redirect: 'manual',
    headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields),
  });
}

test('manual sign-in rejects cross-origin forms and requires a separate attachment confirmation', async (t) => {
  const session = await startBrowserLogin({ timeout: 5000 });
  t.after(session.cancel);
  const origin = new URL(session.url).origin;
  const page = await fetch(session.url);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.equal(page.headers.get('referrer-policy'), 'same-origin');
  const html = await page.text();
  assert.match(html, /account\.battle\.net\/login/);
  assert.match(html, /ref=http%3A%2F%2Flocalhost/);
  assert.match(html, /404 \/ File not found/);
  assert.doesNotMatch(html, /{{[a-zA-Z]+}}/);
  assert.equal((await fetch(`${origin}/wrong-path`)).status, 404);
  assert.equal((await postForm(session.url, { token: SSO }, 'https://evil.example')).status, 403);
  assert.equal((await postForm(session.url, { token: SSO }, 'null')).status, 403);
  const invalid = await postForm(session.url, { token: '<script>private-token</script>' });
  assert.equal(invalid.status, 400);
  assert.doesNotMatch(await invalid.text(), /private-token/);
  const review = await postForm(session.url, { token: `http://localhost/?ST=${SSO}` });
  assert.equal(review.status, 303);
  const confirmationUrl = review.headers.get('location');
  assert.equal(new URL(confirmationUrl).origin, origin);
  assert.equal((await postForm(confirmationUrl, {}, 'https://evil.example')).status, 403);
  assert.equal((await postForm(confirmationUrl, {}, 'null')).status, 403);
  const accepted = await postForm(confirmationUrl);
  assert.equal(accepted.status, 303);
  assert.equal((await accepted.text()).includes(SSO), false);
  assert.equal(await session.token, SSO);
});

test('callback captures one token and removes it from the URL before the confirmation page', async (t) => {
  const session = await startBrowserLogin({ timeout: 5000 });
  t.after(session.cancel);
  let confirmed = false;
  session.token
    .then(() => {
      confirmed = true;
    })
    .catch(() => {});
  const callback = new URL(session.callbackUrl);
  callback.searchParams.set('ST', SSO);
  const response = await fetch(callback, { redirect: 'manual' });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  const confirmationUrl = response.headers.get('location');
  assert.equal(new URL(confirmationUrl).search, '');
  assert.equal(new URL(confirmationUrl).origin, new URL(session.url).origin);
  assert.equal(confirmationUrl.includes(SSO), false);
  const page = await fetch(confirmationUrl);
  assert.equal(page.headers.get('referrer-policy'), 'same-origin');
  const html = await page.text();
  assert.match(html, /Sign-in received/);
  assert.match(html, /Continue and attach authenticator/);
  assert.equal(html.includes(SSO), false);
  assert.equal(confirmed, false);
  assert.equal((await fetch(callback, { redirect: 'manual' })).status, 303);
  callback.searchParams.set('ST', 'EU-another-synthetic-login-token');
  assert.equal((await fetch(callback, { redirect: 'manual' })).status, 409);
  assert.equal((await postForm(confirmationUrl)).status, 303);
  assert.equal(await session.token, SSO);
});

test('callback rejects invalid tokens, ambiguous parameters, unknown paths and unexpected hosts', async (t) => {
  const session = await startBrowserLogin({ timeout: 5000 });
  t.after(session.cancel);
  for (const query of ['', '?ST=invalid', `?ST=${SSO}&ST=${SSO}`]) {
    const response = await fetch(`${session.callbackUrl}${query}`, { redirect: 'manual' });
    assert.equal(response.status, 400);
    assert.equal((await response.text()).includes(SSO), false);
  }
  const wrongPath = new URL(session.callbackUrl);
  wrongPath.pathname = '/login/unknown/callback';
  wrongPath.searchParams.set('ST', SSO);
  assert.equal((await fetch(wrongPath)).status, 404);
  // Fetch controls the Host header, so use HTTP directly to test an unexpected host.
  const unexpectedHostStatus = await new Promise((resolve, reject) => {
    get(session.url, { headers: { Host: 'evil.example' } }, (response) => {
      response.resume();
      resolve(response.statusCode);
    }).on('error', reject);
  });
  assert.equal(unexpectedHostStatus, 404);
  assert.equal((await postForm(`${session.url}/confirm`)).status, 409);
  assert.equal((await postForm(session.url, { token: 'x'.repeat(9000) })).status, 413);
});

test('local login times out and supports cancellation', async () => {
  const timed = await startBrowserLogin({ timeout: 30 });
  await assert.rejects(timed.token, /timed out/);
  const controller = new AbortController();
  const cancelled = await startBrowserLogin({ signal: controller.signal });
  controller.abort();
  await assert.rejects(cancelled.token, /cancelled/);
});

test('browser launch commands avoid a shell and quote Windows URLs', () => {
  const url = 'http://127.0.0.1:8123/login/abcdef';
  assert.deepEqual(browserCommand(url, 'linux', false), ['xdg-open', [url]]);
  assert.deepEqual(browserCommand(url, 'darwin', false), ['open', [url]]);
  assert.equal(browserCommand(url, 'win32', false)[0], 'powershell.exe');
  assert.match(browserCommand(url, 'win32', false)[1].at(-1), /Start-Process -FilePath 'http/);
  assert.throws(() => browserCommand('file:///etc/passwd'), /HTTP/);
});

function testConfig(t) {
  const directory = mkdtempSync(join(tmpdir(), 'bna-modern-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return new ConfigStore(join(directory, 'bna.conf'));
}

function syntheticLogin() {
  return { token: SSO, showResult() {}, showError() {} };
}

test('browser enrollment saves the authenticator and recovery file without logging credentials', async (t) => {
  const config = testConfig(t);
  let output = '';
  const client = new ModernAPIClient({
    fetchImpl: async (url) =>
      Response.json(
        url.includes('/oauth/') ? { access_token: BEARER, token_type: 'bearer' } : payload,
      ),
  });
  const result = await enrollWithBrowser({
    config,
    client,
    login: async () => syntheticLogin(),
    stdout: {
      write: (value) => {
        output += value;
      },
    },
  });
  assert.equal(config.getSecret(result.serial), result.secret);
  assert.equal(config.sections.get(result.serial).get('restore_code'), payload.restoreCode);
  assert.deepEqual(JSON.parse(readFileSync(result.recoveryPath, 'utf8')), payload);
  assert.equal(
    output.includes(SSO) || output.includes(BEARER) || output.includes(result.secret),
    false,
  );
});

test('failed login removes the empty recovery file and leaves config absent', async (t) => {
  const config = testConfig(t);
  await assert.rejects(
    enrollWithBrowser({
      config,
      login: async () => {
        throw new Error('Login failed');
      },
    }),
    /Login failed/,
  );
  assert.equal(existsSync(config.path), false);
  assert.deepEqual(readdirSync(join(config.path, '..')), []);
});

test('if config save fails after attachment, a recovery backup survives and enrollment is never retried', async (t) => {
  const config = testConfig(t);
  config.addSerial = () => {
    throw new Error('Disk write failed');
  };
  let enrollments = 0;
  const client = new ModernAPIClient({
    fetchImpl: async (url) => {
      if (url.includes('/oauth/'))
        return Response.json({ access_token: BEARER, token_type: 'bearer' });
      enrollments++;
      return Response.json(payload);
    },
  });
  await assert.rejects(
    enrollWithBrowser({
      config,
      client,
      login: async () => syntheticLogin(),
      stdout: { write: () => {} },
    }),
    /Recovery data was saved/,
  );
  assert.equal(enrollments, 1);
  const backup = readdirSync(join(config.path, '..')).find((name) =>
    name.startsWith('bna-enrollment-'),
  );
  assert.deepEqual(JSON.parse(readFileSync(join(config.path, '..', backup), 'utf8')), payload);
});
