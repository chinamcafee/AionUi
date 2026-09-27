// 移植自 client-reference/server/personal-sync-crypto.ts（上游 commit 915d14c0）。
// 设备身份（X25519 加密钥 + Ed25519 签名钥）、UMK、设备信封、配对、恢复码/恢复轮换的客户端密码学。
// 协议语句（zsl:personal-sync:*）与 keysetDigest 算法与上游逐字节一致，team-server 端校验通过。
//
// AionUi 适配（协议不变、载体更换）：恢复包口令派生由 argon2id 换为 scrypt——
// Electron 37 内置 Node 22 无 crypto.argon2Sync（Node ≥24.7 才有），而恢复包对服务端不透明
// （服务端仅存 salt/params 并做区间校验，从不执行 KDF），故包内自带 kdf 描述符、打开时按描述符派生；
// 上报服务端的 argon2idParams 保持协议名义值（65536/3/1）以满足服务端区间校验。见 docs/03 E-31。

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  randomUUID,
  scryptSync,
  sign,
  type KeyObject,
} from 'node:crypto';
import { getSecret, setSecret } from './secretVault.js';
import {
  canonical,
  hash as escrowHash,
  signStatement,
  open as openOrgEnvelope,
  publicKey as escrowPublicKey,
  decode as escrowDecode,
  type Envelope,
  type Scope,
} from '../orgescrow/protocol';

const DEVICE_X25519_PRIVATE = 'personal-sync:device:x25519-private';
const DEVICE_ED25519_PRIVATE = 'personal-sync:device:ed25519-private';
const INITIALIZATION_REQUEST = 'personal-sync:initialization-request';
const INITIALIZATION_RECOVERY_CODE = 'personal-sync:initialization-recovery-code';
const RECOVERY_ROTATION_REQUEST = 'personal-sync:recovery-rotation-request';
const KEYSET_DIGEST = 'personal-sync:keyset-digest';
const ENVELOPE_ALGORITHM = 'X25519-HKDF-SHA256-AES-256-GCM';
const RECOVERY_PACKAGE_AAD = 'zsl:personal-sync:recovery-package:v1';

export interface RecoveryKdf {
  name: 'scrypt';
  N: number;
  r: number;
  p: number;
  keyLen: number;
}

const RECOVERY_KDF: RecoveryKdf = { name: 'scrypt', N: 65536, r: 8, p: 1, keyLen: 32 };
/** 协议名义参数（服务端区间校验要求 memoryKiB≥65536、passes≥3、parallelism≥1），实际 KDF 见 RECOVERY_KDF。 */
const NOMINAL_ARGON2ID_PARAMS = { memoryKiB: 65536, passes: 3, parallelism: 1 };

function deriveRecoveryKey(secret: Buffer, salt: Buffer, kdf: RecoveryKdf): Buffer {
  if (
    kdf?.name !== 'scrypt' ||
    kdf.N !== 65536 ||
    kdf.r !== 8 ||
    kdf.p !== 1 ||
    kdf.keyLen !== 32 ||
    salt.length !== 16 ||
    secret.length !== 32
  ) {
    throw new Error('RECOVERY_PACKAGE_KDF_UNSUPPORTED');
  }
  return Buffer.from(scryptSync(secret, salt, kdf.keyLen, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 256 * 1024 * 1024 }));
}

/** 生成 32 字节 vault 主密钥（base64url，43 字符）——由 Electron safeStorage 保护落盘。 */
export function generateVaultKey(): string {
  return randomBytes(32).toString('base64url');
}

export interface PersonalSyncInitializeRequest {
  idempotencyKey: string;
  x25519EncryptionPublicKey: string;
  x25519KeyFingerprint: string;
  ed25519SigningPublicKey: string;
  ed25519KeyFingerprint: string;
  deviceEnvelope: string;
  envelopeAlgorithm: typeof ENVELOPE_ALGORITHM;
  recoveryEd25519PublicKey: string;
  recoveryPublicKeyFingerprint: string;
  argon2idSalt: string;
  argon2idParams: { memoryKiB: number; passes: number; parallelism: number };
  encryptedRecoveryPackage: string;
  recoveryPackageHash: string;
  keysetDigest: string;
  devicePoPSignature: string;
  recoverySignature: string;
}

export interface PersonalSyncPairingRequest {
  x25519EncryptionPublicKey: string;
  x25519KeyFingerprint: string;
  ed25519SigningPublicKey: string;
  ed25519KeyFingerprint: string;
  challenge: string;
  popSignature: string;
}

export interface PersonalSyncPairingApprovalInput {
  id: string;
  pendingDeviceId: string;
  challenge: string;
  x25519EncryptionPublicKey: string;
  requiredKeyVersions: number[];
  keysetDigest: string;
  displayCode: string;
}

export interface PersonalSyncRecoveryChallenge {
  id: string;
  pendingDeviceId: string;
  nonce: string;
  expectedCounter: number;
}

export interface PersonalSyncRecoveryPackage {
  recoveryKdf?: RecoveryKdf & { salt: string };
  counter: number;
  recoveryEd25519PublicKey: string;
  argon2idSalt: string;
  argon2idParams: { memoryKiB: number; passes: number; parallelism: number };
  encryptedRecoveryPackage: string;
  recoveryPackageHash: string;
  keysetDigest: string;
}

interface DeviceIdentity {
  x25519Private: KeyObject;
  x25519PublicRaw: Buffer;
  ed25519Private: KeyObject;
  ed25519PublicRaw: Buffer;
}

function b64(value: Buffer | Uint8Array) {
  return Buffer.from(value).toString('base64url');
}
function digest(value: Buffer | string) {
  return createHash('sha256').update(value).digest();
}
function fingerprint(value: Buffer) {
  return digest(value).toString('hex');
}
function rawPublicKey(key: KeyObject) {
  const der = Buffer.from(key.export({ format: 'der', type: 'spki' }));
  if (der.length < 32) throw new Error('PERSONAL_SYNC_KEY_INVALID');
  return der.subarray(der.length - 32);
}

function privateDER(key: KeyObject) {
  return Buffer.from(key.export({ format: 'der', type: 'pkcs8' })).toString('base64url');
}

function storedPrivate(name: string) {
  const encoded = getSecret(name);
  if (!encoded) return null;
  try {
    return createPrivateKey({ key: Buffer.from(encoded, 'base64url'), format: 'der', type: 'pkcs8' });
  } catch {
    throw new Error('PERSONAL_SYNC_DEVICE_KEY_INVALID');
  }
}

export function loadOrCreateDeviceIdentity(): DeviceIdentity {
  let x25519Private = storedPrivate(DEVICE_X25519_PRIVATE);
  let ed25519Private = storedPrivate(DEVICE_ED25519_PRIVATE);
  if (!x25519Private) {
    x25519Private = generateKeyPairSync('x25519').privateKey;
    setSecret(DEVICE_X25519_PRIVATE, privateDER(x25519Private));
  }
  if (!ed25519Private) {
    ed25519Private = generateKeyPairSync('ed25519').privateKey;
    setSecret(DEVICE_ED25519_PRIVATE, privateDER(ed25519Private));
  }
  const x25519Public = createPublicKey(x25519Private);
  const ed25519Public = createPublicKey(ed25519Private);
  return {
    x25519Private,
    x25519PublicRaw: rawPublicKey(x25519Public),
    ed25519Private,
    ed25519PublicRaw: rawPublicKey(ed25519Public),
  };
}

function seal(plaintext: Buffer, keyBuf: Buffer, aad: Buffer) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyBuf, iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv: b64(iv), tag: b64(cipher.getAuthTag()), ciphertext: b64(ciphertext) };
}

/** 读取恢复包自带的 KDF 描述符（盐随协议字段单独下发，不在包内）。 */
function readPackageKdf(encoded: string): RecoveryKdf {
  let envelope: { version: number; kdf?: RecoveryKdf };
  try {
    envelope = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    throw new Error('RECOVERY_PACKAGE_INVALID');
  }
  if (envelope.version !== 1 || !envelope.kdf) throw new Error('RECOVERY_PACKAGE_INVALID');
  return envelope.kdf;
}

function openSealedPackageWithKey(encoded: string, keyBuf: Buffer, aad: Buffer): Buffer {
  let envelope: { version: number; iv: string; tag: string; ciphertext: string };
  try {
    envelope = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    throw new Error('RECOVERY_PACKAGE_INVALID');
  }
  if (envelope.version !== 1) throw new Error('RECOVERY_PACKAGE_INVALID');
  try {
    const decipher = createDecipheriv('aes-256-gcm', keyBuf, Buffer.from(envelope.iv, 'base64url'));
    decipher.setAAD(aad);
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64url')), decipher.final()]);
  } catch {
    throw new Error('RECOVERY_CODE_INVALID');
  }
}

function createDeviceEnvelope(umk: Buffer, recipientPublicRaw: Buffer) {
  const ephemeral = generateKeyPairSync('x25519');
  const shared = diffieHellman({
    privateKey: ephemeral.privateKey,
    publicKey: createPublicKey({
      key: Buffer.concat([Buffer.from('302a300506032b656e032100', 'hex'), recipientPublicRaw]),
      format: 'der',
      type: 'spki',
    }),
  });
  const salt = randomBytes(16);
  const wrappingKey = Buffer.from(hkdfSync('sha256', shared, salt, 'zsl-personal-sync-device-envelope-v1', 32));
  const aad = Buffer.from('zsl:personal-sync:device-envelope:v1');
  const sealed = seal(umk, wrappingKey, aad);
  wrappingKey.fill(0);
  return Buffer.from(
    JSON.stringify({
      version: 1,
      ephemeralPublicKey: b64(rawPublicKey(ephemeral.publicKey)),
      salt: b64(salt),
      ...sealed,
    })
  );
}

function initializationStatement(
  request: Omit<PersonalSyncInitializeRequest, 'devicePoPSignature' | 'recoverySignature'>
) {
  return JSON.stringify(request);
}

function signatureMessage(signer: 'device' | 'recovery', requestHash: Buffer) {
  return Buffer.from(`zsl:personal-sync:initialize:${signer}:v1\n${requestHash.toString('hex')}`);
}

export function createPersonalSyncInitialization(): { request: PersonalSyncInitializeRequest; recoveryCode: string } {
  const existing = getSecret(INITIALIZATION_REQUEST);
  if (existing) {
    const recoveryCode = getSecret(INITIALIZATION_RECOVERY_CODE);
    if (!recoveryCode) throw new Error('PERSONAL_SYNC_INITIALIZATION_INVALID');
    return { request: JSON.parse(existing) as PersonalSyncInitializeRequest, recoveryCode };
  }
  const device = loadOrCreateDeviceIdentity();
  const recovery = generateKeyPairSync('ed25519');
  const recoveryPublicRaw = rawPublicKey(recovery.publicKey);
  const umk = randomBytes(32);
  const deviceEnvelope = createDeviceEnvelope(umk, device.x25519PublicRaw);
  const recoveryCodeBytes = randomBytes(32);
  const recoveryCode = b64(recoveryCodeBytes);
  const salt = randomBytes(16);
  const recoveryKey = deriveRecoveryKey(recoveryCodeBytes, salt, RECOVERY_KDF);
  const recoveryPlaintext = Buffer.from(
    JSON.stringify({
      version: 1,
      keyVersion: 1,
      umk: b64(umk),
      recoveryEd25519PrivateKey: privateDER(recovery.privateKey),
    })
  );
  const recoverySealed = seal(recoveryPlaintext, recoveryKey, Buffer.from(RECOVERY_PACKAGE_AAD));
  const recoveryPackage = Buffer.from(JSON.stringify({ version: 1, kdf: RECOVERY_KDF, ...recoverySealed }));
  recoveryKey.fill(0);
  recoveryCodeBytes.fill(0);
  const x25519Fingerprint = fingerprint(device.x25519PublicRaw);
  const ed25519Fingerprint = fingerprint(device.ed25519PublicRaw);
  const recoveryFingerprint = fingerprint(recoveryPublicRaw);
  const keysetDigest = `sha256:${digest(
    ['v1', x25519Fingerprint, ed25519Fingerprint, recoveryFingerprint, digest(deviceEnvelope).toString('hex')].join(
      '\n'
    )
  ).toString('hex')}`;
  const unsigned: Omit<PersonalSyncInitializeRequest, 'devicePoPSignature' | 'recoverySignature'> = {
    idempotencyKey: randomUUID(),
    x25519EncryptionPublicKey: b64(device.x25519PublicRaw),
    x25519KeyFingerprint: x25519Fingerprint,
    ed25519SigningPublicKey: b64(device.ed25519PublicRaw),
    ed25519KeyFingerprint: ed25519Fingerprint,
    deviceEnvelope: b64(deviceEnvelope),
    envelopeAlgorithm: ENVELOPE_ALGORITHM,
    recoveryEd25519PublicKey: b64(recoveryPublicRaw),
    recoveryPublicKeyFingerprint: recoveryFingerprint,
    argon2idSalt: b64(salt),
    argon2idParams: NOMINAL_ARGON2ID_PARAMS,
    encryptedRecoveryPackage: b64(recoveryPackage),
    recoveryPackageHash: `sha256:${digest(recoveryPackage).toString('hex')}`,
    keysetDigest,
  };
  const requestHash = digest(initializationStatement(unsigned));
  const request: PersonalSyncInitializeRequest = {
    ...unsigned,
    devicePoPSignature: b64(sign(null, signatureMessage('device', requestHash), device.ed25519Private)),
    recoverySignature: b64(sign(null, signatureMessage('recovery', requestHash), recovery.privateKey)),
  };
  setSecret('personal-sync:umk:v1', b64(umk));
  setSecret(INITIALIZATION_REQUEST, JSON.stringify(request));
  setSecret(INITIALIZATION_RECOVERY_CODE, recoveryCode);
  umk.fill(0);
  return { request, recoveryCode };
}

export function pendingPersonalSyncInitialization(): PersonalSyncInitializeRequest | null {
  const encoded = getSecret(INITIALIZATION_REQUEST);
  if (!encoded) return null;
  try {
    return JSON.parse(encoded) as PersonalSyncInitializeRequest;
  } catch {
    throw new Error('PERSONAL_SYNC_INITIALIZATION_INVALID');
  }
}

export function confirmPersonalSyncInitialization(keysetDigest: string) {
  const pending = pendingPersonalSyncInitialization();
  if (!pending || pending.keysetDigest !== keysetDigest) throw new Error('PERSONAL_SYNC_INITIALIZATION_MISMATCH');
  setSecret('personal-sync:initialization-v2-request', '');
  setSecret(INITIALIZATION_REQUEST, '');
  setSecret(INITIALIZATION_RECOVERY_CODE, '');
  setSecret(KEYSET_DIGEST, keysetDigest);
}

/** 本机已确立的密钥集摘要（快照 manifest 需要），未初始化时抛错。 */
export function storedKeysetDigest(): string {
  const value = getSecret(KEYSET_DIGEST);
  if (!/^sha256:[0-9a-f]{64}$/.test(value)) throw new Error('PERSONAL_SYNC_NOT_INITIALIZED');
  return value;
}

export function createPersonalSyncPairingRequest(subject: {
  tenantId: string;
  userId: string;
  deviceId: string;
}): PersonalSyncPairingRequest {
  for (const value of [subject.tenantId, subject.userId, subject.deviceId]) {
    if (!/^[0-9a-f-]{36}$/i.test(value)) throw new Error('PERSONAL_SYNC_PAIRING_SUBJECT_INVALID');
  }
  const device = loadOrCreateDeviceIdentity();
  const challenge = randomBytes(32);
  const message = Buffer.from(
    [
      'zsl:personal-sync:pairing-request:v1',
      subject.tenantId,
      subject.userId,
      subject.deviceId,
      challenge.toString('hex'),
    ].join('\n')
  );
  return {
    x25519EncryptionPublicKey: b64(device.x25519PublicRaw),
    x25519KeyFingerprint: fingerprint(device.x25519PublicRaw),
    ed25519SigningPublicKey: b64(device.ed25519PublicRaw),
    ed25519KeyFingerprint: fingerprint(device.ed25519PublicRaw),
    challenge: b64(challenge),
    popSignature: b64(sign(null, message, device.ed25519Private)),
  };
}

export function createPersonalSyncPairingApproval(input: PersonalSyncPairingApprovalInput) {
  const targetPublic = Buffer.from(input.x25519EncryptionPublicKey, 'base64url');
  if (
    targetPublic.length !== 32 ||
    !/^sha256:[0-9a-f]{64}$/.test(input.keysetDigest) ||
    !/^\d{8}$/.test(input.displayCode) ||
    Buffer.from(input.challenge, 'base64url').length !== 32 ||
    !Array.isArray(input.requiredKeyVersions) ||
    input.requiredKeyVersions.length === 0 ||
    new Set(input.requiredKeyVersions).size !== input.requiredKeyVersions.length
  ) {
    throw new Error('PERSONAL_SYNC_PAIRING_INVALID');
  }
  const versions = [...input.requiredKeyVersions].sort((left, right) => left - right);
  const keyEnvelopes = versions.map((keyVersion) => {
    const encodedUMK = getSecret(`personal-sync:umk:v${keyVersion}`);
    const umk = Buffer.from(encodedUMK, 'base64url');
    if (umk.length !== 32) throw new Error('KEYSET_INCOMPLETE');
    const wrappedKey = createDeviceEnvelope(umk, targetPublic);
    umk.fill(0);
    return { keyVersion, wrappedKey: b64(wrappedKey) };
  });
  const parts = [
    input.id,
    input.pendingDeviceId,
    Buffer.from(input.challenge, 'base64url').toString('hex'),
    input.keysetDigest,
  ];
  for (const envelope of keyEnvelopes) {
    parts.push(`${envelope.keyVersion}:${digest(Buffer.from(envelope.wrappedKey, 'base64url')).toString('hex')}`);
  }
  const device = loadOrCreateDeviceIdentity();
  const message = Buffer.from(`zsl:personal-sync:pairing-approval:v1\n${parts.join('\n')}`);
  return {
    displayCode: input.displayCode,
    keysetDigest: input.keysetDigest,
    keyEnvelopes,
    approvalSignature: b64(sign(null, message, device.ed25519Private)),
  };
}

export function createPersonalSyncRecoveryAttestation(input: {
  challenge: PersonalSyncRecoveryChallenge;
  recoveryPackage: PersonalSyncRecoveryPackage;
  recoveryCode: string;
}) {
  const { challenge, recoveryPackage } = input;
  const encryptedPackage = Buffer.from(recoveryPackage.encryptedRecoveryPackage, 'base64url');
  if (
    `sha256:${digest(encryptedPackage).toString('hex')}` !== recoveryPackage.recoveryPackageHash ||
    challenge.expectedCounter !== recoveryPackage.counter ||
    Buffer.from(challenge.nonce, 'base64url').length !== 32 ||
    !/^sha256:[0-9a-f]{64}$/.test(recoveryPackage.keysetDigest)
  ) {
    throw new Error('RECOVERY_PACKAGE_INVALID');
  }
  const recoveryCode = Buffer.from(input.recoveryCode, 'base64url');
  if (recoveryCode.length !== 32) throw new Error('RECOVERY_CODE_INVALID');
  const kdf = readPackageKdf(recoveryPackage.encryptedRecoveryPackage);
  const oldKey = deriveRecoveryKey(
    recoveryCode,
    Buffer.from(recoveryPackage.recoveryKdf?.salt ?? recoveryPackage.argon2idSalt, 'base64url'),
    kdf
  );
  const plaintext = openSealedPackageWithKey(
    recoveryPackage.encryptedRecoveryPackage,
    oldKey,
    Buffer.from(RECOVERY_PACKAGE_AAD)
  );
  oldKey.fill(0);
  recoveryCode.fill(0);
  let recovered: {
    version: number;
    keyVersion?: number;
    umk?: string;
    keyring?: Array<{ keyVersion: number; umk: string }>;
    recoveryEd25519PrivateKey: string;
  };
  try {
    recovered = JSON.parse(plaintext.toString('utf8'));
  } catch {
    throw new Error('RECOVERY_PACKAGE_INVALID');
  }
  plaintext.fill(0);
  const keyring = recovered.keyring ?? [{ keyVersion: recovered.keyVersion ?? 0, umk: recovered.umk ?? '' }];
  if (
    recovered.version !== 1 ||
    keyring.length === 0 ||
    new Set(keyring.map((item) => item.keyVersion)).size !== keyring.length
  ) {
    throw new Error('RECOVERY_PACKAGE_INVALID');
  }
  const oldRecoveryPrivate = createPrivateKey({
    key: Buffer.from(recovered.recoveryEd25519PrivateKey, 'base64url'),
    format: 'der',
    type: 'pkcs8',
  });
  if (
    !rawPublicKey(createPublicKey(oldRecoveryPrivate)).equals(
      Buffer.from(recoveryPackage.recoveryEd25519PublicKey, 'base64url')
    )
  ) {
    throw new Error('RECOVERY_PACKAGE_INVALID');
  }
  const device = loadOrCreateDeviceIdentity();
  const keyEnvelopes = keyring
    .sort((left, right) => left.keyVersion - right.keyVersion)
    .map((item) => {
      const umk = Buffer.from(item.umk, 'base64url');
      if (!Number.isSafeInteger(item.keyVersion) || item.keyVersion < 1 || umk.length !== 32) {
        throw new Error('RECOVERY_PACKAGE_INVALID');
      }
      setSecret(`personal-sync:umk:v${item.keyVersion}`, b64(umk));
      const wrappedKey = createDeviceEnvelope(umk, device.x25519PublicRaw);
      umk.fill(0);
      return { keyVersion: item.keyVersion, wrappedKey: b64(wrappedKey) };
    });
  const envelopeHashes = keyEnvelopes.map((envelope) => ({
    keyVersion: envelope.keyVersion,
    hash: `sha256:${digest(Buffer.from(envelope.wrappedKey, 'base64url')).toString('hex')}`,
  }));
  const newRecovery = generateKeyPairSync('ed25519');
  const newRecoveryPublicRaw = rawPublicKey(newRecovery.publicKey);
  const newRecoveryCodeBytes = randomBytes(32);
  const newRecoveryCode = b64(newRecoveryCodeBytes);
  const newSalt = randomBytes(16);
  const newRecoveryKey = deriveRecoveryKey(newRecoveryCodeBytes, newSalt, RECOVERY_KDF);
  const newPlaintext = Buffer.from(
    JSON.stringify({
      version: 1,
      keyring: keyring.map((item) => ({
        keyVersion: item.keyVersion,
        umk: getSecret(`personal-sync:umk:v${item.keyVersion}`),
      })),
      recoveryEd25519PrivateKey: privateDER(newRecovery.privateKey),
    })
  );
  const newSealed = seal(newPlaintext, newRecoveryKey, Buffer.from(RECOVERY_PACKAGE_AAD));
  newPlaintext.fill(0);
  newRecoveryKey.fill(0);
  newRecoveryCodeBytes.fill(0);
  const newPackage = Buffer.from(JSON.stringify({ version: 1, kdf: RECOVERY_KDF, ...newSealed }));
  const request = {
    oldCounter: recoveryPackage.counter,
    newCounter: recoveryPackage.counter + 1,
    keysetDigest: recoveryPackage.keysetDigest,
    keyEnvelopes,
    envelopeHashes,
    newRecoveryEd25519PublicKey: b64(newRecoveryPublicRaw),
    newRecoveryPublicKeyFingerprint: fingerprint(newRecoveryPublicRaw),
    newRecoveryKdf: { ...RECOVERY_KDF, salt: b64(newSalt) },
    newEncryptedRecoveryPackage: b64(newPackage),
    newRecoveryPackageHash: `sha256:${digest(newPackage).toString('hex')}`,
    oldRecoverySignature: '',
    newDeviceSignature: '',
  };
  const parts = [
    challenge.id,
    challenge.pendingDeviceId,
    Buffer.from(challenge.nonce, 'base64url').toString('hex'),
    String(request.oldCounter),
    String(request.newCounter),
    request.keysetDigest,
    request.newRecoveryPublicKeyFingerprint,
    request.newRecoveryPackageHash,
    ...envelopeHashes.map((item) => `${item.keyVersion}:${item.hash}`),
    `recovery-kdf:${escrowHash(canonical(request.newRecoveryKdf))}`,
  ];
  const statementHash = digest(parts.join('\n'));
  request.oldRecoverySignature = b64(
    sign(
      null,
      Buffer.from(`zsl:personal-sync:recovery-attestation:recovery:v2\n${statementHash.toString('hex')}`),
      oldRecoveryPrivate
    )
  );
  request.newDeviceSignature = b64(
    sign(
      null,
      Buffer.from(`zsl:personal-sync:recovery-attestation:device:v2\n${statementHash.toString('hex')}`),
      device.ed25519Private
    )
  );
  setSecret(RECOVERY_ROTATION_REQUEST, JSON.stringify(request));
  return { request, newRecoveryCode };
}

export function confirmPersonalSyncRecoveryRotation(keysetDigest: string) {
  const encoded = getSecret(RECOVERY_ROTATION_REQUEST);
  if (!encoded) throw new Error('RECOVERY_ROTATION_NOT_PENDING');
  const request = JSON.parse(encoded) as { keysetDigest?: string };
  if (request.keysetDigest !== keysetDigest) throw new Error('RECOVERY_ROTATION_MISMATCH');
  setSecret(RECOVERY_ROTATION_REQUEST, '');
  setSecret(KEYSET_DIGEST, keysetDigest);
}

/** Upgrade the existing pending root without replacing its UMK or recovery code. */
export function createPersonalSyncInitializationV2(escrow: unknown | null) {
  const pending = getSecret('personal-sync:initialization-v2-request');
  const legacy = createPersonalSyncInitialization();
  if (pending) return { request: JSON.parse(pending) as Record<string, unknown>, recoveryCode: legacy.recoveryCode };
  const { request: old, recoveryCode } = legacy;
  const key = deriveRecoveryKey(
    Buffer.from(recoveryCode, 'base64url'),
    Buffer.from(old.argon2idSalt, 'base64url'),
    RECOVERY_KDF
  );
  const plaintext = openSealedPackageWithKey(old.encryptedRecoveryPackage, key, Buffer.from(RECOVERY_PACKAGE_AAD));
  key.fill(0);
  const recovered = JSON.parse(plaintext.toString('utf8')) as { recoveryEd25519PrivateKey: string };
  plaintext.fill(0);
  const recoveryPrivate = createPrivateKey({
    key: Buffer.from(recovered.recoveryEd25519PrivateKey, 'base64url'),
    format: 'der',
    type: 'pkcs8',
  });
  const {
    argon2idSalt,
    argon2idParams: _legacyParams,
    devicePoPSignature: _deviceSig,
    recoverySignature: _recoverySig,
    ...base
  } = old;
  const statement = { ...base, protocolVersion: 2, recoveryKdf: { ...RECOVERY_KDF, salt: argon2idSalt }, escrow };
  const request = {
    ...statement,
    devicePoPSignature: signStatement(loadOrCreateDeviceIdentity().ed25519Private, 'init-v2', statement),
    recoverySignature: signStatement(recoveryPrivate, 'init-v2', statement),
  };
  setSecret('personal-sync:initialization-v2-request', JSON.stringify(request));
  return { request, recoveryCode };
}

/** Read either a legacy device envelope or a scoped organization result envelope. */
export function openPersonalSyncDeviceEnvelope(wrapped: string, privateKey: KeyObject): Buffer {
  const raw = Buffer.from(wrapped, 'base64url');
  if (raw.length > 8192) throw new Error('ESCROW_ENVELOPE_INVALID');
  const envelope = JSON.parse(raw.toString('utf8')) as {
    version: number;
    scope: Scope;
    envelope: Envelope;
    ephemeralPublicKey: string;
    salt: string;
    iv: string;
    tag: string;
    ciphertext: string;
  };
  if (envelope.version === 2) return openOrgEnvelope(privateKey, envelope.envelope, envelope.scope);
  if (envelope.version !== 1) throw new Error('ESCROW_ENVELOPE_INVALID');
  const shared = diffieHellman({
    privateKey,
    publicKey: escrowPublicKey(escrowDecode(envelope.ephemeralPublicKey, 32), 'x25519'),
  });
  const key = Buffer.from(
    hkdfSync('sha256', shared, escrowDecode(envelope.salt, 16), 'zsl-personal-sync-device-envelope-v1', 32)
  );
  shared.fill(0);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, escrowDecode(envelope.iv, 12));
    decipher.setAAD(Buffer.from('zsl:personal-sync:device-envelope:v1'));
    decipher.setAuthTag(escrowDecode(envelope.tag, 16));
    return Buffer.concat([decipher.update(escrowDecode(envelope.ciphertext, 32)), decipher.final()]);
  } finally {
    key.fill(0);
  }
}
