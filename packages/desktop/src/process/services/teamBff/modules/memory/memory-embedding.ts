/**
 * 记忆语义 embedding 基础设施（Phase 1：T1.2–T1.4、T1.10）。
 *
 * - `MemoryEmbeddingProvider`：provider 抽象（借鉴 agentmemory src/types.ts:238）
 * - local provider：`@xenova/transformers` + Xenova/bge-small-zh-v1.5（512 维，T1.23 评测选型），
 *   懒加载单例，optionalDependency 缺失时降级为 null 不抛错
 * - cloud provider（T1.10）：OpenAI 兼容 `POST {baseUrl}/embeddings`，显式配置优先于 local
 * - `withDimensionGuard`：维度守卫装饰器，维度不符立即 throw（防止坏向量入库）
 * - `enqueueMemoryEmbedding`：内存批量队列，50ms 防抖聚合（≤32 条/批），
 *   失败重试 3 次后标记 pending（内存 Set，进程级即可）
 */

export interface MemoryEmbeddingProvider {
  /** Provider 标识（写入 memory_vectors.provider 列） */
  name: string;
  /** 输出向量维度，维度守卫以此为基准校验 */
  dimensions: number;
  embed(text: string): Promise<Float32Array>;
  embedBatch(texts: string[]): Promise<Float32Array[]>;
}

const LOCAL_MODEL_ID = 'Xenova/bge-small-zh-v1.5';
const LOCAL_MODEL_DIMENSIONS = 512;

/** feature-extraction pipeline 返回的 Tensor 最小结构 */
interface FeatureExtractionTensor {
  data: Float32Array | number[];
  dims?: number[];
}
type FeatureExtractor = (
  input: string[],
  options: { pooling: 'mean'; normalize: true },
) => Promise<FeatureExtractionTensor>;

// 懒加载单例：并发调用共享同一个 Promise（并发去重）；失败时重置，允许后续重试。
let localExtractorPromise: Promise<FeatureExtractor | null> | null = null;

function loadLocalExtractor(): Promise<FeatureExtractor | null> {
  if (!localExtractorPromise) {
    const promise = (async (): Promise<FeatureExtractor | null> => {
      // optionalDependency：未安装时 dynamic import 失败，降级为 null 不抛错
      const mod = await import('@xenova/transformers').catch(() => null);
      if (!mod) return null;
      const pipeline = (mod as { pipeline?: unknown }).pipeline;
      if (typeof pipeline !== 'function') return null;
      const create = pipeline as (task: string, model: string) => Promise<FeatureExtractor>;
      return create('feature-extraction', LOCAL_MODEL_ID).catch(() => null);
    })();
    localExtractorPromise = promise;
    void promise.then((extractor) => {
      if (!extractor && localExtractorPromise === promise) localExtractorPromise = null;
    });
  }
  return localExtractorPromise;
}

/** local provider：Xenova/bge-small-zh-v1.5（512 维，T1.23 中文场景选型），模型侧完成 mean pooling + L2 归一化 */
export function createLocalEmbeddingProvider(): MemoryEmbeddingProvider {
  return {
    name: 'local-bge-small-zh-v1.5',
    dimensions: LOCAL_MODEL_DIMENSIONS,
    async embed(text: string): Promise<Float32Array> {
      const [vector] = await this.embedBatch([text]);
      return vector;
    },
    async embedBatch(texts: string[]): Promise<Float32Array[]> {
      if (texts.length === 0) return [];
      const extractor = await loadLocalExtractor();
      if (!extractor) throw new Error('EMBEDDING_PROVIDER_UNAVAILABLE');
      const output = await extractor(texts, { pooling: 'mean', normalize: true });
      const data = output.data instanceof Float32Array ? output.data : Float32Array.from(output.data);
      const dims = output.dims ?? [];
      const dim = dims.length >= 2 ? dims[dims.length - 1] : Math.floor(data.length / texts.length);
      const vectors: Float32Array[] = [];
      for (let index = 0; index < texts.length; index += 1) {
        vectors.push(data.slice(index * dim, (index + 1) * dim));
      }
      return vectors;
    },
  };
}

// ---------------------------------------------------------------------------
// T1.10 cloud provider：OpenAI 兼容 embeddings 端点（显式配置优先于 local）
// ---------------------------------------------------------------------------

/** cloud provider 显式配置（OpenAI 兼容 `POST {baseUrl}/embeddings`，Bearer 鉴权） */
export interface CloudEmbeddingConfig {
  /** OpenAI 兼容服务根地址，如 https://open.bigmodel.cn/api/paas/v4（不含 /embeddings） */
  baseUrl: string;
  apiKey: string;
  /** embedding 模型名，如 embedding-3 / text-embedding-3-small */
  model: string;
  /** 期望输出维度：维度守卫以此为基准校验响应 */
  dimensions: number;
  /** provider 标识（写入 memory_vectors.provider 列），默认 `cloud:{model}` */
  name?: string;
}

/**
 * cloud provider 工厂：接受显式配置对象，不依赖任何配置存储。
 * 响应按 data[].index 排序还原批量顺序；条数不符/HTTP 非 2xx 立即 throw（由队列重试兜底）。
 */
export function createCloudEmbeddingProvider(config: CloudEmbeddingConfig): MemoryEmbeddingProvider {
  const endpoint = `${config.baseUrl.replace(/\/+$/, '')}/embeddings`;
  const request = async (texts: string[]): Promise<Float32Array[]> => {
    if (texts.length === 0) return [];
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({ model: config.model, input: texts }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`CLOUD_EMBEDDING_HTTP_${response.status}`);
    const payload = await response.json() as { data?: Array<{ index?: number; embedding?: number[] }> };
    const data = Array.isArray(payload.data) ? payload.data : [];
    if (data.length !== texts.length) throw new Error('CLOUD_EMBEDDING_COUNT_MISMATCH');
    const ordered = [...data].sort((left, right) => (left.index ?? 0) - (right.index ?? 0));
    return ordered.map((item) => Float32Array.from(item.embedding ?? []));
  };
  return {
    name: config.name ?? `cloud:${config.model}`,
    dimensions: config.dimensions,
    async embed(text: string): Promise<Float32Array> {
      const [vector] = await request([text]);
      return vector;
    },
    embedBatch: request,
  };
}

/**
 * cloud 配置解析器接入点（T1.10 预留）。
 *
 * 调查结论：现有模型配置体系（model-config.ts 的 ModelRole 仅 chat/multimodal/imageGen/videoGen，
 * model-binding.ts 的 SCENES 无 memory-embedding 场景）没有可直接复用的 embedding 端点配置结构，
 * 新增 role/场景会牵动配置存储与 UI，超出本可选任务范围。因此 cloud provider 只做显式配置工厂 +
 * 此解析器接入点，不发明新配置存储。
 * TODO：后续若在 model-binding 注册 `memory-embedding` 场景（复用 getBoundRawEndpoint 的端点结构，
 * 端点需补 model/dimensions 字段），在此处实现 resolver 即可接通，resolveEmbeddingProvider 无需再改。
 */
export type CloudEmbeddingConfigResolver = () => CloudEmbeddingConfig | null | Promise<CloudEmbeddingConfig | null>;
let cloudConfigResolver: CloudEmbeddingConfigResolver | null = null;
export function setCloudEmbeddingConfigResolver(resolver: CloudEmbeddingConfigResolver | null): void {
  cloudConfigResolver = resolver;
}

/** 维度守卫：embed/embedBatch 返回维度 ≠ provider.dimensions 立即 throw */
export function withDimensionGuard(provider: MemoryEmbeddingProvider): MemoryEmbeddingProvider {
  const assertDimensions = (vector: Float32Array): Float32Array => {
    if (vector.length !== provider.dimensions) {
      throw new Error(
        `EMBEDDING_DIMENSION_MISMATCH provider=${provider.name} expected=${provider.dimensions} actual=${vector.length}`,
      );
    }
    return vector;
  };
  return {
    name: provider.name,
    dimensions: provider.dimensions,
    async embed(text: string): Promise<Float32Array> {
      return assertDimensions(await provider.embed(text));
    },
    async embedBatch(texts: string[]): Promise<Float32Array[]> {
      return (await provider.embedBatch(texts)).map(assertDimensions);
    },
  };
}

/**
 * provider 探测：显式 cloud 配置（T1.10，经 setCloudEmbeddingConfigResolver 注入）> 自动检测 local > null。
 * 仅探测依赖可用性，不触发模型下载；全不可用时返回 null，向量流整体降级（不报错）。
 */
export async function resolveEmbeddingProvider(): Promise<MemoryEmbeddingProvider | null> {
  // 显式 cloud 配置优先于 local（即使在 VITEST 环境：显式注入视为有意为之）；resolver 异常等同无配置
  const cloudConfig = cloudConfigResolver
    ? await Promise.resolve().then(() => cloudConfigResolver!()).catch(() => null)
    : null;
  if (cloudConfig) return withDimensionGuard(createCloudEmbeddingProvider(cloudConfig));
  // 测试环境禁止真实加载模型（避免下载）；测试经 setMemoryEmbeddingQueueHooks / setMemorySearchHooks 注入 fake provider
  if (process.env.VITEST) return null;
  const available = await import('@xenova/transformers').then(() => true).catch(() => false);
  if (!available) return null;
  return withDimensionGuard(createLocalEmbeddingProvider());
}

// ---------------------------------------------------------------------------
// T1.4 embedding 批量队列（进程内内存队列，不持久化）
// ---------------------------------------------------------------------------

export const EMBEDDING_QUEUE_BATCH_SIZE = 32;
export const EMBEDDING_QUEUE_DEBOUNCE_MS = 50;
/** 单批失败后的最大重试次数（首次失败 + 3 次重试后标记 pending） */
export const EMBEDDING_QUEUE_MAX_RETRIES = 3;

export interface MemoryEmbeddingVectorResult {
  memoryId: string;
  vector: Float32Array;
  provider: string;
  dimensions: number;
}

interface MemoryEmbeddingQueueHooks {
  resolveProvider?: () => Promise<MemoryEmbeddingProvider | null>;
  onEmbedded?: (results: MemoryEmbeddingVectorResult[]) => void | Promise<void>;
}

// 队列以 memoryId 去重，保留最新文本
let embeddingQueue = new Map<string, string>();
let embeddingFlushTimer: ReturnType<typeof setTimeout> | null = null;
// 串行化处理链，避免 drain 并发重入
let embeddingDrainChain: Promise<void> = Promise.resolve();
const embeddingRetryCounts = new Map<string, number>();
const embeddingPendingIds = new Set<string>();
let queueHooks: MemoryEmbeddingQueueHooks = {};

/** 测试/后续任务（T1.8 写库 sink）注入 hook */
export function setMemoryEmbeddingQueueHooks(hooks: MemoryEmbeddingQueueHooks): void {
  queueHooks = hooks;
}

export function isMemoryEmbeddingPending(memoryId: string): boolean {
  return embeddingPendingIds.has(memoryId);
}

export function listPendingMemoryEmbeddings(): string[] {
  return [...embeddingPendingIds];
}

export function enqueueMemoryEmbedding(memoryId: string, text: string): void {
  if (!memoryId || !text.trim()) return;
  embeddingPendingIds.delete(memoryId);
  embeddingRetryCounts.delete(memoryId);
  embeddingQueue.set(memoryId, text);
  scheduleEmbeddingFlush();
}

function scheduleEmbeddingFlush(): void {
  if (embeddingFlushTimer) return;
  embeddingFlushTimer = setTimeout(() => {
    embeddingFlushTimer = null;
    void drainEmbeddingQueue();
  }, EMBEDDING_QUEUE_DEBOUNCE_MS);
}

function drainEmbeddingQueue(): Promise<void> {
  embeddingDrainChain = embeddingDrainChain.then(processEmbeddingQueue, processEmbeddingQueue);
  return embeddingDrainChain;
}

async function processEmbeddingBatchWithRetry(
  provider: MemoryEmbeddingProvider,
  batch: Array<[string, string]>,
): Promise<void> {
  const texts = batch.map(([, text]) => text);
  for (let attempt = 0; attempt <= EMBEDDING_QUEUE_MAX_RETRIES; attempt += 1) {
    try {
      const vectors = await provider.embedBatch(texts);
      const results = batch.map(([memoryId], index): MemoryEmbeddingVectorResult => ({
        memoryId,
        vector: vectors[index],
        provider: provider.name,
        dimensions: provider.dimensions,
      }));
      for (const [memoryId] of batch) embeddingRetryCounts.delete(memoryId);
      await queueHooks.onEmbedded?.(results);
      return;
    } catch {
      if (attempt >= EMBEDDING_QUEUE_MAX_RETRIES) {
        // 重试耗尽：标记 pending，由全量重建兜底
        for (const [memoryId] of batch) {
          embeddingPendingIds.add(memoryId);
          embeddingRetryCounts.delete(memoryId);
        }
        return;
      }
    }
  }
}

async function processEmbeddingQueue(): Promise<void> {
  if (embeddingQueue.size === 0) return;
  const resolveProvider = queueHooks.resolveProvider ?? resolveEmbeddingProvider;
  const provider = await resolveProvider();
  if (!provider) {
    // 无可用 provider：全部标记 pending，不阻塞写路径
    for (const memoryId of embeddingQueue.keys()) embeddingPendingIds.add(memoryId);
    embeddingQueue.clear();
    return;
  }
  while (embeddingQueue.size > 0) {
    const batch = [...embeddingQueue.entries()].slice(0, EMBEDDING_QUEUE_BATCH_SIZE);
    for (const [memoryId] of batch) embeddingQueue.delete(memoryId);
    await processEmbeddingBatchWithRetry(provider, batch);
  }
}

/** 立即冲刷队列（供测试与关停前使用） */
export async function flushEmbeddings(): Promise<void> {
  if (embeddingFlushTimer) {
    clearTimeout(embeddingFlushTimer);
    embeddingFlushTimer = null;
  }
  await drainEmbeddingQueue();
}

/** 测试辅助：重置队列全部内部状态 */
export function resetMemoryEmbeddingQueue(): void {
  if (embeddingFlushTimer) {
    clearTimeout(embeddingFlushTimer);
    embeddingFlushTimer = null;
  }
  embeddingQueue = new Map();
  embeddingDrainChain = Promise.resolve();
  embeddingRetryCounts.clear();
  embeddingPendingIds.clear();
  queueHooks = {};
}
