// 个人记忆云备份（E-31 移植）：快照模块验证。
// ① 准备/恢复往返（整库加密包，明文不外泄）；② 篡改与绑定校验（密文 hash / manifest / 租户绑定）；
// ③ 快照清单签名（zsl:personal-sync:snapshot-manifest:v1）。

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { AccountRuntimeManager } from '@/process/services/teamBff/accountRuntime';
import { bindAccountRuntime } from '@/process/services/teamBff/modules/memory/account-runtime';
import {
  confirmPersonalSyncInitialization,
  createPersonalSyncInitialization,
  loadOrCreateDeviceIdentity,
} from '@/process/services/teamBff/modules/personalSync/crypto';
import {
  preparePersonalSyncSnapshot,
  restorePersonalSyncSnapshot,
  signPersonalSyncSnapshot,
} from '@/process/services/teamBff/modules/personalSync/snapshot';
import { unlockSecretVault } from '@/process/services/teamBff/modules/personalSync/secretVault';
import { getMemoryStoreContext } from '@/process/services/teamBff/modules/memory/memory-store';
import { readPersonalSyncLocalStatus } from '@/process/services/teamBff/modules/personalSync/store';
import { newUlid } from '@/process/services/teamBff/modules/shared/ids';

const T1 = '018f0000-0000-7000-8000-000000000001';
const M1 = '018f0000-0000-7000-8000-000000000002';
const TEAM_A = '018f0000-0000-7000-8000-000000000003';
const VAULT_KEY = Buffer.from(Array.from({ length: 32 }, (_, index) => index + 1)).toString('base64url');
const ED25519_SPKI_PREFIX = '302a300506032b6570032100';

async function insertMemory(runtime: AccountRuntimeManager, id: string, title: string, content: string) {
  const now = Date.now();
  await runtime.database('memory').execute({
    sql: `INSERT INTO memories(id,category_id,title,content,source,scope,pinned,tenant_id,tenant_member_id,
      context_team_id,version,hlc,deleted_at,importance,forget_after,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    args: [
      id,
      'fact',
      title,
      content,
      'manual',
      'chat',
      0,
      T1,
      M1,
      null,
      1,
      `${String(now).padStart(13, '0')}:000000`,
      null,
      0.5,
      null,
      now,
      now,
    ],
  });
}

describe('personal-sync snapshot（移植自 client server/personal-sync-snapshot.ts）', () => {
  let runtime: AccountRuntimeManager;
  let keysetDigest: string;

  beforeEach(async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'aionui-personal-sync-snapshot-'));
    runtime = new AccountRuntimeManager(root);
    bindAccountRuntime(runtime);
    await runtime.activate({ tenantId: T1, tenantMemberId: M1, activeTeamId: TEAM_A });
    unlockSecretVault(VAULT_KEY);
    await getMemoryStoreContext();
    const { request } = createPersonalSyncInitialization();
    confirmPersonalSyncInitialization(request.keysetDigest);
    keysetDigest = request.keysetDigest;
    // 建 sync 表（生产路径：快照恢复总在 store 的拉取循环内发生，sync 表已就绪）
    await readPersonalSyncLocalStatus();
  });

  afterEach(async () => {
    await runtime.deactivate();
  });

  it('准备/恢复往返：密文不含明文、恢复后记忆与游标还原', async () => {
    const memoryId = newUlid();
    await insertMemory(runtime, memoryId, '快照-敏感标题', '快照-敏感内容');
    const prepared = await preparePersonalSyncSnapshot({ throughServerSeq: 7, keyVersion: 1, keysetDigest });
    expect(prepared.ciphertextHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(prepared.manifestHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(prepared.sizeBytes).toBe(prepared.blob.length);
    // 明文不外泄：blob 中不出现标题/内容
    const raw = prepared.blob.toString('utf8');
    expect(raw).not.toContain('敏感标题');
    expect(raw).not.toContain('敏感内容');
    // 破坏本地库后从快照恢复
    await runtime.database('memory').execute('DELETE FROM memories');
    const restored = await restorePersonalSyncSnapshot(prepared.blob, {
      throughServerSeq: prepared.throughServerSeq,
      keyVersion: prepared.keyVersion,
      ciphertextHash: prepared.ciphertextHash,
      manifestHash: prepared.manifestHash,
    });
    expect(restored.restoredMemories).toBe(1);
    const row = await runtime.database('memory').execute({
      sql: 'SELECT title, importance FROM memories WHERE id=?',
      args: [memoryId],
    });
    expect(row.rows[0]?.title).toBe('快照-敏感标题');
    expect(Number(row.rows[0]?.importance)).toBe(0.5);
    const cursor = await runtime.database('sync').execute('SELECT pull_cursor FROM sync_state WHERE id=1');
    expect(Number(cursor.rows[0]?.pull_cursor)).toBe(7);
  });

  it('篡改与绑定校验：密文 hash / manifest / 游标不一致均拒绝', async () => {
    await insertMemory(runtime, newUlid(), '标题', '内容');
    const prepared = await preparePersonalSyncSnapshot({ throughServerSeq: 3, keyVersion: 1, keysetDigest });
    const tampered = Buffer.from(prepared.blob);
    tampered[tampered.length - 2] = tampered[tampered.length - 2] ^ 0x01;
    await expect(
      restorePersonalSyncSnapshot(tampered, {
        throughServerSeq: prepared.throughServerSeq,
        keyVersion: prepared.keyVersion,
        ciphertextHash: prepared.ciphertextHash,
        manifestHash: prepared.manifestHash,
      })
    ).rejects.toThrow('SNAPSHOT_CIPHERTEXT_HASH_INVALID');
    await expect(
      restorePersonalSyncSnapshot(prepared.blob, {
        throughServerSeq: prepared.throughServerSeq + 1,
        keyVersion: prepared.keyVersion,
        ciphertextHash: prepared.ciphertextHash,
        manifestHash: prepared.manifestHash,
      })
    ).rejects.toThrow('SNAPSHOT_MANIFEST_INVALID');
    await expect(
      restorePersonalSyncSnapshot(prepared.blob, {
        throughServerSeq: prepared.throughServerSeq,
        keyVersion: 2,
        ciphertextHash: prepared.ciphertextHash,
        manifestHash: prepared.manifestHash,
      })
    ).rejects.toThrow('SNAPSHOT_MANIFEST_INVALID');
  });

  it('快照清单签名：覆盖对象会话/设备/游标/两个 hash/大小/密钥集摘要', async () => {
    const prepared = await preparePersonalSyncSnapshot({ throughServerSeq: 9, keyVersion: 1, keysetDigest });
    const objectSessionId = newUlid();
    const deviceId = TEAM_A;
    const signed = signPersonalSyncSnapshot(prepared, objectSessionId, deviceId);
    expect(signed.objectSessionId).toBe(objectSessionId);
    expect(signed.throughServerSeq).toBe(9);
    expect(signed.ciphertextHash).toBe(prepared.ciphertextHash);
    expect(signed.manifestHash).toBe(prepared.manifestHash);
    expect(signed.sizeBytes).toBe(prepared.sizeBytes);
    const statementHash = createHash('sha256')
      .update(
        [
          objectSessionId,
          deviceId,
          '9',
          '1',
          prepared.ciphertextHash,
          prepared.manifestHash,
          String(prepared.sizeBytes),
          keysetDigest,
        ].join('\n')
      )
      .digest('hex');
    const device = loadOrCreateDeviceIdentity();
    const ok = verify(
      null,
      Buffer.from(`zsl:personal-sync:snapshot-manifest:v1\n${statementHash}`),
      createPublicKey({
        key: Buffer.concat([Buffer.from(ED25519_SPKI_PREFIX, 'hex'), device.ed25519PublicRaw]),
        format: 'der',
        type: 'spki',
      }),
      Buffer.from(signed.creatorSignature, 'base64url')
    );
    expect(ok).toBe(true);
  });
});
