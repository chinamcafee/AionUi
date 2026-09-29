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
          category_id TEXT,
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
      // 分类体系（2026-09-29）：category 枚举列 → category_id（种子分类 id 沿用旧枚举值，回填后删除旧列）
      await database.execute('ALTER TABLE memories ADD COLUMN category_id TEXT').catch(() => {});
      await database
        .execute('UPDATE memories SET category_id = category WHERE category_id IS NULL AND category IS NOT NULL')
        .catch(() => {});
      await database.execute('DROP INDEX IF EXISTS idx_memories_category').catch(() => {});
      await database.execute('ALTER TABLE memories DROP COLUMN category').catch(() => {});
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
      await database.execute(`CREATE INDEX IF NOT EXISTS idx_memories_category_id ON memories (category_id)`);
      await database.execute(`CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories (scope)`);
      await database.execute(
        'CREATE INDEX IF NOT EXISTS idx_memories_owner_scope ON memories (tenant_id, tenant_member_id, context_team_id, scope, updated_at DESC)'
      );
      // 可管理分类表：name 账号内唯一（应用层大小写归一判重，归档后释放名称）
      await database.execute(`
        CREATE TABLE IF NOT EXISTS memory_categories (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT,
          sort INTEGER NOT NULL DEFAULT 0,
          source TEXT NOT NULL DEFAULT 'manual',
          archived_at INTEGER,
          tenant_id TEXT,
          tenant_member_id TEXT,
          version INTEGER NOT NULL DEFAULT 1,
          hlc TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);
      const seedNow = Date.now();
      for (const seed of SEED_CATEGORIES) {
        await database.execute({
          sql: `INSERT OR IGNORE INTO memory_categories
            (id, name, description, sort, source, archived_at, tenant_id, tenant_member_id, version, hlc, created_at, updated_at)
            VALUES (?, ?, ?, ?, 'manual', NULL, ?, ?, 1, NULL, ?, ?)`,
          args: [
            seed.id,
            seed.name,
            seed.description,
            seed.sort,
            identity.tenantId,
            identity.tenantMemberId,
            seedNow,
            seedNow,
          ],
        });
      }
      await database.execute({
        sql: `UPDATE memory_categories SET tenant_id = ?, tenant_member_id = ?
          WHERE tenant_id IS NULL OR tenant_member_id IS NULL`,
        args: [identity.tenantId, identity.tenantMemberId],
      });
      await database.execute(
        'CREATE INDEX IF NOT EXISTS idx_memory_categories_owner ON memory_categories (tenant_id, tenant_member_id, sort, created_at)'
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

export type MemorySource = 'manual' | 'auto' | 'consolidated';
/** 记忆空间：chat=普通会话，code=编程会话独有 */
export type MemoryScope = 'chat' | 'code';
/** 分类来源：manual=用户手动创建；consolidated=整理时由模型新建（决策 D2） */
export type MemoryCategorySource = 'manual' | 'consolidated';

/** 「未分类」过滤值（listMemories 与路由层共用）：category_id IS NULL */
export const UNCATEGORIZED_FILTER = '__uncategorized__';

/** 分类上限与字段长度（决策 D5：分类 ≤500、名称 ≤20 字、说明 ≤200 字） */
export const MAX_MEMORY_CATEGORIES = 500;
export const MAX_CATEGORY_NAME_LENGTH = 20;
export const MAX_CATEGORY_DESCRIPTION_LENGTH = 200;

/**
 * 种子分类：id 沿用旧 category 枚举值（偏好/事实/要求/事件），
 * 使 retention 先验（CATEGORY_SALIENCE）与召回 semanticType 映射对种子继续有效。
 */
export const SEED_CATEGORIES: ReadonlyArray<{ id: string; name: string; description: string; sort: number }> = [
  { id: 'preference', name: '偏好习惯', description: '用户的偏好、习惯与常用做法', sort: 0 },
  { id: 'fact', name: '个人事实', description: '关于用户的稳定事实（身份、关系、背景）', sort: 1 },
  { id: 'requirement', name: '要求约束', description: '用户对协作方式与输出格式的要求、约束', sort: 2 },
  { id: 'event', name: '重要事件', description: '对用户有长期意义的事件', sort: 3 },
];

/** 可管理分类（个人记忆的归档维度；不参与召回） */
export interface MemoryCategoryEntry {
  id: string;
  name: string;
  description: string | null;
  sort: number;
  source: MemoryCategorySource;
  archivedAt: number | null;
  version: number;
  hlc: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface MemoryEntry {
  id: string;
  /** 分类 id；null=未分类 */
  categoryId: string | null;
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

// ============================================================
// 记忆条目 CRUD
// ============================================================

interface Row {
  [key: string]: unknown;
}

function toEntry(r: Row): MemoryEntry {
  return {
    id: String(r.id),
    categoryId: r.category_id === null || r.category_id === undefined ? null : String(r.category_id),
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
  /** 分类过滤：分类 id、UNCATEGORIZED_FILTER（未分类）或 undefined（全部） */
  categoryId?: string,
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
  if (categoryId === UNCATEGORIZED_FILTER) {
    where.push('category_id IS NULL');
  } else if (categoryId) {
    where.push('category_id = ?');
    args.push(categoryId);
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
  /** 分类 id（null=未分类）；与 categoryName 同时给出时以 categoryId 为准 */
  categoryId?: string | null;
  /** 分类名（按名解析为 id，未命中落未分类；供 <memorize> 协议与兜底抽取使用） */
  categoryName?: string;
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
  const categoryId = await resolveMemoryCategoryRef({
    categoryId: input.categoryId,
    categoryName: input.categoryName,
  });
  const src = input.source ?? 'manual';
  const scope = input.scope ?? 'chat';
  const forgetAfter =
    typeof input.forgetAfter === 'number' && Number.isFinite(input.forgetAfter) ? input.forgetAfter : null;
  const hlc = nextHlc();
  await database.execute({
    sql: `INSERT INTO memories
      (id, category_id, title, content, source, scope, pinned, tenant_id, tenant_member_id, context_team_id,
       version, hlc, deleted_at, forget_after, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, NULL, 1, ?, NULL, ?, ?, ?)`,
    args: [
      id,
      categoryId,
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
    categoryId,
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
    Pick<MemoryEntry, 'categoryId' | 'title' | 'content' | 'pinned' | 'scope' | 'importance' | 'forgetAfter'>
  >,
  expectedVersion: number
): Promise<MemoryEntry> {
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) throw new Error('MEMORY_BASE_VERSION_REQUIRED');
  const { database, identity } = await getDb();
  const sets: string[] = [];
  const args: (string | number | null)[] = [];
  if (patch.categoryId !== undefined) {
    if (patch.categoryId !== null) await assertMemoryCategoryActive(patch.categoryId);
    sets.push('category_id = ?');
    args.push(patch.categoryId);
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
// 分类 CRUD（2026-09-29；决策 D1 单轴 / D3 id 引用与归档式删除 / D5 上限）
// ============================================================

function toCategory(r: Row): MemoryCategoryEntry {
  return {
    id: String(r.id),
    name: String(r.name),
    description: r.description === null || r.description === undefined ? null : String(r.description),
    sort: Number(r.sort ?? 0),
    source: String(r.source ?? 'manual') as MemoryCategorySource,
    archivedAt: r.archived_at === null || r.archived_at === undefined ? null : Number(r.archived_at),
    version: Number(r.version ?? 1),
    hlc: r.hlc === null || r.hlc === undefined ? null : String(r.hlc),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

function normalizeCategoryName(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ');
}

export async function listMemoryCategories(
  options: { includeArchived?: boolean } = {}
): Promise<MemoryCategoryEntry[]> {
  const { database, identity } = await getDb();
  const where = ['tenant_id = ?', 'tenant_member_id = ?'];
  if (!options.includeArchived) where.push('archived_at IS NULL');
  const result = await database.execute({
    sql: `SELECT * FROM memory_categories WHERE ${where.join(' AND ')} ORDER BY sort ASC, created_at ASC`,
    args: [identity.tenantId, identity.tenantMemberId],
  });
  return result.rows.map(toCategory);
}

export async function getMemoryCategory(id: string): Promise<MemoryCategoryEntry | null> {
  const { database, identity } = await getDb();
  const result = await database.execute({
    sql: 'SELECT * FROM memory_categories WHERE id = ? AND tenant_id = ? AND tenant_member_id = ?',
    args: [id, identity.tenantId, identity.tenantMemberId],
  });
  const r = result.rows[0];
  return r ? toCategory(r as Row) : null;
}

/** 按名称查找活跃分类（trim + 空白归一后大小写不敏感精确匹配） */
export async function findMemoryCategoryByName(name: string): Promise<MemoryCategoryEntry | null> {
  const normalized = normalizeCategoryName(name).toLowerCase();
  if (!normalized) return null;
  const active = await listMemoryCategories();
  return active.find((category) => category.name.toLowerCase() === normalized) ?? null;
}

async function assertMemoryCategoryActive(id: string): Promise<void> {
  const category = await getMemoryCategory(id);
  if (!category || category.archivedAt !== null) throw new Error('CATEGORY_NOT_FOUND');
}

/** 解析分类引用：categoryId 优先（校验存在且未归档）；否则按 categoryName 解析（未命中→未分类） */
export async function resolveMemoryCategoryRef(input: {
  categoryId?: string | null;
  categoryName?: string;
}): Promise<string | null> {
  if (typeof input.categoryId === 'string' && input.categoryId.trim()) {
    const id = input.categoryId.trim();
    await assertMemoryCategoryActive(id);
    return id;
  }
  if (typeof input.categoryName === 'string' && input.categoryName.trim()) {
    const found = await findMemoryCategoryByName(input.categoryName);
    return found ? found.id : null;
  }
  return null;
}

export async function createMemoryCategory(input: {
  name: string;
  description?: string | null;
  source?: MemoryCategorySource;
}): Promise<MemoryCategoryEntry> {
  const { database, identity } = await getDb();
  const name = normalizeCategoryName(input.name ?? '');
  if (!name || name.length > MAX_CATEGORY_NAME_LENGTH) throw new Error('CATEGORY_NAME_INVALID');
  const description = input.description?.trim()
    ? input.description.trim().slice(0, MAX_CATEGORY_DESCRIPTION_LENGTH)
    : null;
  const total = await database.execute({
    sql: 'SELECT COUNT(*) AS n FROM memory_categories WHERE tenant_id = ? AND tenant_member_id = ?',
    args: [identity.tenantId, identity.tenantMemberId],
  });
  if (Number((total.rows[0] as Row)?.n ?? 0) >= MAX_MEMORY_CATEGORIES) throw new Error('CATEGORY_LIMIT_REACHED');
  if (await findMemoryCategoryByName(name)) throw new Error('CATEGORY_NAME_DUPLICATE');
  const maxSort = await database.execute({
    sql: 'SELECT COALESCE(MAX(sort), -1) AS n FROM memory_categories WHERE tenant_id = ? AND tenant_member_id = ?',
    args: [identity.tenantId, identity.tenantMemberId],
  });
  const id = newUlid();
  const now = Date.now();
  const hlc = nextHlc();
  const sort = Number((maxSort.rows[0] as Row)?.n ?? -1) + 1;
  await database.execute({
    sql: `INSERT INTO memory_categories
      (id, name, description, sort, source, archived_at, tenant_id, tenant_member_id, version, hlc, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, NULL, ?, ?, 1, ?, ?, ?)`,
    args: [
      id,
      name,
      description,
      sort,
      input.source ?? 'manual',
      identity.tenantId,
      identity.tenantMemberId,
      hlc,
      now,
      now,
    ],
  });
  markPersonalSyncDirty();
  return {
    id,
    name,
    description,
    sort,
    source: input.source ?? 'manual',
    archivedAt: null,
    version: 1,
    hlc,
    createdAt: now,
    updatedAt: now,
  };
}

export async function updateMemoryCategory(
  id: string,
  patch: { name?: string; description?: string | null; sort?: number },
  expectedVersion: number
): Promise<MemoryCategoryEntry> {
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) throw new Error('CATEGORY_VERSION_CONFLICT');
  const { database, identity } = await getDb();
  const sets: string[] = [];
  const args: (string | number | null)[] = [];
  if (patch.name !== undefined) {
    const name = normalizeCategoryName(patch.name);
    if (!name || name.length > MAX_CATEGORY_NAME_LENGTH) throw new Error('CATEGORY_NAME_INVALID');
    const duplicate = await findMemoryCategoryByName(name);
    if (duplicate && duplicate.id !== id) throw new Error('CATEGORY_NAME_DUPLICATE');
    sets.push('name = ?');
    args.push(name);
  }
  if (patch.description !== undefined) {
    sets.push('description = ?');
    args.push(patch.description?.trim() ? patch.description.trim().slice(0, MAX_CATEGORY_DESCRIPTION_LENGTH) : null);
  }
  if (patch.sort !== undefined) {
    sets.push('sort = ?');
    args.push(Number.isFinite(patch.sort) ? Math.trunc(patch.sort) : 0);
  }
  if (sets.length === 0) {
    const current = await getMemoryCategory(id);
    if (!current || current.archivedAt !== null) throw new Error('CATEGORY_NOT_FOUND');
    return current;
  }
  const updatedAt = Date.now();
  const hlc = nextHlc();
  sets.push('updated_at = ?', 'hlc = ?', 'version = version + 1');
  args.push(updatedAt, hlc);
  args.push(id, identity.tenantId, identity.tenantMemberId, expectedVersion);
  const result = await database.execute({
    sql: `UPDATE memory_categories SET ${sets.join(', ')}
      WHERE id = ? AND tenant_id = ? AND tenant_member_id = ? AND archived_at IS NULL AND version = ?`,
    args,
  });
  if (result.rowsAffected === 0) {
    if (await getMemoryCategory(id)) throw new Error('CATEGORY_VERSION_CONFLICT');
    throw new Error('CATEGORY_NOT_FOUND');
  }
  markPersonalSyncDirty();
  return (await getMemoryCategory(id))!;
}

/**
 * 归档式删除（决策 D3）：先校验版本 → 归档分类（软删，名称释放）→ 把引用该分类的记忆
 * 迁往 reassignTo（null=未分类），每条记忆 version+1 并刷新 HLC，供同步按序应用。
 */
export async function archiveMemoryCategory(
  id: string,
  expectedVersion: number,
  reassignTo: string | null
): Promise<{ reassigned: number }> {
  const { database, identity } = await getDb();
  const category = await getMemoryCategory(id);
  if (!category || category.archivedAt !== null) throw new Error('CATEGORY_NOT_FOUND');
  if (reassignTo !== null) {
    if (reassignTo === id) throw new Error('CATEGORY_REASSIGN_INVALID');
    await assertMemoryCategoryActive(reassignTo);
  }
  const now = Date.now();
  const hlc = nextHlc();
  const archived = await database.execute({
    sql: `UPDATE memory_categories SET archived_at = ?, version = version + 1, hlc = ?, updated_at = ?
      WHERE id = ? AND tenant_id = ? AND tenant_member_id = ? AND archived_at IS NULL AND version = ?`,
    args: [now, hlc, now, id, identity.tenantId, identity.tenantMemberId, expectedVersion],
  });
  if (archived.rowsAffected === 0) throw new Error('CATEGORY_VERSION_CONFLICT');
  const moved = await database.execute({
    sql: `UPDATE memories SET category_id = ?, version = version + 1, hlc = ?, updated_at = ?
      WHERE category_id = ? AND tenant_id = ? AND tenant_member_id = ?`,
    args: [reassignTo, hlc, now, id, identity.tenantId, identity.tenantMemberId],
  });
  markPersonalSyncDirty();
  return { reassigned: moved.rowsAffected };
}

/** 各分类引用计数（key '' = 未分类）；供 UI 展示与整理提示词按使用量排序 */
export async function countMemoriesByCategory(): Promise<Map<string, number>> {
  const { database, identity } = await getDb();
  const result = await database.execute({
    sql: `SELECT COALESCE(category_id, '') AS category_id, COUNT(*) AS n FROM memories
      WHERE tenant_id = ? AND tenant_member_id = ? AND (context_team_id IS NULL OR context_team_id = ?) AND deleted_at IS NULL
      GROUP BY COALESCE(category_id, '')`,
    args: [identity.tenantId, identity.tenantMemberId, identity.activeTeamId],
  });
  const counts = new Map<string, number>();
  for (const row of result.rows) counts.set(String(row.category_id), Number(row.n ?? 0));
  return counts;
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
