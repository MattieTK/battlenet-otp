import { readFileSync } from 'node:fs';

export const BATTLE_NET_LOGIN_URL = 'https://account.battle.net/login/en/?ref=localhost';

// Read the shipped source files directly. There is no template compiler or build.
const loginTemplate = readFileSync(new URL('../web/login.html', import.meta.url), 'utf8');
const receivedTemplate = readFileSync(new URL('../web/received.html', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../web/login.css', import.meta.url), 'utf8');

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

export function renderLoginPage(formPath, errorMessage = '') {
  const values = {
    // CSS comes only from our own file. Every other inserted value is escaped.
    styles,
    loginUrl: escapeHtml(BATTLE_NET_LOGIN_URL),
    formPath: escapeHtml(formPath),
    errorMessage: escapeHtml(errorMessage),
  };

  // A single pass prevents inserted text from being interpreted as a placeholder.
  return loginTemplate.replace(
    /{{(styles|loginUrl|formPath|errorMessage)}}/g,
    (placeholder, name) => values[name],
  );
}

export function renderReceivedPage() {
  return receivedTemplate.replace('{{styles}}', () => styles);
}
