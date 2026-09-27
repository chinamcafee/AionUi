/**
 * 个人记忆保持分（retention）体系（05 章 §2，T2.7–T2.12）。
 *
 * 三套语义分离的模型：
 * - Ebbinghaus 指数保持分：R = salience·e^(-λ·Δt_days) + σ·Σ(1/daysSince_access)，
 *   用作召回排序的乘性因子与清理候选判定（本文件计算，不落库）。
 * - 月度复利 strength：source='consolidated' 条目每满 30 天无访问 importance ×= 0.9（下限 0.1），
 *   由每日 sweep 应用（decay 写回会刷新 updatedAt，使 idle 天数归零，天然幂等）。
 * - TTL 硬过期：forget_after 到期由 sweep 直接软删（用户显式授权，无需审批）。
 *
 * 治理风格：低值清理不静默删除，只生成 delete 类整理候选，并入既有 consolidate/apply 审批流。
 */
import {
  deleteMemory,
  listMemories,
  listMemoryAccessLogs,
  updateMemory,
  MEMORY_ACCESS_LOG_CAP,
  type MemoryCategory,
  type MemoryEntry,
} from './memory-store.js';

/** retention 模型参数（借鉴 agentmemory 默认值，λ=0.01 对应半衰期 ≈69 天） */
export const RETENTION = {
  lambda: 0.01,
  sigma: 0.3,
  accessCap: MEMORY_ACCESS_LOG_CAP,
  coldThreshold: 0.15,
} as const;

/** 分类显著度先验（映射 agentmemory 的类型先验到本项目分类） */
export const CATEGORY_SALIENCE: Record<MemoryCategory, number> = {
  requirement: 0.85,
  preference: 0.8,
  event: 0.6,
  fact: 0.5,
};

/** consolidated 条目月度复利衰减率与下限（T2.10） */
export const CONSOLIDATED_MONTHLY_DECAY = 0.9;
export const CONSOLIDATED_IMPORTANCE_FLOOR = 0.1;

const DAY_MS = 24 * 60 * 60 * 1000;
/** 候选判定：创建超过 30 天才允许进入「冷且未用」候选 */
const CANDIDATE_MIN_AGE_DAYS = 30;

/** salience = min(1, max(分类先验, importance) + min(0.2, recallCount×0.02)) */
export function salienceOf(memory: Pick<MemoryEntry, 'category' | 'importance' | 'recallCount'>): number {
  const base = Math.max(CATEGORY_SALIENCE[memory.category] ?? 0.5, memory.importance);
  return Math.min(1, base + Math.min(0.2, memory.recallCount * 0.02));
}

/**
 * Ebbinghaus 保持分：R = min(1, salience·e^(-λ·Δt) + σ·Σ(1/daysSince_access))。
 * Δt 以最近一次更新/召回为准；daysSince_access 下限 1 天（单次访问最多贡献 σ）。
 */
export function retentionOf(
  memory: Pick<MemoryEntry, 'category' | 'importance' | 'recallCount' | 'updatedAt' | 'lastRecalledAt'>,
  accessAts: number[] = [],
  now = Date.now()
): number {
  const reference = Math.max(memory.updatedAt, memory.lastRecalledAt ?? 0);
  const deltaDays = Math.max(0, (now - reference) / DAY_MS);
  const accessBoost = accessAts
    .slice(0, RETENTION.accessCap)
    .reduce((sum, at) => sum + 1 / Math.max(1, (now - at) / DAY_MS), 0);
  return Math.min(1, salienceOf(memory) * Math.exp(-RETENTION.lambda * deltaDays) + RETENTION.sigma * accessBoost);
}

/** 召回排序乘性因子（T2.8）：retention ∈ [0,1] → 因子 ∈ [0.5, 1.0]，RRF 仍是主序 */
export function retentionScoreFactor(retention: number): number {
  return 0.5 + 0.5 * Math.min(1, Math.max(0, retention));
}

/** 月度复利衰减（T2.10）：importance ×= 0.9^⌊idleDays/30⌋，下限 0.1 */
export function compoundedImportance(importance: number, idleDays: number): number {
  const steps = Math.max(0, Math.floor(idleDays / 30));
  if (steps === 0) return importance;
  return Math.max(CONSOLIDATED_IMPORTANCE_FLOOR, importance * Math.pow(CONSOLIDATED_MONTHLY_DECAY, steps));
}

/** 整理候选（T2.12）：并入 consolidation review 流的 delete 类操作素材 */
export interface RetentionCandidate {
  targetId: string;
  baseVersion: number;
  reason: string;
}

/**
 * 低值清理候选（05 章 §2.4）：置顶豁免；
 * 命中任一条件即入选——①保持分 < 冷阈值且从未被召回且创建超过 30 天；②importance 衰减触底。
 */
export function buildRetentionCandidates(
  entries: MemoryEntry[],
  accessLogs: ReadonlyMap<string, number[]>,
  now = Date.now()
): RetentionCandidate[] {
  const candidates: RetentionCandidate[] = [];
  for (const entry of entries) {
    if (entry.pinned) continue;
    const retention = retentionOf(entry, accessLogs.get(entry.id) ?? [], now);
    const coldUnused =
      retention < RETENTION.coldThreshold &&
      entry.recallCount === 0 &&
      now - entry.createdAt > CANDIDATE_MIN_AGE_DAYS * DAY_MS;
    const floored = entry.importance <= CONSOLIDATED_IMPORTANCE_FLOOR + 1e-9;
    if (!coldUnused && !floored) continue;
    candidates.push({
      targetId: entry.id,
      baseVersion: entry.version,
      reason: coldUnused
        ? `保持分 ${retention.toFixed(2)} 低于阈值 ${RETENTION.coldThreshold}，从未被召回且创建超过 ${CANDIDATE_MIN_AGE_DAYS} 天`
        : `重要度已衰减至下限 ${CONSOLIDATED_IMPORTANCE_FLOOR}`,
    });
  }
  return candidates;
}

export interface RetentionSweepResult {
  ttlDeleted: number;
  decayed: number;
  candidates: RetentionCandidate[];
  summary: string;
}

/**
 * 每日 retention sweep（T2.11）：重算 retention → TTL 到期软删 → consolidated 复利衰减 → 生成整理候选。
 * 幂等：连跑两次，第二次无 TTL 可删、无新 decay 档位（衰减写回刷新 updatedAt），候选集合一致。
 */
export async function runMemoryRetentionSweep(now = Date.now()): Promise<RetentionSweepResult> {
  const entries = await listMemories();
  const accessLogs = await listMemoryAccessLogs(entries.map((entry) => entry.id));

  // 1. TTL 到期软删（用户显式授权，无需审批）
  let ttlDeleted = 0;
  const remaining: MemoryEntry[] = [];
  for (const entry of entries) {
    if (entry.forgetAfter !== null && entry.forgetAfter <= now) {
      await deleteMemory(entry.id, entry.version);
      ttlDeleted += 1;
    } else {
      remaining.push(entry);
    }
  }

  // 2. consolidated 条目月度复利衰减（T2.10，以 last_recalled_at 或 updated_at 为准）
  let decayed = 0;
  for (const entry of remaining) {
    if (entry.source !== 'consolidated') continue;
    const idleDays = (now - (entry.lastRecalledAt ?? entry.updatedAt)) / DAY_MS;
    const next = compoundedImportance(entry.importance, idleDays);
    if (next < entry.importance - 1e-9) {
      await updateMemory(entry.id, { importance: next }, entry.version);
      entry.importance = next;
      decayed += 1;
    }
  }

  // 3. 生成整理候选（T2.12）：不静默删除，候选由 consolidation review 流审批处置
  const candidates = buildRetentionCandidates(remaining, accessLogs, now);
  const summary = `记忆保持巡检完成：TTL 到期软删 ${ttlDeleted} 条，复利衰减 ${decayed} 条，低值整理候选 ${candidates.length} 条（可在记忆整理审批中处置）。`;
  return { ttlDeleted, decayed, candidates, summary };
}
