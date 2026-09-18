import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { ConfigStore, getDefaultConfigPath } from './config.js';
import { enrollWithBrowser } from './enroll.js';
import {
  getOtpAuthUrl,
  getRestoreCode,
  normalizeSerial,
  prettifySerial,
  requestNewSerial,
  restore,
  TOTP,
} from './index.js';

const HELP = `Usage: bna [--config PATH] [COMMAND] [OPTIONS]
       bna [--config PATH] [SERIAL]

Commands:
  show [SERIAL]                 Show the current 8-digit token (default command)
  enroll                       Open browser login and attach a new authenticator
  new                          Request an authenticator using the legacy API
  restore SERIAL RESTORE_CODE  Recover an authenticator
  delete SERIAL                Delete a saved authenticator
  list                         List configured authenticators
  set-default [SERIAL]          Choose the default authenticator
  show-restore-code [SERIAL]    Display the restore code
  show-url [SERIAL]             Display an OTPAuth URL
  show-secret [SERIAL]          Display the stored Base32 secret

Options:
  --config PATH                Read/write an existing Python-compatible INI file
  --region US|EU|CN|KR          Region for 'new' (default: US)
  --set-default                Make the new/restored serial the default
  --no-set-default             Keep the current default
  --interactive                Refresh 'show' each second; Ctrl-C to exit
  --no-interactive             Print once (default)
  --help, -h                   Show this help
  --version, -v                Show the version

'enroll' and 'new' set the default unless --no-set-default is given. 'restore' preserves
an existing default unless --set-default is given. The first serial is always
the default. 'enroll' uses browser sign-in; 'new' and 'restore' use the legacy API.
`;

const COMMANDS = new Map([
  ['enroll', { min: 0, max: 0, options: ['set-default', 'no-set-default'] }],
  ['show', { min: 0, max: 1, options: ['interactive', 'no-interactive'] }],
  ['new', { min: 0, max: 0, options: ['region', 'set-default', 'no-set-default'] }],
  ['restore', { min: 2, max: 2, options: ['set-default', 'no-set-default'] }],
  ['delete', { min: 1, max: 1, options: [] }],
  ['list', { min: 0, max: 0, options: [] }],
  ['set-default', { min: 0, max: 1, options: [] }],
  ['show-restore-code', { min: 0, max: 1, options: [] }],
  ['show-url', { min: 0, max: 1, options: [] }],
  ['show-secret', { min: 0, max: 1, options: [] }],
]);

async function showInteractive(totp, stdout) {
  stdout.write('Ctrl-C to exit\n');
  stdout.write(`\r${totp.now()}`);
  await new Promise((resolve) => {
    const timer = setInterval(() => stdout.write(`\r${totp.now()}`), 1000);
    const stop = () => {
      clearInterval(timer);
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      stdout.write('\n');
      resolve();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}

export async function runCli(
  args = process.argv.slice(2),
  {
    stdout = process.stdout,
    stderr = process.stderr,
    services = { requestNewSerial, restore, enrollWithBrowser },
  } = {},
) {
  try {
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: {
        config: { type: 'string' },
        region: { type: 'string' },
        'set-default': { type: 'boolean' },
        'no-set-default': { type: 'boolean' },
        interactive: { type: 'boolean' },
        'no-interactive': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    });
    if (values.help) {
      stdout.write(HELP);
      return 0;
    }
    if (values.version) {
      const { version } = JSON.parse(
        readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
      );
      stdout.write(`javascript-bna ${version}\n`);
      return 0;
    }

    let command = positionals.shift() ?? 'show';
    if (/^[A-Z]{2}\d{12}$/.test(normalizeSerial(command))) {
      positionals.unshift(command);
      command = 'show';
    }
    const definition = COMMANDS.get(command);
    if (!definition) throw new Error(`Unknown command: ${command}. Use 'bna --help'.`);
    if (positionals.length < definition.min || positionals.length > definition.max) {
      throw new Error(`Wrong number of arguments for '${command}'. Use 'bna --help'.`);
    }
    for (const option of Object.keys(values)) {
      if (!['config', 'help', 'version', ...definition.options].includes(option)) {
        throw new Error(`Option --${option} is not supported by '${command}'`);
      }
    }
    for (const option of ['interactive', 'set-default']) {
      if (values[option] && values[`no-${option}`])
        throw new Error(`Choose only one of --${option} and --no-${option}`);
    }

    const config = new ConfigStore(values.config || getDefaultConfigPath(), {
      warn: (message) => stderr.write(`${message}\n`),
    });
    const [argument] = positionals;
    const print = (value) => stdout.write(`${value}\n`);
    switch (command) {
      case 'enroll': {
        const controller = new AbortController();
        const cancel = () => controller.abort();
        process.once('SIGINT', cancel);
        process.once('SIGTERM', cancel);
        try {
          const result = await services.enrollWithBrowser({
            config,
            setDefault: !values['no-set-default'],
            stdout,
            signal: controller.signal,
          });
          print(`New authenticator saved: ${result.serial}`);
          print(`Configuration: ${config.path}`);
          print(`Recovery backup: ${result.recoveryPath}`);
          if (result.requireHealup)
            print(
              'Blizzard reports that additional account setup is required. Check your Battle.net account.',
            );
        } finally {
          process.off('SIGINT', cancel);
          process.off('SIGTERM', cancel);
        }
        break;
      }
      case 'new': {
        const { serial, secret } = await services.requestNewSerial(values.region ?? 'US');
        config.addSerial(serial, secret, { setDefault: !values['no-set-default'] });
        print(`Success! Your new authenticator is: ${prettifySerial(serial)}`);
        break;
      }
      case 'restore': {
        const serial = prettifySerial(argument);
        if (config.sections.has(serial))
          throw new Error(`A secret already exists for ${serial}. Delete it before replacing it.`);
        const secret = await services.restore(serial, positionals[1]);
        config.addSerial(serial, secret, { setDefault: !!values['set-default'] });
        print(`Restored ${prettifySerial(serial)}`);
        break;
      }
      case 'delete':
        print(`Deleted authenticator: ${prettifySerial(config.deleteSerial(argument))}`);
        break;
      case 'list': {
        const serials = config.serials();
        for (const serial of serials)
          print(`${serial}${serial === config.getDefaultSerial() ? ' (default)' : ''}`);
        print(`${serials.length} authenticators`);
        break;
      }
      case 'set-default':
        print(
          `${prettifySerial(config.setDefaultSerial(argument))} is now your default authenticator.`,
        );
        break;
      default: {
        const serial = config.resolveSerial(argument);
        const secret = config.getSecret(serial);
        if (command === 'show-secret') print(secret);
        else if (command === 'show-restore-code')
          print(config.sections.get(serial).get('restore_code') ?? getRestoreCode(serial, secret));
        else if (command === 'show-url')
          stdout.write(getOtpAuthUrl(serial, secret) + (stdout.isTTY ? '\n' : ''));
        else {
          const totp = new TOTP(secret);
          if (values.interactive) await showInteractive(totp, stdout);
          else print(totp.now());
        }
      }
    }
    return 0;
  } catch (error) {
    stderr.write(`Error: ${error.message}\n`);
    return 1;
  }
}
