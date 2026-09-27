import { accountRuntime } from './account-runtime.js';
import {
  getMemoryStoreContext,
  listMemories,
  listMemoryAccessLogs,
  type MemoryEntry,
  type MemoryScope,
} from './memory-store.js';
import { graphRecall, type GraphRecallHit } from './memory-graph.js';
import { retentionOf, retentionScoreFactor, RETENTION } from './memory-retention.js';
import {
  resolveEmbeddingProvider,
  setMemoryEmbeddingQueueHooks,
  type MemoryEmbeddingProvider,
  type MemoryEmbeddingVectorResult,
} from './memory-embedding.js';

/** 当前向量模型指纹：bge-small-zh-v1.5 512 维中文语义 embedding（T1.23 选型；旧 minilm-l6-v2-384 / feature-hash-chargram-v1 均已废弃） */
const VECTOR_MODEL = 'bge-small-zh-v1.5-512';
/** provider 不可用时的占位维度（对应行 vector 列为 NULL，召回侧跳过） */
const VECTOR_DIMENSIONS = 512;
const RRF_K = 60;
/** 默认融合深度：保留 top-20 供后续 rerank（02 章 §2.2）；各流召回深度为其 2 倍 */
const DEFAULT_FUSION_DEPTH = 20;
const initialization = new Map<number, Promise<void>>();
let rebuildScheduled = false;
accountRuntime.registerCacheInvalidator(() => {
  initialization.clear();
  rebuildScheduled = false;
  graphRecallAnnotations.length = 0;
  graphRecallSeq = 0;
});

/** Float32Array → BLOB 序列化：显式 byteOffset/byteLength（agentmemory #455 教训，禁止直接用整个 buffer） */
export function serializeFloat32Vector(vector: Float32Array): Buffer {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

/** BLOB → Float32Array 反序列化：拷贝到独立 4 字节对齐的 ArrayBuffer，避免池化 Buffer 的 byteOffset 未对齐 */
export function deserializeFloat32Vector(blob: ArrayBuffer | Uint8Array): Float32Array {
  const bytes = blob instanceof Uint8Array ? blob : new Uint8Array(blob);
  const aligned = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(aligned).set(bytes);
  return new Float32Array(aligned);
}

export type MemoryRetrievalChannel = 'pinned' | 'fts' | 'vector' | 'graph';
export interface HybridMemoryHit {
  memory: MemoryEntry;
  score: number;
  channels: MemoryRetrievalChannel[];
  /** T3.8 图谱流命中标注（"经实体 X 关联"），供注入文案与 ChatPage 记忆提示 UI 展示 */
  viaGraph?: string;
}

/** T3.8 图谱召回标注 ring buffer：记录近期检索中图谱流命中的记忆，供 UI 轮询展示（账号切换清空） */
export interface GraphRecallAnnotation {
  seq: number;
  memoryId: string;
  title: string;
  viaGraph: string;
}
const graphRecallAnnotations: GraphRecallAnnotation[] = [];
let graphRecallSeq = 0;
const GRAPH_RECALL_ANNOTATION_CAP = 50;

/** UI 轮询接口：返回 seq 水位与 since 之后的新标注 */
export function listGraphRecallAnnotations(sinceSeq = 0): { seq: number; items: GraphRecallAnnotation[] } {
  return { seq: graphRecallSeq, items: graphRecallAnnotations.filter((item) => item.seq > sinceSeq) };
}

function recordGraphRecallAnnotations(hits: HybridMemoryHit[]): void {
  for (const hit of hits) {
    if (!hit.viaGraph) continue;
    graphRecallSeq += 1;
    graphRecallAnnotations.push({
      seq: graphRecallSeq,
      memoryId: hit.memory.id,
      title: hit.memory.title,
      viaGraph: hit.viaGraph,
    });
  }
  if (graphRecallAnnotations.length > GRAPH_RECALL_ANNOTATION_CAP) {
    graphRecallAnnotations.splice(0, graphRecallAnnotations.length - GRAPH_RECALL_ANNOTATION_CAP);
  }
}

/** 测试注入点：替换 provider 解析（默认 resolveEmbeddingProvider；测试注入 fake provider，避免真实模型下载） */
export interface MemorySearchHooks {
  resolveProvider?: () => Promise<MemoryEmbeddingProvider | null>;
}
let searchHooks: MemorySearchHooks = {};
export function setMemorySearchHooks(hooks: MemorySearchHooks): void {
  searchHooks = hooks;
}
async function resolveSearchProvider(): Promise<MemoryEmbeddingProvider | null> {
  return (searchHooks.resolveProvider ?? resolveEmbeddingProvider)();
}

export function tokenizeForMemorySearch(text: string): string[] {
  const normalized = text.normalize('NFKC').toLowerCase();
  const tokens: string[] = [];
  for (const segment of normalized.split(/[^\p{L}\p{N}]+/u).filter(Boolean)) {
    const chars = [...segment];
    // eslint-disable-next-line no-control-regex -- 上游分词逻辑原样保留
    if (/^[\x00-\x7f]+$/.test(segment)) {
      if (segment.length > 1) tokens.push(segment);
      continue;
    }
    if (chars.length === 1) tokens.push(chars[0]);
    for (let index = 0; index < chars.length - 1; index += 1) tokens.push(chars[index] + chars[index + 1]);
    for (let index = 0; index < chars.length - 2; index += 1)
      tokens.push(chars[index] + chars[index + 1] + chars[index + 2]);
  }
  return [...new Set(tokens)].slice(0, 256);
}

/**
 * T1.12 query 侧 FTS 展开（02 章 §2.2 方案 A）：中文连续段（≥2 个 CJK 字）展开为 bigram 词组，
 * 单字/ASCII 词保持原样。
 * 不复用 tokenizeForMemorySearch 的 trigram：query 侧 trigram 相对 bigram 无召回增量
 * （bigram 已能命中索引内对应 token），多余的 OR 项只会稀释 bm25 排名；
 * 索引侧保留 trigram 属既有行为，不影响 bigram 匹配。
 */
export function expandQueryForFts(query: string): string[] {
  const normalized = query.normalize('NFKC').toLowerCase();
  const tokens: string[] = [];
  for (const segment of normalized.split(/[^\p{L}\p{N}]+/u).filter(Boolean)) {
    const chars = [...segment];
    // eslint-disable-next-line no-control-regex -- 上游分词逻辑原样保留
    if (/^[\x00-\x7f]+$/.test(segment)) {
      if (segment.length > 1) tokens.push(segment);
      continue;
    }
    if (chars.length === 1) {
      tokens.push(chars[0]);
      continue;
    }
    for (let index = 0; index < chars.length - 1; index += 1) tokens.push(chars[index] + chars[index + 1]);
  }
  return [...new Set(tokens)].slice(0, 64);
}

/** 构造 FTS5 MATCH 表达式：词组加双引号，引号自身翻倍转义（防 MATCH 语法注入） */
export function buildFtsMatchQuery(query: string): string {
  return expandQueryForFts(query)
    .slice(0, 32)
    .map((token) => `"${token.replaceAll('"', '""')}"`)
    .join(' OR ');
}

export function cosineSimilarity(left: ArrayLike<number>, right: ArrayLike<number>): number {
  if (left.length !== right.length || left.length === 0) return 0;
  let sum = 0;
  for (let index = 0; index < left.length; index += 1) sum += left[index] * (right[index] ?? 0);
  return sum;
}

/**
 * RRF 融合（k=60，只用名次不用原始分）。
 * 缺流归一化（02 章 §2.2）：权重为 0 或 ids 为空的流不参与归一，总分按有效权重重新归一，
 * 避免向量流缺失（provider 不可用）时总分被稀释影响阈值判断。
 */
export function fuseMemoryRanks(
  channels: Array<{ channel: MemoryRetrievalChannel; ids: string[]; weight?: number }>
): Map<string, { score: number; channels: MemoryRetrievalChannel[] }> {
  const effective = channels.filter((channel) => (channel.weight ?? 1) > 0 && channel.ids.length > 0);
  const totalWeight = effective.reduce((sum, channel) => sum + (channel.weight ?? 1), 0);
  const fused = new Map<string, { score: number; channels: MemoryRetrievalChannel[] }>();
  if (totalWeight <= 0) return fused;
  for (const channel of effective) {
    const normalizedWeight = (channel.weight ?? 1) / totalWeight;
    channel.ids.forEach((id, index) => {
      const current = fused.get(id) ?? { score: 0, channels: [] };
      current.score += normalizedWeight / (RRF_K + index + 1);
      if (!current.channels.includes(channel.channel)) current.channels.push(channel.channel);
      fused.set(id, current);
    });
  }
  return fused;
}

async function ensureSearchSchema() {
  const generation = accountRuntime.currentGeneration();
  const { database } = await getMemoryStoreContext();
  let pending = initialization.get(generation);
  if (!pending) {
    pending = (async () => {
      await database.execute(`CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
        memory_id UNINDEXED, tokens, tokenize='unicode61 remove_diacritics 2'
      )`);
      // memory_vectors 是可重建投影表：检测旧 schema（vector_json 文本列）则 DROP 重建为 BLOB 方案
      const vectorColumns = await database.execute('PRAGMA table_info(memory_vectors)');
      const vectorColumnNames = new Set(vectorColumns.rows.map((row) => String(row.name)));
      if (vectorColumnNames.size > 0 && (vectorColumnNames.has('vector_json') || !vectorColumnNames.has('vector'))) {
        await database.execute('DROP TABLE memory_vectors');
      }
      await database.execute(`CREATE TABLE IF NOT EXISTS memory_vectors (
        memory_id TEXT PRIMARY KEY,
        version INTEGER NOT NULL,
        model_fingerprint TEXT NOT NULL,
        provider TEXT NOT NULL DEFAULT '',
        dimensions INTEGER NOT NULL,
        vector BLOB
      )`);
      await database.execute(`CREATE TABLE IF NOT EXISTS memory_search_state (
        memory_id TEXT PRIMARY KEY,
        version INTEGER NOT NULL
      )`);
    })();
    initialization.set(generation, pending);
  }
  await pending;
  if (accountRuntime.currentGeneration() !== generation) throw new Error('ACCOUNT_CONTEXT_CHANGED');
  return database;
}

type SearchDatabase = Awaited<ReturnType<typeof ensureSearchSchema>>;

/** 清空投影三表（memory_fts / memory_vectors / memory_search_state），供模型指纹 bump 与手动 reindex 使用 */
async function clearProjectionTables(database: SearchDatabase): Promise<void> {
  await database.batch(
    [
      { sql: 'DELETE FROM memory_fts', args: [] },
      { sql: 'DELETE FROM memory_vectors', args: [] },
      { sql: 'DELETE FROM memory_search_state', args: [] },
    ],
    'write'
  );
}

/** fire-and-forget 全量重建：不阻塞启动/检索，重建期间向量流无结果即自然降级 */
function scheduleFullRebuild(): void {
  if (rebuildScheduled) return;
  rebuildScheduled = true;
  setTimeout(() => {
    rebuildScheduled = false;
    void syncSearchProjection(['chat', 'code']).catch(() => {});
  }, 0);
}

/** T1.9 管理端点底层实现：清空投影三表并全量重建（调用方决定是否 fire-and-forget） */
export async function rebuildMemorySearchProjection(): Promise<void> {
  const database = await ensureSearchSchema();
  await clearProjectionTables(database);
  await syncSearchProjection(['chat', 'code']);
}

async function syncSearchProjection(scope: MemoryScope | MemoryScope[]) {
  const database = await ensureSearchSchema();
  const [allActive, visible] = await Promise.all([listMemories(), listMemories(undefined, undefined, scope)]);

  // T1.6 模型指纹守卫：库内向量与当前模型不符（如旧 96 维哈希）→ 清表 + 后台全量重建；
  // 本次调用直接降级返回（pinned 可用、FTS/vector 为空），不阻塞检索
  const staleModel = await database.execute({
    sql: 'SELECT memory_id FROM memory_vectors WHERE model_fingerprint <> ? LIMIT 1',
    args: [VECTOR_MODEL],
  });
  if (staleModel.rows.length > 0) {
    await clearProjectionTables(database);
    scheduleFullRebuild();
    return { database, visible };
  }

  const activeIds = new Set(allActive.map((memory) => memory.id));
  const states = await database.execute('SELECT memory_id, version FROM memory_search_state');
  const versions = new Map(states.rows.map((row) => [String(row.memory_id), Number(row.version)]));
  const staleEntries = allActive.filter((memory) => versions.get(memory.id) !== memory.version);

  // T1.7 条目向量：provider embedBatch 批量补算缺失/过期条目；provider 不可用时 vector 列留 NULL（召回侧跳过）
  const vectorsById = new Map<string, Float32Array | null>();
  let provider: MemoryEmbeddingProvider | null = null;
  if (staleEntries.length > 0) {
    provider = await resolveSearchProvider().catch(() => null);
    if (provider) {
      for (let offset = 0; offset < staleEntries.length; offset += 32) {
        const chunk = staleEntries.slice(offset, offset + 32);
        try {
          const vectors = await provider.embedBatch(chunk.map((memory) => `${memory.title}\n${memory.content}`));
          chunk.forEach((memory, index) => vectorsById.set(memory.id, vectors[index] ?? null));
        } catch {
          chunk.forEach((memory) => vectorsById.set(memory.id, null));
        }
      }
    }
  }

  for (const memory of staleEntries) {
    const tokens = tokenizeForMemorySearch(`${memory.title} ${memory.content}`).join(' ');
    const vector = vectorsById.get(memory.id) ?? null;
    await database.batch(
      [
        { sql: 'DELETE FROM memory_fts WHERE memory_id = ?', args: [memory.id] },
        { sql: 'INSERT INTO memory_fts (memory_id, tokens) VALUES (?, ?)', args: [memory.id, tokens] },
        {
          sql: `INSERT INTO memory_vectors (memory_id, version, model_fingerprint, provider, dimensions, vector)
          VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(memory_id) DO UPDATE SET
          version=excluded.version, model_fingerprint=excluded.model_fingerprint,
          provider=excluded.provider, dimensions=excluded.dimensions, vector=excluded.vector`,
          args: [
            memory.id,
            memory.version,
            VECTOR_MODEL,
            provider?.name ?? '',
            provider?.dimensions ?? VECTOR_DIMENSIONS,
            vector ? serializeFloat32Vector(vector) : null,
          ],
        },
        {
          sql: `INSERT INTO memory_search_state (memory_id, version) VALUES (?, ?)
          ON CONFLICT(memory_id) DO UPDATE SET version=excluded.version`,
          args: [memory.id, memory.version],
        },
      ],
      'write'
    );
  }
  for (const id of versions.keys()) {
    if (activeIds.has(id)) continue;
    await database.batch(
      [
        { sql: 'DELETE FROM memory_fts WHERE memory_id = ?', args: [id] },
        { sql: 'DELETE FROM memory_vectors WHERE memory_id = ?', args: [id] },
        { sql: 'DELETE FROM memory_search_state WHERE memory_id = ?', args: [id] },
      ],
      'write'
    );
  }
  return { database, visible };
}

export async function retrieveHybridMemories(
  query: string,
  scope: MemoryScope | MemoryScope[] = 'chat',
  limit = DEFAULT_FUSION_DEPTH
): Promise<HybridMemoryHit[]> {
  const { database, visible } = await syncSearchProjection(scope);
  if (visible.length === 0) return [];
  // T2.8 冷记忆过滤：retention < 冷阈值且非置顶的条目不进入召回集（置顶全豁免）；
  // access_log 批量 IN 查询一次取回，避免 N+1
  const now = Date.now();
  const accessLogs = await listMemoryAccessLogs(visible.map((memory) => memory.id));
  const retentionById = new Map(
    visible.map((memory) => [memory.id, retentionOf(memory, accessLogs.get(memory.id) ?? [], now)])
  );
  const candidates = visible.filter(
    (memory) => memory.pinned || (retentionById.get(memory.id) ?? 1) >= RETENTION.coldThreshold
  );
  if (candidates.length === 0) return [];
  // 召回深度（02 章 §2.2）：各路取 max(limit,20)*2 入融合，融合后保留 top-N 供 rerank
  const fusionDepth = Math.max(limit, DEFAULT_FUSION_DEPTH);
  const streamDepth = fusionDepth * 2;
  const byId = new Map(candidates.map((memory) => [memory.id, memory]));
  const pinnedIds = candidates
    .filter((memory) => memory.pinned)
    .toSorted((left, right) => right.updatedAt - left.updatedAt)
    .map((memory) => memory.id);
  // T1.12 query 侧 bigram 展开（中文连续段 ≥2 字），MATCH 表达式引号转义安全
  const match = buildFtsMatchQuery(query);
  let ftsIds: string[] = [];
  if (match) {
    const result = await database
      .execute({
        sql: 'SELECT memory_id, bm25(memory_fts) AS rank FROM memory_fts WHERE memory_fts MATCH ? ORDER BY rank LIMIT ?',
        args: [match, streamDepth],
      })
      .catch(() => ({ rows: [] }));
    ftsIds = result.rows.map((row) => String(row.memory_id)).filter((id) => byId.has(id));
  }

  // T1.7 向量流：query 经真 embedding provider 编码；provider 为 null 或 embed 失败时整流跳过（不报错）
  let vectorIds: string[] = [];
  const provider = await resolveSearchProvider().catch(() => null);
  if (provider) {
    try {
      const queryVector = await provider.embed(query);
      // 跳过 NULL 行（provider 不可用期间补写的投影）
      const vectorRows = await database.execute(
        'SELECT memory_id, vector FROM memory_vectors WHERE vector IS NOT NULL'
      );
      vectorIds = vectorRows.rows
        .map((row) => {
          try {
            const vector = deserializeFloat32Vector(row.vector as ArrayBuffer | Uint8Array);
            return { id: String(row.memory_id), similarity: cosineSimilarity(queryVector, vector) };
          } catch {
            return { id: String(row.memory_id), similarity: 0 };
          }
        })
        .filter((item) => byId.has(item.id) && item.similarity >= 0.12)
        .toSorted((left, right) => right.similarity - left.similarity)
        .slice(0, streamDepth)
        .map((item) => item.id);
    } catch {
      vectorIds = [];
    }
  }

  // T3.7/T3.8 图谱流：query 实体提取 → BFS 召回（内部失败返回空 Map，整流跳过自然降级）
  const graphHits = await graphRecall(query, streamDepth).catch(() => new Map<string, GraphRecallHit>());
  const graphIds = [...graphHits.keys()].filter((id) => byId.has(id));

  // T1.11 权重 pinned 3.0 / fts 0.4 / vector 0.6 / graph 0.3（T3.8）；缺流（ids 为空）自动置 0 重新归一
  const fused = fuseMemoryRanks([
    { channel: 'pinned', ids: pinnedIds, weight: 3.0 },
    { channel: 'fts', ids: ftsIds, weight: 0.4 },
    { channel: 'vector', ids: vectorIds, weight: 0.6 },
    { channel: 'graph', ids: graphIds, weight: 0.3 },
  ]);
  // T2.8 保持分乘性调节：finalScore = rrfScore × (0.5 + 0.5×retention)，RRF 仍是主序
  const sorted = [...fused.entries()]
    .map(([id, rank]): [string, { score: number; channels: MemoryRetrievalChannel[] }] => [
      id,
      { score: rank.score * retentionScoreFactor(retentionById.get(id) ?? 1), channels: rank.channels },
    ])
    .toSorted(
      (left, right) =>
        right[1].score - left[1].score || (byId.get(right[0])?.updatedAt ?? 0) - (byId.get(left[0])?.updatedAt ?? 0)
    );
  // T1.13 同标题去重（02 章 §2.3）：同 title 近亲条目（consolidation 未清理干净）只保留最高分一条
  const seenTitles = new Set<string>();
  const deduped = sorted.filter(([id]) => {
    const title = byId.get(id)?.title ?? '';
    if (seenTitles.has(title)) return false;
    seenTitles.add(title);
    return true;
  });
  const results = deduped.slice(0, Math.max(1, Math.min(32, limit))).map(([id, rank]): HybridMemoryHit => {
    const graphHit = graphHits.get(id);
    return Object.assign(
      { memory: byId.get(id)!, score: rank.score, channels: rank.channels },
      graphHit ? { viaGraph: `经实体 ${graphHit.viaPath.join(` → `)} 关联` } : {}
    );
  });
  recordGraphRecallAnnotations(results);
  return results;
}

/**
 * T1.8 embedding 队列 onEmbedded sink：批量算好的向量落库为 memory_vectors BLOB 行
 * （含 version/provider/dimensions/model_fingerprint）。失败静默（不阻塞写路径），由版本守卫/全量重建兜底。
 */
export async function persistEmbeddedMemoryVectors(results: MemoryEmbeddingVectorResult[]): Promise<void> {
  if (results.length === 0) return;
  try {
    const database = await ensureSearchSchema();
    for (const result of results) {
      const row = await database.execute({ sql: 'SELECT version FROM memories WHERE id = ?', args: [result.memoryId] });
      const version = Number(row.rows[0]?.version);
      if (!Number.isSafeInteger(version) || version < 1) continue;
      await database.execute({
        sql: `INSERT INTO memory_vectors (memory_id, version, model_fingerprint, provider, dimensions, vector)
          VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(memory_id) DO UPDATE SET
          version=excluded.version, model_fingerprint=excluded.model_fingerprint,
          provider=excluded.provider, dimensions=excluded.dimensions, vector=excluded.vector`,
        args: [
          result.memoryId,
          version,
          VECTOR_MODEL,
          result.provider,
          result.dimensions,
          serializeFloat32Vector(result.vector),
        ],
      });
    }
  } catch {
    // 账号切换/库不可用等场景：丢弃本次结果，由全量重建兜底
  }
}

// 模块初始化：注册队列落库 sink（测试可用 setMemoryEmbeddingQueueHooks 覆盖，并显式组合 persistEmbeddedMemoryVectors）
setMemoryEmbeddingQueueHooks({ onEmbedded: persistEmbeddedMemoryVectors });
