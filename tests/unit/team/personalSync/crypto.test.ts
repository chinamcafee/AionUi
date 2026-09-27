// 个人记忆云备份（E-31 移植）：密码学模块验证。
// 覆盖初始化请求（keysetDigest 与服务端算法逐字节一致、双签、恢复包 hash）、
// 恢复码解封与凭据轮换（scrypt 包）、配对请求/批准的密钥信封（X25519-HKDF-AES-GCM）。

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDecipheriv, createHash, createPublicKey, diffieHellman, hkdfSync, verify } from 'node:crypto';
import { AccountRuntimeManager } from '@/process/services/teamBff/accountRuntime';
import { bindAccountRuntime } from '@/process/services/teamBff/modules/memory/account-runtime';
import {
  confirmPersonalSyncInitialization,
  confirmPersonalSyncRecoveryRotation,
  createPersonalSyncInitialization,
  createPersonalSyncPairingApproval,
  createPersonalSyncPairingRequest,
  createPersonalSyncRecoveryAttestation,
  loadOrCreateDeviceIdentity,
  pendingPersonalSyncInitialization,
  storedKeysetDigest,
} from '@/process/services/teamBff/modules/personalSync/crypto';
import { getSecret, unlockSecretVault } from '@/process/services/teamBff/modules/personalSync/secretVault';

const X25519_SPKI_PREFIX = '302a300506032b656e032100';
const ED25519_SPKI_PREFIX = '302a300506032b6570032100';
const T1 = '018f0000-0000-7000-8000-000000000001';
const M1 = '018f0000-0000-7000-8000-000000000002';
const TEAM_A = '018f0000-0000-7000-8000-000000000003';
/** vault 主密钥为 32 字节 base64url（43 字符）——测试直接解锁，无需 safeStorage。 */
const VAULT_KEY = Buffer.from(Array.from({ length: 32 }, (_, index) => index + 1)).toString('base64url');

function sha256Hex(value: Buffer | string) {
  return createHash('sha256').update(value).digest('hex');
}

function verifyEd25519Raw(publicRaw: Buffer, message: Buffer, signature: Buffer) {
  return verify(
    null,
    message,
    createPublicKey({
      key: Buffer.concat([Buffer.from(ED25519_SPKI_PREFIX, 'hex'), publicRaw]),
      format: 'der',
      type: 'spki',
    }),
    signature
  );
}

/** 设备信封解封（createDeviceEnvelope 的测试侧配对实现）。 */
function openDeviceEnvelope(envelope: Buffer, recipientPrivateKey: Parameters<typeof diffieHellman>[0]['privateKey']) {
  const parsed = JSON.parse(envelope.toString('utf8')) as {
    ephemeralPublicKey: string;
    salt: string;
    iv: string;
    tag: string;
    ciphertext: string;
  };
  const shared = diffieHellman({
    privateKey: recipientPrivateKey,
    publicKey: createPublicKey({
      key: Buffer.concat([Buffer.from(X25519_SPKI_PREFIX, 'hex'), Buffer.from(parsed.ephemeralPublicKey, 'base64url')]),
      format: 'der',
      type: 'spki',
    }),
  });
  const wrappingKey = Buffer.from(
    hkdfSync('sha256', shared, Buffer.from(parsed.salt, 'base64url'), 'zsl-personal-sync-device-envelope-v1', 32)
  );
  const decipher = createDecipheriv('aes-256-gcm', wrappingKey, Buffer.from(parsed.iv, 'base64url'));
  decipher.setAAD(Buffer.from('zsl:personal-sync:device-envelope:v1'));
  decipher.setAuthTag(Buffer.from(parsed.tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(parsed.ciphertext, 'base64url')), decipher.final()]);
}

describe('personal-sync crypto（移植自 client server/personal-sync-crypto.ts）', () => {
  let runtime: AccountRuntimeManager;

  beforeEach(async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'aionui-personal-sync-crypto-'));
    runtime = new AccountRuntimeManager(root);
    bindAccountRuntime(runtime);
    await runtime.activate({ tenantId: T1, tenantMemberId: M1, activeTeamId: TEAM_A });
    unlockSecretVault(VAULT_KEY);
  });

  afterEach(async () => {
    await runtime.deactivate();
  });

  it('初始化请求：字段规格、keysetDigest 复算（与服务端同算法）与双签可验证', () => {
    const { request, recoveryCode } = createPersonalSyncInitialization();
    const device = loadOrCreateDeviceIdentity();
    expect(Buffer.from(request.x25519EncryptionPublicKey, 'base64url')).toEqual(device.x25519PublicRaw);
    expect(request.x25519KeyFingerprint).toBe(sha256Hex(device.x25519PublicRaw));
    expect(request.ed25519KeyFingerprint).toBe(sha256Hex(device.ed25519PublicRaw));
    expect(Buffer.from(request.recoveryEd25519PublicKey, 'base64url')).toHaveLength(32);
    expect(request.envelopeAlgorithm).toBe('X25519-HKDF-SHA256-AES-256-GCM');
    expect(Buffer.from(request.deviceEnvelope, 'base64url').length).toBeGreaterThanOrEqual(64);
    // 协议名义 argon2id 参数（服务端区间校验：memoryKiB≥65536、passes≥3、parallelism≥1）
    expect(request.argon2idParams).toEqual({ memoryKiB: 65536, passes: 3, parallelism: 1 });
    expect(recoveryCode).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(request.recoveryPackageHash).toBe(
      `sha256:${sha256Hex(Buffer.from(request.encryptedRecoveryPackage, 'base64url'))}`
    );
    // keysetDigest 复算：v1\nx25519FP\ned25519FP\nrecoveryFP\nsha256(deviceEnvelope)
    const envelopeHash = sha256Hex(Buffer.from(request.deviceEnvelope, 'base64url'));
    const expectedDigest = `sha256:${sha256Hex(
      [
        'v1',
        request.x25519KeyFingerprint,
        request.ed25519KeyFingerprint,
        request.recoveryPublicKeyFingerprint,
        envelopeHash,
      ].join('\n')
    )}`;
    expect(request.keysetDigest).toBe(expectedDigest);
    // 双签：签名消息 = zsl:personal-sync:initialize:{signer}:v1\n{requestHash hex}
    const statement = { ...request } as Record<string, unknown>;
    delete statement.devicePoPSignature;
    delete statement.recoverySignature;
    const requestHash = sha256Hex(JSON.stringify(statement));
    expect(
      verifyEd25519Raw(
        device.ed25519PublicRaw,
        Buffer.from(`zsl:personal-sync:initialize:device:v1\n${requestHash}`),
        Buffer.from(request.devicePoPSignature, 'base64url')
      )
    ).toBe(true);
    expect(
      verifyEd25519Raw(
        Buffer.from(request.recoveryEd25519PublicKey, 'base64url'),
        Buffer.from(`zsl:personal-sync:initialize:recovery:v1\n${requestHash}`),
        Buffer.from(request.recoverySignature, 'base64url')
      )
    ).toBe(true);
    // 设备信封可被本设备私钥解封，且内容为 32 字节 UMK（与 vault 内登记一致）
    const umk = openDeviceEnvelope(Buffer.from(request.deviceEnvelope, 'base64url'), device.x25519Private);
    expect(umk).toHaveLength(32);
    expect(umk.toString('base64url')).toBe(getSecret('personal-sync:umk:v1'));
  });

  it('初始化确认：keysetDigest 落盘并清理 pending（重复确认拒绝）', () => {
    const { request } = createPersonalSyncInitialization();
    expect(pendingPersonalSyncInitialization()?.idempotencyKey).toBe(request.idempotencyKey);
    confirmPersonalSyncInitialization(request.keysetDigest);
    expect(pendingPersonalSyncInitialization()).toBeNull();
    expect(storedKeysetDigest()).toBe(request.keysetDigest);
    expect(() => confirmPersonalSyncInitialization(request.keysetDigest)).toThrow(
      'PERSONAL_SYNC_INITIALIZATION_MISMATCH'
    );
  });

  it('恢复码解封并轮换凭据：keyring 安装、newCounter=old+1、旧码失效', () => {
    const { request, recoveryCode } = createPersonalSyncInitialization();
    confirmPersonalSyncInitialization(request.keysetDigest);
    const challenge = {
      id: '018f0000-0000-7000-8000-0000000000aa',
      pendingDeviceId: '018f0000-0000-7000-8000-0000000000bb',
      nonce: Buffer.from(Array.from({ length: 32 }, (_, index) => index)).toString('base64url'),
      expectedCounter: 1,
    };
    const recoveryPackage = {
      counter: 1,
      recoveryEd25519PublicKey: request.recoveryEd25519PublicKey,
      argon2idSalt: request.argon2idSalt,
      argon2idParams: request.argon2idParams,
      encryptedRecoveryPackage: request.encryptedRecoveryPackage,
      recoveryPackageHash: request.recoveryPackageHash,
      keysetDigest: request.keysetDigest,
    };
    const { request: rotation, newRecoveryCode } = createPersonalSyncRecoveryAttestation({
      challenge,
      recoveryPackage,
      recoveryCode,
    });
    expect(newRecoveryCode).not.toBe(recoveryCode);
    expect(newRecoveryCode).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(rotation.oldCounter).toBe(1);
    expect(rotation.newCounter).toBe(2);
    expect(rotation.keysetDigest).toBe(request.keysetDigest);
    expect(rotation.keyEnvelopes).toHaveLength(1);
    expect(getSecret('personal-sync:umk:v1')).toBeTruthy();
    expect(rotation.envelopeHashes[0].hash).toBe(
      `sha256:${sha256Hex(Buffer.from(rotation.keyEnvelopes[0].wrappedKey, 'base64url'))}`
    );
    expect(Buffer.from(rotation.oldRecoverySignature, 'base64url')).toHaveLength(64);
    expect(Buffer.from(rotation.newDeviceSignature, 'base64url')).toHaveLength(64);
    // 旧恢复码无法解封新包（新轮换请求必须用新码）
    expect(() =>
      createPersonalSyncRecoveryAttestation({
        challenge: { ...challenge, expectedCounter: 2 },
        recoveryPackage: {
          ...recoveryPackage,
          counter: 2,
          encryptedRecoveryPackage: rotation.newEncryptedRecoveryPackage,
          recoveryPackageHash: rotation.newRecoveryPackageHash,
          recoveryEd25519PublicKey: rotation.newRecoveryEd25519PublicKey,
        },
        recoveryCode,
      })
    ).toThrow('RECOVERY_CODE_INVALID');
    confirmPersonalSyncRecoveryRotation(rotation.keysetDigest);
    expect(storedKeysetDigest()).toBe(rotation.keysetDigest);
  });

  it('配对：请求 PoP 签名与批准信封（目标设备可解封出完整 UMK、批准签名可验证）', () => {
    const { request } = createPersonalSyncInitialization();
    confirmPersonalSyncInitialization(request.keysetDigest);
    const subject = { tenantId: T1, userId: M1, deviceId: TEAM_A };
    const pairingRequest = createPersonalSyncPairingRequest(subject);
    const pairingChallenge = Buffer.from(pairingRequest.challenge, 'base64url');
    const popMessage = Buffer.from(
      [
        'zsl:personal-sync:pairing-request:v1',
        subject.tenantId,
        subject.userId,
        subject.deviceId,
        pairingChallenge.toString('hex'),
      ].join('\n')
    );
    expect(
      verifyEd25519Raw(
        Buffer.from(pairingRequest.ed25519SigningPublicKey, 'base64url'),
        popMessage,
        Buffer.from(pairingRequest.popSignature, 'base64url')
      )
    ).toBe(true);

    // 目标设备 = 本设备身份：批准信封应可被其 X25519 私钥解封出 UMK
    const device = loadOrCreateDeviceIdentity();
    const approval = createPersonalSyncPairingApproval({
      id: '018f0000-0000-7000-8000-0000000000cc',
      pendingDeviceId: subject.deviceId,
      challenge: pairingRequest.challenge,
      x25519EncryptionPublicKey: device.x25519PublicRaw.toString('base64url'),
      requiredKeyVersions: [1],
      keysetDigest: request.keysetDigest,
      displayCode: '12345678',
    });
    expect(approval.keyEnvelopes.map((item) => item.keyVersion)).toEqual([1]);
    const unwrapped = openDeviceEnvelope(
      Buffer.from(approval.keyEnvelopes[0].wrappedKey, 'base64url'),
      device.x25519Private
    );
    expect(unwrapped).toHaveLength(32);
    expect(unwrapped.toString('base64url')).toBe(getSecret('personal-sync:umk:v1'));
    // 批准签名消息 = zsl:personal-sync:pairing-approval:v1\n{id}\n{pendingDeviceId}\n{challengeHex}\n{keysetDigest}\n{kv}:{envelopeHash}
    const envelopeHash = sha256Hex(Buffer.from(approval.keyEnvelopes[0].wrappedKey, 'base64url'));
    const approvalMessage = Buffer.from(
      `zsl:personal-sync:pairing-approval:v1\n${[
        '018f0000-0000-7000-8000-0000000000cc',
        subject.deviceId,
        pairingChallenge.toString('hex'),
        request.keysetDigest,
        `1:${envelopeHash}`,
      ].join('\n')}`
    );
    expect(
      verifyEd25519Raw(device.ed25519PublicRaw, approvalMessage, Buffer.from(approval.approvalSignature, 'base64url'))
    ).toBe(true);
    // 缺少对应密钥版本时批准失败（KEYSET_INCOMPLETE）
    expect(() =>
      createPersonalSyncPairingApproval({
        id: '018f0000-0000-7000-8000-0000000000cc',
        pendingDeviceId: subject.deviceId,
        challenge: pairingRequest.challenge,
        x25519EncryptionPublicKey: device.x25519PublicRaw.toString('base64url'),
        requiredKeyVersions: [2],
        keysetDigest: request.keysetDigest,
        displayCode: '12345678',
      })
    ).toThrow('KEYSET_INCOMPLETE');
  });
});
