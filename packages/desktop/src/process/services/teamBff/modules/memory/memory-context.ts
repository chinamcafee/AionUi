/**
 * 记忆上下文检索服务。
 *
 * 用途（对话需求 3）：当用户提问与记忆相关的话题时，把记忆系统中相关的条目
 * 检索出来，拼成「记忆上下文块」注入 Agent 的 instructions，随对话一同发给 LLM。
 *
 * 检索策略：Pinned、FTS5 与本地 Vector 三路并行候选，经 RRF 融合后限量注入。
 */
import { listMemories, type MemoryEntry, type MemoryScope } from './memory-store.js';
import { retrieveHybridMemories } from './memory-search.js';

/** 单次注入的记忆条数上限 */
const MAX_RELATED = 8;
/** T1.11 召回窗口：retrieveHybridMemories 保留 top-20 供后续 rerank，注入条数仍由 MAX_RELATED 截断 */
const RECALL_WINDOW = 20;

/**
 * 从一段文本（用户最新输入）抽取候选关键词。
 * 规则：按中文/英文分词边界切分，过滤停用词与过短词，去重，保留前 N 个。
 */
const STOP_WORDS = new Set([
  // 中文常见停用词
  '的', '了', '是', '在', '我', '你', '他', '她', '它', '们', '和', '与', '或',
  '也', '都', '就', '还', '又', '把', '被', '让', '给', '对', '为', '到', '从',
  '这', '那', '一个', '一些', '什么', '怎么', '为什么', '哪', '哪里', '哪个',
  '可以', '能', '会', '要', '想', '需要', '应该', '请', '麻烦', '帮', '帮我',
  '的话', '一下', '吗', '呢', '吧', '啊', '哦', '嗯',
  // 英文常见停用词
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'to', 'of', 'in', 'on',
  'for', 'and', 'or', 'but', 'with', 'as', 'at', 'by', 'from', 'it', 'this',
  'that', 'i', 'you', 'he', 'she', 'we', 'they', 'my', 'your', 'do', 'does',
]);

export function extractKeywords(text: string, max = 12): string[] {
  if (!text?.trim()) return [];
  const lower = text.toLowerCase();
  const out: string[] = [];

  // 先按非「字/字母/数字」边界切成段
  const segments = lower.split(/[^\p{L}\p{N}]+/u).filter(Boolean);

  for (const seg of segments) {
    // 英文/数字段：保留 2 字以上的词
    if (!/[\u4e00-\u9fff]/.test(seg)) {
      if (seg.length >= 2 && !STOP_WORDS.has(seg)) out.push(seg);
      continue;
    }
    // 中文段：切成 2/3 字滑窗（中文无空格，单字歧义太大）
    const chars = [...seg];
    for (let i = 0; i < chars.length - 1; i++) {
      const bi = chars[i]! + chars[i + 1]!;
      if (!STOP_WORDS.has(bi)) out.push(bi);
    }
    for (let i = 0; i < chars.length - 2; i++) {
      const tri = chars[i]! + chars[i + 1]! + chars[i + 2]!;
      if (!STOP_WORDS.has(tri)) out.push(tri);
    }
  }
  // 去重保序
  return Array.from(new Set(out)).slice(0, max);
}

/**
 * 检索与「当前用户输入」相关的记忆。
 * @param userInput 当前轮用户输入文本
 * @param scope 作用域过滤：普通会话传 'chat'（默认），编程会话传 ['chat','code']（普通+独有）
 * @returns 命中的相关记忆（置顶项 + 关键词命中项，去重，限量）
 */
export async function retrieveRelevantMemories(
  userInput: string,
  scope: MemoryScope | MemoryScope[] = 'chat',
): Promise<MemoryEntry[]> {
  // T1.11：显式取 top-20 召回窗口，外层 slice 保持注入上限 MAX_RELATED 不变
  const hits = await retrieveHybridMemories(userInput, scope, RECALL_WINDOW);
  return hits.slice(0, MAX_RELATED).map((hit) => hit.memory);
}

/**
 * 把检索到的记忆拼成「记忆上下文块」文本，供注入 instructions。
 * 无相关记忆时返回空字符串。
 * @param scope 普通会话 'chat'；编程会话 ['chat','code']
 */
export async function buildMemoryContextBlock(
  userInput: string,
  scope: MemoryScope | MemoryScope[] = 'chat',
): Promise<string> {
  // T3.8：直接取 HybridMemoryHit（含 viaGraph 图谱标注），注入文案附带「经实体 X 关联」
  const hits = await retrieveHybridMemories(userInput, scope, RECALL_WINDOW);
  const related = hits.slice(0, MAX_RELATED);
  console.log('========== 记忆检索 ==========');
  console.log('[memory-context] userInput:', JSON.stringify(userInput.slice(0, 60)));
  console.log('[memory-context] scope:', JSON.stringify(scope));
  console.log('[memory-context] 检索命中条数:', related.length);
  for (const h of related) console.log('[memory-context]  -', h.memory.title, '| pinned=' + h.memory.pinned, '| scope=' + h.memory.scope, h.viaGraph ? `| ${h.viaGraph}` : '');
  console.log('==============================');
  if (related.length === 0) return '';

  const lines = related.map((h) => {
    const m = h.memory;
    const tag = m.category;
    const pin = m.pinned ? '⭐' : '';
    return `- ${pin}[${tag}] ${m.title}：${m.content}${h.viaGraph ? `（${h.viaGraph}）` : ''}`;
  });

  return [
    '## 关于用户的相关记忆',
    '以下是你已掌握的、与本次对话相关的用户记忆（来自记忆系统，请据此个性化回复；若与新信息冲突，以最新信息为准）：',
    ...lines,
  ].join('\n');
}

/** 仅供测试/调试：返回检索细节 */
export async function debugRetrieve(userInput: string, scope: MemoryScope | MemoryScope[] = 'chat') {
  const keywords = extractKeywords(userInput);
  const hits = await retrieveHybridMemories(userInput, scope, MAX_RELATED);
  return { keywords, scope, related: hits.map((hit) => hit.memory), hits };
}

/**
 * 构建「置顶记忆」上下文块（兜底用，量小）。
 * 当无法获取当前轮用户输入时（如 Mastra 内部调用），只注入置顶记忆，
 * 避免全量注入浪费 token。置顶项是用户标记的重要偏好/要求，量通常很小。
 */
export async function buildPinnedMemoriesBlock(scope: MemoryScope | MemoryScope[] = 'chat'): Promise<string> {
  const all = await listMemories(undefined, undefined, scope);
  const pinned = all.filter((m) => m.pinned);
  if (pinned.length === 0) return '';
  const lines = pinned.map((m) => `- ⭐[${m.category}] ${m.title}：${m.content}`);
  return [
    '## 关于用户的相关记忆',
    '以下是你已掌握的用户记忆（来自记忆系统，请据此个性化回复）：',
    ...lines,
  ].join('\n');
}
