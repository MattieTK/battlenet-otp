import { closeSync, fsyncSync, mkdirSync, openSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loginWithBrowser } from './browser-login.js';
import { ModernAPIClient } from './modern.js';

/**
 * Read this function first to follow the whole enrollment flow.
 * A successful request changes the Battle.net account; it is never retried here.
 */
export async function enrollWithBrowser({
  config,
  setDefault = true,
  stdout = process.stdout,
  login = loginWithBrowser,
  client = new ModernAPIClient(),
  signal,
} = {}) {
  // 1. Reserve a private recovery file before changing the remote account.
  const configDirectory = dirname(config.path);
  mkdirSync(configDirectory, { recursive: true, mode: 0o700 });
  const recoveryPath = join(configDirectory, `bna-enrollment-${randomUUID()}.json`);
  const recoveryFile = openSync(recoveryPath, 'wx', 0o600);
  let recoveryStarted = false;
  let recoverySaved = false;
  let recovery;
  let browser;
  let attachmentRequested = false;

  async function saveRecovery(responseData) {
    // Preserve even a partial file if writing or fsync fails after attachment.
    recoveryStarted = true;
    recovery = `${JSON.stringify(responseData, null, 2)}\n`;
    writeFileSync(recoveryFile, recovery, 'utf8');
    fsyncSync(recoveryFile);
    recoverySaved = true;
  }

  try {
    // 2. Sign in on Battle.net, then exchange the returned SSO login token.
    browser = await login({ stdout, signal });
    const loginToken = await browser.token;
    stdout.write('Completing Battle.net sign-in...\n');
    const accessToken = await client.exchangeSsoToken(loginToken);
    if (signal?.aborted) {
      throw new Error('Enrollment cancelled before the account change');
    }

    // 3. Attach once. The client calls saveRecovery before validating the response.
    stdout.write('Attaching the new authenticator...\n');
    attachmentRequested = true;
    const authenticator = await client.enroll(accessToken, { saveRecovery });

    // 4. Store the validated secret and restore code in the normal config file.
    config.addSerial(authenticator.serial, authenticator.secret, {
      setDefault,
      restoreCode: authenticator.restoreCode,
    });
    const resultUrl = browser.showResult({ ...authenticator, recovery });
    return { ...authenticator, recoveryPath, resultUrl };
  } catch (error) {
    // The browser gets a safe summary, never an arbitrary exception or response body.
    browser?.showError({ recovery, attachmentRequested });
    if (recoverySaved) {
      error.message += ` Recovery data was saved to ${recoveryPath}. Do not repeat enrollment.`;
    } else if (recoveryStarted) {
      error.message += ` Recovery storage failed; a partial file may exist at ${recoveryPath}. Do not repeat enrollment.`;
    }
    throw error;
  } finally {
    closeSync(recoveryFile);
    if (!recoveryStarted) {
      unlinkSync(recoveryPath);
    }
  }
}
