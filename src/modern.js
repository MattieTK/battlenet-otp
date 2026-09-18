import { encodeBase32 } from './base32.js';
import { prettifySerial } from './utils.js';
import { restoreCodeToBytes } from './crypto.js';
import { HTTPError, ProtocolError } from './http.js';

// These are the only remote destinations used by browser-based enrollment.
const SSO_ENDPOINT = 'https://oauth.battle.net/oauth/sso';
const ENROLL_ENDPOINT =
  'https://authenticator-rest-api.bnet-identity.blizzard.net/v1/authenticator';

// Public mobile client identifier from python-bna issue #42; not a client secret.
const MOBILE_CLIENT_ID = 'baedda12fe054e4abdfc3ad7bdea970a';
const MAX_RESPONSE_BYTES = 1024 * 1024;
const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'];
const ACCOUNT_HOSTS = ['account.battle.net', 'eu.account.battle.net', 'us.account.battle.net'];
const SSO_TOKEN_PATTERN = /^(US|EU|CN|KR)-[A-Za-z0-9-]{10,2048}$/;
const BEARER_TOKEN_PATTERN = /^[\x21-\x7e]+$/;

function isExpectedRedirect(url) {
  if (LOOPBACK_HOSTS.includes(url.hostname)) {
    return true;
  }

  // Battle.net can treat `ref=localhost` as a relative path. Its resulting 404
  // still carries the ST login token in the address bar; the page need not load.
  return (
    url.protocol === 'https:' &&
    ACCOUNT_HOSTS.includes(url.hostname) &&
    /^\/login\/[a-z]{2}(?:-[a-z]{2})?\/localhost\/?$/i.test(url.pathname)
  );
}

/** Extract an SSO login token from a pasted redirect address or a bare token. */
export function parseSsoInput(input) {
  if (typeof input !== 'string') {
    throw new TypeError('Enter the redirected localhost URL or SSO token');
  }

  let token = input.trim();
  if (/^https?:\/\//i.test(token)) {
    let redirectUrl;
    try {
      redirectUrl = new URL(token);
    } catch {
      throw new TypeError('Invalid redirect URL');
    }
    if (!isExpectedRedirect(redirectUrl)) {
      throw new TypeError('Expected the final localhost redirect address from Battle.net');
    }
    token = redirectUrl.searchParams.get('ST') ?? '';
  }

  if (!SSO_TOKEN_PATTERN.test(token)) {
    throw new TypeError(
      'No valid SSO token found. Finish the Battle.net login and copy the final localhost address.',
    );
  }
  return token;
}

function statusHint(status) {
  switch (status) {
    case 401:
      return 'Sign in again; the login token may have expired.';
    case 409:
      return 'An authenticator may already be attached to this account.';
    case 403:
      return 'Blizzard denied this request; check the account requirements.';
    default:
      return 'The service did not accept the request.';
  }
}

async function readJsonResponse(response, label) {
  if (!response.body) {
    throw new ProtocolError(`${label} returned an empty response`);
  }

  let bytesRead = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    bytesRead += chunk.length;
    if (bytesRead > MAX_RESPONSE_BYTES) {
      throw new ProtocolError(`${label} response exceeds 1 MiB`);
    }
    chunks.push(Buffer.from(chunk));
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ProtocolError(`${label} returned invalid JSON`);
  }
}

/** Login exchange and enrollment only. Disk writes belong to enroll.js. */
export class ModernAPIClient {
  constructor({ fetchImpl = globalThis.fetch, timeout = 15_000 } = {}) {
    if (!Number.isSafeInteger(timeout) || timeout <= 0) {
      throw new TypeError('timeout must be a positive integer');
    }
    this.fetch = fetchImpl;
    this.timeout = timeout;
  }

  async request(url, options, label) {
    let response;
    try {
      response = await this.fetch(url, {
        ...options,
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeout),
      });
    } catch {
      // Raw fetch errors can contain credentials. Keep diagnostics generic.
      throw new Error(`${label} could not connect or timed out`);
    }

    if (!response.ok) {
      await response.body?.cancel();
      throw new HTTPError(
        `${label} returned HTTP ${response.status}. ${statusHint(response.status)}`,
        { status: response.status },
      );
    }
    return readJsonResponse(response, label);
  }

  async exchangeSsoToken(input) {
    const loginToken = parseSsoInput(input);
    const form = new URLSearchParams({
      client_id: MOBILE_CLIENT_ID,
      grant_type: 'client_sso',
      scope: 'auth.authenticator',
      token: loginToken,
    });
    const data = await this.request(
      SSO_ENDPOINT,
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
          Accept: 'application/json',
        },
        body: form.toString(),
      },
      'Battle.net sign-in',
    );

    if (
      !data ||
      typeof data.access_token !== 'string' ||
      !BEARER_TOKEN_PATTERN.test(data.access_token) ||
      data.token_type?.toLowerCase() !== 'bearer'
    ) {
      throw new ProtocolError('Battle.net did not return a bearer token');
    }
    return data.access_token;
  }

  async enroll(accessToken, { saveRecovery = async () => {} } = {}) {
    if (typeof accessToken !== 'string' || !BEARER_TOKEN_PATTERN.test(accessToken)) {
      throw new TypeError('A valid bearer token is required');
    }

    const data = await this.request(
      ENROLL_ENDPOINT,
      {
        headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}` },
        body: '',
      },
      'Authenticator enrollment',
    );

    // The account may already be changed. Save successful JSON before validating
    // its shape, and never automatically retry this operation.
    await saveRecovery(data);
    if (
      !data ||
      typeof data.deviceSecret !== 'string' ||
      !/^[0-9a-f]{40}$/i.test(data.deviceSecret)
    ) {
      throw new ProtocolError(
        'Enrollment returned an invalid device secret. Check the saved recovery file.',
      );
    }
    const serial = prettifySerial(data.serial);
    if (typeof data.restoreCode !== 'string' || data.restoreCode.length !== 10) {
      throw new ProtocolError(
        'Enrollment returned an invalid restore code. Check the saved recovery file.',
      );
    }
    restoreCodeToBytes(data.restoreCode);

    return {
      serial,
      secret: encodeBase32(Buffer.from(data.deviceSecret, 'hex')),
      restoreCode: data.restoreCode.toUpperCase(),
      timeMs: Number.isSafeInteger(data.timeMs) ? data.timeMs : null,
      requireHealup: data.requireHealup === true,
    };
  }
}
