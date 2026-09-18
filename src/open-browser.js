import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { release } from 'node:os';

// Return a command and separate arguments; never construct a shell command.
export function browserCommand(
  url,
  platform = process.platform,
  isWsl = /microsoft/i.test(release()),
) {
  const parsedUrl = new URL(url);
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    throw new TypeError('Browser URL must use HTTP(S)');
  }

  if (platform === 'win32' || isWsl) {
    const windowsPowerShell = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
    const executable =
      isWsl && existsSync(windowsPowerShell) ? windowsPowerShell : 'powershell.exe';
    // A literal single quote inside a PowerShell single-quoted string is doubled.
    const quotedUrl = parsedUrl.href.replaceAll("'", "''");
    return [
      executable,
      ['-NoProfile', '-NonInteractive', '-Command', `Start-Process -FilePath '${quotedUrl}'`],
    ];
  }

  if (platform === 'darwin') {
    return ['open', [parsedUrl.href]];
  }
  return ['xdg-open', [parsedUrl.href]];
}

export async function openBrowser(url) {
  const [command, argumentsList] = browserCommand(url);
  await new Promise((resolve, reject) => {
    const child = spawn(command, argumentsList, { stdio: 'ignore', shell: false });
    child.once('error', () => {
      reject(new Error('Could not open the browser automatically'));
    });
    child.once('exit', (exitCode) => {
      if (exitCode === 0) {
        resolve();
      } else {
        reject(new Error('Browser launcher failed'));
      }
    });
  });
}
