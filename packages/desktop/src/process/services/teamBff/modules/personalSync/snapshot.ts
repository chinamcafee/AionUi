// 移植自 client-reference/server/personal-sync-snapshot.ts（上游 commit 915d14c0）。
// 云端快照：整库记忆 + 实体头的 AES-256-GCM 加密包（UMK 加密、manifest 作 AAD），
// 服务端与对象存储只见密文；游标压缩（CURSOR_COMPACTED）时经 restore 恢复本地状态。
//
// AionUi 适配：memories 行按本仓表结构落库（含 importance/forget_after；本机召回统计不入快照）。

import { createCipheriv, createDecipheriv, createHash, randomBytes, sign } from 'node:crypto';
import { currentPersonalBackupContext } from '../memory/account-request-context.js';
import { accountRuntime } from '../memory/account-runtime.js';
import { loadOrCreateDeviceIdentity } from './crypto.js';
import { getSecret } from './secretVault.js';

function digest(value: Buffer | string) {
  return createHash('sha256').update(value).digest();
}

export interface PreparedPersonalSyncSnapshot {
  blob: Buffer;
  throughServerSeq: number;
  keyVersion: number;
  ciphertextHash: string;
  manifestHash: string;
  sizeBytes: number;
  keysetDigest: string;
}

export async function preparePersonalSyncSnapshot(input: {
  throughServerSeq: number;
  keyVersion: number;
  keysetDigest: string;
}): Promise<PreparedPersonalSyncSnapshot> {
  if (
    !Number.isSafeInteger(input.throughServerSeq) ||
    input.throughServerSeq < 0 ||
    !Number.isSafeInteger(input.keyVersion) ||
    input.keyVersion < 1 ||
    !/^sha256:[0-9a-f]{64}$/.test(input.keysetDigest)
  )
    throw new Error('SNAPSHOT_INPUT_INVALID');
  const identity = currentPersonalBackupContext();
  await import('../memory/memory-store.js').then((module) => module.getBackupStoreContext());
  const rows = await accountRuntime.database('memory').execute({
    sql: 'SELECT * FROM memories WHERE tenant_id=? AND tenant_member_id=? ORDER BY id',
    args: [identity.tenantId, identity.tenantMemberId],
  });
  const heads = await accountRuntime
    .database('sync')
    .execute('SELECT entity_id,event_id,version,hlc,payload_json,updated_at FROM sync_entity_heads ORDER BY entity_id')
    .then((result) => result.rows)
    .catch((): unknown[] => []);
  const payload = Buffer.from(
    JSON.stringify({
      version: 1,
      tenantId: identity.tenantId,
      tenantMemberId: identity.tenantMemberId,
      throughServerSeq: input.throughServerSeq,
      memories: rows.rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value]))),
      entityHeads: heads.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value]))),
    })
  );
  const manifest = {
    version: 1,
    cipher: 'AES-256-GCM',
    keyVersion: input.keyVersion,
    throughServerSeq: input.throughServerSeq,
    entityCount: rows.rows.length,
    plaintextHash: `sha256:${digest(payload).toString('hex')}`,
    keysetDigest: input.keysetDigest,
  };
  const manifestJSON = Buffer.from(JSON.stringify(manifest));
  const umk = Buffer.from(getSecret(`personal-sync:umk:v${input.keyVersion}`), 'base64url');
  if (umk.length !== 32) throw new Error('PERSONAL_SYNC_KEY_VERSION_MISSING');
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', umk, nonce);
  cipher.setAAD(manifestJSON);
  const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
  const blob = Buffer.from(
    JSON.stringify({
      version: 1,
      manifest,
      nonce: nonce.toString('base64url'),
      ciphertext: ciphertext.toString('base64url'),
      tag: cipher.getAuthTag().toString('base64url'),
    })
  );
  umk.fill(0);
  payload.fill(0);
  return {
    blob,
    throughServerSeq: input.throughServerSeq,
    keyVersion: input.keyVersion,
    ciphertextHash: `sha256:${digest(blob).toString('hex')}`,
    manifestHash: `sha256:${digest(manifestJSON).toString('hex')}`,
    sizeBytes: blob.length,
    keysetDigest: input.keysetDigest,
  };
}

export async function restorePersonalSyncSnapshot(
  blob: Buffer,
  expected: {
    throughServerSeq: number;
    keyVersion: number;
    ciphertextHash: string;
    manifestHash: string;
  }
) {
  if (`sha256:${digest(blob).toString('hex')}` !== expected.ciphertextHash) {
    throw new Error('SNAPSHOT_CIPHERTEXT_HASH_INVALID');
  }
  let envelope: {
    version: number;
    manifest: Record<string, unknown>;
    nonce: string;
    ciphertext: string;
    tag: string;
  };
  try {
    envelope = JSON.parse(blob.toString('utf8'));
  } catch {
    throw new Error('SNAPSHOT_FORMAT_INVALID');
  }
  const manifestJSON = Buffer.from(JSON.stringify(envelope.manifest));
  if (
    envelope.version !== 1 ||
    `sha256:${digest(manifestJSON).toString('hex')}` !== expected.manifestHash ||
    envelope.manifest.throughServerSeq !== expected.throughServerSeq ||
    envelope.manifest.keyVersion !== expected.keyVersion
  ) {
    throw new Error('SNAPSHOT_MANIFEST_INVALID');
  }
  const umk = Buffer.from(getSecret(`personal-sync:umk:v${expected.keyVersion}`), 'base64url');
  if (umk.length !== 32) throw new Error('PERSONAL_SYNC_KEY_VERSION_MISSING');
  let plaintext: Buffer;
  try {
    const decipher = createDecipheriv('aes-256-gcm', umk, Buffer.from(envelope.nonce, 'base64url'));
    decipher.setAAD(manifestJSON);
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64url'));
    plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64url')), decipher.final()]);
  } catch {
    throw new Error('SNAPSHOT_CIPHERTEXT_INVALID');
  } finally {
    umk.fill(0);
  }
  if (envelope.manifest.plaintextHash !== `sha256:${digest(plaintext).toString('hex')}`) {
    plaintext.fill(0);
    throw new Error('SNAPSHOT_PLAINTEXT_HASH_INVALID');
  }
  let payload: {
    version: number;
    tenantId: string;
    tenantMemberId: string;
    throughServerSeq: number;
    memories: Array<Record<string, unknown>>;
    entityHeads: Array<Record<string, unknown>>;
  };
  try {
    payload = JSON.parse(plaintext.toString('utf8'));
  } catch {
    throw new Error('SNAPSHOT_PAYLOAD_INVALID');
  } finally {
    plaintext.fill(0);
  }
  const identity = currentPersonalBackupContext();
  if (
    payload.version !== 1 ||
    payload.tenantId !== identity.tenantId ||
    payload.tenantMemberId !== identity.tenantMemberId ||
    payload.throughServerSeq !== expected.throughServerSeq ||
    !Array.isArray(payload.memories) ||
    !Array.isArray(payload.entityHeads)
  )
    throw new Error('SNAPSHOT_PAYLOAD_BINDING_INVALID');
  await import('../memory/memory-store.js').then((module) => module.getBackupStoreContext());
  const memory = accountRuntime.database('memory');
  const sync = accountRuntime.database('sync');
  const memoryStatements = [
    {
      sql: 'DELETE FROM memories WHERE tenant_id=? AND tenant_member_id=?',
      args: [identity.tenantId, identity.tenantMemberId],
    },
    ...payload.memories.map((row) => ({
      sql: `INSERT INTO memories(id,category,title,content,source,scope,pinned,tenant_id,tenant_member_id,
        context_team_id,version,hlc,deleted_at,importance,forget_after,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [
        row.id,
        row.category,
        row.title,
        row.content,
        row.source,
        row.scope,
        row.pinned,
        row.tenant_id,
        row.tenant_member_id,
        row.context_team_id,
        row.version,
        row.hlc,
        row.deleted_at,
        row.importance ?? 0.5,
        row.forget_after ?? null,
        row.created_at,
        row.updated_at,
      ] as (string | number | null)[],
    })),
  ];
  await memory.batch(memoryStatements, 'write');
  await sync.batch(
    [
      { sql: 'DELETE FROM sync_inbox', args: [] },
      { sql: 'DELETE FROM sync_entity_versions', args: [] },
      { sql: 'DELETE FROM sync_entity_heads', args: [] },
      ...payload.entityHeads.map((row) => ({
        sql: `INSERT INTO sync_entity_heads(entity_id,event_id,version,hlc,payload_json,updated_at)
          VALUES(?,?,?,?,?,?)`,
        args: [row.entity_id, row.event_id, row.version, row.hlc, row.payload_json, row.updated_at] as (
          | string
          | number
        )[],
      })),
      {
        sql: 'UPDATE sync_state SET pull_cursor=?,last_error=NULL,updated_at=? WHERE id=1',
        args: [expected.throughServerSeq, Date.now()],
      },
    ],
    'write'
  );
  return { throughServerSeq: expected.throughServerSeq, restoredMemories: payload.memories.length };
}

export function signPersonalSyncSnapshot(
  prepared: PreparedPersonalSyncSnapshot,
  objectSessionId: string,
  deviceId: string
) {
  const parts = [
    objectSessionId,
    deviceId,
    String(prepared.throughServerSeq),
    String(prepared.keyVersion),
    prepared.ciphertextHash,
    prepared.manifestHash,
    String(prepared.sizeBytes),
    prepared.keysetDigest,
  ];
  const statementHash = digest(parts.join('\n'));
  const signature = sign(
    null,
    Buffer.from(`zsl:personal-sync:snapshot-manifest:v1\n${statementHash.toString('hex')}`),
    loadOrCreateDeviceIdentity().ed25519Private
  );
  return {
    objectSessionId,
    throughServerSeq: prepared.throughServerSeq,
    keyVersion: prepared.keyVersion,
    ciphertextHash: prepared.ciphertextHash,
    manifestHash: prepared.manifestHash,
    creatorSignature: signature.toString('base64url'),
    sizeBytes: prepared.sizeBytes,
  };
}

export function signPersonalSyncSnapshotVerification(input: {
  snapshotId: string;
  manifestHash: string;
  throughServerSeq: number;
  keysetDigest: string;
  verificationType: 'peer_device' | 'recovery_drill';
  recoveryChallengeId?: string;
  recoveryCounter?: number;
}) {
  const parts = [
    input.snapshotId,
    input.manifestHash,
    String(input.throughServerSeq),
    input.keysetDigest,
    input.verificationType,
    input.recoveryChallengeId ?? '',
    input.recoveryCounter === undefined ? '' : String(input.recoveryCounter),
  ];
  const statementHash = digest(parts.join('\n'));
  return {
    verificationType: input.verificationType,
    keysetDigest: input.keysetDigest,
    ...(input.recoveryChallengeId ? { recoveryChallengeId: input.recoveryChallengeId } : {}),
    ...(input.recoveryCounter !== undefined ? { recoveryCounter: input.recoveryCounter } : {}),
    verificationSignature: sign(
      null,
      Buffer.from(`zsl:personal-sync:snapshot-verification:v1\n${statementHash.toString('hex')}`),
      loadOrCreateDeviceIdentity().ed25519Private
    ).toString('base64url'),
  };
}
