import { randomBytes } from 'node:crypto';
import http from 'node:http';
import { parseSsoInput } from './modern.js';
import { renderLoginPage, renderReceivedPage } from './login-page.js';
import { openBrowser } from './open-browser.js';

// Keep existing imports working after separating the page and browser launcher.
export { BATTLE_NET_LOGIN_URL } from './login-page.js';
export { browserCommand, openBrowser } from './open-browser.js';

const LOGIN_TIMEOUT_MS = 10 * 60_000;
const MAX_FORM_BYTES = 8192;
const INVALID_TOKEN_MESSAGE =
  'No valid login token found. Copy the complete final localhost address after signing in.';

function setPrivateResponseHeaders(response) {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Referrer-Policy', 'no-referrer');
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
 * Start one temporary loopback login session.
 * `token` resolves when a valid form is submitted; `cancel()` closes the session.
 * This server receives the login token only. Enrollment happens in enroll.js.
 */
export async function startBrowserLogin({ timeout = LOGIN_TIMEOUT_MS, signal } = {}) {
  if (!Number.isSafeInteger(timeout) || timeout <= 0) {
    throw new TypeError('timeout must be a positive integer');
  }
  if (signal?.aborted) {
    throw new Error('Sign-in cancelled');
  }

  const formPath = `/login/${randomBytes(24).toString('hex')}`;
  let origin;
  let expectedHost;
  let timer;
  let settled = false;
  let resolveToken;
  let rejectToken;

  const token = new Promise((resolve, reject) => {
    resolveToken = resolve;
    rejectToken = reject;
  });
  // Callers may still be launching a browser when cancellation occurs.
  token.catch(() => {});

  function finish(error, receivedToken) {
    if (settled) {
      return;
    }
    settled = true;
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

  async function handleRequest(request, response) {
    setPrivateResponseHeaders(response);

    // The random path and exact Host/Origin checks restrict access to this session.
    if (settled || request.headers.host !== expectedHost || request.url !== formPath) {
      response.writeHead(404).end('Not found');
      return;
    }

    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (request.method === 'GET') {
      response.end(renderLoginPage(formPath));
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

      const receivedToken = parseSsoInput(form.get('token'));
      response.end(renderReceivedPage());
      finish(null, receivedToken);
    } catch {
      // Do not reflect the submitted address or token into the error page.
      response.writeHead(400).end(renderLoginPage(formPath, INVALID_TOKEN_MESSAGE));
    }
  }

  const server = http.createServer(handleRequest);
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  expectedHost = `127.0.0.1:${server.address().port}`;
  origin = `http://${expectedHost}`;
  timer = setTimeout(() => {
    finish(new Error('Sign-in timed out; run enrollment again'));
  }, timeout);
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) {
    cancel();
  }

  return { url: `${origin}${formPath}`, token, cancel };
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
