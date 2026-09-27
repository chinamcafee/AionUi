// 移植自 client-reference/server/secret-vault.ts（上游 commit 915d14c0）。
// 账户级密钥保险箱：UMK / 设备私钥等 E2EE 材料以 AES-256-GCM 整体加密落盘于账户目录 secrets.vault。
// AionUi 适配：主密钥由 Electron safeStorage 保护的密钥文件派生（见 service.ts 的 ensureVaultReady），
// 文件读写保持上游同步实现（文件 ≤2MiB、原子 rename、0600/0700 权限校验）。

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { accountRuntime } from '../memory/account-runtime.js';

const SECRET_NAME = /^[A-Za-z0-9][A-Za-z0-9:._-]{1,199}$/;
const MAX_VAULT_BYTES = 2 * 1024 * 1024;
let masterKey: Buffer | null = null;
let syncScope = '';
function scopedName(name: string): string {
  return syncScope && name.startsWith('personal-sync:') ? syncScope + name : name;
}
/** Scope the sync vault by verified server origin, tenant, user and device. */
export function bindPersonalSyncScope(identity: {
  baseUrl: string;
  tenantId: string;
  userId: string;
  deviceId: string;
}) {
  syncScope =
    'ps:' +
    createHash('sha256')
      .update(
        JSON.stringify([new URL(identity.baseUrl).origin, identity.tenantId, identity.userId, identity.deviceId, 1])
      )
      .digest('hex') +
    ':';
}
export function clearPersonalSyncScope() {
  syncScope = '';
}
export function legacyPersonalSyncSecrets(): Record<string, string> {
  return Object.fromEntries(Object.entries(read()).filter(([key]) => key.startsWith('personal-sync:')));
}
/** Called only after a trusted server envelope was decrypted using the legacy identity. */
export function migrateVerifiedPersonalSyncSecrets(expectedDigest: string) {
  if (!syncScope) throw new Error('ESCROW_CACHE_SCOPE_INVALID');
  const data = read();
  if (data['personal-sync:keyset-digest'] !== expectedDigest) throw new Error('ESCROW_CACHE_SCOPE_INVALID');
  const marker = 'personal-sync:legacy-scope';
  if (data[marker] && data[marker] !== syncScope) throw new Error('ESCROW_CACHE_SCOPE_INVALID');
  for (const [key, value] of Object.entries(data))
    if (key.startsWith('personal-sync:') && key !== marker) {
      if (data[scopedName(key)] && data[scopedName(key)] !== value) throw new Error('ESCROW_CACHE_SCOPE_INVALID');
      data[scopedName(key)] = value;
    }
  data[marker] = syncScope;
  write(data);
}

interface VaultEnvelope {
  version: 1;
  iv: string;
  tag: string;
  ciphertext: string;
}
type VaultData = Record<string, string>;

function key() {
  if (!masterKey) throw new Error('SECRET_VAULT_LOCKED');
  return masterKey;
}

function filePath() {
  const directory = accountRuntime.currentDirectory();
  if (!directory) throw new Error('ACCOUNT_RUNTIME_REQUIRED');
  return path.join(directory, 'secrets.vault');
}

function validateName(name: string) {
  if (!SECRET_NAME.test(name)) throw new Error('SECRET_NAME_INVALID');
}

function read(): VaultData {
  const target = filePath();
  if (!fs.existsSync(target)) return {};
  const info = fs.lstatSync(target);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size <= 0 ||
    info.size > MAX_VAULT_BYTES ||
    (process.platform !== 'win32' && (info.mode & 0o077) !== 0)
  )
    throw new Error('SECRET_VAULT_INVALID');
  try {
    const envelope = JSON.parse(fs.readFileSync(target, 'utf8')) as VaultEnvelope;
    if (envelope.version !== 1) throw new Error();
    const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(envelope.iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64url'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
    const value = JSON.parse(plaintext) as VaultData;
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.entries(value).some(([name, secret]) => !SECRET_NAME.test(name) || typeof secret !== 'string')
    )
      throw new Error();
    return value;
  } catch (error) {
    if (error instanceof Error && error.message === 'SECRET_VAULT_LOCKED') throw error;
    throw new Error('SECRET_VAULT_INVALID');
  }
}

function write(data: VaultData) {
  const target = filePath();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]);
  const envelope: VaultEnvelope = {
    version: 1,
    iv: iv.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
    ciphertext: ciphertext.toString('base64url'),
  };
  const serialized = JSON.stringify(envelope);
  if (Buffer.byteLength(serialized) > MAX_VAULT_BYTES) throw new Error('SECRET_VAULT_TOO_LARGE');
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, serialized, { mode: 0o600, flag: 'wx' });
  try {
    fs.renameSync(temporary, target);
    if (process.platform !== 'win32') fs.chmodSync(target, 0o600);
  } catch (error) {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      /* ignore */
    }
    throw error;
  }
}

export function unlockSecretVault(encodedKey: string) {
  const decoded = Buffer.from(encodedKey, 'base64url');
  if (decoded.length !== 32) throw new Error('SECRET_VAULT_KEY_INVALID');
  masterKey?.fill(0);
  masterKey = Buffer.from(decoded);
}

export function isSecretVaultUnlocked() {
  return masterKey !== null;
}

export function getSecret(name: string): string {
  validateName(name);
  return read()[scopedName(name)] ?? '';
}

export function hasSecret(name: string): boolean {
  return !!getSecret(name);
}

export function setSecret(name: string, value: string): void {
  validateName(name);
  if (typeof value !== 'string' || value.length > 256 * 1024) throw new Error('SECRET_VALUE_INVALID');
  const data = read();
  if (value) data[scopedName(name)] = value;
  else delete data[scopedName(name)];
  write(data);
}

export function deleteSecret(name: string): void {
  setSecret(name, '');
}
