import { createHash } from 'node:crypto';
import { cosineSimilarity, tokenizeForMemorySearch } from './memory-search.js';
import type { ContextHit, ParallelContextResult } from './context-broker.js';

// 轻量文本指纹向量（96 维 feature-hash 字符 n-gram）：仅用于 context 去重/冲突检测的同步相似度，
// 与记忆召回的语义 embedding 无关（召回已切换 MiniLM，见 memory-search.ts）
const FINGERPRINT_DIMENSIONS = 96;

function hash32(value: string, seed: number): number {
  let hash = seed >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function buildTextFingerprint(text: string): number[] {
  const vector = Array.from({ length: FINGERPRINT_DIMENSIONS }, () => 0);
  for (const token of tokenizeForMemorySearch(text)) {
    const slot = hash32(token, 2166136261) % FINGERPRINT_DIMENSIONS;
    vector[slot] += (hash32(token, 0x9e3779b1) & 1) === 0 ? 1 : -1;
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return norm === 0 ? vector : vector.map((value) => value / norm);
}

export type ContextSemanticType =
  | 'team_policy' | 'personal_requirement' | 'team_fact'
  | 'personal_preference' | 'personal_fact' | 'knowledge';

export interface FusedContextHit extends ContextHit {
  semanticType: ContextSemanticType;
  normalizedScore: number;
  contentHash: string;
  provenance: string[];
  conflictsWith?: string;
  estimatedTokens: number;
}

export interface ContextBudget {
  contextWindow: number;
  personal: number;
  team: number;
  knowledge: number;
}

export interface FusedContextResult {
  hits: FusedContextHit[];
  budget: ContextBudget;
  usedTokens: { personal: number; team: number; knowledge: number };
  omitted: number;
  degraded: string[];
}

const priority: Record<ContextSemanticType, number> = {
  team_policy: 6,
  personal_requirement: 5,
  team_fact: 4,
  personal_preference: 3,
  personal_fact: 2,
  knowledge: 1,
};

const sourcePriority: Record<ContextHit['kind'], number> = {
  personal_memory: 3,
  team_memory: 2,
  personal_document: 1,
  team_document: 1,
};

function canonicalText(hit: ContextHit) {
  return `${hit.title}\n${hit.text}`.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

function semanticType(hit: ContextHit): ContextSemanticType {
  const declared = (hit as ContextHit & { semanticType?: ContextSemanticType }).semanticType;
  if (declared && declared in priority) return declared;
  if (hit.kind === 'team_memory') return hit.mandatory ? 'team_policy' : 'team_fact';
  if (hit.kind === 'personal_memory') return hit.mandatory ? 'personal_requirement' : 'personal_fact';
  return 'knowledge';
}

function normalizedByKind(hits: ContextHit[]) {
  const groups = new Map<ContextHit['kind'], ContextHit[]>();
  for (const hit of hits) groups.set(hit.kind, [...(groups.get(hit.kind) ?? []), hit]);
  const scores = new Map<string, number>();
  for (const group of groups.values()) {
    const sorted = [...group].sort((left, right) => right.score - left.score);
    const min = Math.min(...sorted.map((hit) => hit.score));
    const max = Math.max(...sorted.map((hit) => hit.score));
    sorted.forEach((hit, index) => scores.set(hit.id, max > min
      ? (hit.score - min) / (max - min)
      : 1 - (index / Math.max(1, sorted.length)) * 0.25));
  }
  return scores;
}

function better(left: FusedContextHit, right: FusedContextHit) {
  return sourcePriority[left.kind] - sourcePriority[right.kind] ||
    priority[left.semanticType] - priority[right.semanticType] ||
    Number(left.mandatory) - Number(right.mandatory) ||
    left.normalizedScore - right.normalizedScore;
}

function negated(text: string) {
  return /(?:不|不得|禁止|严禁|无需|不能|no|not|never|mustn['’]?t)/i.test(text);
}

export function estimateContextTokens(text: string) {
  const chars = [...text].length;
  // eslint-disable-next-line no-control-regex -- 上游 token 估算逻辑原样保留
  const latin = (text.match(/[\x00-\x7f]/g) ?? []).length;
  return Math.max(1, Math.ceil((chars - latin) / 1.7 + latin / 4));
}

export function resolveContextWindow() {
  const configured = Number(process.env.ZSL_MODEL_CONTEXT_WINDOW ?? 32768);
  return Number.isSafeInteger(configured) && configured >= 4096 && configured <= 2_000_000 ? configured : 32768;
}

export function contextBudget(contextWindow: number, includeKnowledge: boolean): ContextBudget {
  const window = Math.max(4096, Math.min(2_000_000, Math.trunc(contextWindow)));
  return {
    contextWindow: window,
    personal: Math.floor(window * 0.15),
    team: Math.floor(window * 0.20),
    knowledge: includeKnowledge ? Math.floor(window * 0.25) : 0,
  };
}

function exactAndSemanticDedupe(hits: FusedContextHit[]) {
  const exact = new Map<string, FusedContextHit>();
  for (const hit of hits) {
    const previous = exact.get(hit.contentHash);
    if (!previous) exact.set(hit.contentHash, hit);
    else {
      const kept = better(hit, previous) > 0 ? hit : previous;
      kept.provenance = [...new Set([...previous.provenance, ...hit.provenance])];
      exact.set(hit.contentHash, kept);
    }
  }
  const selected: FusedContextHit[] = [];
  const vectors = new Map<string, number[]>();
  for (const candidate of [...exact.values()].sort((left, right) => better(right, left))) {
    const vector = buildTextFingerprint(canonicalText(candidate));
    const duplicate = selected.find((hit) => {
      if (negated(hit.text) !== negated(candidate.text)) return false;
      return cosineSimilarity(vectors.get(hit.id)!, vector) >= 0.92;
    });
    if (!duplicate) {
      selected.push(candidate);
      vectors.set(candidate.id, vector);
    } else {
      duplicate.provenance = [...new Set([...duplicate.provenance, ...candidate.provenance])];
    }
  }
  for (let index = 0; index < selected.length; index += 1) {
    const hit = selected[index]!;
    const vector = vectors.get(hit.id)!;
    const conflict = selected.slice(0, index).find((higher) =>
      negated(higher.text) !== negated(hit.text) &&
      cosineSimilarity(vectors.get(higher.id)!, vector) >= 0.72 &&
      (sourcePriority[higher.kind] > sourcePriority[hit.kind] ||
        (sourcePriority[higher.kind] === sourcePriority[hit.kind] && priority[higher.semanticType] > priority[hit.semanticType])));
    if (conflict) hit.conflictsWith = conflict.id;
  }
  return selected;
}

export function fuseAndBudgetContext(
  result: ParallelContextResult,
  options: { contextWindow?: number; includeKnowledge?: boolean } = {},
): FusedContextResult {
  const all = [
    ...result.personalHits,
    ...(result.cloud?.teamMemories ?? []),
    ...(options.includeKnowledge === false ? [] : (result.cloud?.knowledgeHits ?? [])),
  ];
  const normalized = normalizedByKind(all);
  const prepared = all.map((hit): FusedContextHit => {
    const canonical = canonicalText(hit);
    return {
      ...hit,
      semanticType: semanticType(hit),
      normalizedScore: normalized.get(hit.id) ?? 0,
      contentHash: createHash('sha256').update(canonical).digest('hex'),
      provenance: [`${hit.kind}:${hit.sourceId}@${hit.version}`],
      estimatedTokens: estimateContextTokens(`${hit.title}\n${hit.text}`),
    };
  });
  const deduped = exactAndSemanticDedupe(prepared).sort((left, right) => better(right, left));
  const budget = contextBudget(options.contextWindow ?? resolveContextWindow(), options.includeKnowledge !== false);
  const usedTokens = { personal: 0, team: 0, knowledge: 0 };
  const selected: FusedContextHit[] = [];
  for (const hit of deduped) {
    const bucket = hit.kind === 'personal_memory' ? 'personal'
      : hit.kind === 'team_memory' ? 'team' : 'knowledge';
    const mustKeep = hit.semanticType === 'team_policy' || hit.semanticType === 'personal_requirement';
    if (!mustKeep && usedTokens[bucket] + hit.estimatedTokens > budget[bucket]) continue;
    selected.push(hit);
    usedTokens[bucket] += hit.estimatedTokens;
  }
  return {
    hits: selected,
    budget,
    usedTokens,
    omitted: deduped.length - selected.length,
    degraded: result.degraded,
  };
}

export function renderFusedContext(result: FusedContextResult): string {
  const sections: Array<[string, FusedContextHit[]]> = [
    ['## 个人记忆', result.hits.filter((hit) => hit.kind === 'personal_memory')],
    ['## 当前团队正式记忆', result.hits.filter((hit) => hit.kind === 'team_memory')],
    ['## 知识库检索结果', result.hits.filter((hit) => hit.kind.endsWith('_document'))],
  ];
  const lines: string[] = [];
  for (const [heading, hits] of sections) {
    if (hits.length === 0) continue;
    if (lines.length > 0) lines.push('');
    lines.push(heading);
    for (const hit of hits) {
      const prefix = hit.kind === 'personal_memory' ? `P:${hit.sourceId}@${hit.version}`
        : hit.kind === 'team_memory' ? `T:${hit.sourceId}@${hit.version}` : `K:${hit.sourceId}`;
      const flags = [hit.semanticType === 'team_policy' ? 'policy' : '', hit.conflictsWith ? `conflicts:${hit.conflictsWith}` : '']
        .filter(Boolean).map((flag) => `[${flag}]`).join('');
      lines.push(`- [${prefix}]${flags} ${hit.title ? `${hit.title}：` : ''}${hit.text}${hit.viaGraph ? `（${hit.viaGraph}）` : ''}`);
    }
  }
  if (result.degraded.length > 0) lines.push('', `<!-- context-degraded:${result.degraded.join(',')} -->`);
  return lines.join('\n').trim();
}
