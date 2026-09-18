import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { startBrowserLogin } from '../src/browser-login.js';
import { ConfigStore } from '../src/config.js';
import { enrollWithBrowser } from '../src/enroll.js';
import { renderResultPage } from '../src/login-page.js';
import { encodeBase32, getOtpAuthUrl, ModernAPIClient } from '../src/index.js';

const SSO = 'EU-synthetic-result-test-1234567890';
const BEARER = 'synthetic-result-bearer';
const payload = {
  serial: 'US-1234-5678-9012',
  restoreCode: '4B91NQCYQ3',
  deviceSecret: '0123456789abcdef0123456789abcdef01234567',
  timeMs: 1700000000000,
  requireHealup: true,
};

function post(url, origin = new URL(url).origin) {
  return fetch(url, {
    method: 'POST',
    redirect: 'manual',
    body: '',
    headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' },
  });
}

async function harness(t, { failSignIn = false, failConfig = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'bna-result-'));
  const config = new ConfigStore(join(directory, 'bna.conf'));
  const session = await startBrowserLogin({ timeout: 5000, resultTimeout: 5000 });
  t.after(() => {
    session.cancel();
    rmSync(directory, { recursive: true, force: true });
  });
  if (failConfig)
    config.addSerial = () => {
      throw new Error('Synthetic disk failure');
    };
  let attachments = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const client = new ModernAPIClient({
    fetchImpl: async (url) => {
      if (url.includes('/oauth/')) {
        return failSignIn
          ? Response.json({ private: BEARER }, { status: 401 })
          : Response.json({ access_token: BEARER, token_type: 'bearer' });
      }
      attachments++;
      await gate;
      return Response.json(payload);
    },
  });
  let output = '';
  const enrollment = enrollWithBrowser({
    config,
    client,
    login: async () => session,
    stdout: {
      write: (value) => {
        output += value;
      },
    },
  });
  enrollment.catch(() => {});
  const callback = new URL(session.callbackUrl);
  callback.searchParams.set('ST', SSO);
  const received = await fetch(callback, { redirect: 'manual' });
  assert.equal(received.status, 303);
  assert.equal(attachments, 0);
  const confirmUrl = received.headers.get('location');
  const confirmed = await post(confirmUrl);
  assert.equal(confirmed.status, 303);
  assert.equal(confirmed.headers.get('location'), session.resultUrl);
  return {
    session,
    enrollment,
    confirmUrl,
    config,
    release,
    attachments: () => attachments,
    output: () => output,
  };
}

test('browser shows progress then saved OTP settings, allows recovery download, and closes without reenrollment', async (t) => {
  const run = await harness(t);
  const { session } = run;
  const waiting = await fetch(session.resultUrl);
  assert.match(await waiting.text(), /Your OTP setup value will appear here/);
  assert.equal((await fetch(`${session.url}/recovery`)).status, 404);
  assert.equal((await post(run.confirmUrl)).status, 303);
  assert.equal((await post(`${session.url}/close`)).status, 409);
  run.release();
  const result = await run.enrollment;
  assert.equal(run.attachments(), 1);
  assert.equal(result.resultUrl, session.resultUrl);
  const page = await fetch(session.resultUrl);
  const html = await page.text();
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
  assert.match(html, /Authenticator attached/);
  const setupUrl = getOtpAuthUrl(result.serial, result.secret);
  assert.ok(html.includes(setupUrl.replaceAll('&', '&amp;')));
  assert.match(html, /additional account setup is required/);
  for (const sensitive of [SSO, BEARER]) assert.equal(html.includes(sensitive), false);
  for (const sensitive of [SSO, BEARER, result.secret])
    assert.equal(run.output().includes(sensitive), false);
  const script = await fetch(`${session.url}/result.js`);
  assert.match(script.headers.get('content-type'), /javascript/);
  assert.match(await script.text(), /navigator.clipboard.writeText/);
  const recovery = await fetch(`${session.url}/recovery`);
  assert.equal(recovery.headers.get('cache-control'), 'no-store');
  assert.match(recovery.headers.get('content-disposition'), /^attachment;/);
  assert.deepEqual(await recovery.json(), payload);
  assert.deepEqual(JSON.parse(readFileSync(result.recoveryPath, 'utf8')), payload);
  assert.equal((await post(run.confirmUrl)).status, 303);
  assert.equal(run.attachments(), 1);
  assert.equal((await fetch(`${session.resultUrl}?extra=1`)).status, 404);
  assert.equal((await post(`${session.url}/close`, 'https://evil.example')).status, 403);
  assert.equal((await post(`${session.url}/close`, 'null')).status, 403);
  const closed = await post(`${session.url}/close`);
  assert.match(await closed.text(), /Setup closed/);
  await assert.rejects(fetch(session.resultUrl));
});

test('failed sign-in shows a safe error and never makes the attachment request', async (t) => {
  const run = await harness(t, { failSignIn: true });
  await assert.rejects(run.enrollment, /401/);
  const html = await (await fetch(run.session.resultUrl)).text();
  assert.match(html, /Setup did not finish/);
  assert.match(html, /fresh sign-in/);
  assert.equal(html.includes(BEARER), false);
  assert.equal(run.attachments(), 0);
  assert.equal((await fetch(`${run.session.url}/recovery`)).status, 404);
});

test('config failure after attachment keeps recovery downloadable without claiming success or retrying', async (t) => {
  const run = await harness(t, { failConfig: true });
  run.release();
  await assert.rejects(run.enrollment, /Recovery data was saved/);
  const html = await (await fetch(run.session.resultUrl)).text();
  assert.match(html, /Setup did not finish/);
  assert.match(html, /may have attached an authenticator/);
  assert.doesNotMatch(html, /<h1>Authenticator attached/);
  const recovery = await fetch(`${run.session.url}/recovery`);
  assert.deepEqual(await recovery.json(), payload);
  assert.equal((await post(run.confirmUrl)).status, 303);
  assert.equal(run.attachments(), 1);
});

test('completed result sessions expire and can still be cancelled after confirmation', async (t) => {
  for (const expire of [false, true]) {
    const session = await startBrowserLogin({ timeout: 5000, resultTimeout: 80 });
    t.after(session.cancel);
    const callback = new URL(session.callbackUrl);
    callback.searchParams.set('ST', SSO);
    const received = await fetch(callback, { redirect: 'manual' });
    await post(received.headers.get('location'));
    await session.token;
    session.showResult({
      serial: payload.serial,
      secret: encodeBase32(Buffer.from(payload.deviceSecret, 'hex')),
      recovery: JSON.stringify(payload),
    });
    if (expire) await new Promise((resolve) => setTimeout(resolve, 120));
    else session.cancel();
    await assert.rejects(fetch(session.resultUrl));
  }
});

test('result template escapes values and loads only the local copy script', () => {
  const html = renderResultPage({
    otpUrl: '</textarea><script>private</script>',
    secret: '"><script>private</script>',
    serial: '<private>',
    recoveryUrl: '/local/recovery',
    scriptUrl: '/local/result.js',
    closePath: '/local/close',
  });
  assert.doesNotMatch(html, /<script>private|{{[a-zA-Z]+}}/);
  assert.match(html, /&lt;\/textarea&gt;/);
  assert.match(html, /<script src="\/local\/result.js" defer>/);
});
