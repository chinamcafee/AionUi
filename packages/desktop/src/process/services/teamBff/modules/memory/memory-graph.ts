/**
 * 个人记忆图谱（T3.2–T3.7，04 章 §5 路径 A：LibSQL 轻量图谱）。
 *
 * - 存储：memory_graph_nodes / memory_graph_edges（schema 见 memory-store.ts T3.1），与 memories 同 owner 隔离。
 * - 抽取：XML 格式 + 正则解析（借鉴 agentmemory，对弱模型宽容）；LLM 用「模型绑定」memory 场景模型。
 * - 写入：幂等合并——节点按 (type,name) 查唯一索引合并溯源，边按 (source,target,type) 查重仅追加溯源。
 * - 级联：记忆软删/编辑时 removeMemoryFromGraph 移除溯源，空溯源节点/边标 stale。
 * - 召回：graphRecall(query) = query 实体提取（规则版）→ 种子双向 includes 匹配 → 应用层 BFS（maxDepth=2，
 *   邻接表一次批量 SQL 读出，禁止 N+1）→ score = avgEdgeWeight × (1/pathLength)，种子直命中 1.0。
 *
 * 规模假设：个人记忆 ≤ 5k 条、节点 ≤ 10k——全量邻接表内存 BFS < 50ms，无需索引结构与 ANN。
 */
import { generateText } from 'ai';
import { newUlid } from '../shared/ids.js';
import { accountRuntime } from './account-runtime.js';
import { getMemoryStoreContext, listMemories } from './memory-store.js';
import { getMemoryModel } from './memory-model-util.js';

// ============================================================
// 类型与常量
// ============================================================

/** 实体类型（裁剪版：去掉 file/function/error 等编码类） */
export const GRAPH_ENTITY_TYPES = ['person', 'organization', 'project', 'concept', 'event', 'product'] as const;
export type GraphEntityType = (typeof GRAPH_ENTITY_TYPES)[number];
/** 关系类型（裁剪版） */
export const GRAPH_RELATION_TYPES = [
  'related_to',
  'works_at',
  'prefers',
  'uses',
  'causes',
  'depends_on',
  'part_of',
] as const;
export type GraphRelationType = (typeof GRAPH_RELATION_TYPES)[number];

export interface ExtractedEntity {
  type: GraphEntityType;
  name: string;
  properties: Record<string, string>;
}

export interface ExtractedRelationship {
  type: GraphRelationType;
  source: string;
  target: string;
  /** 0-1，解析失败默认 0.5 并 clamp */
  weight: number;
}

export interface GraphExtraction {
  entities: ExtractedEntity[];
  relationships: ExtractedRelationship[];
}

export interface GraphNodeRow {
  id: string;
  type: string;
  name: string;
  sourceMemoryIds: string[];
}

/** BFS 命中：memoryId → 分数与溯源路径（路径为种子到挂载节点的实体名序列） */
export interface GraphRecallHit {
  score: number;
  viaPath: string[];
}

/** BFS 最大跳数（04 章 §5.3） */
const MAX_DEPTH = 2;
/** 节点名缓存 TTL：千级规模内存匹配，按 generation 缓存（T3.6） */
const NODE_CACHE_TTL_MS = 2_000;

interface NodeCacheEntry {
  at: number;
  nodes: GraphNodeRow[];
}
const nodeCache = new Map<number, NodeCacheEntry>();
accountRuntime.registerCacheInvalidator(() => {
  nodeCache.clear();
});

// ============================================================
// T3.2 XML 实体抽取（prompt + 正则解析）
// ============================================================

const GRAPH_EXTRACTION_PROMPT = (
  text: string
) => `你是知识图谱抽取器。从下面的记忆文本中抽取实体与关系，只输出 XML，不要输出任何其他内容。

实体类型（type 属性只能取其一）：person（人物）、organization（组织/公司）、project（项目）、concept（概念/技术）、event（事件）、product（产品）。
关系类型（type 属性只能取其一）：related_to（相关）、works_at（任职于）、prefers（偏好）、uses（使用）、causes（导致）、depends_on（依赖于）、part_of（属于/组成部分）。

输出格式：
<entity type="person" name="张总">
  <property key="role">总经理</property>
</entity>
<relationship type="works_at" source="张总" target="闻川科技" weight="0.9"/>

规则：
- 每个实体一个 <entity> 块，name 用文本中的原始称谓；<property> 可选，key 自定义。
- 每条关系一个自闭合 <relationship/>，source/target 必须是已抽取实体的 name，weight 为 0-1 的置信度（不确定可省略）。
- 只抽取文本中明确存在的信息，不要臆造；没有可抽取内容时不输出任何标签。

记忆文本：
${text}`;

/** 解析 XML 标签属性：不假设属性顺序，未识别的属性忽略 */
function parseAttrs(attrText: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const match of attrText.matchAll(/([\w-]+)\s*=\s*"([^"]*)"/g)) {
    attrs[match[1]!] = match[2] ?? '';
  }
  return attrs;
}

/** weight 解析：parseFloat 失败 → 0.5，clamp [0,1] */
function parseWeight(raw: string | undefined): number {
  const parsed = raw === undefined ? Number.NaN : Number.parseFloat(raw);
  if (!Number.isFinite(parsed)) return 0.5;
  return Math.min(1, Math.max(0, parsed));
}

function isEntityType(value: string): value is GraphEntityType {
  return (GRAPH_ENTITY_TYPES as readonly string[]).includes(value);
}

function isRelationType(value: string): value is GraphRelationType {
  return (GRAPH_RELATION_TYPES as readonly string[]).includes(value);
}

/**
 * 解析 LLM 输出的图谱 XML（T3.2）。
 * 容错：容忍 markdown 围栏（```xml）与标签外的杂文本；不假设属性顺序；
 * 非法 type / 缺 name / 缺端点的条目录入跳过，不抛错。
 */
export function parseGraphExtractionXml(raw: string): GraphExtraction {
  // 去掉 markdown 代码围栏与行首行尾空白（容忍 ```xml ... ``` 包裹）
  const text = raw.replace(/```[a-zA-Z]*\s*/g, '').replace(/`\s*/g, '');
  const entities: ExtractedEntity[] = [];
  const relationships: ExtractedRelationship[] = [];

  for (const match of text.matchAll(/<entity\b([^>]*)>([\s\S]*?)<\/entity>/g)) {
    const attrs = parseAttrs(match[1] ?? '');
    const name = (attrs.name ?? '').trim();
    if (!name || !isEntityType(attrs.type ?? '')) continue;
    const properties: Record<string, string> = {};
    const body = match[2] ?? '';
    // 同时容忍自闭合 <property key="k" value="v"/> 与成对 <property key="k">v</property>
    for (const prop of body.matchAll(/<property\b([^>]*?)\/>/g)) {
      const propAttrs = parseAttrs(prop[1] ?? '');
      if (propAttrs.key) properties[propAttrs.key] = propAttrs.value ?? '';
    }
    for (const prop of body.matchAll(/<property\b([^>]*)>([\s\S]*?)<\/property>/g)) {
      const propAttrs = parseAttrs(prop[1] ?? '');
      if (propAttrs.key) properties[propAttrs.key] = (prop[2] ?? '').trim();
    }
    entities.push({ type: attrs.type as GraphEntityType, name, properties });
  }

  for (const match of text.matchAll(/<relationship\b([^>]*?)\/>/g)) {
    const attrs = parseAttrs(match[1] ?? '');
    const source = (attrs.source ?? '').trim();
    const target = (attrs.target ?? '').trim();
    if (!source || !target || !isRelationType(attrs.type ?? '')) continue;
    relationships.push({ type: attrs.type as GraphRelationType, source, target, weight: parseWeight(attrs.weight) });
  }

  return { entities, relationships };
}

/**
 * 调「模型绑定」memory 场景 LLM 抽取一段记忆文本的实体/关系（T3.2）。
 * 未绑定模型或调用失败时抛错，由调用方按「不阻断」策略兜底。
 */
export async function extractGraphFromText(text: string): Promise<GraphExtraction> {
  const { model } = await getMemoryModel();
  const result = await generateText({ model, prompt: GRAPH_EXTRACTION_PROMPT(text) });
  return parseGraphExtractionXml(result.text);
}

// ============================================================
// 内部 DB 辅助
// ============================================================

type GraphDatabase = Awaited<ReturnType<typeof getMemoryStoreContext>>['database'];

function parseIdArray(raw: unknown): string[] {
  try {
    const parsed = JSON.parse(String(raw ?? '[]')) as unknown;
    return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function invalidateNodeCache(): void {
  nodeCache.delete(accountRuntime.currentGeneration());
}

/** 加载当前 owner 的全部活跃节点（千级规模 < 1MB；按 generation 短 TTL 缓存，T3.6） */
async function loadActiveNodes(
  database: GraphDatabase,
  tenantId: string,
  tenantMemberId: string
): Promise<GraphNodeRow[]> {
  const generation = accountRuntime.currentGeneration();
  const cached = nodeCache.get(generation);
  if (cached && Date.now() - cached.at < NODE_CACHE_TTL_MS) return cached.nodes;
  const result = await database.execute({
    sql: `SELECT id, type, name, source_memory_ids FROM memory_graph_nodes
      WHERE tenant_id = ? AND tenant_member_id = ? AND stale = 0`,
    args: [tenantId, tenantMemberId],
  });
  const nodes = result.rows.map((row) => ({
    id: String(row.id),
    type: String(row.type),
    name: String(row.name),
    sourceMemoryIds: parseIdArray(row.source_memory_ids),
  }));
  nodeCache.set(generation, { at: Date.now(), nodes });
  return nodes;
}

// ============================================================
// T3.3 幂等合并 upsert
// ============================================================

/**
 * 把一次抽取结果并入图谱（幂等）。
 * - 节点按 (type,name) 查唯一索引：存在则合并 source_memory_ids（Set 去重）+ properties 浅合并 + stale 复位；
 * - 边按 (source_node,target_node,type) 查重：存在仅追加溯源（weight 保持首次值），不存在才插入。
 * - 关系端点按 name 解析：优先本轮抽取的实体，其次库内已有节点（同 owner 按 name 查）。
 */
export async function mergeGraphExtraction(
  extraction: GraphExtraction,
  sourceMemoryId: string
): Promise<{ nodes: number; edges: number }> {
  const { database, identity } = await getMemoryStoreContext();
  const now = Date.now();
  let nodeCount = 0;
  let edgeCount = 0;
  // name → nodeId（本轮抽取实体优先；同名跨类型时以先出现者为准，供关系端点解析）
  const nodeIdByName = new Map<string, string>();

  for (const entity of extraction.entities) {
    const found = await database.execute({
      sql: `SELECT id, properties, source_memory_ids FROM memory_graph_nodes
        WHERE tenant_id = ? AND tenant_member_id = ? AND type = ? AND name = ?`,
      args: [identity.tenantId, identity.tenantMemberId, entity.type, entity.name],
    });
    const existing = found.rows[0];
    if (existing) {
      const mergedSources = [...new Set([...parseIdArray(existing.source_memory_ids), sourceMemoryId])];
      const mergedProps = {
        ...(JSON.parse(String(existing.properties ?? '{}')) as Record<string, string>),
        ...entity.properties,
      };
      await database.execute({
        sql: `UPDATE memory_graph_nodes SET properties = ?, source_memory_ids = ?, stale = 0, updated_at = ? WHERE id = ?`,
        args: [JSON.stringify(mergedProps), JSON.stringify(mergedSources), now, String(existing.id)],
      });
      if (!nodeIdByName.has(entity.name)) nodeIdByName.set(entity.name, String(existing.id));
    } else {
      const id = newUlid();
      await database.execute({
        sql: `INSERT INTO memory_graph_nodes
          (id, tenant_id, tenant_member_id, type, name, properties, source_memory_ids, stale, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
        args: [
          id,
          identity.tenantId,
          identity.tenantMemberId,
          entity.type,
          entity.name,
          JSON.stringify(entity.properties),
          JSON.stringify([sourceMemoryId]),
          now,
          now,
        ],
      });
      if (!nodeIdByName.has(entity.name)) nodeIdByName.set(entity.name, id);
      nodeCount += 1;
    }
  }

  /** 关系端点解析：本轮实体优先，库内同名活跃节点兜底（找不到则跳过该边，不臆造端点） */
  const resolveNodeId = async (name: string): Promise<string | null> => {
    const local = nodeIdByName.get(name);
    if (local) return local;
    const found = await database.execute({
      sql: `SELECT id FROM memory_graph_nodes WHERE tenant_id = ? AND tenant_member_id = ? AND name = ? AND stale = 0 LIMIT 1`,
      args: [identity.tenantId, identity.tenantMemberId, name],
    });
    const id = found.rows[0] ? String(found.rows[0].id) : null;
    if (id) nodeIdByName.set(name, id);
    return id;
  };

  for (const rel of extraction.relationships) {
    const sourceId = await resolveNodeId(rel.source);
    const targetId = await resolveNodeId(rel.target);
    if (!sourceId || !targetId) continue;
    const found = await database.execute({
      sql: `SELECT id, source_memory_ids FROM memory_graph_edges
        WHERE tenant_id = ? AND tenant_member_id = ? AND source_node_id = ? AND target_node_id = ? AND type = ?`,
      args: [identity.tenantId, identity.tenantMemberId, sourceId, targetId, rel.type],
    });
    const existing = found.rows[0];
    if (existing) {
      const mergedSources = parseIdArray(existing.source_memory_ids);
      if (mergedSources.includes(sourceMemoryId)) continue;
      mergedSources.push(sourceMemoryId);
      await database.execute({
        sql: `UPDATE memory_graph_edges SET source_memory_ids = ?, stale = 0, updated_at = ? WHERE id = ?`,
        args: [JSON.stringify(mergedSources), now, String(existing.id)],
      });
    } else {
      await database.execute({
        sql: `INSERT INTO memory_graph_edges
          (id, tenant_id, tenant_member_id, type, source_node_id, target_node_id, weight, source_memory_ids, stale, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
        args: [
          newUlid(),
          identity.tenantId,
          identity.tenantMemberId,
          rel.type,
          sourceId,
          targetId,
          rel.weight,
          JSON.stringify([sourceMemoryId]),
          now,
          now,
        ],
      });
      edgeCount += 1;
    }
  }

  invalidateNodeCache();
  return { nodes: nodeCount, edges: edgeCount };
}

// ============================================================
// T3.4 记忆删除/更新级联清理
// ============================================================

/**
 * 从图谱中移除一条记忆的溯源：相关节点/边的 source_memory_ids 去掉该 id，
 * 溯源清空的节点/边标 stale（保留行供审计，召回侧只读 stale=0）。
 * 由 memory-store 的 deleteMemory/updateMemory fire-and-forget 调用，失败不阻塞写路径。
 */
export async function removeMemoryFromGraph(memoryId: string): Promise<void> {
  const { database, identity } = await getMemoryStoreContext();
  const now = Date.now();
  const pattern = `%"${memoryId.replaceAll('"', '')}"%`;
  const ownerArgs = [identity.tenantId, identity.tenantMemberId];

  const nodes = await database.execute({
    sql: `SELECT id, source_memory_ids FROM memory_graph_nodes
      WHERE tenant_id = ? AND tenant_member_id = ? AND stale = 0 AND source_memory_ids LIKE ?`,
    args: [...ownerArgs, pattern],
  });
  for (const row of nodes.rows) {
    const remaining = parseIdArray(row.source_memory_ids).filter((id) => id !== memoryId);
    await database.execute({
      sql: `UPDATE memory_graph_nodes SET source_memory_ids = ?, stale = ?, updated_at = ? WHERE id = ?`,
      args: [JSON.stringify(remaining), remaining.length === 0 ? 1 : 0, now, String(row.id)],
    });
  }

  const edges = await database.execute({
    sql: `SELECT id, source_memory_ids FROM memory_graph_edges
      WHERE tenant_id = ? AND tenant_member_id = ? AND stale = 0 AND source_memory_ids LIKE ?`,
    args: [...ownerArgs, pattern],
  });
  for (const row of edges.rows) {
    const remaining = parseIdArray(row.source_memory_ids).filter((id) => id !== memoryId);
    await database.execute({
      sql: `UPDATE memory_graph_edges SET source_memory_ids = ?, stale = ?, updated_at = ? WHERE id = ?`,
      args: [JSON.stringify(remaining), remaining.length === 0 ? 1 : 0, now, String(row.id)],
    });
  }

  invalidateNodeCache();
}

// ============================================================
// T3.5 增量抽取（consolidation 完成后挂钩）
// ============================================================

/**
 * 对「新增/版本变更」的记忆做增量实体抽取（水位 = memory_graph_state 记录的已抽取版本）。
 * 单条失败不阻断整体；返回处理统计供调用方记日志。 deleted 记忆的水位行顺带清理。
 */
export async function runIncrementalGraphExtraction(): Promise<{ processed: number; failed: number }> {
  const { database, identity } = await getMemoryStoreContext();
  const memories = await listMemories();
  const states = await database.execute('SELECT memory_id, version FROM memory_graph_state');
  const extractedVersions = new Map(states.rows.map((row) => [String(row.memory_id), Number(row.version)]));
  const activeIds = new Set(memories.map((memory) => memory.id));
  const pending = memories.filter((memory) => extractedVersions.get(memory.id) !== memory.version);

  let processed = 0;
  let failed = 0;
  for (const memory of pending) {
    try {
      const extraction = await extractGraphFromText(`${memory.title}\n${memory.content}`);
      await mergeGraphExtraction(extraction, memory.id);
      await database.execute({
        sql: `INSERT INTO memory_graph_state (memory_id, version) VALUES (?, ?)
          ON CONFLICT(memory_id) DO UPDATE SET version = excluded.version`,
        args: [memory.id, memory.version],
      });
      processed += 1;
    } catch {
      // 单条抽取失败（模型不可用/输出不可解析）不阻断整理任务，下一轮水位未到会重试
      failed += 1;
    }
  }
  // 清理已删除记忆的水位行（幂等维护，数量级同记忆条数）
  for (const id of extractedVersions.keys()) {
    if (!activeIds.has(id)) {
      await database.execute({ sql: 'DELETE FROM memory_graph_state WHERE memory_id = ?', args: [id] });
    }
  }
  return { processed, failed };
}

// ============================================================
// T3.6 query 实体提取（规则版）
// ============================================================

/**
 * 规则版 query 实体提取（T3.6；LLM 版预留不实现）：
 * 1. 引号短语（中文「」/“” 与英文 "" '' 包裹的片段）；
 * 2. 库内节点名表匹配——节点名在 query 中出现即视为实体提及（千级规模内存匹配）。
 * 返回去重后的候选实体名（保序）。
 */
export function extractQueryEntities(query: string, knownNodeNames: string[]): string[] {
  const entities: string[] = [];
  const push = (value: string) => {
    const trimmed = value.trim();
    if (trimmed && !entities.includes(trimmed)) entities.push(trimmed);
  };
  for (const match of query.matchAll(/[「"“']([^「」"“”'’]{1,64}?)[」"”'’]/g)) {
    push(match[1] ?? '');
  }
  for (const name of knownNodeNames) {
    if (name.length >= 2 && query.includes(name)) push(name);
  }
  return entities;
}

// ============================================================
// T3.7 BFS 召回与路径打分
// ============================================================

/**
 * 图谱召回（T3.7）：种子节点 name 双向 includes 模糊匹配 → 应用层 BFS（maxDepth=2，
 * 邻接表一次批量 SQL 读出，禁止 N+1）→ score = avgEdgeWeight × (1/pathLength)，种子直命中 1.0。
 * 同一 memoryId 多路径命中取最高分。返回 memoryId → {score, viaPath}，按分数降序截 limit。
 * 任何内部失败返回空 Map（图谱是增强流，不阻断主检索）。
 */
export async function graphRecall(query: string, limit = 20): Promise<Map<string, GraphRecallHit>> {
  const hits = new Map<string, GraphRecallHit>();
  try {
    const trimmed = query.trim();
    if (!trimmed) return hits;
    const { database, identity } = await getMemoryStoreContext();
    const nodes = await loadActiveNodes(database, identity.tenantId, identity.tenantMemberId);
    if (nodes.length === 0) return hits;

    const entities = extractQueryEntities(
      trimmed,
      nodes.map((node) => node.name)
    );
    if (entities.length === 0) return hits;
    // 种子：双向 includes 模糊匹配（借鉴 agentmemory）
    const lowered = entities.map((entity) => entity.toLowerCase());
    const seeds = nodes.filter((node) => {
      const name = node.name.toLowerCase();
      return lowered.some((entity) => name.includes(entity) || entity.includes(name));
    });
    if (seeds.length === 0) return hits;

    // 邻接表一次批量读出（当前 owner 全部活跃边，千级规模全量 < 1MB）
    const edgeRows = await database.execute({
      sql: `SELECT source_node_id, target_node_id, weight FROM memory_graph_edges
        WHERE tenant_id = ? AND tenant_member_id = ? AND stale = 0`,
      args: [identity.tenantId, identity.tenantMemberId],
    });
    const adjacency = new Map<string, Array<{ other: string; weight: number }>>();
    const link = (from: string, to: string, weight: number) => {
      const list = adjacency.get(from) ?? [];
      list.push({ other: to, weight });
      adjacency.set(from, list);
    };
    for (const row of edgeRows.rows) {
      const source = String(row.source_node_id);
      const target = String(row.target_node_id);
      const weight = Number.isFinite(Number(row.weight)) ? Number(row.weight) : 0.5;
      link(source, target, weight); // 无向遍历：关系有方向但召回沿关联双向扩展
      link(target, source, weight);
    }

    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    // BFS：best[nodeId] = { depth, weightSum, path }（weightSum 用于算 avgEdgeWeight）
    const best = new Map<string, { depth: number; weightSum: number; path: string[] }>();
    let frontier: string[] = [];
    for (const seed of seeds) {
      best.set(seed.id, { depth: 0, weightSum: 0, path: [seed.name] });
      frontier.push(seed.id);
    }
    for (let depth = 1; depth <= MAX_DEPTH && frontier.length > 0; depth += 1) {
      const next: string[] = [];
      for (const nodeId of frontier) {
        const from = best.get(nodeId)!;
        for (const edge of adjacency.get(nodeId) ?? []) {
          const existing = best.get(edge.other);
          // 更浅深度已访问过的节点（含种子）不允许被更深路径覆盖；
          // 同深度保留累计权重更高（avgEdgeWeight 更大）的路径
          if (existing) {
            if (existing.depth < depth) continue;
            if (existing.weightSum / Math.max(1, existing.depth) >= (from.weightSum + edge.weight) / depth) continue;
          }
          const node = nodeById.get(edge.other);
          if (!node) continue;
          best.set(edge.other, {
            depth,
            weightSum: from.weightSum + edge.weight,
            path: [...from.path, node.name],
          });
          next.push(edge.other);
        }
      }
      frontier = next;
    }

    // 收集：访问到的节点的 source_memory_ids → score = avgEdgeWeight × (1/pathLength)；种子直命中 1.0
    for (const [nodeId, visit] of best) {
      const node = nodeById.get(nodeId);
      if (!node) continue;
      const score = visit.depth === 0 ? 1.0 : (visit.weightSum / visit.depth) * (1 / visit.depth);
      for (const memoryId of node.sourceMemoryIds) {
        const current = hits.get(memoryId);
        if (!current || current.score < score) hits.set(memoryId, { score, viaPath: visit.path });
      }
    }

    return new Map(
      [...hits.entries()].toSorted((left, right) => right[1].score - left[1].score).slice(0, Math.max(1, limit))
    );
  } catch {
    return new Map();
  }
}
