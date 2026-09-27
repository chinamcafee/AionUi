/**
 * 个人记忆条目存储（BFF 端，LibSQL 持久化）。
 *
 * 这里存的是「用户可见、可管理的个人记忆条目」——区别于 Mastra Memory 自动管理的
 * 对话历史 / OM 观察 / working memory。后者由 Mastra 在成员目录的 conversations.db 内维护，
 * 本表是用户主动沉淀的、结构化的长期事实（习惯 / 偏好 / 要求 / 重要事件）。
 *
 * 设计参见 doc/memorySystem/02-long-term-memory-evolution.md 的「Working Memory 便签」概念，
 * 但以独立可管理的条目形式呈现，便于「查看 / 管理 / 新增 / 整理」。
 *
 * 团队版（共享 / 审批 / 合并）预留到后续团队服务端，本期仅个人本地。
 */
import { newUlid } from '../shared/ids.js';
import { HybridLogicalClock } from '../shared/hlc.js';
import { currentVerifiedAccountContext } from './account-request-context.js';
import { accountRuntime } from './account-runtime.js';
import { enqueueMemoryEmbedding } from './memory-embedding.js';
import { markPersonalSyncDirty } from '../personalSync/dirty.js';

const initialization = new Map<number, Promise<void>>();
const clocks = new Map<number, HybridLogicalClock>();
accountRuntime.registerCacheInvalidator(() => {
  initialization.clear();
  clocks.clear();
});

function nextHlc() {
  const generation = accountRuntime.currentGeneration();
  let clock = clocks.get(generation);
  if (!clock) {
    clock = new HybridLogicalClock();
    clocks.set(generation, clock);
  }
  return clock.now();
}

function observeHlc(remote: string) {
  const generation = accountRuntime.currentGeneration();
  let clock = clocks.get(generation);
  if (!clock) {
    clock = new HybridLogicalClock();
    clocks.set(generation, clock);
  }
  clock.observe(remote);
}

async function initializeMemoryDatabase(identity: {
  tenantId: string;
  tenantMemberId: string;
  activeTeamId: string | null;
  resourceId: string | null;
}) {
  const generation = accountRuntime.currentGeneration();
  const database = accountRuntime.database('memory');
  let pending = initialization.get(generation);
  if (!pending) {
    pending = (async () => {
      await database.execute(`
        CREATE TABLE IF NOT EXISTS memories (
          id TEXT PRIMARY KEY,
          category TEXT NOT NULL DEFAULT 'fact',
          title TEXT NOT NULL,
          content TEXT NOT NULL,
          source TEXT DEFAULT 'manual',
          scope TEXT NOT NULL DEFAULT 'chat',
          pinned INTEGER NOT NULL DEFAULT 0,
          tenant_id TEXT,
          tenant_member_id TEXT,
          context_team_id TEXT,
          version INTEGER NOT NULL DEFAULT 1,
          hlc TEXT,
          deleted_at INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);
      await database.execute(`ALTER TABLE memories ADD COLUMN scope TEXT NOT NULL DEFAULT 'chat'`).catch(() => {});
      await database.execute('ALTER TABLE memories ADD COLUMN tenant_id TEXT').catch(() => {});
      await database.execute('ALTER TABLE memories ADD COLUMN tenant_member_id TEXT').catch(() => {});
      await database.execute('ALTER TABLE memories ADD COLUMN context_team_id TEXT').catch(() => {});
      await database.execute('ALTER TABLE memories ADD COLUMN version INTEGER NOT NULL DEFAULT 1').catch(() => {});
      await database.execute('ALTER TABLE memories ADD COLUMN hlc TEXT').catch(() => {});
      await database.execute('ALTER TABLE memories ADD COLUMN deleted_at INTEGER').catch(() => {});
      // T2.6 retention 字段：importance 显著度、召回统计、TTL（ALTER .catch 演进模式）
      await database.execute('ALTER TABLE memories ADD COLUMN importance REAL NOT NULL DEFAULT 0.5').catch(() => {});
      await database.execute('ALTER TABLE memories ADD COLUMN last_recalled_at INTEGER').catch(() => {});
      await database.execute('ALTER TABLE memories ADD COLUMN recall_count INTEGER NOT NULL DEFAULT 0').catch(() => {});
      await database.execute('ALTER TABLE memories ADD COLUMN forget_after INTEGER').catch(() => {});
      // T2.6 访问时间戳环形缓冲（每条记忆保留最近 RETENTION.accessCap 条，插入后裁剪）
      await database.execute(`
        CREATE TABLE IF NOT EXISTS memory_access_log (
          memory_id TEXT NOT NULL,
          accessed_at INTEGER NOT NULL
        )
      `);
      await database.execute(
        'CREATE INDEX IF NOT EXISTS idx_memory_access_log_memory ON memory_access_log (memory_id, accessed_at DESC)'
      );
      await database.execute({
        sql: 'UPDATE memories SET tenant_id = ?, tenant_member_id = ? WHERE tenant_id IS NULL OR tenant_member_id IS NULL',
        args: [identity.tenantId, identity.tenantMemberId],
      });
      await database.execute(`UPDATE memories SET hlc = printf('%013d:000000', updated_at) WHERE hlc IS NULL`);
      const latestHlc = await database.execute(
        'SELECT hlc FROM memories WHERE hlc IS NOT NULL ORDER BY hlc DESC LIMIT 1'
      );
      if (latestHlc.rows[0]?.hlc) observeHlc(String(latestHlc.rows[0].hlc));
      await database.execute(`CREATE INDEX IF NOT EXISTS idx_memories_category ON memories (category)`);
      await database.execute(`CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories (scope)`);
      await database.execute(
        'CREATE INDEX IF NOT EXISTS idx_memories_owner_scope ON memories (tenant_id, tenant_member_id, context_team_id, scope, updated_at DESC)'
      );
      await database.execute(`
        CREATE TABLE IF NOT EXISTS memory_runs (
          id TEXT PRIMARY KEY,
          scope TEXT NOT NULL DEFAULT 'all',
          status TEXT NOT NULL,
          summary TEXT,
          before_count INTEGER,
          after_count INTEGER,
          model_name TEXT,
          tenant_id TEXT,
          tenant_member_id TEXT,
          active_team_id TEXT,
          resource_id TEXT,
          created_at INTEGER NOT NULL
        )
      `);
      await database.execute(`ALTER TABLE memory_runs ADD COLUMN scope TEXT NOT NULL DEFAULT 'all'`).catch(() => {});
      for (const column of ['tenant_id', 'tenant_member_id', 'active_team_id', 'resource_id']) {
        await database.execute(`ALTER TABLE memory_runs ADD COLUMN ${column} TEXT`).catch(() => {});
      }
      await database.execute({
        sql: `UPDATE memory_runs SET tenant_id = ?, tenant_member_id = ?, active_team_id = ?, resource_id = ?
          WHERE tenant_id IS NULL OR tenant_member_id IS NULL OR active_team_id IS NULL OR resource_id IS NULL`,
        args: [identity.tenantId, identity.tenantMemberId, identity.activeTeamId, identity.resourceId],
      });
      await database.execute(
        'CREATE INDEX IF NOT EXISTS idx_memory_runs_owner ON memory_runs (tenant_id, tenant_member_id, active_team_id, created_at DESC)'
      );
      // T3.1 记忆图谱两表（04 章 §5.1）：实体节点 + 关系边，与 memories 同 owner 隔离；
      // source_memory_ids 为 JSON 数组溯源，stale 软删（空溯源节点/边由 T3.4 级联标记）
      await database.execute(`
        CREATE TABLE IF NOT EXISTS memory_graph_nodes (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          tenant_member_id TEXT NOT NULL,
          type TEXT NOT NULL,
          name TEXT NOT NULL,
          properties TEXT NOT NULL DEFAULT '{}',
          source_memory_ids TEXT NOT NULL DEFAULT '[]',
          stale INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER
        )
      `);
      await database.execute(
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_mgn_name ON memory_graph_nodes (tenant_id, tenant_member_id, type, name)`
      );
      await database.execute(`
        CREATE TABLE IF NOT EXISTS memory_graph_edges (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          tenant_member_id TEXT NOT NULL,
          type TEXT NOT NULL,
          source_node_id TEXT NOT NULL REFERENCES memory_graph_nodes(id),
          target_node_id TEXT NOT NULL REFERENCES memory_graph_nodes(id),
          weight REAL NOT NULL DEFAULT 0.5,
          source_memory_ids TEXT NOT NULL DEFAULT '[]',
          stale INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER
        )
      `);
      await database.execute(
        `CREATE INDEX IF NOT EXISTS idx_mge_source ON memory_graph_edges (tenant_id, tenant_member_id, source_node_id)`
      );
      await database.execute(
        `CREATE INDEX IF NOT EXISTS idx_mge_target ON memory_graph_edges (tenant_id, tenant_member_id, target_node_id)`
      );
      // T3.5 增量抽取水位：记录每条记忆已完成实体抽取的版本（memory_search_state 同款小表模式）
      await database.execute(`
        CREATE TABLE IF NOT EXISTS memory_graph_state (
          memory_id TEXT PRIMARY KEY,
          version INTEGER NOT NULL
        )
      `);
    })();
    initialization.set(generation, pending);
  }
  await pending;
  if (accountRuntime.currentGeneration() !== generation) throw new Error('ACCOUNT_CONTEXT_CHANGED');
  return { database, identity };
}

async function getDb() {
  const identity = currentVerifiedAccountContext();
  const { database } = await initializeMemoryDatabase(identity);
  return { database, identity };
}
/** Initialize personal backup tables without impersonating a Team context. */
export async function getBackupStoreContext() {
  const subject = accountRuntime.currentSubject();
  if (!subject) throw new Error('ACCOUNT_RUNTIME_REQUIRED');
  return initializeMemoryDatabase({
    ...subject,
    resourceId: subject.activeTeamId ? currentVerifiedAccountContext().resourceId : null,
  });
}

/** 仅供本地可重建检索投影使用；调用方仍必须使用返回的已验证 identity 过滤。 */
export async function getMemoryStoreContext() {
  return getDb();
}

// ============================================================
// 类型
// ============================================================

export type MemoryCategory = 'preference' | 'fact' | 'requirement' | 'event';
export type MemorySource = 'manual' | 'auto' | 'consolidated';
/** 记忆空间：chat=普通会话，code=编程会话独有 */
export type MemoryScope = 'chat' | 'code';

export interface MemoryEntry {
  id: string;
  category: MemoryCategory;
  title: string;
  content: string;
  source: MemorySource;
  scope: MemoryScope;
  pinned: boolean;
  tenantId: string;
  tenantMemberId: string;
  contextTeamId: string | null;
  version: number;
  hlc: string;
  deletedAt: number | null;
  /** 显著度（0-1，写入时 LLM 评估/手动；T2.6） */
  importance: number;
  /** 最近被注入召回的时间（T2.6） */
  lastRecalledAt: number | null;
  /** 累计被注入召回次数（T2.6） */
  recallCount: number;
  /** TTL：到期由 sweep 软删；null=永不过期（T2.6） */
  forgetAfter: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface MemoryRun {
  id: string;
  scope: MemoryScope | 'all';
  status: 'success' | 'failed' | 'skipped';
  summary: string;
  beforeCount: number | null;
  afterCount: number | null;
  modelName: string | null;
  createdAt: number;
}

export const CATEGORY_META: Record<MemoryCategory, { label: string; color: string }> = {
  preference: { label: '偏好习惯', color: 'bg-sky-100 text-sky-700' },
  fact: { label: '个人事实', color: 'bg-emerald-100 text-emerald-700' },
  requirement: { label: '要求约束', color: 'bg-amber-100 text-amber-700' },
  event: { label: '重要事件', color: 'bg-purple-100 text-purple-700' },
};

// ============================================================
// 记忆条目 CRUD
// ============================================================

interface Row {
  [key: string]: unknown;
}

function toEntry(r: Row): MemoryEntry {
  return {
    id: String(r.id),
    category: String(r.category) as MemoryCategory,
    title: String(r.title),
    content: String(r.content),
    source: String(r.source ?? 'manual') as MemorySource,
    scope: String(r.scope ?? 'chat') as MemoryScope,
    pinned: Number(r.pinned) === 1,
    tenantId: String(r.tenant_id),
    tenantMemberId: String(r.tenant_member_id),
    contextTeamId: (r.context_team_id as string | null) ?? null,
    version: Number(r.version),
    hlc: String(r.hlc),
    deletedAt: r.deleted_at === null || r.deleted_at === undefined ? null : Number(r.deleted_at),
    importance: r.importance === null || r.importance === undefined ? 0.5 : Number(r.importance),
    lastRecalledAt: r.last_recalled_at === null || r.last_recalled_at === undefined ? null : Number(r.last_recalled_at),
    recallCount: Number(r.recall_count ?? 0),
    forgetAfter: r.forget_after === null || r.forget_after === undefined ? null : Number(r.forget_after),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

export async function listMemories(
  category?: MemoryCategory,
  search?: string,
  /** 作用域过滤：单个 scope 或数组。不传=全部。编程会话传 ['chat','code']，普通会话传 'chat' */
  scope?: MemoryScope | MemoryScope[]
): Promise<MemoryEntry[]> {
  const { database, identity } = await getDb();
  let sql = 'SELECT * FROM memories';
  const args: (string | number)[] = [identity.tenantId, identity.tenantMemberId, identity.activeTeamId];
  const where: string[] = [
    'tenant_id = ?',
    'tenant_member_id = ?',
    '(context_team_id IS NULL OR context_team_id = ?)',
    'deleted_at IS NULL',
  ];
  if (category) {
    where.push('category = ?');
    args.push(category);
  }
  if (search?.trim()) {
    where.push('(title LIKE ? OR content LIKE ?)');
    args.push(`%${search}%`, `%${search}%`);
  }
  if (scope) {
    const scopes = Array.isArray(scope) ? scope : [scope];
    if (scopes.length === 1) {
      where.push('scope = ?');
      args.push(scopes[0]);
    } else if (scopes.length > 1) {
      where.push(`scope IN (${scopes.map(() => '?').join(',')})`);
      args.push(...scopes);
    }
  }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY pinned DESC, updated_at DESC';
  const result = await database.execute({ sql, args });
  return result.rows.map(toEntry);
}

export async function getMemory(id: string): Promise<MemoryEntry | null> {
  const { database, identity } = await getDb();
  const result = await database.execute({
    sql: `SELECT * FROM memories WHERE id = ? AND tenant_id = ? AND tenant_member_id = ?
      AND (context_team_id IS NULL OR context_team_id = ?) AND deleted_at IS NULL`,
    args: [id, identity.tenantId, identity.tenantMemberId, identity.activeTeamId],
  });
  const r = result.rows[0];
  return r ? toEntry(r as Row) : null;
}

export async function createMemory(input: {
  category?: MemoryCategory;
  title: string;
  content: string;
  source?: MemorySource;
  scope?: MemoryScope;
  /** TTL（T2.13）：到期由 sweep 软删；不传/null=永不过期 */
  forgetAfter?: number | null;
}): Promise<MemoryEntry> {
  const { database, identity } = await getDb();
  const id = newUlid();
  const now = Date.now();
  const cat = input.category ?? 'fact';
  const src = input.source ?? 'manual';
  const scope = input.scope ?? 'chat';
  const forgetAfter =
    typeof input.forgetAfter === 'number' && Number.isFinite(input.forgetAfter) ? input.forgetAfter : null;
  const hlc = nextHlc();
  await database.execute({
    sql: `INSERT INTO memories
      (id, category, title, content, source, scope, pinned, tenant_id, tenant_member_id, context_team_id,
       version, hlc, deleted_at, forget_after, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, NULL, 1, ?, NULL, ?, ?, ?)`,
    args: [
      id,
      cat,
      input.title,
      input.content,
      src,
      scope,
      identity.tenantId,
      identity.tenantMemberId,
      hlc,
      forgetAfter,
      now,
      now,
    ],
  });
  // T1.8 写路径挂钩：入队异步批量 embedding（入队即返回，不阻塞写路径）
  enqueueMemoryEmbedding(id, `${input.title}\n${input.content}`);
  // 个人记忆云备份：写路径脏标记（未启用/未登录时为空操作）
  markPersonalSyncDirty();
  return {
    id,
    category: cat,
    title: input.title,
    content: input.content,
    source: src,
    scope,
    pinned: false,
    tenantId: identity.tenantId,
    tenantMemberId: identity.tenantMemberId,
    contextTeamId: null,
    version: 1,
    hlc,
    deletedAt: null,
    importance: 0.5,
    lastRecalledAt: null,
    recallCount: 0,
    forgetAfter,
    createdAt: now,
    updatedAt: now,
  };
}

export async function updateMemory(
  id: string,
  patch: Partial<
    Pick<MemoryEntry, 'category' | 'title' | 'content' | 'pinned' | 'scope' | 'importance' | 'forgetAfter'>
  >,
  expectedVersion: number
): Promise<MemoryEntry> {
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) throw new Error('MEMORY_BASE_VERSION_REQUIRED');
  const { database, identity } = await getDb();
  const sets: string[] = [];
  const args: (string | number | null)[] = [];
  if (patch.category !== undefined) {
    sets.push('category = ?');
    args.push(patch.category);
  }
  if (patch.title !== undefined) {
    sets.push('title = ?');
    args.push(patch.title);
  }
  if (patch.content !== undefined) {
    sets.push('content = ?');
    args.push(patch.content);
  }
  if (patch.pinned !== undefined) {
    sets.push('pinned = ?');
    args.push(patch.pinned ? 1 : 0);
  }
  if (patch.scope !== undefined) {
    sets.push('scope = ?');
    args.push(patch.scope);
  }
  if (patch.importance !== undefined) {
    sets.push('importance = ?');
    args.push(Math.min(1, Math.max(0, patch.importance)));
  }
  if (patch.forgetAfter !== undefined) {
    sets.push('forget_after = ?');
    args.push(patch.forgetAfter);
  }
  if (sets.length === 0) {
    const current = await getMemory(id);
    if (!current) throw new Error('MEMORY_NOT_FOUND');
    return current;
  }
  const updatedAt = Date.now();
  const hlc = nextHlc();
  sets.push('updated_at = ?', 'hlc = ?', 'version = version + 1');
  args.push(updatedAt, hlc);
  args.push(id, identity.tenantId, identity.tenantMemberId, identity.activeTeamId, expectedVersion);
  const result = await database.execute({
    sql: `UPDATE memories SET ${sets.join(', ')} WHERE id = ? AND tenant_id = ? AND tenant_member_id = ?
      AND (context_team_id IS NULL OR context_team_id = ?) AND deleted_at IS NULL AND version = ?`,
    args,
  });
  if (result.rowsAffected === 0) {
    if (await getMemory(id)) throw new Error('MEMORY_VERSION_CONFLICT');
    throw new Error('MEMORY_NOT_FOUND');
  }
  const updated = (await getMemory(id))!;
  // T1.8 写路径挂钩：标题/内容变更后重算向量（consolidate apply 路径同走这里）
  enqueueMemoryEmbedding(updated.id, `${updated.title}\n${updated.content}`);
  markPersonalSyncDirty();
  // T3.4 图谱级联：编辑后旧实体溯源失效，从节点/边移除该记忆（fire-and-forget，不阻塞写路径；
  // 新一轮增量抽取会以新内容重新挂接）
  void import('./memory-graph.js').then((graph) => graph.removeMemoryFromGraph(id)).catch(() => {});
  return updated;
}

export async function deleteMemory(id: string, expectedVersion: number): Promise<MemoryEntry> {
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) throw new Error('MEMORY_BASE_VERSION_REQUIRED');
  const { database, identity } = await getDb();
  const deletedAt = Date.now();
  const hlc = nextHlc();
  const result = await database.execute({
    sql: `UPDATE memories SET deleted_at = ?, updated_at = ?, hlc = ?, version = version + 1
      WHERE id = ? AND tenant_id = ? AND tenant_member_id = ?
      AND (context_team_id IS NULL OR context_team_id = ?) AND deleted_at IS NULL AND version = ?`,
    args: [
      deletedAt,
      deletedAt,
      hlc,
      id,
      identity.tenantId,
      identity.tenantMemberId,
      identity.activeTeamId,
      expectedVersion,
    ],
  });
  if (result.rowsAffected === 0) {
    const row = await database.execute({
      sql: 'SELECT version, deleted_at FROM memories WHERE id = ? AND tenant_id = ? AND tenant_member_id = ?',
      args: [id, identity.tenantId, identity.tenantMemberId],
    });
    if (row.rows.length > 0) throw new Error('MEMORY_VERSION_CONFLICT');
    throw new Error('MEMORY_NOT_FOUND');
  }
  const row = await database.execute({ sql: 'SELECT * FROM memories WHERE id = ?', args: [id] });
  markPersonalSyncDirty();
  // T3.4 图谱级联：软删后从相关节点/边 source_memory_ids 移除该 id，空溯源标 stale
  // （fire-and-forget 动态 import，避免循环依赖且不阻塞写路径）
  void import('./memory-graph.js').then((graph) => graph.removeMemoryFromGraph(id)).catch(() => {});
  return toEntry(row.rows[0] as Row);
}

export async function countMemories(): Promise<number> {
  const { database, identity } = await getDb();
  const r = await database.execute({
    sql: `SELECT COUNT(*) as n FROM memories WHERE tenant_id = ? AND tenant_member_id = ?
      AND (context_team_id IS NULL OR context_team_id = ?) AND deleted_at IS NULL`,
    args: [identity.tenantId, identity.tenantMemberId, identity.activeTeamId],
  });
  return Number((r.rows[0] as Row)?.n ?? 0);
}

// ============================================================
// 召回访问记录（T2.6/T2.9）
// ============================================================

/** 访问时间戳环形缓冲容量（memory-retention 的 RETENTION.accessCap 引用此值） */
export const MEMORY_ACCESS_LOG_CAP = 20;

/**
 * 批量记录一批记忆被注入召回（T2.9）：last_recalled_at/recall_count + access_log，
 * 插入后按每条记忆裁剪到最近 MEMORY_ACCESS_LOG_CAP 条。只更新当前 owner 的活跃条目。
 */
export async function recordMemoryAccess(ids: string[], accessedAt = Date.now()): Promise<void> {
  const unique = [...new Set(ids)].filter(Boolean);
  if (unique.length === 0) return;
  const { database, identity } = await getDb();
  const placeholders = unique.map(() => '?').join(',');
  const ownerArgs = [identity.tenantId, identity.tenantMemberId, identity.activeTeamId];
  // 只回写当前 owner 的活跃条目（团队通道/他租户 id 一律忽略，连 access_log 也不写）
  const owned = await database.execute({
    sql: `SELECT id FROM memories WHERE id IN (${placeholders}) AND tenant_id = ? AND tenant_member_id = ?
      AND (context_team_id IS NULL OR context_team_id = ?) AND deleted_at IS NULL`,
    args: [...unique, ...ownerArgs],
  });
  const ownedIds = owned.rows.map((row) => String(row.id));
  if (ownedIds.length === 0) return;
  const ownedPlaceholders = ownedIds.map(() => '?').join(',');
  await database.execute({
    sql: `UPDATE memories SET last_recalled_at = ?, recall_count = recall_count + 1 WHERE id IN (${ownedPlaceholders})`,
    args: [accessedAt, ...ownedIds],
  });
  await database.batch(
    ownedIds.flatMap((id) => [
      { sql: 'INSERT INTO memory_access_log (memory_id, accessed_at) VALUES (?, ?)', args: [id, accessedAt] },
      {
        sql: `DELETE FROM memory_access_log WHERE memory_id = ? AND rowid NOT IN (
          SELECT rowid FROM memory_access_log WHERE memory_id = ? ORDER BY accessed_at DESC, rowid DESC LIMIT ?)`,
        args: [id, id, MEMORY_ACCESS_LOG_CAP],
      },
    ]),
    'write'
  );
}

/** 批量读取访问时间戳（T2.8 召回侧批量 IN 查询，避免 N+1）；返回按 accessed_at 倒序的时间戳数组 */
export async function listMemoryAccessLogs(ids: string[]): Promise<Map<string, number[]>> {
  const logs = new Map<string, number[]>();
  const unique = [...new Set(ids)].filter(Boolean);
  if (unique.length === 0) return logs;
  const { database } = await getDb();
  const placeholders = unique.map(() => '?').join(',');
  const result = await database.execute({
    sql: `SELECT memory_id, accessed_at FROM memory_access_log WHERE memory_id IN (${placeholders})
      ORDER BY accessed_at DESC`,
    args: unique,
  });
  for (const row of result.rows) {
    const id = String(row.memory_id);
    const list = logs.get(id) ?? [];
    if (list.length < MEMORY_ACCESS_LOG_CAP) list.push(Number(row.accessed_at));
    logs.set(id, list);
  }
  return logs;
}

// ============================================================
// 整理记录
// ============================================================

export async function listRuns(scope?: MemoryScope | 'all'): Promise<MemoryRun[]> {
  const { database, identity } = await getDb();
  const ownerArgs = [identity.tenantId, identity.tenantMemberId, identity.activeTeamId, identity.resourceId];
  const result = scope
    ? await database.execute({
        sql: `SELECT * FROM memory_runs WHERE tenant_id = ? AND tenant_member_id = ? AND active_team_id = ?
        AND resource_id = ? AND scope = ? ORDER BY created_at DESC LIMIT 50`,
        args: [...ownerArgs, scope],
      })
    : await database.execute({
        sql: `SELECT * FROM memory_runs WHERE tenant_id = ? AND tenant_member_id = ? AND active_team_id = ?
        AND resource_id = ? ORDER BY created_at DESC LIMIT 50`,
        args: ownerArgs,
      });
  return result.rows.map((r) => {
    const row = r as Row;
    return {
      id: String(row.id),
      scope: String(row.scope ?? 'all') as MemoryRun['scope'],
      status: String(row.status) as MemoryRun['status'],
      summary: String(row.summary ?? ''),
      beforeCount: row.before_count === null ? null : Number(row.before_count),
      afterCount: row.after_count === null ? null : Number(row.after_count),
      modelName: (row.model_name as string | null) ?? null,
      createdAt: Number(row.created_at),
    };
  });
}

export async function recordRun(run: Omit<MemoryRun, 'id' | 'createdAt'>): Promise<MemoryRun> {
  const { database, identity } = await getDb();
  const id = newUlid();
  const createdAt = Date.now();
  await database.execute({
    sql: `INSERT INTO memory_runs
      (id, scope, status, summary, before_count, after_count, model_name, tenant_id, tenant_member_id, active_team_id, resource_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      id,
      run.scope,
      run.status,
      run.summary,
      run.beforeCount ?? null,
      run.afterCount ?? null,
      run.modelName,
      identity.tenantId,
      identity.tenantMemberId,
      identity.activeTeamId,
      identity.resourceId,
      createdAt,
    ],
  });
  return { ...run, id, createdAt };
}
