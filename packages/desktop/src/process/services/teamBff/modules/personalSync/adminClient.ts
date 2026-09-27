// 移植自 client-reference/electron/bff/team-api-client.cjs 的 personal-sync 管理段（上游 commit 915d14c0）。
// 覆盖初始化、设备列表/撤销、配对创建/批准、恢复挑战/恢复包/轮换、对象上传（预签名 PUT）、快照创建。
// 全部带 DTO 严格校验；错误码直接沿用 team-server 的 error.code（writePersonalSyncError 映射表）。

import { createHash, randomUUID } from 'node:crypto';
import { validatePresignedObjectUrl, type PersonalSyncHttp } from './http.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const MAX_OBJECT_BYTES = 512 * 1024 * 1024;

export interface PersonalSyncDevice {
  id: string;
  displayName: string;
  status: 'pending_pairing' | 'trusted' | 'revoked';
  [key: string]: unknown;
}

export interface PersonalSyncDeviceState {
  tenantMemberId: string;
  rootStatus: 'uninitialized' | 'active' | 'locked';
  devices: PersonalSyncDevice[];
}

export interface PersonalSyncPairingView {
  id: string;
  pendingDeviceId: string;
  status: 'pending' | 'approved' | 'expired' | 'cancelled';
  expiresAt: string;
  requiredKeyVersions: number[];
  keysetDigest: string;
  challenge: string;
  x25519EncryptionPublicKey: string;
  displayCode?: string;
  [key: string]: unknown;
}

export interface PersonalSyncSnapshotView {
  id: string;
  objectSessionId: string;
  creatorDeviceId: string;
  throughServerSeq: number;
  keyVersion: number;
  ciphertextHash: string;
  manifestHash: string;
  status: 'ready' | 'verified' | 'superseded';
  createdAt?: string;
  [key: string]: unknown;
}

export interface PersonalSyncRecoveryChallengeView {
  id: string;
  pendingDeviceId: string;
  nonce: string;
  expectedCounter: number;
  expiresAt: string;
  status: string;
}

export interface PersonalSyncRecoveryPackageView {
  recoveryKdf?: { name: 'scrypt'; N: number; r: number; p: number; keyLen: number; salt: string };
  counter: number;
  recoveryEd25519PublicKey: string;
  argon2idSalt: string;
  argon2idParams: { memoryKiB: number; passes: number; parallelism: number };
  encryptedRecoveryPackage: string;
  recoveryPackageHash: string;
  keysetDigest: string;
}

export class PersonalSyncAdminClient {
  constructor(private readonly http: PersonalSyncHttp) {}

  async initialize(request: unknown): Promise<{
    tenantMemberId: string;
    status: string;
    keyVersion: number;
    keysetDigest: string;
    replayed: boolean;
  }> {
    if (!request || typeof request !== 'object' || Array.isArray(request))
      throw new Error('PERSONAL_SYNC_INITIALIZATION_INVALID');
    const body = JSON.stringify(request);
    if (Buffer.byteLength(body) < 256 || Buffer.byteLength(body) > 2 * 1024 * 1024)
      throw new Error('PERSONAL_SYNC_INITIALIZATION_INVALID');
    const { data } = await this.http.request('/api/v1/personal-sync:initialize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    if (
      !UUID_PATTERN.test(String(data.tenantMemberId)) ||
      data.status !== 'active' ||
      data.keyVersion !== 1 ||
      !SHA256_PATTERN.test(String(data.keysetDigest)) ||
      typeof data.replayed !== 'boolean'
    )
      throw new Error('PERSONAL_SYNC_RESPONSE_INVALID');
    return {
      tenantMemberId: String(data.tenantMemberId),
      status: String(data.status),
      keyVersion: Number(data.keyVersion),
      keysetDigest: String(data.keysetDigest),
      replayed: data.replayed,
    };
  }

  async listDevices(): Promise<PersonalSyncDeviceState> {
    const { data } = await this.http.request('/api/v1/personal-sync/devices');
    const devices = data.devices as unknown;
    if (
      !UUID_PATTERN.test(String(data.tenantMemberId)) ||
      !['uninitialized', 'active', 'locked'].includes(String(data.rootStatus)) ||
      !Array.isArray(devices) ||
      devices.some(
        (device) =>
          !device ||
          !UUID_PATTERN.test(String((device as PersonalSyncDevice).id)) ||
          !['pending_pairing', 'trusted', 'revoked'].includes(String((device as PersonalSyncDevice).status)) ||
          typeof (device as PersonalSyncDevice).displayName !== 'string'
      )
    )
      throw new Error('PERSONAL_SYNC_RESPONSE_INVALID');
    return {
      tenantMemberId: String(data.tenantMemberId),
      rootStatus: String(data.rootStatus) as PersonalSyncDeviceState['rootStatus'],
      devices: devices as PersonalSyncDevice[],
    };
  }

  async revokeDevice(deviceId: string): Promise<PersonalSyncDeviceState> {
    if (!UUID_PATTERN.test(deviceId)) throw new Error('PERSONAL_SYNC_DEVICE_INVALID');
    await this.http.request(`/api/v1/personal-sync/devices/${deviceId}`, { method: 'DELETE' });
    return this.listDevices();
  }

  async createPairing(request: unknown): Promise<PersonalSyncPairingView> {
    const body = JSON.stringify(request ?? {});
    if (!request || typeof request !== 'object' || Buffer.byteLength(body) > 64 * 1024)
      throw new Error('PERSONAL_SYNC_PAIRING_INVALID');
    const { data } = await this.http.request('/api/v1/personal-sync/device-pairings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    return this.parsePairing(data, true);
  }

  async getPairing(pairingId: string): Promise<PersonalSyncPairingView> {
    if (!UUID_PATTERN.test(pairingId)) throw new Error('PERSONAL_SYNC_PAIRING_INVALID');
    const { data } = await this.http.request(`/api/v1/personal-sync/device-pairings/${pairingId}`);
    return this.parsePairing(data, false);
  }

  async approvePairing(pairingId: string, request: unknown): Promise<PersonalSyncPairingView> {
    if (!UUID_PATTERN.test(pairingId) || !request || typeof request !== 'object')
      throw new Error('PERSONAL_SYNC_PAIRING_INVALID');
    const body = JSON.stringify(request);
    if (Buffer.byteLength(body) > 512 * 1024) throw new Error('PERSONAL_SYNC_PAIRING_INVALID');
    const { data } = await this.http.request(`/api/v1/personal-sync/device-pairings/${pairingId}:approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    return this.parsePairing(data, false);
  }

  private parsePairing(data: Record<string, unknown>, allowDisplayCode: boolean): PersonalSyncPairingView {
    if (
      !UUID_PATTERN.test(String(data.id)) ||
      !UUID_PATTERN.test(String(data.pendingDeviceId)) ||
      !['pending', 'approved', 'expired', 'cancelled'].includes(String(data.status)) ||
      !Number.isFinite(Date.parse(String(data.expiresAt))) ||
      !Array.isArray(data.requiredKeyVersions) ||
      (data.requiredKeyVersions as unknown[]).some((value) => !Number.isSafeInteger(value) || Number(value) < 1) ||
      !SHA256_PATTERN.test(String(data.keysetDigest)) ||
      Buffer.from(String(data.challenge), 'base64url').length !== 32 ||
      Buffer.from(String(data.x25519EncryptionPublicKey), 'base64url').length !== 32 ||
      (!allowDisplayCode && data.displayCode !== undefined) ||
      (data.displayCode !== undefined && !/^\d{8}$/.test(String(data.displayCode)))
    )
      throw new Error('PERSONAL_SYNC_RESPONSE_INVALID');
    return { ...data } as PersonalSyncPairingView;
  }

  async createRecoveryChallenge(): Promise<PersonalSyncRecoveryChallengeView> {
    const { data } = await this.http.request('/api/v1/personal-sync/recovery-challenges', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (
      !UUID_PATTERN.test(String(data.id)) ||
      !UUID_PATTERN.test(String(data.pendingDeviceId)) ||
      Buffer.from(String(data.nonce || ''), 'base64url').length !== 32 ||
      !Number.isSafeInteger(data.expectedCounter) ||
      Number(data.expectedCounter) < 1 ||
      !Number.isFinite(Date.parse(String(data.expiresAt))) ||
      data.status !== 'pending'
    )
      throw new Error('PERSONAL_SYNC_RESPONSE_INVALID');
    return { ...data } as unknown as PersonalSyncRecoveryChallengeView;
  }

  async getRecoveryPackage(): Promise<PersonalSyncRecoveryPackageView> {
    const { data } = await this.http.request('/api/v1/personal-sync/recovery-package');
    if (
      !Number.isSafeInteger(data.counter) ||
      Number(data.counter) < 1 ||
      Buffer.from(String(data.recoveryEd25519PublicKey || ''), 'base64url').length !== 32 ||
      Buffer.from(
        String((data.recoveryKdf as { salt?: string } | undefined)?.salt ?? data.argon2idSalt ?? ''),
        'base64url'
      ).length < 16 ||
      typeof data.encryptedRecoveryPackage !== 'string' ||
      !SHA256_PATTERN.test(String(data.recoveryPackageHash || '')) ||
      !SHA256_PATTERN.test(String(data.keysetDigest || ''))
    )
      throw new Error('PERSONAL_SYNC_RESPONSE_INVALID');
    return { ...data } as unknown as PersonalSyncRecoveryPackageView;
  }

  async attestRecovery(challengeId: string, request: unknown): Promise<Record<string, unknown>> {
    if (!UUID_PATTERN.test(challengeId) || !request || typeof request !== 'object')
      throw new Error('PERSONAL_SYNC_RECOVERY_INVALID');
    const body = JSON.stringify(request);
    if (Buffer.byteLength(body) > 2 * 1024 * 1024) throw new Error('PERSONAL_SYNC_RECOVERY_INVALID');
    const { data } = await this.http.request(
      `/api/v1/personal-sync/recovery-challenges/${challengeId}:attest-and-rotate`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }
    );
    if (data.rootStatus !== 'active' || !Array.isArray(data.devices)) throw new Error('PERSONAL_SYNC_RESPONSE_INVALID');
    return data;
  }

  /** 加密对象上传：预签名 PUT（不带用户令牌）+ 完成确认，返回 ready 对象。 */
  async uploadObject(purpose: 'snapshot' | 'recovery_package', blob: Buffer): Promise<{ id: string }> {
    if (
      !['snapshot', 'recovery_package'].includes(purpose) ||
      !Buffer.isBuffer(blob) ||
      blob.length < 1 ||
      blob.length > MAX_OBJECT_BYTES
    )
      throw new Error('PERSONAL_SYNC_OBJECT_INVALID');
    const { data: upload } = await this.http.request('/api/v1/personal-sync/objects/uploads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        purpose,
        sizeBytes: blob.length,
        sha256: createHash('sha256').update(blob).digest('hex'),
        idempotencyKey: randomUUID(),
      }),
    });
    if (!UUID_PATTERN.test(String(upload.id)) || upload.method !== 'PUT' || typeof upload.url !== 'string')
      throw new Error('PERSONAL_SYNC_RESPONSE_INVALID');
    const target = validatePresignedObjectUrl(upload.url);
    const headers = new Headers((upload.requiredHeaders ?? {}) as Record<string, string>);
    const put = await this.http.fetcher(target, {
      method: 'PUT',
      headers,
      body: blob,
      redirect: 'error',
      cache: 'no-store',
      signal: this.http.signal(),
    });
    if (!put.ok) throw new Error('OBJECT_STORE_UPLOAD_FAILED');
    const { data: completed } = await this.http.request(`/api/v1/personal-sync/objects/uploads/${upload.id}:complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (completed.id !== upload.id || completed.status !== 'ready' || typeof completed.objectVersionId !== 'string')
      throw new Error('PERSONAL_SYNC_RESPONSE_INVALID');
    return { id: String(upload.id) };
  }

  async createSnapshot(request: Record<string, unknown>): Promise<PersonalSyncSnapshotView> {
    const { data } = await this.http.request('/api/v1/personal-sync/snapshots', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });
    return this.parseSnapshot(data);
  }

  private parseSnapshot(data: Record<string, unknown>): PersonalSyncSnapshotView {
    if (
      !UUID_PATTERN.test(String(data.id)) ||
      !UUID_PATTERN.test(String(data.objectSessionId)) ||
      !UUID_PATTERN.test(String(data.creatorDeviceId)) ||
      !Number.isSafeInteger(data.throughServerSeq) ||
      !Number.isSafeInteger(data.keyVersion) ||
      !SHA256_PATTERN.test(String(data.ciphertextHash || '')) ||
      !SHA256_PATTERN.test(String(data.manifestHash || '')) ||
      !['ready', 'verified', 'superseded'].includes(String(data.status))
    )
      throw new Error('PERSONAL_SYNC_RESPONSE_INVALID');
    return { ...data } as PersonalSyncSnapshotView;
  }
}
