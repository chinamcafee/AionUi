// 个人记忆云备份（E-31 移植）：同步状态机验证。
// ① echo 往返：本地记忆捕获 → 加密推送 → outbox 清空 → 回拉判重；
// ② 远端事件：伪造远端设备事件（与服务端同 AAD/GCM 契约）→ 解密落库；冲突路径生成冲突副本；
// ③ 游标压缩：CursorCompactedClientError → 快照恢复 → 回放待上传事件。

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { AccountRuntimeManager } from '@/process/services/teamBff/accountRuntime';
import { bindAccountRuntime } from '@/process/services/teamBff/modules/memory/account-runtime';
import {
  confirmPersonalSyncInitialization,
  createPersonalSyncInitialization,
  storedKeysetDigest,
} from '@/process/services/teamBff/modules/personalSync/crypto';
import {
  CursorCompactedClientError,
  pullPersonalSyncInbox,
  readPersonalSyncConflicts,
  readPersonalSyncLocalStatus,
  syncPersonalMemoriesNow,
  threeWayMergeMemory,
  type EncryptedCloudEvent,
  type MemorySyncPayload,
  type SyncTransport,
} from '@/process/services/teamBff/modules/personalSync/store';
import { preparePersonalSyncSnapshot } from '@/process/services/teamBff/modules/personalSync/snapshot';
import { getSecret, unlockSecretVault } from '@/process/services/teamBff/modules/personalSync/secretVault';
import { newUlid } from '@/process/services/teamBff/modules/shared/ids';
// 顶层静态导入：memory-store 的 cacheInvalidator 在模块加载期注册（绑定前进入全局注册表，
// 每次 bind 都会重新挂到新实例上）；测试内再动态 import 会导致后续用例缓存不清理。
import { getMemoryStoreContext } from '@/process/services/teamBff/modules/memory/memory-store';

const T1 = '018f0000-0000-7000-8000-000000000001';
const M1 = '018f0000-0000-7000-8000-000000000002';
const TEAM_A = '018f0000-0000-7000-8000-000000000003';
const VAULT_KEY = Buffer.from(Array.from({ length: 32 }, (_, index) => index + 1)).toString('base64url');

function sha256(value: Buffer | string) {
  return createHash('sha256').update(value).digest();
}

/** 本地写入一条记忆（绕过 memory-store 的鉴权包装，直接落 memory.db）。 */
async function insertMemory(runtime: AccountRuntimeManager, id: string, title: string, content: string) {
  const now = Date.now();
  await runtime.database('memory').execute({
    sql: `INSERT INTO memories(id,category,title,content,source,scope,pinned,tenant_id,tenant_member_id,
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

/** 伪造一条远端设备事件：AAD/GCM 契约与生产代码 eventAAD/materializeEvent 完全一致。 */
function craftRemoteEvent(input: {
  deviceId: string;
  payload: MemorySyncPayload;
  parentEventId: string | null;
}): EncryptedCloudEvent {
  const umk = Buffer.from(getSecret('personal-sync:umk:v1'), 'base64url');
  const eventId = newUlid();
  // idempotencyKey 同时进入 AAD 与事件体——必须只生成一次
  const idempotencyKey = newUlid();
  const aad = Buffer.from(
    JSON.stringify({
      tenantId: T1,
      tenantMemberId: M1,
      eventId,
      originDeviceId: input.deviceId,
      entityType: 'personalMemory',
      entityId: input.payload.id,
      operation: input.payload.deletedAt === null ? 'upsert' : 'delete',
      baseVersion: Math.max(input.payload.version - 1, 0),
      entityVersion: input.payload.version,
      parentEventId: input.parentEventId,
      hlc: input.payload.hlc,
      keyVersion: 1,
      idempotencyKey,
    })
  );
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', umk, nonce);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(input.payload), 'utf8'),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  umk.fill(0);
  return {
    serverSeq: 1,
    eventId,
    originDeviceId: input.deviceId,
    entityType: 'personalMemory',
    entityId: input.payload.id,
    operation: input.payload.deletedAt === null ? 'upsert' : 'delete',
    baseVersion: Math.max(input.payload.version - 1, 0),
    entityVersion: input.payload.version,
    parentEventId: input.parentEventId,
    hlc: input.payload.hlc,
    keyVersion: 1,
    nonce: nonce.toString('base64url'),
    ciphertext: ciphertext.toString('base64url'),
    aadHash: sha256(aad).toString('base64url'),
    idempotencyKey,
    deviceSignature: Buffer.alloc(64).toString('base64url'),
  };
}

/** 内存 echo 服务端：记录推送事件，供回拉。 */
function echoTransport(server: { events: EncryptedCloudEvent[]; cursor: number }): SyncTransport {
  return {
    pushEvents: async (request) => {
      for (const event of request.events as EncryptedCloudEvent[]) {
        server.cursor += 1;
        server.events.push({ ...event, serverSeq: server.cursor });
      }
      return {
        results: (request.events as Array<{ eventId: string }>).map((event) => ({
          eventId: event.eventId,
          status: 'accepted' as const,
          serverSeq: server.cursor,
        })),
        currentCursor: server.cursor,
      };
    },
    pullEvents: async (after, limit) => {
      const events = server.events.filter((event) => event.serverSeq > after).slice(0, limit);
      return { events, currentCursor: server.cursor, hasMore: false };
    },
    ackCursor: async () => {},
    downloadSnapshot: async () => {
      throw new Error('NO_SNAPSHOT');
    },
  };
}

describe('personal-sync store（移植自 client server/personal-sync-store.ts）', () => {
  let runtime: AccountRuntimeManager;

  beforeEach(async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'aionui-personal-sync-store-'));
    runtime = new AccountRuntimeManager(root);
    bindAccountRuntime(runtime);
    await runtime.activate({ tenantId: T1, tenantMemberId: M1, activeTeamId: TEAM_A });
    unlockSecretVault(VAULT_KEY);
    // 建表（与生产同路径：memory-store 首次访问时创建 memories 等表）
    await getMemoryStoreContext();
    const { request } = createPersonalSyncInitialization();
    confirmPersonalSyncInitialization(request.keysetDigest);
  });

  afterEach(async () => {
    await runtime.deactivate();
  });

  it('echo 往返：本地记忆加密推送、outbox 清空、回拉判重、状态更新', async () => {
    await insertMemory(runtime, newUlid(), '偏好：深色主题', '用户偏好深色界面');
    const server = { events: [] as EncryptedCloudEvent[], cursor: 0 };
    const transport = echoTransport(server);
    const result = await syncPersonalMemoriesNow(transport, newUlid());
    expect(result.pushed).toBe(1);
    expect(server.events).toHaveLength(1);
    // 推送密文不含明文
    expect(Buffer.from(server.events[0].ciphertext, 'base64url').toString('utf8')).not.toContain('深色');
    const status = await readPersonalSyncLocalStatus();
    expect(status.pendingEvents).toBe(0);
    expect(status.cursor).toBe(1);
    // 二次同步：回拉自身事件应判重（inbox 记录 duplicate / skipped），不产生冲突副本
    const second = await syncPersonalMemoriesNow(transport, newUlid());
    expect(second.pushed).toBe(0);
    expect(second.conflicts).toBe(0);
    expect((await readPersonalSyncConflicts()).length).toBe(0);
  });

  it('远端事件：解密落库（新记忆 + 远端编辑），冲突时生成冲突副本', async () => {
    const localId = newUlid();
    await insertMemory(runtime, localId, '本地标题', '本地内容');
    const server = { events: [] as EncryptedCloudEvent[], cursor: 0 };
    const transport = echoTransport(server);
    await syncPersonalMemoriesNow(transport, newUlid());

    // 远端新增一条记忆 → 直接应用
    const remoteId = newUlid();
    const now = Date.now();
    const remotePayload: MemorySyncPayload = {
      id: remoteId,
      category: 'fact',
      title: '远端设备写入',
      content: '来自另一台设备的记忆',
      source: 'manual',
      scope: 'chat',
      pinned: false,
      tenantId: T1,
      tenantMemberId: M1,
      contextTeamId: null,
      version: 1,
      hlc: `${String(now).padStart(13, '0')}:000001`,
      deletedAt: null,
      importance: 0.5,
      forgetAfter: null,
      createdAt: now,
      updatedAt: now,
    };
    const remoteEvent = {
      ...craftRemoteEvent({ deviceId: TEAM_A, payload: remotePayload, parentEventId: null }),
      serverSeq: 2,
    };
    const rows = await runtime.database('memory').execute({
      sql: 'SELECT title FROM memories WHERE id=?',
      args: [remoteId],
    });
    expect(rows.rows.length).toBe(0);
    const pullTransport: SyncTransport = {
      ...echoTransport({ events: [], cursor: 2 }),
      pullEvents: async () => ({ events: [remoteEvent], currentCursor: 2, hasMore: false }),
    };
    await pullPersonalSyncInbox(pullTransport);
    const applied = await runtime.database('memory').execute({
      sql: 'SELECT title, content FROM memories WHERE id=?',
      args: [remoteId],
    });
    expect(applied.rows[0]?.title).toBe('远端设备写入');

    // 冲突：远端事件 parent 与本地 head 不一致，且 hlc 早于本地 → 冲突副本
    const localRow = await runtime.database('memory').execute({
      sql: 'SELECT hlc FROM memories WHERE id=?',
      args: [localId],
    });
    const localHlc = String(localRow.rows[0]?.hlc);
    const conflictPayload: MemorySyncPayload = {
      ...remotePayload,
      id: localId,
      title: '远端标题',
      // 早于本地 HLC：走「基线缺失 + 远端更早」的冲突副本分支
      hlc: `${String(now - 60_000).padStart(13, '0')}:000000`,
      version: 1,
    };
    const conflictEvent = {
      ...craftRemoteEvent({ deviceId: TEAM_A, payload: conflictPayload, parentEventId: 'unknown-parent-event' }),
      serverSeq: 3,
    };
    expect(localHlc > conflictPayload.hlc).toBe(true);
    await pullPersonalSyncInbox({
      ...echoTransport({ events: [], cursor: 3 }),
      pullEvents: async () => ({ events: [conflictEvent], currentCursor: 3, hasMore: false }),
    });
    const conflicts = await readPersonalSyncConflicts();
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].title).toContain('[冲突副本]');
    const copy = await runtime.database('memory').execute({
      sql: 'SELECT title FROM memories WHERE id=?',
      args: [conflicts[0].conflictCopyId],
    });
    expect(String(copy.rows[0]?.title)).toContain('远端标题');
  });

  it('三次合并：无重叠字段取远端、重叠字段报冲突', () => {
    const base: MemorySyncPayload = {
      id: 'x',
      category: 'fact',
      title: 'A',
      content: 'base',
      source: 'manual',
      scope: 'chat',
      pinned: false,
      tenantId: T1,
      tenantMemberId: M1,
      contextTeamId: null,
      version: 1,
      hlc: '0000000000001:000000',
      deletedAt: null,
      importance: 0.5,
      forgetAfter: null,
      createdAt: 1,
      updatedAt: 1,
    };
    const local = { ...base, title: '本地标题' };
    const remote = { ...base, content: '远端内容' };
    const merged = threeWayMergeMemory(base, local, remote);
    expect(merged.conflicts).toEqual([]);
    expect(merged.merged.title).toBe('本地标题');
    expect(merged.merged.content).toBe('远端内容');
    const overlapping = threeWayMergeMemory(base, local, { ...base, title: '远端标题', content: '远端内容' });
    expect(overlapping.conflicts).toEqual(['title']);
  });

  it('游标压缩：坏快照回退、好快照恢复库与游标、回放待上传事件', async () => {
    await insertMemory(runtime, newUlid(), '快照内记忆', '应被快照恢复');
    const server = { events: [] as EncryptedCloudEvent[], cursor: 0 };
    await syncPersonalMemoriesNow(echoTransport(server), newUlid());
    const before = await readPersonalSyncLocalStatus();
    const prepared = await preparePersonalSyncSnapshot({
      throughServerSeq: before.cursor,
      keyVersion: 1,
      keysetDigest: storedKeysetDigest(),
    });

    // 压缩后新增一条本地记忆（进入 pending outbox），再触发压缩恢复
    const pendingId = newUlid();
    await insertMemory(runtime, pendingId, '压缩后本地新增', '需在恢复后回放');
    const badPoint = {
      snapshotId: newUlid(),
      objectSessionId: newUlid(),
      throughServerSeq: before.cursor,
      keyVersion: 1,
      ciphertextHash: prepared.ciphertextHash,
      manifestHash: prepared.manifestHash,
    };
    const goodPoint = { ...badPoint, objectSessionId: newUlid() };
    // 仅首次拉取抛 CURSOR_COMPACTED：恢复后的回拉走正常分支（否则无限递归恢复）
    let pullCount = 0;
    const transport: SyncTransport = {
      ...echoTransport({ events: [], cursor: before.cursor }),
      pushEvents: async () => ({ results: [], currentCursor: before.cursor }),
      pullEvents: async () => {
        pullCount += 1;
        if (pullCount === 1) throw new CursorCompactedClientError(before.cursor, [badPoint, goodPoint]);
        return { events: [], currentCursor: before.cursor, hasMore: false };
      },
      downloadSnapshot: async (objectSessionId) => {
        if (objectSessionId === badPoint.objectSessionId) return Buffer.from('corrupted-blob');
        return prepared.blob;
      },
    };
    const result = (await syncPersonalMemoriesNow(transport, newUlid())) as {
      recoveredFromSnapshot?: boolean;
      replayedOutbox?: number;
    };
    expect(result.recoveredFromSnapshot).toBe(true);
    expect(result.replayedOutbox).toBe(1);
    // 快照恢复的记忆 + 压缩后新增（回放）都在
    const titles = await runtime.database('memory').execute('SELECT title FROM memories ORDER BY title');
    const values = titles.rows.map((row) => String(row.title));
    expect(values).toContain('快照内记忆');
    expect(values).toContain('压缩后本地新增');
    const after = await readPersonalSyncLocalStatus();
    expect(after.cursor).toBe(before.cursor);
  });
});
