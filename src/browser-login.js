import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { parseSsoInput } from './modern.js';
import { getOtpAuthUrl } from './utils.js';
import {
  buildBattleNetLoginUrl,
  renderLoginPage,
  renderConfirmationPage,
  renderReceivedPage,
  renderResultPage,
  renderErrorPage,
  renderClosedPage,
} from './login-page.js';
import { openBrowser } from './open-browser.js';

export { BATTLE_NET_LOGIN_URL } from './login-page.js';
export { browserCommand, openBrowser } from './open-browser.js';

const LOGIN_TIMEOUT_MS = 10 * 60_000;
const RESULT_TIMEOUT_MS = 30 * 60_000;
const resultScript = readFileSync(new URL('../web/result.js', import.meta.url), 'utf8');
const MAX_FORM_BYTES = 8192;
const INVALID_TOKEN_MESSAGE =
  'No valid login token found. Try signing in again, or paste the complete final return address.';

function setPrivateResponseHeaders(response) {
  response.setHeader('Cache-Control', 'no-store');
  // Keep the Origin header on local form POSTs. `no-referrer` makes browsers
  // send Origin: null, which fails our same-origin check. External links still
  // receive no referrer under this policy.
  response.setHeader('Referrer-Policy', 'same-origin');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'none'",
      "style-src 'unsafe-inline'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
    ].join('; '),
  );
  response.setHeader('Connection', 'close');
}

function isLocalFormSubmission(request, expectedOrigin) {
  return (
    request.method === 'POST' &&
    request.headers.origin === expectedOrigin &&
    request.headers['content-type']?.startsWith('application/x-www-form-urlencoded')
  );
}

// Return null for an oversized form. Never log the body: it contains a login token.
async function readForm(request) {
  const chunks = [];
  let bytesRead = 0;
  for await (const chunk of request) {
    bytesRead += chunk.length;
    if (bytesRead > MAX_FORM_BYTES) {
      return null;
    }
    chunks.push(chunk);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

/**
 * Receive a browser callback, then wait for the user's attachment confirmation.
 * `token` resolves only after confirmation. Enrollment happens in enroll.js,
 * which calls showResult or showError to update the waiting browser page.
 * `cancel()` closes the server and releases its stored result.
 */
export async function startBrowserLogin({
  timeout = LOGIN_TIMEOUT_MS,
  resultTimeout = RESULT_TIMEOUT_MS,
  signal,
} = {}) {
  if (![timeout, resultTimeout].every((value) => Number.isSafeInteger(value) && value > 0)) {
    throw new TypeError('timeouts must be positive integers');
  }
  if (signal?.aborted) {
    throw new Error('Sign-in cancelled');
  }

  const formPath = `/login/${randomBytes(24).toString('hex')}`;
  const callbackPath = `${formPath}/callback`;
  const confirmPath = `${formPath}/confirm`;
  const resultPath = `${formPath}/result`;
  const recoveryPath = `${formPath}/recovery`;
  const scriptPath = `${formPath}/result.js`;
  const closePath = `${formPath}/close`;
  let origin;
  let expectedHost;
  let callbackHost;
  let loginUrl;
  let pendingToken;
  let timer;
  let phase = 'login';
  let result;
  let recoveryData;
  let mayBeAttached = false;
  let resolveToken;
  let rejectToken;

  const token = new Promise((resolve, reject) => {
    resolveToken = resolve;
    rejectToken = reject;
  });
  // The browser may still be launching when cancellation occurs.
  token.catch(() => {});

  function close(error = new Error('Setup closed')) {
    if (phase === 'closed') {
      return;
    }
    phase = 'closed';
    pendingToken = undefined;
    result = undefined;
    recoveryData = undefined;
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
    server.close();
    rejectToken(error); // Has no effect after the login promise was resolved.
  }

  function cancel() {
    close(new Error('Sign-in cancelled'));
    server.closeAllConnections();
  }

  function startResultTimer() {
    clearTimeout(timer);
    timer = setTimeout(cancel, resultTimeout);
  }

  function showResult({ serial, secret, requireHealup, recovery }) {
    if (phase !== 'working') return;
    result = { serial, secret, requireHealup, otpUrl: getOtpAuthUrl(serial, secret) };
    recoveryData = recovery;
    phase = 'complete';
    startResultTimer();
    return `${origin}${resultPath}`;
  }

  function showError({ recovery, attachmentRequested = false } = {}) {
    if (phase !== 'working') return;
    recoveryData = recovery;
    mayBeAttached = attachmentRequested;
    phase = 'failed';
    startResultTimer();
  }

  function redirect(response, path) {
    response.writeHead(303, { Location: `${origin}${path}` }).end();
  }

  function showLogin(response, status = 200, errorMessage = '') {
    response.writeHead(status).end(renderLoginPage({ formPath, loginUrl, errorMessage }));
  }

  function receiveToken(response, receivedToken) {
    if (pendingToken && pendingToken !== receivedToken) {
      response.writeHead(409).end('A sign-in has already been received for this session.');
      return;
    }
    pendingToken = receivedToken;
    // Strip the token from the address bar before displaying any page. Return to
    // the canonical origin even when the callback arrived through localhost.
    response.setHeader('Referrer-Policy', 'no-referrer');
    redirect(response, confirmPath);
  }

  async function handleRequest(request, response) {
    setPrivateResponseHeaders(response);
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    let url;
    try {
      url = new URL(request.url, origin);
    } catch {
      response.writeHead(400).end('Invalid request address');
      return;
    }
    const isCallback = url.pathname === callbackPath;
    const validHost =
      request.headers.host === expectedHost ||
      (isCallback && request.headers.host === callbackHost);
    if (phase === 'closed' || !validHost || url.origin !== origin) {
      response.writeHead(404).end('Not found');
      return;
    }

    if (request.method === 'GET' && isCallback) {
      if (phase !== 'login') {
        response.writeHead(409).end('Sign-in has already been confirmed.');
        return;
      }
      try {
        if (url.searchParams.getAll('ST').length !== 1) {
          throw new Error('Expected one login token');
        }
        receiveToken(response, parseSsoInput(url.href));
      } catch {
        showLogin(response, 400, INVALID_TOKEN_MESSAGE);
      }
      return;
    }

    // Secrets stay out of result URLs. Every route belongs to this random session.
    const paths = [formPath, confirmPath, resultPath, recoveryPath, scriptPath, closePath];
    if (url.search || !paths.includes(url.pathname)) {
      response.writeHead(404).end('Not found');
      return;
    }
    if (request.method === 'GET') {
      if (url.pathname === scriptPath && phase === 'complete') {
        response.setHeader('Content-Type', 'text/javascript; charset=utf-8');
        response.end(resultScript);
      } else if (url.pathname === recoveryPath && recoveryData !== undefined) {
        response.setHeader('Content-Type', 'application/json');
        response.setHeader(
          'Content-Disposition',
          'attachment; filename="battle-net-authenticator-recovery.json"',
        );
        response.end(recoveryData);
      } else if (url.pathname === resultPath && phase !== 'login') {
        if (phase === 'complete') {
          // Only the result page loads a script, shipped locally for the copy buttons.
          response.setHeader(
            'Content-Security-Policy',
            `${response.getHeader('Content-Security-Policy')}; script-src 'self'`,
          );
          response.end(
            renderResultPage({
              ...result,
              recoveryUrl: recoveryPath,
              scriptUrl: scriptPath,
              closePath,
            }),
          );
        } else if (phase === 'failed') {
          response.end(
            renderErrorPage({
              mayBeAttached,
              hasRecovery: recoveryData !== undefined,
              recoveryUrl: recoveryPath,
              closePath,
            }),
          );
        } else {
          response.end(renderReceivedPage());
        }
      } else if (![formPath, confirmPath, resultPath].includes(url.pathname)) {
        response.writeHead(404).end('Not found');
      } else if (phase !== 'login') {
        redirect(response, resultPath);
      } else if (url.pathname === resultPath) {
        redirect(response, formPath);
      } else if (url.pathname === confirmPath && pendingToken) {
        response.end(renderConfirmationPage(confirmPath));
      } else {
        showLogin(response);
      }
      return;
    }
    if (!isLocalFormSubmission(request, origin)) {
      response.writeHead(403).end('Invalid request origin or method');
      return;
    }
    if (![formPath, confirmPath, closePath].includes(url.pathname)) {
      response.writeHead(405).end('Method not allowed');
      return;
    }

    try {
      const form = await readForm(request);
      if (form === null) {
        response.writeHead(413).end('Request too large');
        return;
      }
      if (url.pathname === closePath) {
        if (phase === 'working') {
          response.writeHead(409).end('Wait for enrollment to finish before closing setup.');
          return;
        }
        response.end(renderClosedPage());
        close();
        return;
      }
      // Repeated clicks and browser refreshes never trigger a second attachment.
      if (phase !== 'login') {
        redirect(response, resultPath);
        return;
      }
      if (url.pathname === formPath) {
        receiveToken(response, parseSsoInput(form.get('token')));
        return;
      }
      if (!pendingToken) {
        showLogin(response, 409, 'Sign in before attaching an authenticator.');
        return;
      }
      phase = 'working';
      startResultTimer();
      redirect(response, resultPath);
      resolveToken(pendingToken);
      pendingToken = undefined;
    } catch {
      showLogin(response, 400, INVALID_TOKEN_MESSAGE);
    }
  }

  const server = http.createServer(handleRequest);
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const port = server.address().port;
  expectedHost = `127.0.0.1:${port}`;
  callbackHost = `localhost:${port}`;
  origin = `http://${expectedHost}`;
  const callbackUrl = `http://${callbackHost}${callbackPath}`;
  loginUrl = buildBattleNetLoginUrl(callbackUrl);
  timer = setTimeout(() => {
    close(new Error('Sign-in timed out; run enrollment again'));
    server.closeAllConnections();
  }, timeout);
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) {
    cancel();
  }
  return {
    url: `${origin}${formPath}`,
    callbackUrl,
    resultUrl: `${origin}${resultPath}`,
    token,
    showResult,
    showError,
    cancel,
  };
}

export async function loginWithBrowser({
  stdout = process.stdout,
  signal,
  launch = openBrowser,
  timeout,
  resultTimeout,
} = {}) {
  const session = await startBrowserLogin({ signal, timeout, resultTimeout });
  stdout.write(`Sign in using the local browser page:\n${session.url}\n`);
  try {
    try {
      await launch(session.url);
    } catch {
      stdout.write('Open the local URL above manually to continue.\n');
    }
    return session;
  } catch (error) {
    session.cancel();
    throw error;
  }
}
