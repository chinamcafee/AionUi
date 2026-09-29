/**
 * 记忆整理服务。
 *
 * 「整理」= 用「模型绑定」中 memory 场景绑定的模型，对现有个人记忆条目做归并 / 去重 /
 * 分类 / 提炼，生成整理后的结果，并留下一整理记录。
 *
 * 关键约束（用户要求）：
 * - 一切 LLM 调用必须使用「模型绑定」里 memory 场景绑定的 API 渠道与模型名。
 * - 启用判定：以「模型绑定」页是否绑定 memory 模型为准——
 *   已绑定则真实调用绑定模型整理；未绑定则仅做本地结构化归并（基础去重）并提示需绑定。
 *   （不再使用 process.env.LLM_ENABLED，统一以「模型绑定」页设置为准。）
 *
 * 设计参见 doc/memorySystem/02-long-term-memory-evolution.md（定期整理 = OM Reflector 思路的
 * 应用层实现）。
 */
import { generateText, type LanguageModel } from 'ai';
import {
  listMemories,
  listMemoryAccessLogs,
  listMemoryCategories,
  createMemoryCategory,
  findMemoryCategoryByName,
  countMemoriesByCategory,
  updateMemory,
  deleteMemory,
  recordRun,
  MAX_CATEGORY_NAME_LENGTH,
  type MemoryEntry,
  type MemoryScope,
} from './memory-store.js';
import { buildRetentionCandidates } from './memory-retention.js';
import { getMemoryModel } from './memory-model-util.js';

export interface ConsolidateResult {
  status: 'success' | 'skipped' | 'failed';
  summary: string;
  beforeCount: number;
  afterCount: number;
  modelName: string | null;
  mode: ConsolidationMode;
  operations: ConsolidationOperation[];
  appliedCount: number;
  /** 整理细节（人类可读） */
  details: string[];
}

/**
 * 取 memory 场景绑定的模型（LanguageModel）。
 * 实现已移至共享模块 memory-model-util.ts，供 extract/service/dedup 复用。
 */

export type ConsolidationScope = MemoryScope | 'all';
export type ConsolidationMode = 'auto' | 'review';

/** 单次整理最多新建分类数（决策 D5） */
export const MAX_NEW_CATEGORIES_PER_RUN = 10;
/** 整理提示词最多注入的分类条数（决策 D5：超出按引用记忆数取前 N） */
export const MAX_PROMPT_CATEGORIES = 100;

export type ConsolidationOperation =
  | {
      id: string;
      type: 'merge';
      targetId: string;
      targetBaseVersion?: number;
      sourceIds: string[];
      sourceBaseVersions?: Record<string, number>;
      title: string;
      content: string;
      /** 分类 id；null=未分类（undefined=不改） */
      categoryId?: string | null;
      /** 本次计划内新建分类的名称引用（与 create_category 配套） */
      categoryName?: string;
      reason: string;
    }
  | {
      id: string;
      type: 'update';
      targetId: string;
      baseVersion?: number;
      title?: string;
      content?: string;
      categoryId?: string | null;
      categoryName?: string;
      reason: string;
    }
  | {
      id: string;
      type: 'delete';
      targetId: string;
      baseVersion?: number;
      reason: string;
    }
  | {
      id: string;
      type: 'create_category';
      name: string;
      description?: string;
      reason: string;
    };

/** 现役分类上下文（整理解析用）：ids 供 categoryId 校验；names 供新建判重 */
export interface ConsolidationCategoryContext {
  ids: ReadonlySet<string>;
  names: ReadonlySet<string>;
}

export interface ConsolidationPlan {
  summary: string;
  operations: ConsolidationOperation[];
}

const SCOPE_LABEL: Record<ConsolidationScope, string> = {
  all: '全部记忆',
  chat: '对话记忆',
  code: '编码记忆',
};

const CONSOLIDATE_PROMPT = (
  scopeLabel: string,
  memories: string,
  categoriesText: string
) => `你是一个记忆整理助手。下面是用户的${scopeLabel}条目列表（JSON）与现有分类清单。
请输出可以直接执行的结构化整理计划，而不是只给建议文本。

允许的操作：
1. merge：把语义重复或高度重叠的多条记忆合并到 targetId，并删除 sourceIds。
2. update：修正单条记忆的 title/content/categoryId。
3. create_category：现有分类都不合适、且该主题会长期沉淀记忆时，先新建一个分类。
4. delete：删除明显无意义、过期、测试碎片或冗余条目。

分类规则（重要）：
- 优先复用现有分类：在 merge/update 中用 "categoryId" 指定（null 表示未分类）。
- 确需新分类：先输出一条 create_category，再在同一次输出的 merge/update 里用 "categoryName" 引用该新分类名。
- 本次最多新建 ${MAX_NEW_CATEGORIES_PER_RUN} 个分类，分类名不超过 ${MAX_CATEGORY_NAME_LENGTH} 字；不要为单条零散记忆新建分类。
- 分类是归档维度：不要为了让分类"更整齐"而改动记忆内容，也绝不要编造新分类之外的措施。

现有分类（id | 名称 | 说明）：
${categoriesText || '（暂无）'}

记忆条目（categoryId 为 null 表示未分类）：
${memories}

只输出 JSON，不要 markdown 代码块：
{
  "summary": "中文摘要，120字以内",
  "operations": [
    {
      "type": "create_category",
      "name": "新分类名",
      "description": "可选：一句话说明什么内容该归到这里",
      "reason": "为什么新建"
    },
    {
      "type": "merge",
      "targetId": "保留的记忆id",
      "sourceIds": ["被合并后删除的记忆id"],
      "title": "合并后标题",
      "content": "合并后完整内容",
      "categoryId": "现有分类id或null",
      "categoryName": "可选：引用本次新建的分类名",
      "reason": "为什么合并"
    },
    {
      "type": "update",
      "id": "记忆id",
      "title": "可选新标题",
      "content": "可选新内容",
      "categoryId": "可选：现有分类id或null",
      "categoryName": "可选：引用本次新建的分类名",
      "reason": "为什么更新"
    },
    {
      "type": "delete",
      "id": "记忆id",
      "reason": "为什么删除"
    }
  ]
}
如果无需整理，operations 返回空数组。`;

export function groupMemoriesByScope(all: MemoryEntry[]): Record<MemoryScope, MemoryEntry[]> {
  return {
    chat: all.filter((m) => m.scope === 'chat'),
    code: all.filter((m) => m.scope === 'code'),
  };
}

export function dedupeByTitleWithinScope(all: MemoryEntry[]): {
  removedIds: string[];
  mergePatches: Array<{ id: string; content: string }>;
} {
  const seen = new Map<string, MemoryEntry>();
  const removedIds: string[] = [];
  const mergePatches: Array<{ id: string; content: string }> = [];

  const sorted = [...all].toSorted((a, b) => a.createdAt - b.createdAt);
  for (const m of sorted) {
    const key = m.title.trim().toLowerCase();
    const prev = seen.get(key);
    if (prev) {
      if (m.content && !prev.content.includes(m.content)) {
        const patch = mergePatches.find((p) => p.id === prev.id);
        const baseContent = patch?.content ?? prev.content;
        const nextContent = `${baseContent}\n[合并] ${m.content}`;
        if (patch) patch.content = nextContent;
        else mergePatches.push({ id: prev.id, content: nextContent });
      }
      removedIds.push(m.id);
    } else {
      seen.set(key, m);
    }
  }

  return { removedIds, mergePatches };
}

function extractJsonObject(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  if (candidate.startsWith('{') && candidate.endsWith('}')) return candidate;

  const start = candidate.indexOf('{');
  if (start === -1) return candidate;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < candidate.length; i += 1) {
    const ch = candidate[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return candidate.slice(start, i + 1);
    }
  }
  return candidate;
}

const EMPTY_CATEGORY_CONTEXT: ConsolidationCategoryContext = { ids: new Set(), names: new Set() };

function normalizeCategoryName(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ');
}

/** 解析分类指派：现有 id 优先；否则引用本次计划内新建的分类名；未知一律忽略（不改分类） */
function parseCategoryAssignment(
  op: Record<string, unknown>,
  context: ConsolidationCategoryContext,
  plannedNames: ReadonlySet<string>
): { categoryId?: string | null; categoryName?: string } {
  const assignment: { categoryId?: string | null; categoryName?: string } = {};
  if (op.categoryId !== undefined) {
    if (op.categoryId === null) assignment.categoryId = null;
    else if (typeof op.categoryId === 'string' && context.ids.has(op.categoryId)) assignment.categoryId = op.categoryId;
  }
  if (
    assignment.categoryId === undefined &&
    typeof op.categoryName === 'string' &&
    plannedNames.has(normalizeCategoryName(op.categoryName).toLowerCase())
  ) {
    assignment.categoryName = normalizeCategoryName(op.categoryName);
  }
  return assignment;
}

function opId(type: string, ids: string[]): string {
  return `${type}-${ids.join('-')}`;
}

export function parseConsolidationPlan(
  rawText: string,
  validIds: string[],
  versions: Readonly<Record<string, number>> = {},
  categories: ConsolidationCategoryContext = EMPTY_CATEGORY_CONTEXT
): ConsolidationPlan {
  const valid = new Set(validIds);
  try {
    const parsed = JSON.parse(extractJsonObject(rawText)) as { summary?: unknown; operations?: unknown };
    const operations: ConsolidationOperation[] = [];
    const rawOps = Array.isArray(parsed.operations) ? parsed.operations : [];

    // 第一遍：收集计划内新建分类（供 categoryName 引用），去重、上限 MAX_NEW_CATEGORIES_PER_RUN
    const plannedNames = new Set<string>();
    for (const rawOp of rawOps) {
      const op = rawOp as Record<string, unknown>;
      if (op.type !== 'create_category') continue;
      const name = typeof op.name === 'string' ? normalizeCategoryName(op.name) : '';
      if (!name || name.length > MAX_CATEGORY_NAME_LENGTH) continue;
      if (categories.names.has(name.toLowerCase()) || plannedNames.has(name.toLowerCase())) continue;
      if (plannedNames.size >= MAX_NEW_CATEGORIES_PER_RUN) continue;
      plannedNames.add(name.toLowerCase());
      operations.push({
        id: opId('create-category', [name]),
        type: 'create_category',
        name,
        ...(typeof op.description === 'string' && op.description.trim()
          ? { description: op.description.trim().slice(0, 200) }
          : {}),
        reason: typeof op.reason === 'string' && op.reason.trim() ? op.reason.trim() : '现有分类不合适，新建分类归档',
      });
    }

    for (const rawOp of rawOps) {
      const op = rawOp as Record<string, unknown>;
      if (op.type === 'create_category') continue;
      if (op.type === 'merge') {
        const targetId = typeof op.targetId === 'string' ? op.targetId : '';
        const sourceIds = Array.isArray(op.sourceIds)
          ? op.sourceIds.filter((id): id is string => typeof id === 'string')
          : [];
        const title = typeof op.title === 'string' ? op.title.trim() : '';
        const content = typeof op.content === 'string' ? op.content.trim() : '';
        const reason = typeof op.reason === 'string' ? op.reason.trim() : '合并重复或重叠记忆';
        if (!valid.has(targetId) || sourceIds.length === 0 || sourceIds.some((id) => !valid.has(id) || id === targetId))
          continue;
        if (!title || !content) continue;
        operations.push({
          id: opId('merge', [targetId, ...sourceIds]),
          type: 'merge',
          targetId,
          ...(versions[targetId] ? { targetBaseVersion: versions[targetId] } : {}),
          sourceIds,
          ...(sourceIds.every((id) => versions[id])
            ? { sourceBaseVersions: Object.fromEntries(sourceIds.map((id) => [id, versions[id]])) }
            : {}),
          title: title.slice(0, 80),
          content,
          ...parseCategoryAssignment(op, categories, plannedNames),
          reason,
        });
      } else if (op.type === 'update') {
        const targetId = typeof op.id === 'string' ? op.id : '';
        const title = typeof op.title === 'string' ? op.title.trim() : undefined;
        const content = typeof op.content === 'string' ? op.content.trim() : undefined;
        const reason = typeof op.reason === 'string' ? op.reason.trim() : '更新记忆内容';
        if (!valid.has(targetId)) continue;
        const assignment = parseCategoryAssignment(op, categories, plannedNames);
        if (!title && !content && assignment.categoryId === undefined && !assignment.categoryName) continue;
        operations.push({
          id: targetId,
          type: 'update',
          targetId,
          ...(versions[targetId] ? { baseVersion: versions[targetId] } : {}),
          ...(title ? { title: title.slice(0, 80) } : {}),
          ...(content ? { content } : {}),
          ...assignment,
          reason,
        });
      } else if (op.type === 'delete') {
        const targetId = typeof op.id === 'string' ? op.id : '';
        const reason = typeof op.reason === 'string' ? op.reason.trim() : '删除冗余记忆';
        if (!valid.has(targetId)) continue;
        operations.push({
          id: targetId,
          type: 'delete',
          targetId,
          ...(versions[targetId] ? { baseVersion: versions[targetId] } : {}),
          reason,
        });
      }
    }

    return {
      summary: typeof parsed.summary === 'string' && parsed.summary.trim() ? parsed.summary.trim() : '已生成整理计划。',
      operations,
    };
  } catch {
    return { summary: '模型未返回有效的结构化整理计划。', operations: [] };
  }
}

/**
 * 应用整理操作（决策 D2/D3）：
 * 1) 先落 create_category（已存在的同名分类直接复用映射，不重复建）→ 名称引用表；
 * 2) merge/update 的分类指派按「现有 id > 本次新建名」解析，无法解析时不改分类；
 * 3) 其余乐观锁冲突语义不变。
 */
export async function applyConsolidationOperations(operations: ConsolidationOperation[]): Promise<number> {
  let applied = 0;
  const createdCategoryIds = new Map<string, string>();
  for (const op of operations) {
    if (op.type !== 'create_category') continue;
    try {
      const existing = await findMemoryCategoryByName(op.name);
      if (existing) {
        createdCategoryIds.set(existing.name.toLowerCase(), existing.id);
        continue;
      }
      const created = await createMemoryCategory({
        name: op.name,
        description: op.description ?? null,
        source: 'consolidated',
      });
      createdCategoryIds.set(created.name.toLowerCase(), created.id);
      applied += 1;
    } catch {
      // 名称冲突/超限等：跳过该新建，其引用降级为「不改分类」
    }
  }
  const resolveAssignment = (op: { categoryId?: string | null; categoryName?: string }): string | null | undefined => {
    if (op.categoryId !== undefined) return op.categoryId;
    if (op.categoryName) return createdCategoryIds.get(op.categoryName.toLowerCase());
    return undefined;
  };
  const existing = await listMemories();
  const current = new Map(existing.map((memory) => [memory.id, memory]));
  const validIds = new Set(current.keys());
  for (const op of operations) {
    if (op.type === 'create_category') continue;
    if (op.type === 'merge') {
      if (!validIds.has(op.targetId) || op.sourceIds.some((id) => !validIds.has(id))) continue;
      if (
        !op.targetBaseVersion ||
        !op.sourceBaseVersions ||
        current.get(op.targetId)?.version !== op.targetBaseVersion ||
        op.sourceIds.some((id) => current.get(id)?.version !== op.sourceBaseVersions?.[id])
      ) {
        throw new Error('MEMORY_VERSION_CONFLICT');
      }
      const categoryId = resolveAssignment(op);
      await updateMemory(
        op.targetId,
        {
          title: op.title,
          content: op.content,
          ...(categoryId !== undefined ? { categoryId } : {}),
        },
        op.targetBaseVersion
      );
      for (const id of op.sourceIds) await deleteMemory(id, op.sourceBaseVersions[id]);
      for (const id of op.sourceIds) validIds.delete(id);
      applied += 1;
    } else if (op.type === 'update') {
      if (!validIds.has(op.targetId)) continue;
      if (!op.baseVersion || current.get(op.targetId)?.version !== op.baseVersion)
        throw new Error('MEMORY_VERSION_CONFLICT');
      const categoryId = resolveAssignment(op);
      await updateMemory(
        op.targetId,
        {
          ...(op.title ? { title: op.title } : {}),
          ...(op.content ? { content: op.content } : {}),
          ...(categoryId !== undefined ? { categoryId } : {}),
        },
        op.baseVersion
      );
      applied += 1;
    } else {
      if (!validIds.has(op.targetId)) continue;
      if (!op.baseVersion || current.get(op.targetId)?.version !== op.baseVersion)
        throw new Error('MEMORY_VERSION_CONFLICT');
      await deleteMemory(op.targetId, op.baseVersion);
      validIds.delete(op.targetId);
      applied += 1;
    }
  }
  return applied;
}

/**
 * 执行一次记忆整理。
 */
export async function consolidateMemories(
  scope: ConsolidationScope = 'all',
  mode: ConsolidationMode = 'auto',
  options: { abortSignal?: AbortSignal } = {}
): Promise<ConsolidateResult> {
  const all = scope === 'all' ? await listMemories() : await listMemories(undefined, undefined, scope);
  const beforeCount = all.length;
  const details: string[] = [];

  // 分类上下文：按引用记忆数排序取前 MAX_PROMPT_CATEGORIES 条注入提示词（决策 D5）
  const [categories, categoryCounts] = await Promise.all([listMemoryCategories(), countMemoriesByCategory()]);
  const promptCategories = [...categories]
    .toSorted((a, b) => (categoryCounts.get(b.id) ?? 0) - (categoryCounts.get(a.id) ?? 0) || a.sort - b.sort)
    .slice(0, MAX_PROMPT_CATEGORIES);
  const categoriesText = promptCategories
    .map((category) => `${category.id} | ${category.name} | ${category.description ?? ''}`)
    .join('\n');
  const categoryContext: ConsolidationCategoryContext = {
    ids: new Set(categories.map((category) => category.id)),
    names: new Set(categories.map((category) => category.name.toLowerCase())),
  };

  // 取绑定模型（未绑定则失败）
  let modelName: string | null = null;
  let model: LanguageModel | null = null;
  try {
    const got = await getMemoryModel();
    model = got.model;
    modelName = got.name;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await recordRun({ scope, status: 'failed', summary: msg, beforeCount, afterCount: null, modelName: null });
    return {
      status: 'failed',
      summary: msg,
      beforeCount,
      afterCount: beforeCount,
      modelName: null,
      mode,
      operations: [],
      appliedCount: 0,
      details: [],
    };
  }

  // 没有记忆可整理
  if (all.length === 0) {
    const summary = '当前没有记忆条目，无需整理。';
    await recordRun({ scope, status: 'skipped', summary, beforeCount: 0, afterCount: 0, modelName });
    return {
      status: 'skipped',
      summary,
      beforeCount: 0,
      afterCount: 0,
      modelName,
      mode,
      operations: [],
      appliedCount: 0,
      details: [],
    };
  }

  const groups = scope === 'all' ? groupMemoriesByScope(all) : ({ [scope]: all } as Record<MemoryScope, MemoryEntry[]>);
  const scopeEntries = Object.entries(groups) as Array<[MemoryScope, MemoryEntry[]]>;

  const operations: ConsolidationOperation[] = [];
  for (const [groupScope, memories] of scopeEntries) {
    if (memories.length === 0) continue;
    const merged = dedupeByTitleWithinScope(memories);
    for (const patch of merged.mergePatches) {
      const target = memories.find((m) => m.id === patch.id);
      if (!target) continue;
      const sources = merged.removedIds.filter(
        (id) =>
          memories
            .find((m) => m.id === id)
            ?.title.trim()
            .toLowerCase() === target.title.trim().toLowerCase()
      );
      if (sources.length === 0) continue;
      operations.push({
        id: opId('merge-title', [target.id, ...sources]),
        type: 'merge',
        targetId: target.id,
        targetBaseVersion: target.version,
        sourceIds: sources,
        sourceBaseVersions: Object.fromEntries(
          sources.map((id) => [id, memories.find((memory) => memory.id === id)!.version])
        ),
        title: target.title,
        content: patch.content,
        categoryId: target.categoryId,
        reason: '标题完全相同，自动生成合并操作',
      });
    }
    if (merged.removedIds.length > 0)
      details.push(`${SCOPE_LABEL[groupScope]}本地发现 ${merged.removedIds.length} 条标题完全重复的条目。`);
  }
  const afterCount = beforeCount;

  // —— LLM 整理（已绑定模型才真实调用）——
  const summaries: string[] = [];
  if (!model) {
    // 理论上不会走到（未绑定已在前面 try/catch 返回 failed），防御性处理
    summaries.push(`本地生成 ${operations.length} 项重复记忆整理操作。未获取到绑定模型。`);
  } else {
    for (const [groupScope, memories] of scopeEntries) {
      if (memories.length === 0) continue;
      try {
        const payload = JSON.stringify(
          memories.map(({ id, title, content, categoryId, scope }) => ({ id, title, content, categoryId, scope }))
        );
        const res = await generateText({
          model,
          prompt: CONSOLIDATE_PROMPT(SCOPE_LABEL[groupScope], payload, categoriesText),
          abortSignal: options.abortSignal,
        });
        const plan = parseConsolidationPlan(
          res.text,
          memories.map((m) => m.id),
          Object.fromEntries(memories.map((memory) => [memory.id, memory.version])),
          categoryContext
        );
        operations.push(...plan.operations);
        summaries.push(`${SCOPE_LABEL[groupScope]}：${plan.summary}`);
        details.push(
          `已通过绑定模型「${modelName}」生成${SCOPE_LABEL[groupScope]}整理计划（${plan.operations.length} 项操作）。`
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        summaries.push(`${SCOPE_LABEL[groupScope]} LLM 调用失败：${msg}。已保留本地去重结果。`);
        details.push(`${SCOPE_LABEL[groupScope]}模型调用出错：${msg}`);
      }
    }
  }

  // T2.12 低值清理候选并入 review 审批流（05 章 §2.4：不静默删除；auto 模式语义不变，不追加候选）
  if (mode === 'review') {
    const candidateScopeEntries = scopeEntries.flatMap(([, memories]) => memories);
    const accessLogs = await listMemoryAccessLogs(candidateScopeEntries.map((memory) => memory.id));
    const handledIds = new Set(
      operations.flatMap((op) =>
        op.type === 'create_category' ? [] : [op.targetId, ...(op.type === 'merge' ? op.sourceIds : [])]
      )
    );
    const retentionCandidates = buildRetentionCandidates(candidateScopeEntries, accessLogs).filter(
      (candidate) => !handledIds.has(candidate.targetId)
    );
    for (const candidate of retentionCandidates) {
      operations.push({
        id: `retention-${candidate.targetId}`,
        type: 'delete',
        targetId: candidate.targetId,
        baseVersion: candidate.baseVersion,
        reason: candidate.reason,
      });
    }
    if (retentionCandidates.length > 0) {
      details.push(`保持分巡检发现 ${retentionCandidates.length} 条低值记忆，已作为删除候选并入本次审批。`);
    }
  }

  const appliedCount = mode === 'auto' ? await applyConsolidationOperations(operations) : 0;
  const createdCategoryCount = operations.filter((op) => op.type === 'create_category').length;
  if (createdCategoryCount > 0) {
    details.push(
      mode === 'auto'
        ? `本次整理新建了 ${createdCategoryCount} 个分类，已自动应用（可在「管理分类」中改名或归档）。`
        : `本次整理包含 ${createdCategoryCount} 个新建分类，勾选后一并创建（可在「管理分类」中调整）。`
    );
  }
  const finalCount =
    mode === 'auto'
      ? (await listMemories(undefined, undefined, scope === 'all' ? undefined : scope)).length
      : afterCount;
  const summary = summaries.join('\n') || `本地生成 ${operations.length} 项整理操作。`;
  const modeSummary =
    mode === 'auto'
      ? `${summary}\n已自动应用 ${appliedCount} 项整理操作。`
      : `${summary}\n已生成 ${operations.length} 项待审批整理操作。`;
  await recordRun({ scope, status: 'success', summary: modeSummary, beforeCount, afterCount: finalCount, modelName });
  return {
    status: 'success',
    summary: modeSummary,
    beforeCount,
    afterCount: finalCount,
    modelName,
    mode,
    operations,
    appliedCount,
    details,
  };
}
