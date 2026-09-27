// AionUi 新增：个人记忆云备份编排层。
// 移植自 client 的调度模型（personal-sync-scheduler.ts 的 debounce 3s / max-wait 30s 与
// electron/main.cjs 的 periodic 5min±30s / startup / resume / online / manual / account-switch 触发器），
// 并与 AionUi 主进程结构对齐：账户运行时取数、safeStorage 保护的 vault 主密钥、Bearer access token 直连 team-server。
//
// 生命周期：teamBffService 在 bootstrap ready / 切换团队后 activate（含 deviceId 与令牌来源），
// 登出/未就绪时 deactivate；记忆写路径经 dirty.ts 触发 debounce；快照达到阈值自动创建。

import fs from 'node:fs/promises';
import path from 'node:path';
import { createPrivateKey, timingSafeEqual } from 'node:crypto';
import { EscrowClient } from '../orgescrow/client';
import { enableEscrowBackup, advanceEscrowBackup, hasAutomaticBackupConsent } from '../orgescrow/workflow';
import { readPending } from '../orgescrow/trust';
import type { SafeStorageLike } from '../../../../auth/secureRefreshStore.js';
import { accountRuntime } from '../memory/account-runtime.js';
import { currentVerifiedAccountContext } from '../memory/account-request-context.js';
import { PersonalSyncAdminClient } from './adminClient.js';
import * as cryptoModule from './crypto.js';
import { setPersonalSyncDirtyHandler } from './dirty.js';
import { createPersonalSyncHttp } from './http.js';
import {
  hasSecret,
  getSecret,
  bindPersonalSyncScope,
  clearPersonalSyncScope,
  legacyPersonalSyncSecrets,
  migrateVerifiedPersonalSyncSecrets,
  unlockSecretVault,
} from './secretVault.js';
import * as snapshots from './snapshot.js';
import * as store from './store.js';
import { createPersonalSyncTransport } from './transport.js';

export type PersonalSyncTrigger =
  | 'debounce'
  | 'max-wait'
  | 'periodic'
  | 'startup'
  | 'resume'
  | 'online'
  | 'account-switch'
  | 'manual';

/** 距上次快照的游标增量达到该阈值时自动创建云端快照（供压缩恢复）。 */
const SNAPSHOT_EVENT_THRESHOLD = 500;
const DEBOUNCE_MS = 3_000;
const MAX_WAIT_MS = 30_000;
const PERIODIC_MS = 5 * 60_000;
const PERIODIC_JITTER_MS = 30_000;
const MAX_VAULT_KEY_BYTES = 4096;

class SafeStorageVaultKeyStore {
  constructor(
    private readonly safeStorage: SafeStorageLike,
    private readonly filePath: string
  ) {}

  async getOrCreate(): Promise<string> {
    try {
      const info = await fs.lstat(this.filePath);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.size <= 0 ||
        info.size > MAX_VAULT_KEY_BYTES ||
        (process.platform !== 'win32' && (info.mode & 0o077) !== 0)
      )
        throw new Error('VAULT_KEY_INVALID');
      const raw = await fs.readFile(this.filePath);
      const key = this.decrypt(raw);
      if (!/^[A-Za-z0-9_-]{43}$/.test(key)) throw new Error('VAULT_KEY_INVALID');
      if (raw.subarray(0, 6).toString('utf8') === 'PLAIN:') {
        const temporary = `${this.filePath}.${process.pid}.${Date.now()}.upgrade`;
        await fs.writeFile(temporary, this.encrypt(key), { mode: 0o600, flag: 'wx' });
        await fs.rename(temporary, this.filePath);
      }
      return key;
    } catch (error) {
      if ((error as { code?: string })?.code !== 'ENOENT') throw error;
    }
    const key = cryptoModule.generateVaultKey();
    const encrypted = this.encrypt(key);
    const directory = path.dirname(this.filePath);
    const temporary = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.writeFile(temporary, encrypted, { mode: 0o600, flag: 'wx' });
    try {
      await fs.rename(temporary, this.filePath);
      await fs.chmod(this.filePath, 0o600);
    } catch (renameError) {
      await fs.rm(temporary, { force: true }).catch(() => {});
      throw renameError;
    }
    return key;
  }

  private encrypt(raw: string): Buffer {
    try {
      if (this.safeStorage?.isEncryptionAvailable()) return this.safeStorage.encryptString(raw);
    } catch {
      /* fall through */
    }
    throw new Error('SECRET_VAULT_OS_STORAGE_UNAVAILABLE');
  }

  private decrypt(raw: Buffer): string {
    if (!this.safeStorage?.isEncryptionAvailable()) throw new Error('SECRET_VAULT_OS_STORAGE_UNAVAILABLE');
    if (raw.subarray(0, 6).toString('utf8') === 'PLAIN:') return raw.subarray(6).toString('utf8');
    return this.safeStorage.decryptString(raw);
  }
}

export interface PersonalSyncCredentials {
  baseUrl: string;
  deviceId: string;
  userId: string;
  tenantId: string;
  getAccessToken: (forceRefresh?: boolean) => Promise<string>;
}

interface ServiceState {
  keyStore: SafeStorageVaultKeyStore | null;
  fetcher: typeof fetch;
  vaultReady: boolean;
  credentials: PersonalSyncCredentials | null;
  activationKey: string | null;
  autoEnabled: boolean;
  dirty: boolean;
  debounceTimer: ReturnType<typeof setTimeout> | null;
  maxWaitTimer: ReturnType<typeof setTimeout> | null;
  periodicTimer: ReturnType<typeof setTimeout> | null;
  running: Promise<store.SyncRunResult> | null;
  runningTrigger: string | null;
}

const state: ServiceState = {
  keyStore: null,
  fetcher: fetch.bind(globalThis),
  vaultReady: false,
  credentials: null,
  activationKey: null,
  autoEnabled: true,
  dirty: false,
  debounceTimer: null,
  maxWaitTimer: null,
  periodicTimer: null,
  running: null,
  runningTrigger: null,
};

export function configurePersonalSync(input: {
  vaultKeyFilePath: string;
  safeStorage: SafeStorageLike;
  fetcher?: typeof fetch;
}) {
  state.keyStore = new SafeStorageVaultKeyStore(input.safeStorage, input.vaultKeyFilePath);
  state.fetcher = input.fetcher ?? fetch.bind(globalThis);
  setPersonalSyncDirtyHandler(() => scheduleAutoSync());
}

async function ensureVaultReady() {
  if (state.vaultReady) return;
  if (!state.keyStore) throw new Error('PERSONAL_SYNC_NOT_CONFIGURED');
  const key = await state.keyStore.getOrCreate();
  unlockSecretVault(key);
  state.vaultReady = true;
}

export function isPersonalSyncInitialized(): boolean {
  try {
    return state.vaultReady && hasSecret('personal-sync:keyset-digest');
  } catch {
    return false;
  }
}

function requireCredentials(): PersonalSyncCredentials {
  if (!state.credentials) throw new Error('PERSONAL_SYNC_NOT_ACTIVE');
  return state.credentials;
}

function createClients() {
  const credentials = requireCredentials();
  const signal = accountRuntime.signal();
  const http = createPersonalSyncHttp({
    baseUrl: credentials.baseUrl,
    getAccessToken: credentials.getAccessToken,
    signal: () => signal,
    fetcher: state.fetcher,
  });
  return { http, admin: new PersonalSyncAdminClient(http), transport: createPersonalSyncTransport(http) };
}

export async function activatePersonalSync(credentials: PersonalSyncCredentials) {
  const generation = accountRuntime.currentGeneration();
  await ensureVaultReady();
  if (generation !== accountRuntime.currentGeneration()) throw new Error('ACCOUNT_RUNTIME_REQUIRED');
  const activationKey = `${credentials.baseUrl}|${credentials.tenantId}|${credentials.userId}|${credentials.deviceId}`;
  const isNewActivation = activationKey !== state.activationKey;
  state.credentials = credentials;
  bindPersonalSyncScope(credentials);
  state.activationKey = activationKey;
  if (isNewActivation && !hasSecret('personal-sync:keyset-digest')) {
    const legacy = legacyPersonalSyncSecrets();
    if (legacy['personal-sync:keyset-digest'] && legacy['personal-sync:device:x25519-private']) {
      try {
        const { http } = createClients();
        const { data } = await http.request('/api/v1/personal-sync/key-envelopes');
        if (
          data.keysetDigest !== legacy['personal-sync:keyset-digest'] ||
          !Array.isArray(data.envelopes) ||
          data.envelopes.length < 1
        )
          throw new Error('ESCROW_CACHE_SCOPE_INVALID');
        const privateKey = createPrivateKey({
          key: Buffer.from(legacy['personal-sync:device:x25519-private'], 'base64url'),
          format: 'der',
          type: 'pkcs8',
        });
        for (const item of data.envelopes as Array<{ keyVersion: number; wrappedKey: string }>) {
          const opened = cryptoModule.openPersonalSyncDeviceEnvelope(item.wrappedKey, privateKey);
          try {
            const expected = Buffer.from(legacy[`personal-sync:umk:v${item.keyVersion}`] ?? '', 'base64url');
            if (expected.length !== 32 || !timingSafeEqual(expected, opened))
              throw new Error('ESCROW_CACHE_SCOPE_INVALID');
          } finally {
            opened.fill(0);
          }
        }
        if (http.signal().aborted) throw new Error('ACCOUNT_RUNTIME_REQUIRED');
        migrateVerifiedPersonalSyncSecrets(String(data.keysetDigest));
      } catch {
        /* Preserve unverified legacy material. Never copy it into another scope. */
      }
    }
  }
  try {
    state.autoEnabled = (await store.readPersonalSyncLocalStatus()).autoEnabled;
  } catch {
    state.autoEnabled = false;
  }
  // Legacy auto-enabled preferences cannot imply consent to organization escrow.
  const subject = accountRuntime.currentSubject();
  if (!subject || generation !== accountRuntime.currentGeneration()) throw new Error('ACCOUNT_RUNTIME_REQUIRED');
  if (!hasAutomaticBackupConsent({ identity: { ...credentials, tenantMemberId: subject.tenantMemberId } })) {
    state.autoEnabled = false;
    await store.setPersonalSyncAutoEnabled(false);
  }
  scheduleEscrowProgress();
  schedulePeriodic();
  // 同一会话内的重复 bootstrap 不重复触发启动同步
  if (isNewActivation && state.autoEnabled && isPersonalSyncInitialized()) {
    void runPersonalSync('startup').catch((error) => {
      console.warn('[personalSync] startup run failed:', (error as Error)?.message ?? error);
    });
  }
}

let escrowTimer: ReturnType<typeof setTimeout> | null = null;
let escrowError: string | null = null;
function scheduleEscrowProgress() {
  if (escrowTimer) return;
  const generation = accountRuntime.currentGeneration();
  escrowTimer = setTimeout(async () => {
    escrowTimer = null;
    if (!state.credentials || generation !== accountRuntime.currentGeneration()) return;
    if (!escrowInFlight && !state.running) {
      try {
        let readyForUpload = false;
        await escrowAction(async (client) => {
          if (readPending(client.identity, 'enrollment') || readPending(client.identity, 'recovery')) {
            const wasBlocked =
              !!getSecret('personal-sync:org-restoring') || !!getSecret('personal-sync:org-verification-pending');
            await advanceEscrowBackup(client);
            readyForUpload =
              wasBlocked &&
              !getSecret('personal-sync:org-restoring') &&
              !getSecret('personal-sync:org-verification-pending');
          }
        });
        if (readyForUpload && state.autoEnabled && generation === accountRuntime.currentGeneration()) {
          void runPersonalSync('startup').catch(() => {});
        }
        if (generation === accountRuntime.currentGeneration()) escrowError = null;
      } catch (error) {
        if (generation === accountRuntime.currentGeneration()) escrowError = (error as Error).message;
      }
    }
    if (state.credentials && generation === accountRuntime.currentGeneration()) scheduleEscrowProgress();
  }, 3000);
  escrowTimer.unref?.();
}

export function deactivatePersonalSync() {
  if (escrowTimer) clearTimeout(escrowTimer);
  escrowTimer = null;
  escrowError = null;
  state.credentials = null;
  clearPersonalSyncScope();
  // 重置激活键：同账号重新登录后应重新触发一次启动同步
  state.activationKey = null;
  state.dirty = false;
  clearDirtyTimers();
  if (state.periodicTimer) clearTimeout(state.periodicTimer);
  state.periodicTimer = null;
}

export async function setPersonalSyncAutoEnabled(enabled: boolean) {
  const generation = accountRuntime.currentGeneration();
  if (enabled) {
    await ensureVaultReady();
    await escrowAction((client) =>
      enableEscrowBackup(client, isPersonalSyncInitialized() && !getSecret('personal-sync:initialization-request'))
    );
    scheduleEscrowProgress();
  }
  if (generation !== accountRuntime.currentGeneration()) throw new Error('ACCOUNT_RUNTIME_REQUIRED');
  await store.setPersonalSyncAutoEnabled(enabled);
  if (generation !== accountRuntime.currentGeneration()) throw new Error('ACCOUNT_RUNTIME_REQUIRED');
  state.autoEnabled = enabled;
  if (!enabled) {
    state.dirty = false;
    clearDirtyTimers();
  } else {
    scheduleAutoSync();
  }
}

function clearDirtyTimers() {
  if (state.debounceTimer) clearTimeout(state.debounceTimer);
  if (state.maxWaitTimer) clearTimeout(state.maxWaitTimer);
  state.debounceTimer = null;
  state.maxWaitTimer = null;
}

/** 记忆写路径 → 自动备份（debounce 3s，最长 30s 后强制冲刷）。 */
function scheduleAutoSync() {
  if (!state.credentials || !state.autoEnabled || !isPersonalSyncInitialized()) return;
  state.dirty = true;
  if (state.maxWaitTimer === null) {
    state.maxWaitTimer = setTimeout(() => {
      state.maxWaitTimer = null;
      void runPersonalSync('max-wait').catch(() => {});
    }, MAX_WAIT_MS);
  }
  if (state.debounceTimer) clearTimeout(state.debounceTimer);
  state.debounceTimer = setTimeout(() => {
    state.debounceTimer = null;
    void runPersonalSync('debounce').catch(() => {});
  }, DEBOUNCE_MS);
}

function schedulePeriodic() {
  if (state.periodicTimer) return;
  const jitter = Math.round((Math.random() * 2 - 1) * PERIODIC_JITTER_MS);
  state.periodicTimer = setTimeout(() => {
    state.periodicTimer = null;
    if (state.credentials && state.autoEnabled && isPersonalSyncInitialized()) {
      void runPersonalSync('periodic').catch(() => {});
    }
    if (state.credentials) schedulePeriodic();
  }, PERIODIC_MS + jitter);
}

export async function runPersonalSync(trigger: PersonalSyncTrigger): Promise<store.SyncRunResult> {
  requireCredentials();
  if (trigger !== 'manual' && !state.autoEnabled) throw new Error('PERSONAL_SYNC_AUTO_DISABLED');
  if (escrowInFlight) throw new Error('ESCROW_OPERATION_BUSY');
  if (getSecret('personal-sync:org-restoring') || getSecret('personal-sync:org-verification-pending'))
    throw new Error('ESCROW_VERIFICATION_REQUIRED');
  if (!isPersonalSyncInitialized()) throw new Error('PERSONAL_SYNC_NOT_INITIALIZED');
  if (state.running) return state.running;
  const generation = accountRuntime.currentGeneration();
  const task = (async () => {
    state.dirty = false;
    clearDirtyTimers();
    state.runningTrigger = trigger;
    const { transport, admin } = createClients();
    try {
      const result = await store.syncPersonalMemoriesNow(transport, requireCredentials().deviceId);
      await store.writePersonalSyncOutcome({ trigger, result: { ...result } });
      await maybeCreateSnapshot(result);
      return result;
    } catch (error) {
      const code = (error as Error)?.message ?? String(error);
      await store.writePersonalSyncOutcome({ trigger, error: code }).catch(() => {});
      throw error;
    } finally {
      state.runningTrigger = null;
      // A stale request must not deactivate a newer account runtime.
      if (accountRuntime.currentGeneration() === generation) state.runningTrigger = null;
    }
  })();
  state.running = task;
  try {
    return await task;
  } finally {
    if (state.running === task) state.running = null;
    if (state.dirty) scheduleAutoSync();
  }
}

async function maybeCreateSnapshot(result: store.SyncRunResult) {
  if ((result as { recoveredFromSnapshot?: boolean }).recoveredFromSnapshot) return;
  const local = await store.readPersonalSyncLocalStatus();
  if (local.pendingEvents > 0) return;
  if (local.cursor - local.lastSnapshotSeq < SNAPSHOT_EVENT_THRESHOLD) return;
  try {
    await createPersonalSyncSnapshotNow();
  } catch (error) {
    console.warn('[personalSync] snapshot creation failed:', (error as Error)?.message ?? error);
  }
}

export async function createPersonalSyncSnapshotNow(): Promise<{ throughServerSeq: number; sizeBytes: number }> {
  await ensureVaultReady();
  const credentials = requireCredentials();
  if (escrowInFlight || getSecret('personal-sync:org-restoring') || getSecret('personal-sync:org-verification-pending'))
    throw new Error('ESCROW_VERIFICATION_REQUIRED');
  const local = await store.readPersonalSyncLocalStatus();
  const keysetDigest = cryptoModule.storedKeysetDigest();
  const prepared = await snapshots.preparePersonalSyncSnapshot({
    throughServerSeq: local.cursor,
    keyVersion: Number(getSecret('personal-sync:current-key-version') || '1'),
    keysetDigest,
  });
  const { admin } = createClients();
  const uploaded = await admin.uploadObject('snapshot', prepared.blob);
  const signed = snapshots.signPersonalSyncSnapshot(prepared, uploaded.id, credentials.deviceId);
  await admin.createSnapshot({ ...signed });
  await store.writePersonalSyncSnapshotSeq(prepared.throughServerSeq);
  return { throughServerSeq: prepared.throughServerSeq, sizeBytes: prepared.sizeBytes };
}

// ── 远程操作（初始化 / 设备 / 配对 / 恢复）────────────────────────────────

export async function initializePersonalSyncRoot(
  consent = false
): Promise<{ recoveryCode: string; keysetDigest: string; replayed: boolean }> {
  await ensureVaultReady();
  return escrowAction((client) => client.initialize(consent));
}
let escrowInFlight = false;
async function escrowAction<T>(run: (client: EscrowClient) => Promise<T>): Promise<T> {
  if (escrowInFlight || state.running) throw new Error('ESCROW_OPERATION_BUSY');
  escrowInFlight = true;
  try {
    const credentials = requireCredentials();
    const account = accountRuntime.currentSubject();
    if (!account || account.tenantId !== credentials.tenantId) throw new Error('ACCOUNT_RUNTIME_REQUIRED');
    const { http } = createClients();
    return await run(new EscrowClient(http, { ...credentials, tenantMemberId: account.tenantMemberId }));
  } finally {
    escrowInFlight = false;
  }
}
export async function organizationEscrowAction(action: string, consent = false): Promise<unknown> {
  await ensureVaultReady();
  return escrowAction(async (client) => {
    switch (action) {
      case 'status':
        return { ...(await client.view()), progressError: escrowError };
      case 'enroll':
        return client.enroll(consent);
      case 'confirm':
        return client.confirmEnrollment();
      case 'request':
        return client.requestRecovery();
      case 'cancel':
        return client.cancelRecovery();
      case 'resume':
        return client.resumeRecovery();
      case 'recovery-code':
        return client.recoveryCode();
      case 'acknowledge-code':
        return client.acknowledgeRecoveryCode();
      default:
        throw new Error('ESCROW_ACTION_INVALID');
    }
  });
}

export async function refreshPersonalSyncDevices() {
  const { admin } = createClients();
  const stateView = await admin.listDevices();
  if (
    !isPersonalSyncInitialized() &&
    stateView.devices.some((d) => d.id === requireCredentials().deviceId && d.status === 'trusted')
  ) {
    await escrowAction(async (client) => {
      const ring = await client.loadKeyring();
      for (const key of ring.keys.values()) key.fill(0);
    });
  }
  await store.writePersonalSyncRemoteCache(stateView.rootStatus, stateView.devices);
  return stateView;
}

export async function revokePersonalSyncDeviceById(deviceId: string) {
  const { admin } = createClients();
  const stateView = await admin.revokeDevice(deviceId);
  await store.writePersonalSyncRemoteCache(stateView.rootStatus, stateView.devices);
  return stateView;
}

/** 本设备发起配对：返回配对 ID 与 8 位显示码（在另一台受信设备上批准）。 */
export async function createPersonalSyncPairingForThisDevice() {
  await ensureVaultReady();
  requireCredentials();
  const identity = currentVerifiedAccountContext();
  const credentials = requireCredentials();
  const request = cryptoModule.createPersonalSyncPairingRequest({
    tenantId: identity.tenantId,
    userId: credentials.userId,
    deviceId: credentials.deviceId,
  });
  const { admin } = createClients();
  return admin.createPairing(request);
}

/** 受信设备批准另一台设备（输入配对 ID 与 8 位显示码）。 */
export async function approvePersonalSyncPairingById(pairingId: string, displayCode: string) {
  await ensureVaultReady();
  requireCredentials();
  const { admin } = createClients();
  const pairing = await admin.getPairing(pairingId);
  const approval = cryptoModule.createPersonalSyncPairingApproval({
    id: pairing.id,
    pendingDeviceId: pairing.pendingDeviceId,
    challenge: pairing.challenge,
    x25519EncryptionPublicKey: pairing.x25519EncryptionPublicKey,
    requiredKeyVersions: pairing.requiredKeyVersions,
    keysetDigest: pairing.keysetDigest,
    displayCode,
  });
  return admin.approvePairing(pairingId, approval);
}

/** 用恢复码接入本设备：恢复挑战 → 恢复包 → 解封并重新封装 → 轮换凭据。 */
export async function recoverPersonalSyncWithCode(recoveryCode: string): Promise<{ newRecoveryCode: string }> {
  await ensureVaultReady();
  requireCredentials();
  const { admin } = createClients();
  const challenge = await admin.createRecoveryChallenge();
  const recoveryPackage = await admin.getRecoveryPackage();
  const { request, newRecoveryCode } = cryptoModule.createPersonalSyncRecoveryAttestation({
    challenge,
    recoveryPackage,
    recoveryCode,
  });
  await admin.attestRecovery(challenge.id, request);
  cryptoModule.confirmPersonalSyncRecoveryRotation(recoveryPackage.keysetDigest);
  await refreshPersonalSyncDevices();
  return { newRecoveryCode };
}

// ── 状态视图（UI）──────────────────────────────────────────────────────

export interface PersonalSyncStatusView {
  active: boolean;
  initialized: boolean;
  autoEnabled: boolean;
  syncing: boolean;
  deviceId: string | null;
  pendingEvents: number;
  cursor: number;
  conflicts: number;
  lastSyncAt: number | null;
  lastError: string | null;
  lastTrigger: string | null;
  lastResult: Record<string, unknown> | null;
  lastSnapshotSeq: number;
  remote: store.PersonalSyncRemoteCache | null;
}

export async function getPersonalSyncStatus(): Promise<PersonalSyncStatusView> {
  const credentials = state.credentials;
  const accountActive = accountRuntime.currentSubject() !== null;
  const base: PersonalSyncStatusView = {
    active: !!credentials && accountActive,
    initialized: state.vaultReady && isPersonalSyncInitialized(),
    autoEnabled: state.autoEnabled,
    syncing: state.running !== null,
    deviceId: credentials?.deviceId ?? null,
    pendingEvents: 0,
    cursor: 0,
    conflicts: 0,
    lastSyncAt: null,
    lastError: null,
    lastTrigger: null,
    lastResult: null,
    lastSnapshotSeq: 0,
    remote: null,
  };
  if (!accountActive) return base;
  try {
    const [local, conflicts, remote] = await Promise.all([
      store.readPersonalSyncLocalStatus(),
      store.readPersonalSyncConflicts(),
      store.readPersonalSyncRemoteCache(),
    ]);
    return { ...base, ...local, conflicts: conflicts.length, remote };
  } catch {
    return base;
  }
}

export async function readPersonalSyncConflictViews() {
  return store.readPersonalSyncConflicts();
}

export function currentPersonalSyncTrigger() {
  return state.runningTrigger;
}

export function personalSyncVaultKeyPath(userDataPath: string) {
  return path.join(userDataPath, 'team-platform', 'auth', 'personal-sync-vault-key.bin');
}
