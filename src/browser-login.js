import { randomBytes } from 'node:crypto';
import http from 'node:http';
import { parseSsoInput } from './modern.js';
import {
  buildBattleNetLoginUrl,
  renderLoginPage,
  renderConfirmationPage,
  renderReceivedPage,
} from './login-page.js';
import { openBrowser } from './open-browser.js';

export { BATTLE_NET_LOGIN_URL } from './login-page.js';
export { browserCommand, openBrowser } from './open-browser.js';

const LOGIN_TIMEOUT_MS = 10 * 60_000;
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
 * `token` resolves only after confirmation; `cancel()` closes the session.
 * Enrollment itself happens in enroll.js.
 */
export async function startBrowserLogin({ timeout = LOGIN_TIMEOUT_MS, signal } = {}) {
  if (!Number.isSafeInteger(timeout) || timeout <= 0) {
    throw new TypeError('timeout must be a positive integer');
  }
  if (signal?.aborted) {
    throw new Error('Sign-in cancelled');
  }

  const formPath = `/login/${randomBytes(24).toString('hex')}`;
  const callbackPath = `${formPath}/callback`;
  const confirmPath = `${formPath}/confirm`;
  let origin;
  let expectedHost;
  let callbackHost;
  let loginUrl;
  let pendingToken;
  let timer;
  let settled = false;
  let resolveToken;
  let rejectToken;

  const token = new Promise((resolve, reject) => {
    resolveToken = resolve;
    rejectToken = reject;
  });
  // The browser may still be launching when cancellation occurs.
  token.catch(() => {});

  function finish(error, receivedToken) {
    if (settled) {
      return;
    }
    settled = true;
    pendingToken = undefined;
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
    server.close();
    if (error) {
      server.closeAllConnections();
      rejectToken(error);
    } else {
      resolveToken(receivedToken);
    }
  }

  function cancel() {
    finish(new Error('Sign-in cancelled'));
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
    response.writeHead(303, { Location: `${origin}${confirmPath}` }).end();
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
    if (settled || !validHost || url.origin !== origin) {
      response.writeHead(404).end('Not found');
      return;
    }

    if (request.method === 'GET' && isCallback) {
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

    // Only the callback may have a query string. No form or success page needs a token in its URL.
    if (url.search || ![formPath, confirmPath].includes(url.pathname)) {
      response.writeHead(404).end('Not found');
      return;
    }
    if (request.method === 'GET') {
      if (url.pathname === confirmPath && pendingToken) {
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

    try {
      const form = await readForm(request);
      if (form === null) {
        response.writeHead(413).end('Request too large');
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
      response.end(renderReceivedPage());
      finish(null, pendingToken);
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
    finish(new Error('Sign-in timed out; run enrollment again'));
  }, timeout);
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) {
    cancel();
  }
  return { url: `${origin}${formPath}`, callbackUrl, token, cancel };
}

export async function loginWithBrowser({
  stdout = process.stdout,
  signal,
  launch = openBrowser,
  timeout,
} = {}) {
  const session = await startBrowserLogin({ signal, timeout });
  stdout.write(`Sign in using the local browser page:\n${session.url}\n`);
  try {
    try {
      await launch(session.url);
    } catch {
      stdout.write('Open the local URL above manually to continue.\n');
    }
    return await session.token;
  } finally {
    session.cancel();
  }
}
