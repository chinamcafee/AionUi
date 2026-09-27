// 移植自 client-reference/server/personal-sync-store.ts（上游 commit 915d14c0）。
// 个人记忆云备份的本地状态机：memory.db 的变更捕获 → sync.db 加密 outbox → 推送 team-server；
// 拉取远端事件 → AES-GCM 解密 → 三方合并/冲突副本 → 写回 memory.db；游标压缩时经快照恢复。
//
// AionUi 适配：① memories 表列与上游不同（多 importance/forget_after 等 T2.6 字段、少 hlc 之外的差异），
// 同步载荷取「内容字段」全集并排除本机召回统计（last_recalled_at/recall_count 不参与同步、写回时保留本机值）；
// ② 新增 sync_status（最近同步/最近错误/自动开关/最近快照位点）与 sync_remote_cache（设备列表离线缓存）。

import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, sign } from 'node:crypto';
import { newUlid } from '../shared/ids.js';
import { HybridLogicalClock } from '../shared/hlc.js';
import { currentPersonalBackupContext } from '../memory/account-request-context.js';
import { accountRuntime } from '../memory/account-runtime.js';
import { loadOrCreateDeviceIdentity } from './crypto.js';
import { getSecret } from './secretVault.js';
import { restorePersonalSyncSnapshot } from './snapshot.js';

export interface MemorySyncPayload {
  id: string;
  category: string;
  title: string;
  content: string;
  source: string;
  scope: string;
  pinned: boolean;
  tenantId: string;
  tenantMemberId: string;
  contextTeamId: string | null;
  version: number;
  hlc: string;
  deletedAt: number | null;
  importance: number;
  forgetAfter: number | null;
  createdAt: number;
  updatedAt: number;
}

interface OutboxRow {
  event_id: string;
  entity_id: string;
  operation: string;
  base_version: number;
  entity_version: number;
  parent_event_id: string | null;
  hlc: string;
  payload_json: string;
  idempotency_key: string;
}

export interface SyncTransport {
  pushEvents(request: { baseCursor: number; events: unknown[] }): Promise<{
    results: Array<{ eventId: string; status: string; serverSeq?: number; errorCode?: string }>;
    currentCursor: number;
  }>;
  pullEvents(
    after: number,
    limit: number
  ): Promise<{
    events: EncryptedCloudEvent[];
    currentCursor: number;
    hasMore: boolean;
  }>;
  ackCursor(cursor: number): Promise<void>;
  downloadSnapshot(objectSessionId: string): Promise<Buffer>;
}

export interface CompactedSnapshotPoint {
  snapshotId: string;
  objectSessionId: string;
  throughServerSeq: number;
  keyVersion: number;
  ciphertextHash: string;
  manifestHash: string;
}

export class CursorCompactedClientError extends Error {
  constructor(
    public readonly minimumCursor: number,
    public readonly snapshots: CompactedSnapshotPoint[]
  ) {
    super('CURSOR_COMPACTED');
  }
}

export interface EncryptedCloudEvent {
  serverSeq: number;
  eventId: string;
  originDeviceId: string;
  entityType: string;
  entityId: string;
  operation: string;
  baseVersion: number;
  entityVersion: number;
  parentEventId: string | null;
  hlc: string;
  keyVersion: number;
  nonce: string;
  ciphertext: string;
  aadHash: string;
  idempotencyKey: string;
  deviceSignature: string;
}

const initialized = new Map<number, Promise<void>>();
accountRuntime.registerCacheInvalidator(() => initialized.clear());

function hash(value: Buffer | string) {
  return createHash('sha256').update(value).digest();
}
function b64(value: Buffer) {
  return value.toString('base64url');
}

async function syncDatabase() {
  const generation = accountRuntime.currentGeneration();
  const database = accountRuntime.database('sync');
  let pending = initialized.get(generation);
  if (!pending) {
    pending = (async () => {
      await database.execute(`CREATE TABLE IF NOT EXISTS sync_outbox (
        event_id TEXT PRIMARY KEY, entity_id TEXT NOT NULL, operation TEXT NOT NULL,
        base_version INTEGER NOT NULL, entity_version INTEGER NOT NULL, parent_event_id TEXT,
        hlc TEXT NOT NULL, payload_json TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'pending', last_error TEXT, created_at INTEGER NOT NULL
      )`);
      await database.execute(`CREATE TABLE IF NOT EXISTS sync_inbox (
        server_seq INTEGER PRIMARY KEY, event_id TEXT NOT NULL UNIQUE, payload_json TEXT NOT NULL,
        status TEXT NOT NULL, applied_at INTEGER NOT NULL
      )`);
      await database.execute(`CREATE TABLE IF NOT EXISTS sync_entity_heads (
        entity_id TEXT PRIMARY KEY, event_id TEXT NOT NULL, version INTEGER NOT NULL,
        hlc TEXT NOT NULL, payload_json TEXT NOT NULL, updated_at INTEGER NOT NULL
      )`);
      await database.execute(`CREATE TABLE IF NOT EXISTS sync_entity_versions (
        event_id TEXT PRIMARY KEY, entity_id TEXT NOT NULL, version INTEGER NOT NULL,
        hlc TEXT NOT NULL, payload_json TEXT NOT NULL, created_at INTEGER NOT NULL
      )`);
      await database.execute(`CREATE TABLE IF NOT EXISTS sync_conflicts (
        id TEXT PRIMARY KEY, entity_id TEXT NOT NULL, local_event_id TEXT,
        remote_event_id TEXT NOT NULL, conflict_copy_id TEXT NOT NULL, created_at INTEGER NOT NULL
      )`);
      await database.execute(`CREATE TABLE IF NOT EXISTS sync_state (
        id INTEGER PRIMARY KEY CHECK (id = 1), pull_cursor INTEGER NOT NULL DEFAULT 0,
        last_error TEXT, updated_at INTEGER NOT NULL
      )`);
      await database.execute({
        sql: `INSERT OR IGNORE INTO sync_state(id,pull_cursor,updated_at) VALUES(1,0,?)`,
        args: [Date.now()],
      });
      await database.execute(`CREATE TABLE IF NOT EXISTS sync_status (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        last_sync_at INTEGER, last_error TEXT, last_trigger TEXT, last_result TEXT,
        last_snapshot_seq INTEGER NOT NULL DEFAULT 0, auto_enabled INTEGER NOT NULL DEFAULT 0
      )`);
      await database.execute(`INSERT OR IGNORE INTO sync_status(id,last_snapshot_seq,auto_enabled) VALUES(1,0,0)`);
      await database.execute(`CREATE TABLE IF NOT EXISTS sync_remote_cache (
        id INTEGER PRIMARY KEY CHECK (id = 1), root_status TEXT, devices_json TEXT NOT NULL, fetched_at INTEGER NOT NULL
      )`);
    })();
    initialized.set(generation, pending);
  }
  await pending;
  if (generation !== accountRuntime.currentGeneration()) throw new Error('ACCOUNT_CONTEXT_CHANGED');
  return database;
}

function rowToPayload(row: Record<string, unknown>): MemorySyncPayload {
  return {
    id: String(row.id),
    category: String(row.category),
    title: String(row.title),
    content: String(row.content),
    source: String(row.source),
    scope: String(row.scope),
    pinned: Number(row.pinned) === 1,
    tenantId: String(row.tenant_id),
    tenantMemberId: String(row.tenant_member_id),
    contextTeamId: row.context_team_id === null ? null : String(row.context_team_id),
    version: Number(row.version),
    hlc: String(row.hlc),
    deletedAt: row.deleted_at === null ? null : Number(row.deleted_at),
    importance: Number(row.importance ?? 0.5),
    forgetAfter: row.forget_after === null || row.forget_after === undefined ? null : Number(row.forget_after),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export async function captureLocalMemoryChanges() {
  const identity = currentPersonalBackupContext();
  await import('../memory/memory-store.js').then((module) => module.getBackupStoreContext());
  const memory = accountRuntime.database('memory');
  const sync = await syncDatabase();
  const rows = await memory.execute({
    sql: 'SELECT * FROM memories WHERE tenant_id=? AND tenant_member_id=?',
    args: [identity.tenantId, identity.tenantMemberId],
  });
  let captured = 0;
  for (const source of rows.rows) {
    const payload = rowToPayload(source as Record<string, unknown>);
    const headResult = await sync.execute({
      sql: 'SELECT * FROM sync_entity_heads WHERE entity_id=?',
      args: [payload.id],
    });
    const head = headResult.rows[0] as Record<string, unknown> | undefined;
    if (head && String(head.payload_json) === JSON.stringify(payload)) continue;
    const eventId = newUlid();
    const baseVersion = head ? Number(head.version) : 0;
    const entityVersion = Math.max(payload.version, baseVersion + 1);
    if (payload.version !== entityVersion) {
      payload.version = entityVersion;
      await memory.execute({
        sql: 'UPDATE memories SET version=? WHERE id=? AND tenant_id=? AND tenant_member_id=?',
        args: [entityVersion, payload.id, identity.tenantId, identity.tenantMemberId],
      });
    }
    const payloadJSON = JSON.stringify(payload);
    await sync.batch(
      [
        {
          sql: `INSERT INTO sync_outbox(event_id,entity_id,operation,base_version,entity_version,
            parent_event_id,hlc,payload_json,idempotency_key,status,created_at)
            VALUES(?,?,?,?,?,?,?,?,?,'pending',?)`,
          args: [
            eventId,
            payload.id,
            payload.deletedAt === null ? 'upsert' : 'delete',
            baseVersion,
            entityVersion,
            head ? String(head.event_id) : null,
            payload.hlc,
            payloadJSON,
            randomUUID(),
            Date.now(),
          ],
        },
        {
          sql: `INSERT INTO sync_entity_heads(entity_id,event_id,version,hlc,payload_json,updated_at)
            VALUES(?,?,?,?,?,?) ON CONFLICT(entity_id) DO UPDATE SET event_id=excluded.event_id,
            version=excluded.version,hlc=excluded.hlc,payload_json=excluded.payload_json,updated_at=excluded.updated_at`,
          args: [payload.id, eventId, entityVersion, payload.hlc, payloadJSON, Date.now()],
        },
        {
          sql: `INSERT OR REPLACE INTO sync_entity_versions(event_id,entity_id,version,hlc,payload_json,created_at)
            VALUES(?,?,?,?,?,?)`,
          args: [eventId, payload.id, entityVersion, payload.hlc, payloadJSON, Date.now()],
        },
      ],
      'write'
    );
    captured += 1;
  }
  return captured;
}

function eventAAD(
  identity: ReturnType<typeof currentPersonalBackupContext>,
  event: {
    eventId: string;
    originDeviceId: string;
    entityId: string;
    operation: string;
    baseVersion: number;
    entityVersion: number;
    parentEventId: string | null;
    hlc: string;
    keyVersion: number;
    idempotencyKey: string;
  }
) {
  return Buffer.from(
    JSON.stringify({
      tenantId: identity.tenantId,
      tenantMemberId: identity.tenantMemberId,
      eventId: event.eventId,
      originDeviceId: event.originDeviceId,
      entityType: 'personalMemory',
      entityId: event.entityId,
      operation: event.operation,
      baseVersion: event.baseVersion,
      entityVersion: event.entityVersion,
      parentEventId: event.parentEventId,
      hlc: event.hlc,
      keyVersion: event.keyVersion,
      idempotencyKey: event.idempotencyKey,
    })
  );
}

function signedEventMessage(
  event: Omit<EncryptedCloudEvent, 'serverSeq'>,
  nonce: Buffer,
  ciphertext: Buffer,
  aadHash: Buffer
) {
  const parts = [
    event.eventId,
    event.originDeviceId,
    event.entityType,
    event.entityId,
    event.operation,
    String(event.baseVersion),
    String(event.entityVersion),
    event.parentEventId ?? '',
    event.hlc,
    String(event.keyVersion),
    hash(nonce).toString('hex'),
    hash(ciphertext).toString('hex'),
    aadHash.toString('hex'),
    event.idempotencyKey,
  ];
  return Buffer.from(`zsl:personal-sync:event:v1\n${hash(parts.join('\n')).toString('hex')}`);
}

function materializeEvent(row: OutboxRow, deviceId: string): Omit<EncryptedCloudEvent, 'serverSeq'> {
  const identity = currentPersonalBackupContext();
  const keyVersion = Number(getSecret('personal-sync:current-key-version') || '1');
  if (!Number.isSafeInteger(keyVersion) || keyVersion < 1) throw new Error('KEYSET_INCOMPLETE');
  const umk = Buffer.from(getSecret(`personal-sync:umk:v${keyVersion}`), 'base64url');
  if (umk.length !== 32) throw new Error('PERSONAL_SYNC_KEYRING_LOCKED');
  const base = {
    eventId: String(row.event_id),
    originDeviceId: deviceId,
    entityType: 'personalMemory',
    entityId: String(row.entity_id),
    operation: String(row.operation),
    baseVersion: Number(row.base_version),
    entityVersion: Number(row.entity_version),
    parentEventId: row.parent_event_id ? String(row.parent_event_id) : null,
    hlc: String(row.hlc),
    keyVersion,
    idempotencyKey: String(row.idempotency_key),
  };
  const aad = eventAAD(identity, base);
  const aadHash = hash(aad);
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', umk, nonce);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([
    cipher.update(String(row.payload_json), 'utf8'),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  umk.fill(0);
  const unsigned = {
    ...base,
    nonce: b64(nonce),
    ciphertext: b64(ciphertext),
    aadHash: b64(aadHash),
    deviceSignature: '',
  };
  const device = loadOrCreateDeviceIdentity();
  unsigned.deviceSignature = b64(
    sign(null, signedEventMessage(unsigned, nonce, ciphertext, aadHash), device.ed25519Private)
  );
  return unsigned;
}

export async function pushPersonalSyncOutbox(transport: SyncTransport, deviceId: string) {
  await captureLocalMemoryChanges();
  const sync = await syncDatabase();
  const cursor = Number(
    (await sync.execute('SELECT pull_cursor FROM sync_state WHERE id=1')).rows[0]?.pull_cursor ?? 0
  );
  const rows = await sync.execute(`SELECT * FROM sync_outbox WHERE status='pending' ORDER BY created_at LIMIT 500`);
  if (rows.rows.length === 0) return { pushed: 0, currentCursor: cursor };
  const events = rows.rows.map((row) => materializeEvent(row as unknown as OutboxRow, deviceId));
  const response = await transport.pushEvents({ baseCursor: cursor, events });
  let pushed = 0;
  for (const result of response.results) {
    if (['accepted', 'acceptedConflict', 'duplicate'].includes(result.status)) {
      await sync.execute({ sql: 'DELETE FROM sync_outbox WHERE event_id=?', args: [result.eventId] });
      pushed += 1;
    } else {
      await sync.execute({
        sql: `UPDATE sync_outbox SET status='pending',last_error=? WHERE event_id=?`,
        args: [result.errorCode ?? 'EVENT_REJECTED', result.eventId],
      });
    }
  }
  return { pushed, currentCursor: response.currentCursor };
}

function decryptEvent(event: EncryptedCloudEvent): MemorySyncPayload {
  const identity = currentPersonalBackupContext();
  const umk = Buffer.from(getSecret(`personal-sync:umk:v${event.keyVersion}`), 'base64url');
  if (umk.length !== 32) throw new Error('PERSONAL_SYNC_KEY_VERSION_MISSING');
  const aad = eventAAD(identity, event);
  const expectedAADHash = hash(aad);
  if (!expectedAADHash.equals(Buffer.from(event.aadHash, 'base64url'))) throw new Error('PERSONAL_SYNC_AAD_INVALID');
  const nonce = Buffer.from(event.nonce, 'base64url');
  const sealed = Buffer.from(event.ciphertext, 'base64url');
  if (nonce.length !== 12 || sealed.length <= 16) throw new Error('PERSONAL_SYNC_CIPHERTEXT_INVALID');
  try {
    const decipher = createDecipheriv('aes-256-gcm', umk, nonce);
    decipher.setAAD(aad);
    decipher.setAuthTag(sealed.subarray(sealed.length - 16));
    const plaintext = Buffer.concat([decipher.update(sealed.subarray(0, -16)), decipher.final()]);
    umk.fill(0);
    return JSON.parse(plaintext.toString('utf8')) as MemorySyncPayload;
  } catch {
    umk.fill(0);
    throw new Error('PERSONAL_SYNC_CIPHERTEXT_INVALID');
  }
}

const mergeFields: Array<keyof MemorySyncPayload> = [
  'category',
  'title',
  'content',
  'source',
  'scope',
  'pinned',
  'contextTeamId',
  'deletedAt',
  'importance',
  'forgetAfter',
];

export function threeWayMergeMemory(base: MemorySyncPayload, local: MemorySyncPayload, remote: MemorySyncPayload) {
  const merged = { ...local };
  const conflicts: string[] = [];
  for (const field of mergeFields) {
    const baseValue = base[field];
    const localValue = local[field];
    const remoteValue = remote[field];
    const localChanged = localValue !== baseValue;
    const remoteChanged = remoteValue !== baseValue;
    if (localChanged && remoteChanged && localValue !== remoteValue) conflicts.push(field);
    else if (remoteChanged) (merged as unknown as Record<string, unknown>)[field] = remoteValue;
  }
  return { merged, conflicts };
}

async function writeMemoryPayload(payload: MemorySyncPayload) {
  const memory = accountRuntime.database('memory');
  // 本机召回统计（last_recalled_at/recall_count）不参与同步；冲突更新时保留本机已有值
  await memory.execute({
    sql: `INSERT INTO memories(id,category,title,content,source,scope,pinned,tenant_id,tenant_member_id,
      context_team_id,version,hlc,deleted_at,importance,forget_after,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET category=excluded.category,title=excluded.title,content=excluded.content,
      source=excluded.source,scope=excluded.scope,pinned=excluded.pinned,context_team_id=excluded.context_team_id,
      version=excluded.version,hlc=excluded.hlc,deleted_at=excluded.deleted_at,importance=excluded.importance,
      forget_after=excluded.forget_after,updated_at=excluded.updated_at`,
    args: [
      payload.id,
      payload.category,
      payload.title,
      payload.content,
      payload.source,
      payload.scope,
      payload.pinned ? 1 : 0,
      payload.tenantId,
      payload.tenantMemberId,
      payload.contextTeamId,
      payload.version,
      payload.hlc,
      payload.deletedAt,
      payload.importance,
      payload.forgetAfter,
      payload.createdAt,
      payload.updatedAt,
    ],
  });
}

async function applyRemoteEvent(event: EncryptedCloudEvent, remote: MemorySyncPayload) {
  const identity = currentPersonalBackupContext();
  if (
    remote.id !== event.entityId ||
    remote.tenantId !== identity.tenantId ||
    remote.tenantMemberId !== identity.tenantMemberId ||
    remote.version !== event.entityVersion ||
    remote.hlc !== event.hlc
  )
    throw new Error('PERSONAL_SYNC_PAYLOAD_BINDING_INVALID');
  const sync = await syncDatabase();
  const memory = accountRuntime.database('memory');
  const localRow = (
    await memory.execute({
      sql: 'SELECT * FROM memories WHERE id=? AND tenant_id=? AND tenant_member_id=?',
      args: [event.entityId, identity.tenantId, identity.tenantMemberId],
    })
  ).rows[0] as Record<string, unknown> | undefined;
  const head = (
    await sync.execute({
      sql: 'SELECT * FROM sync_entity_heads WHERE entity_id=?',
      args: [event.entityId],
    })
  ).rows[0] as Record<string, unknown> | undefined;
  if (head && String(head.event_id) === event.eventId) return 'duplicate';
  let outcome = 'applied';
  let applied = remote;
  if (localRow && head && event.parentEventId !== String(head.event_id)) {
    const local = rowToPayload(localRow);
    const baseRow = event.parentEventId
      ? (
          await sync.execute({
            sql: 'SELECT payload_json FROM sync_entity_versions WHERE event_id=?',
            args: [event.parentEventId],
          })
        ).rows[0]
      : undefined;
    if (baseRow) {
      const base = JSON.parse(String(baseRow.payload_json)) as MemorySyncPayload;
      const decision = threeWayMergeMemory(base, local, remote);
      if (decision.conflicts.length === 0) {
        const clock = new HybridLogicalClock();
        clock.observe(local.hlc);
        clock.observe(remote.hlc);
        applied = {
          ...decision.merged,
          version: Math.max(local.version, remote.version) + 1,
          hlc: clock.now(),
          updatedAt: Date.now(),
        };
        outcome = 'merged';
      } else {
        const conflictCopy = {
          ...remote,
          id: newUlid(),
          title: `[冲突副本] ${remote.title}`,
          version: 1,
          hlc: new HybridLogicalClock().now(),
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        await writeMemoryPayload(conflictCopy);
        await sync.execute({
          sql: `INSERT INTO sync_conflicts(id,entity_id,local_event_id,remote_event_id,conflict_copy_id,created_at)
            VALUES(?,?,?,?,?,?)`,
          args: [newUlid(), event.entityId, String(head.event_id), event.eventId, conflictCopy.id, Date.now()],
        });
        return 'conflictCopy';
      }
    } else if (remote.hlc <= String(localRow.hlc)) {
      const conflictCopy = {
        ...remote,
        id: newUlid(),
        title: `[冲突副本] ${remote.title}`,
        version: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      await writeMemoryPayload(conflictCopy);
      await sync.execute({
        sql: `INSERT INTO sync_conflicts(id,entity_id,local_event_id,remote_event_id,conflict_copy_id,created_at)
          VALUES(?,?,?,?,?,?)`,
        args: [newUlid(), event.entityId, String(head.event_id), event.eventId, conflictCopy.id, Date.now()],
      });
      return 'conflictCopy';
    }
  }
  await writeMemoryPayload(applied);
  const remoteJSON = JSON.stringify(remote);
  await sync.batch(
    [
      {
        sql: `INSERT OR REPLACE INTO sync_entity_versions(event_id,entity_id,version,hlc,payload_json,created_at)
          VALUES(?,?,?,?,?,?)`,
        args: [event.eventId, event.entityId, event.entityVersion, event.hlc, remoteJSON, Date.now()],
      },
      {
        sql: `INSERT INTO sync_entity_heads(entity_id,event_id,version,hlc,payload_json,updated_at)
          VALUES(?,?,?,?,?,?) ON CONFLICT(entity_id) DO UPDATE SET event_id=excluded.event_id,
          version=excluded.version,hlc=excluded.hlc,payload_json=excluded.payload_json,updated_at=excluded.updated_at`,
        args: [event.entityId, event.eventId, event.entityVersion, event.hlc, remoteJSON, Date.now()],
      },
    ],
    'write'
  );
  return outcome;
}

export interface PullInboxResult {
  cursor: number;
  applied: number;
  conflicts: number;
  recoveredFromSnapshot?: boolean;
  replayedOutbox?: number;
}

export async function pullPersonalSyncInbox(transport: SyncTransport, limit = 500): Promise<PullInboxResult> {
  await import('../memory/memory-store.js').then((module) => module.getBackupStoreContext());
  const sync = await syncDatabase();
  let cursor = Number((await sync.execute('SELECT pull_cursor FROM sync_state WHERE id=1')).rows[0]?.pull_cursor ?? 0);
  let applied = 0;
  let conflicts = 0;
  do {
    let response: Awaited<ReturnType<SyncTransport['pullEvents']>>;
    try {
      response = await transport.pullEvents(cursor, limit);
    } catch (error) {
      if (!(error instanceof CursorCompactedClientError)) throw error;
      return recoverCompactedCursor(transport, error, limit);
    }
    if (response.hasMore && response.events.length === 0) throw new Error('PERSONAL_SYNC_SEQUENCE_GAP');
    for (const event of response.events) {
      if (event.serverSeq !== cursor + 1) throw new Error('PERSONAL_SYNC_SEQUENCE_GAP');
      const exists = await sync.execute({ sql: 'SELECT 1 FROM sync_inbox WHERE event_id=?', args: [event.eventId] });
      if (exists.rows.length > 0) {
        cursor = Math.max(cursor, event.serverSeq);
        continue;
      }
      const payload = decryptEvent(event);
      const outcome = await applyRemoteEvent(event, payload);
      if (outcome === 'conflictCopy') conflicts += 1;
      else if (outcome !== 'duplicate') applied += 1;
      await sync.execute({
        sql: `INSERT INTO sync_inbox(server_seq,event_id,payload_json,status,applied_at) VALUES(?,?,?,?,?)`,
        args: [event.serverSeq, event.eventId, JSON.stringify(payload), outcome, Date.now()],
      });
      cursor = Math.max(cursor, event.serverSeq);
    }
    await sync.execute({
      sql: 'UPDATE sync_state SET pull_cursor=?,last_error=NULL,updated_at=? WHERE id=1',
      args: [cursor, Date.now()],
    });
    await transport.ackCursor(cursor);
    if (!response.hasMore) {
      if (cursor !== response.currentCursor) throw new Error('PERSONAL_SYNC_SEQUENCE_GAP');
      break;
    }
  } while (true);
  return { cursor, applied, conflicts };
}

async function recoverCompactedCursor(
  transport: SyncTransport,
  compacted: CursorCompactedClientError,
  limit: number
): Promise<PullInboxResult> {
  const sync = await syncDatabase();
  const pendingOutbox = await sync.execute(
    `SELECT payload_json FROM sync_outbox WHERE status='pending' ORDER BY created_at`
  );
  let restored = false;
  for (const point of compacted.snapshots) {
    try {
      const blob = await transport.downloadSnapshot(point.objectSessionId);
      await restorePersonalSyncSnapshot(blob, point);
      restored = true;
      break;
    } catch {
      // 快照 hash、manifest、密钥或 AES-GCM 任一损坏时按服务端列表回退
    }
  }
  if (!restored) throw new Error('SNAPSHOT_RECOVERY_FAILED');
  const delta = await pullPersonalSyncInbox(transport, limit);
  for (const row of pendingOutbox.rows) {
    const payload = JSON.parse(String(row.payload_json)) as MemorySyncPayload;
    await writeMemoryPayload(payload);
  }
  return { ...delta, recoveredFromSnapshot: true, replayedOutbox: pendingOutbox.rows.length };
}

export async function syncPersonalMemoriesNow(
  transport: SyncTransport,
  deviceId: string
): Promise<PullInboxResult & { pushed: number }> {
  const pushed = await pushPersonalSyncOutbox(transport, deviceId);
  const pulled = await pullPersonalSyncInbox(transport);
  await captureLocalMemoryChanges();
  const merged = await pushPersonalSyncOutbox(transport, deviceId);
  return { pushed: pushed.pushed + merged.pushed, ...pulled };
}

export type SyncRunResult = Awaited<ReturnType<typeof syncPersonalMemoriesNow>>;

// ── 本地状态 / 偏好 / 远端缓存（供 UI 状态接口）──────────────────────────

export interface PersonalSyncLocalStatus {
  pendingEvents: number;
  cursor: number;
  conflicts: number;
  lastSyncAt: number | null;
  lastError: string | null;
  lastTrigger: string | null;
  lastResult: Record<string, unknown> | null;
  lastSnapshotSeq: number;
  autoEnabled: boolean;
}

export async function readPersonalSyncLocalStatus(): Promise<PersonalSyncLocalStatus> {
  const sync = await syncDatabase();
  const state = (await sync.execute('SELECT pull_cursor FROM sync_state WHERE id=1')).rows[0];
  const status = (await sync.execute('SELECT * FROM sync_status WHERE id=1')).rows[0];
  const pending = (await sync.execute(`SELECT COUNT(*) AS n FROM sync_outbox WHERE status='pending'`)).rows[0];
  const conflicts = (await sync.execute('SELECT COUNT(*) AS n FROM sync_conflicts')).rows[0];
  let lastResult: Record<string, unknown> | null = null;
  if (status?.last_result) {
    try {
      lastResult = JSON.parse(String(status.last_result)) as Record<string, unknown>;
    } catch {
      lastResult = null;
    }
  }
  return {
    pendingEvents: Number(pending?.n ?? 0),
    cursor: Number(state?.pull_cursor ?? 0),
    conflicts: Number(conflicts?.n ?? 0),
    lastSyncAt:
      status?.last_sync_at === null || status?.last_sync_at === undefined ? null : Number(status.last_sync_at),
    lastError: status?.last_error ? String(status.last_error) : null,
    lastTrigger: status?.last_trigger ? String(status.last_trigger) : null,
    lastResult,
    lastSnapshotSeq: Number(status?.last_snapshot_seq ?? 0),
    autoEnabled: Number(status?.auto_enabled ?? 0) === 1,
  };
}

export async function writePersonalSyncOutcome(input: {
  trigger: string;
  result?: Record<string, unknown>;
  error?: string;
}) {
  const sync = await syncDatabase();
  if (input.error) {
    await sync.execute({
      sql: `UPDATE sync_status SET last_error=?, last_trigger=?, last_sync_at=? WHERE id=1`,
      args: [input.error, input.trigger, Date.now()],
    });
    return;
  }
  await sync.execute({
    sql: `UPDATE sync_status SET last_error=NULL, last_trigger=?, last_sync_at=?, last_result=? WHERE id=1`,
    args: [input.trigger, Date.now(), JSON.stringify(input.result ?? {})],
  });
}

export async function setPersonalSyncAutoEnabled(enabled: boolean) {
  const sync = await syncDatabase();
  await sync.execute({ sql: 'UPDATE sync_status SET auto_enabled=? WHERE id=1', args: [enabled ? 1 : 0] });
}

export async function writePersonalSyncSnapshotSeq(seq: number) {
  const sync = await syncDatabase();
  await sync.execute({ sql: 'UPDATE sync_status SET last_snapshot_seq=? WHERE id=1', args: [seq] });
}

export interface SyncConflictView {
  entityId: string;
  conflictCopyId: string;
  title: string | null;
  createdAt: number;
}

export async function readPersonalSyncConflicts(): Promise<SyncConflictView[]> {
  const sync = await syncDatabase();
  const rows = await sync.execute('SELECT * FROM sync_conflicts ORDER BY created_at DESC LIMIT 50');
  if (rows.rows.length === 0) return [];
  const memory = accountRuntime.database('memory');
  const ids = rows.rows.map((row) => String(row.conflict_copy_id));
  const placeholders = ids.map(() => '?').join(',');
  let titles = new Map<string, string>();
  try {
    const found = await memory.execute({
      sql: `SELECT id, title FROM memories WHERE id IN (${placeholders})`,
      args: ids,
    });
    titles = new Map(found.rows.map((row) => [String(row.id), String(row.title)]));
  } catch {
    titles = new Map();
  }
  return rows.rows.map((row) => ({
    entityId: String(row.entity_id),
    conflictCopyId: String(row.conflict_copy_id),
    title: titles.get(String(row.conflict_copy_id)) ?? null,
    createdAt: Number(row.created_at),
  }));
}

export interface PersonalSyncRemoteCache {
  rootStatus: string;
  devices: unknown[];
  fetchedAt: number;
}

export async function readPersonalSyncRemoteCache(): Promise<PersonalSyncRemoteCache | null> {
  const sync = await syncDatabase();
  const row = (await sync.execute('SELECT * FROM sync_remote_cache WHERE id=1')).rows[0];
  if (!row) return null;
  try {
    return {
      rootStatus: String(row.root_status ?? 'uninitialized'),
      devices: JSON.parse(String(row.devices_json)) as unknown[],
      fetchedAt: Number(row.fetched_at),
    };
  } catch {
    return null;
  }
}

export async function writePersonalSyncRemoteCache(rootStatus: string, devices: unknown[]) {
  const sync = await syncDatabase();
  await sync.execute({
    sql: `INSERT INTO sync_remote_cache(id,root_status,devices_json,fetched_at) VALUES(1,?,?,?)
      ON CONFLICT(id) DO UPDATE SET root_status=excluded.root_status,devices_json=excluded.devices_json,
      fetched_at=excluded.fetched_at`,
    args: [rootStatus, JSON.stringify(devices), Date.now()],
  });
}
