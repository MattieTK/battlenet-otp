import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { decodeBase32, encodeBase32 } from './base32.js';
import { normalizeSerial, prettifySerial } from './utils.js';
import { restoreCodeToBytes } from './crypto.js';

export function getDefaultConfigPath(env = process.env, platform = process.platform) {
  const home = env.HOME || homedir();
  const base =
    platform === 'win32'
      ? env.APPDATA || join(home, 'AppData', 'Roaming')
      : env.XDG_CONFIG_HOME || join(home, '.config');
  return join(base, 'bna', 'bna.conf');
}

export function parseConfig(text) {
  const sections = new Map();
  let current;
  for (const [index, raw] of text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .entries()) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const header = /^\[([^\]\r\n]+)\](?:\s*[#;].*)?$/.exec(line);
    if (header) {
      if (sections.has(header[1])) throw new Error(`Duplicate config section at line ${index + 1}`);
      current = new Map();
      sections.set(header[1], current);
      continue;
    }
    const option = /^([^=:]+?)\s*[=:]\s*(.*)$/.exec(line);
    if (!current || !option) throw new Error(`Invalid config syntax at line ${index + 1}`);
    const key = option[1].trim().toLowerCase();
    if (!key || current.has(key))
      throw new Error(`Invalid or duplicate config option at line ${index + 1}`);
    current.set(key, option[2].trim());
  }
  return sections;
}

export class ConfigStore {
  constructor(
    path = getDefaultConfigPath(),
    { warn = (message) => process.stderr.write(`${message}\n`) } = {},
  ) {
    const expanded = path === '~' ? homedir() : path.replace(/^~[/\\]/, `${homedir()}/`);
    this.path = resolve(expanded);
    this.warn = warn;
    try {
      this.sections = parseConfig(readFileSync(this.path, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') this.sections = new Map();
      else
        throw new Error(`Could not read config file ${this.path}: ${error.message}`, {
          cause: error,
        });
    }
  }

  serials() {
    return [...this.sections.keys()].filter((key) => key !== 'bna' && key !== 'DEFAULT');
  }

  getDefaultSerial() {
    return normalizeSerial(this.sections.get('bna')?.get('default_serial') ?? '');
  }

  resolveSerial(value) {
    const serial = value ? normalizeSerial(value) : this.getDefaultSerial();
    if (!serial) {
      if (!this.serials().length) {
        throw new Error(
          "You do not have any configured authenticators. Use 'bna enroll' or provide an existing bna.conf with --config.",
        );
      }
      throw new Error(
        "You do not have a default authenticator set. Provide a serial or use 'bna set-default <serial>'.",
      );
    }
    if (!this.serials().includes(serial)) throw new Error(`No such authenticator: ${serial}`);
    return serial;
  }

  getSecret(value) {
    const serial = this.resolveSerial(value);
    let secret =
      this.sections.get(serial).get('secret') ?? this.sections.get('DEFAULT')?.get('secret');
    if (typeof secret !== 'string') throw new Error(`No secret configured for ${serial}`);
    if (/^[0-9a-f]{40}$/i.test(secret)) {
      this.warn('Found old format for secret store. Converting.');
      secret = encodeBase32(Buffer.from(secret, 'hex'));
      this.sections.get(serial).set('secret', secret);
      this.write();
    }
    decodeBase32(secret);
    return secret.toUpperCase();
  }

  addSerial(value, secret, { setDefault = false, restoreCode } = {}) {
    const serial = prettifySerial(value);
    decodeBase32(secret);
    if (restoreCode !== undefined) {
      if (typeof restoreCode !== 'string' || restoreCode.length !== 10)
        throw new TypeError('Invalid restore code');
      restoreCodeToBytes(restoreCode);
    }
    if (this.sections.has(serial))
      throw new Error(`A secret already exists for ${serial}. Delete it before replacing it.`);
    this.sections.set(serial, new Map([['secret', secret.toUpperCase()]]));
    if (restoreCode !== undefined)
      this.sections.get(serial).set('restore_code', restoreCode.toUpperCase());
    if (setDefault || !this.getDefaultSerial()) this.setDefaultValue(serial);
    this.write();
  }

  setDefaultValue(serial) {
    if (!this.sections.has('bna')) this.sections.set('bna', new Map());
    this.sections.get('bna').set('default_serial', serial);
  }

  setDefaultSerial(value) {
    const serial = this.resolveSerial(value);
    this.setDefaultValue(serial);
    this.write();
    return serial;
  }

  deleteSerial(value) {
    const serial = this.resolveSerial(value);
    this.sections.delete(serial);
    if (serial === this.getDefaultSerial()) this.sections.get('bna').delete('default_serial');
    this.write();
    return serial;
  }

  write() {
    const contents = [...this.sections]
      .map(([name, options]) => {
        const entries = [...options].map(([key, value]) => `${key} = ${value}`).join('\n');
        return `[${name}]\n${entries}\n`;
      })
      .join('\n');
    const directory = dirname(this.path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = join(directory, `.bna-${randomUUID()}.tmp`);
    try {
      writeFileSync(temporary, contents, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      renameSync(temporary, this.path);
    } catch (error) {
      throw new Error(`Could not write config file ${this.path}: ${error.message}`, {
        cause: error,
      });
    } finally {
      try {
        unlinkSync(temporary);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  }
}
