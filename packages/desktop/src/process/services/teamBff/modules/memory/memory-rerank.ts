/**
 * 记忆召回精排（rerank）。
 *
 * 设计契约：doc/mergeAgentMemory/personal&team-memory-upgrade/03-rerank.md
 * - 方案 B：用「模型绑定」memory 场景绑定的 LLM 对召回 top-20 候选批量打分（复用
 *   consolidation 的模型解析路径 memory-model-util.ts），零新依赖。
 * - 加权融合：finalScore = RERANK_BLEND×(score/10) + (1-RERANK_BLEND)×rrfScore；
 *   rerank 缺失的候选 normalize 取 0.5（中性）；rerank 全缺时自然退化为 RRF 序。
 * - 降级：模型未绑定 / 调用失败 / 超时（3s AbortController）→ 原 RRF 序直通，
 *   记 rerankSkipped 计数（供 DebugOverlay 展示，UI 接入可选）。
 * - 缓存：(queryHash + candidatesHash) 5 分钟进程内缓存（容量 128），
 *   连发消息/重试场景避免重复 LLM 调用。
 *
 * 本模块保持泛型（只要求 title/text/score），不依赖 ContextHit，
 * 个人记忆与团队记忆两个通道各自独立调用，不做跨通道重排。
 */
import { createHash } from 'node:crypto';
import { generateText, type LanguageModel } from 'ai';
import { getMemoryModel, type MemoryModelHandle } from './memory-model-util.js';

/** 精排混合权重：finalScore = RERANK_BLEND×(score/10) + (1-RERANK_BLEND)×rrfScore（03 章 §3） */
export const RERANK_BLEND = 0.7;
/** LLM 单次批量打分超时（03 章 §4：3s AbortController） */
export const RERANK_TIMEOUT_MS = 3_000;
/** 进入精排的候选上限（召回深度 top-20，02 章 §2.2） */
export const RERANK_CANDIDATE_LIMIT = 20;
/** 精排后的注入条数（03 章 §2：top-20→8） */
export const RERANK_INJECTION_LIMIT = 8;
/** 缓存 TTL：5 分钟；容量 128 条（FIFO 逐出） */
const RERANK_CACHE_TTL_MS = 5 * 60_000;
const RERANK_CACHE_CAPACITY = 128;

/** 可精排候选的最小形状（ContextHit / HybridMemoryHit 映射后均满足） */
export interface RerankableHit {
  title: string;
  text: string;
  score: number;
}

export interface RerankScoreEntry {
  score: number;
  reason?: string;
}

/** 测试注入点：替换模型解析与 LLM 调用（默认走模型绑定 + AI SDK generateText） */
export interface MemoryRerankHooks {
  resolveModel?: () => Promise<MemoryModelHandle>;
  generateTextFn?: (args: { model: LanguageModel; prompt: string; abortSignal: AbortSignal }) => Promise<{ text: string }>;
}
let rerankHooks: MemoryRerankHooks = {};
export function setMemoryRerankHooks(hooks: MemoryRerankHooks): void {
  rerankHooks = hooks;
}

// —— 埋点计数（T2.3：供 DebugOverlay 展示，UI 接入可选）——
const counters = { rerankExecuted: 0, rerankSkipped: 0 };
export function getRerankMetrics(): { rerankExecuted: number; rerankSkipped: number } {
  return { ...counters };
}
export function resetRerankMetrics(): void {
  counters.rerankExecuted = 0;
  counters.rerankSkipped = 0;
}

// —— (queryHash + candidatesHash) 5min 进程内缓存（容量 128，FIFO 逐出）——
const rerankCache = new Map<string, { expiresAt: number; order: number[] }>();

function rerankCacheKey(query: string, candidates: RerankableHit[]): string {
  const hash = createHash('sha256');
  hash.update(query.normalize('NFKC'));
  hash.update('\u0000');
  for (const hit of candidates) {
    hash.update(hit.title);
    hash.update('\u0001');
    hash.update(hit.text);
    hash.update('\u0002');
  }
  return hash.digest('hex');
}

function readRerankCache(key: string): number[] | null {
  const entry = rerankCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    rerankCache.delete(key);
    return null;
  }
  return entry.order;
}

function writeRerankCache(key: string, order: number[]): void {
  if (rerankCache.size >= RERANK_CACHE_CAPACITY) {
    const oldest = rerankCache.keys().next().value;
    if (oldest !== undefined) rerankCache.delete(oldest);
  }
  rerankCache.set(key, { expiresAt: Date.now() + RERANK_CACHE_TTL_MS, order });
}

export function clearMemoryRerankCache(): void {
  rerankCache.clear();
}

// —— Prompt 契约（T2.1）：query + ≤20 候选 [{index,title,content}] → JSON {"scores":[{index,score,reason}]} ——
const RERANK_CONTENT_MAX_CHARS = 300;

export function buildRerankPrompt(query: string, candidates: RerankableHit[]): string {
  const payload = candidates.map((hit, index) => ({
    index,
    title: hit.title,
    content: [...hit.text].slice(0, RERANK_CONTENT_MAX_CHARS).join(''),
  }));
  return `你是记忆检索精排助手。根据用户查询为每条候选记忆打 0-10 的相关性分数。
打分维度优先级：语义相关性 > 时效性 > 具体性。词面相近但语义无关的候选应打低分。
只输出 JSON，不要输出任何其他内容：
{"scores":[{"index":候选index,"score":0到10的数字,"reason":"不超过20字"}]}

用户查询：${query}

候选记忆：
${JSON.stringify(payload)}`;
}

/** 从 LLM 输出中提取 JSON：容忍 ```json 代码围栏与前后多余文本 */
function extractJsonObject(text: string): unknown | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1]! : text).trim();
  try { return JSON.parse(candidate); } catch { /* 继续尝试子串提取 */ }
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(candidate.slice(start, end + 1)); } catch { return null; }
  }
  return null;
}

/**
 * 结构化解析 LLM 打分输出（T2.1）：坏 JSON → 空表（全体候选保留原分）；
 * 缺项/非法项跳过（对应候选后续取 0.5 中性分）。reason 截断 ≤20 字。
 */
export function parseRerankScores(text: string): Map<number, RerankScoreEntry> {
  const scores = new Map<number, RerankScoreEntry>();
  const parsed = extractJsonObject(text);
  if (!parsed || typeof parsed !== 'object') return scores;
  const list = (parsed as { scores?: unknown }).scores;
  if (!Array.isArray(list)) return scores;
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const raw = item as { index?: unknown; score?: unknown; reason?: unknown };
    const index = typeof raw.index === 'number' ? raw.index : Number(raw.index);
    const score = typeof raw.score === 'number' ? raw.score : Number(raw.score);
    if (!Number.isInteger(index) || index < 0 || scores.has(index)) continue;
    if (!Number.isFinite(score)) continue;
    scores.set(index, {
      score: Math.max(0, Math.min(10, score)),
      reason: typeof raw.reason === 'string' ? [...raw.reason].slice(0, 20).join('') : undefined,
    });
  }
  return scores;
}

/** 加权融合排序（T2.2）：返回候选下标序（降序）；rerank 缺失候选 normalize 取 0.5 中性 */
function blendRerankOrder(candidates: RerankableHit[], scores: Map<number, RerankScoreEntry>): number[] {
  return candidates
    .map((hit, index) => ({
      index,
      finalScore: RERANK_BLEND * ((scores.get(index)?.score ?? 5) / 10) + (1 - RERANK_BLEND) * hit.score,
    }))
    .sort((left, right) => right.finalScore - left.finalScore || left.index - right.index)
    .map((entry) => entry.index);
}

/** 加权融合后的候选序列（导出供单测验证融合序） */
export function blendRerankScores<T extends RerankableHit>(hits: T[], scores: Map<number, RerankScoreEntry>): T[] {
  return blendRerankOrder(hits, scores).map((index) => hits[index]!);
}

/**
 * 精排入口（T2.1–T2.3）：候选 ≤take 直接跳过（省一次 LLM 调用）；
 * 缓存命中 / 成功 → 按融合序返回 top-take；未绑定/失败/超时 → 原 RRF 序直通。
 * 永不抛异常——精排是纯增强，任何失败都不能阻断召回主路径。
 */
export async function rerankHits<T extends RerankableHit>(
  query: string,
  hits: T[],
  options: { take?: number } = {},
): Promise<T[]> {
  const take = Math.max(1, options.take ?? RERANK_INJECTION_LIMIT);
  if (hits.length <= take) {
    counters.rerankSkipped += 1;
    return hits;
  }
  const candidates = hits.slice(0, RERANK_CANDIDATE_LIMIT);
  const rest = hits.slice(RERANK_CANDIDATE_LIMIT);
  const assemble = (order: number[]): T[] =>
    [...order.map((index) => candidates[index]!), ...rest].slice(0, take);

  const cacheKey = rerankCacheKey(query, candidates);
  const cached = readRerankCache(cacheKey);
  if (cached) {
    counters.rerankExecuted += 1;
    return assemble(cached);
  }

  let handle: MemoryModelHandle;
  try {
    handle = await (rerankHooks.resolveModel ?? getMemoryModel)();
  } catch {
    counters.rerankSkipped += 1;
    return assemble(candidates.map((_, index) => index));
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('RERANK_TIMEOUT')), RERANK_TIMEOUT_MS);
  try {
    const generate = rerankHooks.generateTextFn ?? generateText;
    const result = await generate({
      model: handle.model,
      prompt: buildRerankPrompt(query, candidates),
      abortSignal: controller.signal,
    });
    const order = blendRerankOrder(candidates, parseRerankScores(result.text));
    writeRerankCache(cacheKey, order);
    counters.rerankExecuted += 1;
    return assemble(order);
  } catch {
    counters.rerankSkipped += 1;
    return assemble(candidates.map((_, index) => index));
  } finally {
    clearTimeout(timer);
  }
}
