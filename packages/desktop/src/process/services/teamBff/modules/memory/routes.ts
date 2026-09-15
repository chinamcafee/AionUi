// AionUi 移植：个人记忆 BFF 路由（源 client server/main.ts 358-461、744-751）。
// 差异：挂载前缀 /teamapi/memories*（AionUi 约定）；账号前置中间件沿用上游（无 subject → 409）；
// schedule 系列（Mastra 定时）不在移植范围。错误码与响应形状与上游一致，便于 MemoryPage UI 平移。

import { Hono } from 'hono';
import {
  listMemories, createMemory, updateMemory, deleteMemory, listRuns,
  type MemoryCategory, type MemoryScope,
} from './memory-store.js';
import { applyConsolidationOperations, consolidateMemories, type ConsolidationMode, type ConsolidationOperation } from './memory-service.js';
import { rebuildMemorySearchProjection } from './memory-search.js';
import { judgeMemorySimilarity } from './memory-dedup.js';
import { debugRetrieve } from './memory-context.js';
import { retrieveParallelContext, renderParallelContext } from './context-broker.js';
import { getMemory } from './memory-store.js';
import { accountRuntime } from './account-runtime.js';
import { callTeamGateway, currentTeamGatewayScope } from './team-gateway-runtime.js';
import { teamMemoryInvalidationSnapshot } from './team-memory-invalidation.js';
import { randomUUID } from 'node:crypto';

function parseTeamMemoryScopeFilter(value: string | undefined): MemoryScope | undefined {
  if (value === undefined) return undefined;
  if (value === 'chat' || value === 'code') return value;
  throw new Error('TEAM_MEMORY_SCOPE_FILTER_INVALID');
}

function teamMemoryListQuery(value: string | undefined) {
  const scope = parseTeamMemoryScopeFilter(value);
  const query = new URLSearchParams({ limit: '100' });
  if (scope) query.set('memoryScope', scope);
  return query.toString();
}

function isMemoryScope(value: unknown): value is MemoryScope {
  return value === 'chat' || value === 'code';
}

function isConsolidationScope(value: unknown): value is MemoryScope | 'all' {
  return value === 'all' || isMemoryScope(value);
}

function accountRequestSignal(request: Request) {
  return AbortSignal.any([request.signal, accountRuntime.signal()]);
}

function isAccountContextError(error: unknown) {
  return error instanceof Error && [
    'ACCOUNT_RUNTIME_REQUIRED', 'ACTIVE_TEAM_REQUIRED', 'RESOURCE_CONTEXT_MISMATCH',
    'THREAD_CONTEXT_MISMATCH', 'SESSION_NOT_FOUND', 'MEMORY_NOT_FOUND',
    'MEMORY_BASE_VERSION_REQUIRED', 'MEMORY_VERSION_CONFLICT',
    'PROJECT_CAPABILITY_INVALID',
    'KNOWLEDGE_FILTER_INVALID',
  ].includes(error.message);
}

export function createMemoryRoutes() {
  const app = new Hono();

  app.use('/memories/*', async (c, next) => {
    let active = false;
    try {
      active = accountRuntime.currentSubject() !== null;
    } catch {
      active = false;
    }
    if (!active) {
      c.header('Cache-Control', 'no-store');
      return c.json({ error: 'ACCOUNT_RUNTIME_REQUIRED' }, 409);
    }
    await next();
  });

  app.get('/memories', async (c) => {
    c.header('Cache-Control', 'no-store');
    const category = c.req.query('category') as MemoryCategory | undefined;
    const search = c.req.query('search') ?? undefined;
    const scopeRaw = c.req.query('scope');
    let scope: MemoryScope | MemoryScope[] | undefined;
    if (scopeRaw) {
      const scopes = scopeRaw.split(',').filter(Boolean);
      if (scopes.some((s) => !isMemoryScope(s))) return c.json({ error: 'scope 必须是 chat、code 或 chat,code' }, 400);
      scope = scopes as MemoryScope[];
    }
    return c.json({ memories: await listMemories(category, search, scope) });
  });

  app.post('/memories', async (c) => {
    const body = await c.req.json() as { title: string; content: string; category?: MemoryCategory; scope?: MemoryScope; forgetAfter?: unknown };
    if (!body.title?.trim() || !body.content?.trim()) return c.json({ error: '标题与内容不能为空' }, 400);
    if (body.scope !== undefined && !isMemoryScope(body.scope)) return c.json({ error: 'scope 必须是 chat 或 code' }, 400);
    const forgetAfter = typeof body.forgetAfter === 'number' && Number.isFinite(body.forgetAfter) ? body.forgetAfter : null;
    return c.json(await createMemory({ ...body, forgetAfter }));
  });

  app.post('/memories/check', async (c) => {
    const { title, content, category, scope } = await c.req.json() as {
      title: string; content: string; category?: MemoryCategory; scope?: MemoryScope;
    };
    if (!title?.trim() || !content?.trim()) return c.json({ error: '标题与内容不能为空' }, 400);
    const result = await judgeMemorySimilarity({
      title, content,
      category: (category ?? 'fact') as MemoryCategory,
      scope: (scope ?? 'chat') as MemoryScope,
    });
    return c.json(result);
  });

  app.patch('/memories/:id', async (c) => {
    const body = await c.req.json() as Record<string, unknown> & { baseVersion?: unknown };
    const { baseVersion, ...patch } = body;
    if (patch.scope !== undefined && !isMemoryScope(patch.scope)) {
      return c.json({ error: 'scope 必须是 chat 或 code' }, 400);
    }
    try {
      const memory = await updateMemory(c.req.param('id'), patch as Parameters<typeof updateMemory>[1], Number(baseVersion));
      return c.json({ updated: true, memory });
    } catch (error) {
      const code = error instanceof Error ? error.message : 'MEMORY_UPDATE_FAILED';
      return c.json({ error: code }, isAccountContextError(error) ? 409 : 400);
    }
  });

  app.delete('/memories/:id', async (c) => {
    const body = await c.req.json().catch(() => ({})) as { baseVersion?: unknown };
    try {
      const memory = await deleteMemory(c.req.param('id'), Number(body.baseVersion));
      return c.json({ deleted: true, memory });
    } catch (error) {
      const code = error instanceof Error ? error.message : 'MEMORY_DELETE_FAILED';
      return c.json({ error: code }, isAccountContextError(error) ? 409 : 400);
    }
  });

  app.post('/memories/consolidate', async (c) => {
    let scope: MemoryScope | 'all' = 'all';
    let mode: ConsolidationMode = 'auto';
    try {
      const body = await c.req.json().catch(() => ({})) as { scope?: unknown; mode?: unknown };
      if (body.scope !== undefined) {
        if (!isConsolidationScope(body.scope)) return c.json({ error: 'scope 必须是 all、chat 或 code' }, 400);
        scope = body.scope;
      }
      if (body.mode !== undefined) {
        if (body.mode !== 'auto' && body.mode !== 'review') return c.json({ error: 'mode 必须是 auto 或 review' }, 400);
        mode = body.mode;
      }
    } catch { /* keep default */ }
    const result = await consolidateMemories(scope, mode, {
      abortSignal: accountRequestSignal(c.req.raw),
    });
    return c.json(result);
  });

  app.post('/memories/consolidate/apply', async (c) => {
    const body = await c.req.json().catch(() => ({})) as { operations?: unknown };
    if (!Array.isArray(body.operations)) return c.json({ error: 'operations 必须是数组' }, 400);
    try {
      const appliedCount = await applyConsolidationOperations(body.operations as ConsolidationOperation[]);
      return c.json({ appliedCount });
    } catch (error) {
      const code = error instanceof Error ? error.message : 'MEMORY_CONSOLIDATION_APPLY_FAILED';
      return c.json({ error: code }, isAccountContextError(error) ? 409 : 400);
    }
  });

  app.get('/memories/runs', async (c) => {
    c.header('Cache-Control', 'no-store');
    const scope = c.req.query('scope');
    if (scope !== undefined && !isConsolidationScope(scope)) {
      return c.json({ error: 'scope 必须是 all、chat 或 code' }, 400);
    }
    return c.json({ runs: await listRuns(scope) });
  });

  app.post('/memories/reindex', (c) => {
    void rebuildMemorySearchProjection().catch(() => {});
    return c.json({ status: 'rebuilding' });
  });

  app.post('/memories/retrieve-test', async (c) => {
    const { userInput, scope } = await c.req.json() as { userInput: string; scope?: MemoryScope | MemoryScope[] };
    const normalizedScope = Array.isArray(scope)
      ? scope.filter(isMemoryScope)
      : isMemoryScope(scope) ? scope : 'chat';
    return c.json(await debugRetrieve(userInput, normalizedScope));
  });

  // ── 配对合并（E-18）：新增时 /check 检出 high/partial 相似 → 执行两两合并 ──
  app.post('/memories/merge-pair', async (c) => {
    const body = await c.req.json().catch(() => null) as {
      sourceId?: unknown; targetId?: unknown; mergedTitle?: unknown; mergedContent?: unknown; category?: unknown;
    } | null;
    if (typeof body?.sourceId !== 'string' || typeof body?.targetId !== 'string' ||
        typeof body?.mergedTitle !== 'string' || !body.mergedTitle.trim() ||
        typeof body?.mergedContent !== 'string' || !body.mergedContent.trim()) {
      return c.json({ error: 'MERGE_PAIR_INPUT_INVALID' }, 400);
    }
    try {
      const { applyConsolidationOperations } = await import('./memory-service.js');
      const op: import('./memory-service.js').ConsolidationOperation = {
        id: `merge-pair-${body.sourceId}-${body.targetId}`,
        type: 'merge',
        targetId: body.targetId,
        sourceIds: [body.sourceId],
        title: body.mergedTitle.trim().slice(0, 200),
        content: body.mergedContent.trim().slice(0, 50_000),
        ...(typeof body.category === 'string' && body.category.trim() ? { category: body.category.trim() } : {}),
        reason: '用户确认合并（新增时相似检出）',
      };
      const appliedCount = await applyConsolidationOperations([op]);
      return c.json({ appliedCount });
    } catch (error) {
      const code = error instanceof Error ? error.message : 'MERGE_PAIR_FAILED';
      return c.json({ error: code }, isAccountContextError(error) ? 409 : 400);
    }
  });

  // ── 记忆抽取（T2.10）：回合结束后由 renderer 上送本轮 user/assistant 文本，未绑定模型则跳过 ──
  app.post('/memories/extract', async (c) => {
    if (!accountRuntime.currentSubject()) return c.json({ error: 'ACCOUNT_RUNTIME_REQUIRED' }, 409);
    const body = await c.req.json().catch(() => ({})) as { userInput?: unknown; assistantText?: unknown };
    if (typeof body.userInput !== 'string' || typeof body.assistantText !== 'string') {
      return c.json({ error: 'userInput/assistantText 必须是字符串' }, 400);
    }
    const { autoExtractMemory } = await import('./memory-extract.js');
    return c.json(await autoExtractMemory(body.userInput, body.assistantText));
  });

  // ── 上下文组装（T2.7）：个人记忆 +（M4/M5 后）团队记忆/知识并行召回 → 渲染注入块 ──
  app.post('/context/assemble', async (c) => {
    if (!accountRuntime.currentSubject()) return c.json({ error: 'ACCOUNT_RUNTIME_REQUIRED' }, 409);
    const body = await c.req.json().catch(() => ({})) as {
      query?: unknown; scope?: unknown; includeKnowledge?: unknown; conversationMode?: unknown;
      knowledgeOrganizerFilter?: unknown;
    };
    const query = typeof body.query === 'string' ? body.query : '';
    if (!query.trim()) return c.json({ error: 'query 不能为空' }, 400);
    const scope = Array.isArray(body.scope)
      ? (body.scope.filter(isMemoryScope) as MemoryScope[])
      : isMemoryScope(body.scope) ? body.scope : 'chat';
    const conversationMode = body.conversationMode === 'coding' ? 'coding' as const : 'chat' as const;
    const result = await retrieveParallelContext(
      query, scope, body.includeKnowledge !== false, conversationMode,
      { knowledgeOrganizerFilter: normalizeOrganizerFilter(body.knowledgeOrganizerFilter) },
    );
    return c.json({ result, rendered: renderParallelContext(result) });
  });

  // ── 团队记忆（T3.1/T3.2，只经 team-server Gateway；Renderer 不持有 Access Token）──
  app.get('/team-memory-invalidation', (c) => c.json({ state: teamMemoryInvalidationSnapshot() }));

  app.get('/team-memories', async (c) => {
    c.header('Cache-Control', 'no-store');
    try {
      const { tenantId, teamId } = currentTeamGatewayScope();
      const query = teamMemoryListQuery(c.req.query('memoryScope'));
      const memories = await callTeamGateway(
        `/api/v1/tenants/${encodeURIComponent(tenantId)}/teams/${encodeURIComponent(teamId)}/team-memories?${query}`,
      );
      return c.json({ memories });
    } catch (error) {
      if (error instanceof Error && error.message === 'TEAM_MEMORY_SCOPE_FILTER_INVALID') {
        return c.json({ error: error.message }, 400);
      }
      return c.json({ error: error instanceof Error ? error.message : 'TEAM_MEMORY_UNAVAILABLE' }, 503);
    }
  });

  app.post('/team-memories', async (c) => {
    const body = await c.req.json().catch(() => null) as {
      title?: unknown; content?: unknown; category?: unknown; memoryScope?: unknown; tags?: unknown; personalMemoryId?: unknown;
    } | null;
    if (typeof body?.title !== 'string' || !body.title.trim() || body.title.length > 200 ||
        typeof body.content !== 'string' || !body.content.trim() || body.content.length > 50_000 ||
        typeof body.category !== 'string' || !body.category.trim() || body.category.length > 80 ||
        (typeof body.personalMemoryId !== 'string' && !isMemoryScope(body.memoryScope)) ||
        !Array.isArray(body.tags) || body.tags.length > 20 || body.tags.some((tag) => typeof tag !== 'string')) {
      return c.json({ error: 'TEAM_MEMORY_INPUT_INVALID' }, 400);
    }
    const tags = [...new Set(body.tags.map((tag: string) => String(tag).trim()))];
    if (tags.some((tag) => !tag || tag.length > 80)) return c.json({ error: 'TEAM_MEMORY_INPUT_INVALID' }, 400);
    try {
      const personalMemory = typeof body.personalMemoryId === 'string' ? await getMemory(body.personalMemoryId) : null;
      if (body.personalMemoryId !== undefined && !personalMemory) return c.json({ error: 'PERSONAL_MEMORY_NOT_FOUND' }, 404);
      const { tenantId, teamId } = currentTeamGatewayScope();
      const base = `/api/v1/tenants/${encodeURIComponent(tenantId)}/teams/${encodeURIComponent(teamId)}`;
      const created = await callTeamGateway(`${base}/team-memories`, {
        method: 'POST',
        headers: { 'Idempotency-Key': randomUUID() },
        body: JSON.stringify({
          title: personalMemory?.title ?? body.title.trim(),
          content: personalMemory?.content ?? body.content.trim(),
          category: personalMemory?.category ?? body.category.trim(),
          memoryScope: personalMemory?.scope ?? body.memoryScope,
          tags,
          source: personalMemory
            ? { type: 'personal_memory', reference: { localReference: personalMemory.id, client: 'aionui-desktop', via: 'memory_center' } }
            : { type: 'manual', reference: { client: 'aionui-desktop', via: 'memory_center' } },
        }),
      }) as { version?: { id?: string } };
      if (!created.version?.id) throw new Error('TEAM_MEMORY_RESPONSE_INVALID');
      try {
        const submitted = await callTeamGateway(
          `${base}/team-memory-versions/${encodeURIComponent(created.version.id)}:submit`,
          { method: 'POST', body: JSON.stringify({}) },
        );
        return c.json({ candidate: created, submitted }, 201);
      } catch (submitError) {
        // Candidate 已可靠落库时不诱导 Renderer 重试创建重复草稿；UI 刷新后展示 Draft 状态（上游语义）
        return c.json({
          candidate: created, submitted: null,
          warning: submitError instanceof Error ? submitError.message : 'TEAM_MEMORY_REVIEW_SUBMIT_FAILED',
        }, 202);
      }
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'TEAM_MEMORY_SUBMIT_FAILED' }, 409);
    }
  });

  return app;
}

function normalizeOrganizerFilter(value: unknown): { groupIds: string[]; tagIds: string[] } | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('KNOWLEDGE_FILTER_INVALID');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== 'groupIds' && key !== 'tagIds')) throw new Error('KNOWLEDGE_FILTER_INVALID');
  const pick = (key: 'groupIds' | 'tagIds') =>
    Array.isArray(record[key]) && (record[key] as unknown[]).every((v) => typeof v === 'string')
      ? (record[key] as string[])
      : undefined;
  const groupIds = pick('groupIds');
  const tagIds = pick('tagIds');
  if (!groupIds && !tagIds) return undefined;
  return { groupIds: groupIds ?? [], tagIds: tagIds ?? [] };
}
