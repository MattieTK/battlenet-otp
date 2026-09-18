import { readFileSync } from 'node:fs';

// The relative return address is retained only for manual sign-in as a fallback.
export const BATTLE_NET_LOGIN_URL = 'https://account.battle.net/login/en/?ref=localhost';

// Read the shipped source files directly. There is no template compiler or build.
const loginTemplate = readFileSync(new URL('../web/login.html', import.meta.url), 'utf8');
const confirmTemplate = readFileSync(new URL('../web/confirm.html', import.meta.url), 'utf8');
const receivedTemplate = readFileSync(new URL('../web/received.html', import.meta.url), 'utf8');
const resultTemplate = readFileSync(new URL('../web/result.html', import.meta.url), 'utf8');
const errorTemplate = readFileSync(new URL('../web/error.html', import.meta.url), 'utf8');
const closedTemplate = readFileSync(new URL('../web/closed.html', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../web/login.css', import.meta.url), 'utf8');

/** Ask Battle.net to return to this session's complete loopback callback address. */
export function buildBattleNetLoginUrl(callbackUrl) {
  const callback = new URL(callbackUrl);
  if (
    callback.protocol !== 'http:' ||
    !['localhost', '127.0.0.1'].includes(callback.hostname) ||
    !callback.port ||
    callback.username ||
    callback.password ||
    callback.search ||
    callback.hash
  ) {
    throw new TypeError(
      'Callback must be an HTTP loopback address with a port and no credentials or query',
    );
  }
  const loginUrl = new URL(BATTLE_NET_LOGIN_URL);
  loginUrl.searchParams.set('ref', callback.href);
  return loginUrl.href;
}

function escapeHtml(value) {
  const replacements = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  };
  return String(value).replace(/[&<>"']/g, (character) => replacements[character]);
}

function renderTemplate(template, textValues = {}) {
  const values = Object.fromEntries(
    Object.entries(textValues).map(([name, value]) => [name, escapeHtml(value)]),
  );
  // Only our local stylesheet is inserted as markup. All other values are escaped.
  values.styles = styles;
  return template.replace(/{{([a-zA-Z]+)}}/g, (placeholder, name) => {
    if (!Object.hasOwn(values, name)) {
      throw new Error(`Unknown page placeholder: ${name}`);
    }
    return values[name];
  });
}

export function renderLoginPage({ formPath, loginUrl, errorMessage = '' }) {
  const freshLoginUrl = new URL('https://account.battle.net/login/en/logout');
  freshLoginUrl.searchParams.set('ref', loginUrl);
  return renderTemplate(loginTemplate, {
    formPath,
    loginUrl,
    fallbackLoginUrl: BATTLE_NET_LOGIN_URL,
    freshLoginUrl: freshLoginUrl.href,
    errorMessage,
  });
}

export function renderConfirmationPage(confirmPath) {
  return renderTemplate(confirmTemplate, { confirmPath });
}

export function renderReceivedPage() {
  return renderTemplate(receivedTemplate);
}

export function renderResultPage(values) {
  return renderTemplate(resultTemplate, {
    ...values,
    accountNotice: values.requireHealup
      ? 'Battle.net reports that additional account setup is required. Check your account settings.'
      : '',
  });
}

export function renderErrorPage({ mayBeAttached, hasRecovery, recoveryUrl, closePath }) {
  return renderTemplate(errorTemplate, {
    message: mayBeAttached
      ? 'Battle.net may have attached an authenticator. Check your account before trying again.'
      : 'Sign-in could not be completed. Start setup again to get a fresh sign-in.',
    recoveryHidden: hasRecovery ? '' : 'hidden',
    recoveryUrl,
    closePath,
  });
}

export function renderClosedPage() {
  return renderTemplate(closedTemplate);
}
