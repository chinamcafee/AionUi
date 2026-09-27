import type { MemoryScope } from './memory-store.js';
import { retrieveHybridMemories } from './memory-search.js';
import { callTeamGateway, currentTeamGatewayScope } from './team-gateway-runtime.js';
import { observeTeamMemoryRevision } from './team-memory-invalidation.js';
import type { KnowledgeOrganizerFilter } from './request-context-options.js';

export interface ContextHit {
  id: string;
  kind: 'personal_memory' | 'team_memory' | 'personal_document' | 'team_document';
  title: string;
  text: string;
  score: number;
  sourceId: string;
  version: string;
  mandatory: boolean;
  queryMatched: boolean;
  sensitivity?: string;
  semanticType?:
    | 'team_policy'
    | 'personal_requirement'
    | 'team_fact'
    | 'personal_preference'
    | 'personal_fact'
    | 'knowledge';
  /** T3.8 图谱流命中标注（"经实体 X 关联"），随注入文案与 UI 透传 */
  viaGraph?: string;
}

export interface CloudContextResult {
  teamMemories: ContextHit[];
  knowledgeHits: ContextHit[];
  teamMemoryActivationEpoch: number;
  teamMemoryRevision: number;
  tenantPolicyVersion: number;
  teamPolicyVersion: number;
  retrievalTraceId: string;
  degraded: string[];
}

export interface ParallelContextResult {
  personalHits: ContextHit[];
  cloud: CloudContextResult | null;
  degraded: string[];
}

function personalRetriever(query: string, scope: MemoryScope | MemoryScope[], limit: number) {
  return retrieveHybridMemories(query, scope, limit).then((hits): ContextHit[] =>
    hits.map(({ memory, score, channels, viaGraph }) => ({
      id: memory.id,
      kind: 'personal_memory',
      title: memory.title,
      text: memory.content,
      score,
      sourceId: memory.id,
      version: `v${memory.version}`,
      mandatory: memory.pinned,
      queryMatched: channels.some((channel) => channel !== 'pinned'),
      semanticType:
        memory.category === 'requirement'
          ? 'personal_requirement'
          : memory.category === 'preference'
            ? 'personal_preference'
            : 'personal_fact',
      ...(viaGraph ? { viaGraph } : {}),
    }))
  );
}

async function cloudRetriever(
  query: string,
  includeKnowledge: boolean,
  conversationMode: 'chat' | 'coding',
  teamMemoryLimit = 8,
  knowledgeOrganizerFilter: KnowledgeOrganizerFilter = { groupIds: [], tagIds: [] }
): Promise<CloudContextResult> {
  const { tenantId, teamId } = currentTeamGatewayScope();
  const data = (await callTeamGateway(
    `/api/v1/tenants/${encodeURIComponent(tenantId)}/teams/${encodeURIComponent(teamId)}/context:retrieve`,
    {
      method: 'POST',
      signal: AbortSignal.timeout(8_000),
      body: JSON.stringify({
        query,
        conversationMode,
        includeTeamMemory: true,
        includeKnowledge,
        organizerFilter: knowledgeOrganizerFilter,
        limits: { teamMemory: teamMemoryLimit, knowledge: 12 },
      }),
    }
  )) as CloudContextResult;
  if (
    !data ||
    !Array.isArray(data.teamMemories) ||
    !Array.isArray(data.knowledgeHits) ||
    !Array.isArray(data.degraded) ||
    typeof data.retrievalTraceId !== 'string' ||
    typeof data.teamMemoryActivationEpoch !== 'number' ||
    typeof data.teamMemoryRevision !== 'number' ||
    [...data.teamMemories, ...data.knowledgeHits].some((hit) => typeof hit.queryMatched !== 'boolean')
  ) {
    throw new Error('CONTEXT_BROKER_RESPONSE_INVALID');
  }
  observeTeamMemoryRevision(data.teamMemoryRevision);
  return data;
}

/**
 * 通道内精排器（03 章 rerank）：对个人/团队候选各自重排并截取 top-take。
 * 约束：只在单通道内重排，不做跨通道重排（team_policy > personal_requirement > …
 * 的优先级不变量是治理语义）；实现方必须永不抛异常（失败 → 原序直通）。
 */
export type ContextChannelReranker = (query: string, hits: ContextHit[], take: number) => Promise<ContextHit[]>;

/** PersonalRetriever 与 CloudRetriever 从同一归一化 Query 并行启动，任一路失败不阻断另一侧。 */
export async function retrieveParallelContext(
  query: string,
  scope: MemoryScope | MemoryScope[] = 'chat',
  includeKnowledge = true,
  conversationMode: 'chat' | 'coding' = Array.isArray(scope) && scope.includes('code') ? 'coding' : 'chat',
  options: { rerank?: ContextChannelReranker; knowledgeOrganizerFilter?: KnowledgeOrganizerFilter } = {}
): Promise<ParallelContextResult> {
  const normalized = query.normalize('NFKC').trim().slice(0, 16_000);
  if (!normalized) return { personalHits: [], cloud: null, degraded: [] };
  // T2.4：启用精排时召回深度放宽到 top-20（02 章融合深度），精排后各通道截取 top-8；
  // 未启用精排保持原 top-8 行为不变。个人精排与团队 retrieve 在同一 Promise.all 内并行。
  const { rerank } = options;
  const candidateDepth = rerank ? 20 : 8;
  const [personal, cloud] = await Promise.allSettled([
    personalRetriever(normalized, scope, candidateDepth).then((hits) => (rerank ? rerank(normalized, hits, 8) : hits)),
    cloudRetriever(
      normalized,
      includeKnowledge,
      conversationMode,
      candidateDepth,
      options.knowledgeOrganizerFilter
    ).then(async (data) => (rerank ? { ...data, teamMemories: await rerank(normalized, data.teamMemories, 8) } : data)),
  ]);
  const degraded: string[] = [];
  if (personal.status === 'rejected') degraded.push('personal_retriever_unavailable');
  if (cloud.status === 'rejected') {
    const reason =
      cloud.reason instanceof Error ? `${cloud.reason.name}:${cloud.reason.message}` : String(cloud.reason);
    console.warn(`[context-broker] cloud retrieval failed: ${reason.slice(0, 300)}`);
    degraded.push(
      cloud.reason instanceof Error && cloud.reason.name === 'TimeoutError'
        ? 'cloud_timeout'
        : 'cloud_retriever_unavailable'
    );
  }
  if (cloud.status === 'fulfilled') degraded.push(...cloud.value.degraded);
  return {
    personalHits: personal.status === 'fulfilled' ? personal.value : [],
    cloud: cloud.status === 'fulfilled' ? cloud.value : null,
    degraded: [...new Set(degraded)],
  };
}

/**
 * T2.14 团队记忆召回回写（05 章 §3）：注入后批量上报 memoryIds，
 * team-server 端执行 recall_count+1 / last_recalled_at=now()。fire-and-forget：
 * 永不抛异常（失败静默，统计性回写由后续注入兜底），供回合结束钩子 void 调用。
 */
export async function reportTeamMemoryRecall(memoryIds: readonly string[]): Promise<void> {
  if (memoryIds.length === 0) return;
  try {
    const { tenantId, teamId } = currentTeamGatewayScope();
    await callTeamGateway(
      `/api/v1/tenants/${encodeURIComponent(tenantId)}/teams/${encodeURIComponent(teamId)}/context:recall-feedback`,
      {
        method: 'POST',
        signal: AbortSignal.timeout(2_500),
        body: JSON.stringify({ memoryIds: [...new Set(memoryIds)] }),
      }
    );
  } catch {
    /* 失败静默：统计性回写，不影响回复链路 */
  }
}

/** 原始分区渲染仅供诊断；生产 Agent 使用 T707 的 fuseAndBudgetContext。 */
export function renderParallelContext(result: ParallelContextResult): string {
  const lines: string[] = [];
  if (result.personalHits.length > 0) {
    lines.push('## 个人记忆');
    for (const hit of result.personalHits) lines.push(`- [P:${hit.sourceId}@${hit.version}] ${hit.title}：${hit.text}`);
  }
  if (result.cloud?.teamMemories.length) {
    lines.push('', '## 当前团队正式记忆');
    for (const hit of result.cloud.teamMemories) {
      lines.push(`- [T:${hit.sourceId}@${hit.version}]${hit.mandatory ? '[policy]' : ''} ${hit.title}：${hit.text}`);
    }
  }
  if (result.cloud?.knowledgeHits.length) {
    lines.push('', '## 知识库检索结果');
    for (const hit of result.cloud.knowledgeHits)
      lines.push(`- [K:${hit.sourceId}] ${hit.title ? `${hit.title}：` : ''}${hit.text}`);
  }
  if (result.degraded.length > 0) lines.push('', `<!-- context-degraded:${result.degraded.join(',')} -->`);
  return lines.join('\n').trim();
}
