/**
 * 记忆相似度判定服务（写入时去重的判定逻辑）。
 *
 * 设计参见 doc/modalSetting/02-memory-dedup-design.md。
 *
 * 职责：对一条候选记忆，与同 category 的已有记忆做 LLM 语义相似度判定，
 * 返回四档结果（exact/high/partial/none）+ 合并文本。
 *
 * 本服务无副作用（不落库），仅做判定。落库（新建/合并/丢弃）由调用方决定。
 *
 * 启用判定：以「模型绑定」页是否为 memory 场景绑定了模型为准——
 * 能取到绑定模型就判定；未绑定或调用失败 → 返回 {level:'none'}，不阻断写入。
 * （不再使用 process.env.LLM_ENABLED，统一以「模型绑定」页设置为准。）
 */
import { generateText } from 'ai';
import { getMemoryModel } from './memory-model-util.js';
import { listMemories, UNCATEGORIZED_FILTER, type MemoryEntry, type MemoryScope } from './memory-store.js';

/** 相似度四档 */
export type SimilarityLevel = 'exact' | 'high' | 'partial' | 'none';

/** 判定结果 */
export interface DedupResult {
  level: SimilarityLevel;
  /** 撞上的已有记忆 id（none 时省略） */
  existingId?: string;
  existingVersion?: number;
  /** 合并后标题（high/partial 时给出，供静默合并 / 抽屉预览） */
  mergedTitle?: string;
  /** 合并后内容（high/partial 时给出） */
  mergedContent?: string;
}

interface Candidate {
  title: string;
  content: string;
  /** 分类 id；null=未分类（去重只与同分类比对） */
  categoryId: string | null;
  /** 候选记忆的 scope，去重时只与同 scope 比对，防跨 scope 误判 */
  scope?: MemoryScope;
}

/**
 * 判定候选记忆与已有记忆的相似度。
 * - 只与同 categoryId + 同 scope 的已有记忆比对（降噪/提速 + 防 cross-scope 误判）。
 * - 未在「模型绑定」页绑定 memory 模型、或调用失败：返回 {level:'none'}，不阻断写入。
 */
export async function judgeMemorySimilarity(candidate: Candidate): Promise<DedupResult> {
  // 1. 取同 categoryId + 同 scope 已有记忆
  const existing = await listMemories(
    candidate.categoryId ?? UNCATEGORIZED_FILTER,
    undefined,
    candidate.scope ?? 'chat'
  );
  if (existing.length === 0) return { level: 'none' };

  // 2. 取「模型绑定」页绑定的 memory 模型；未绑定 → 降级放行（不阻断写入）
  //    （getMemoryModel 在未绑定/绑定类型不符时会抛错，统一 catch 降级）
  let model;
  try {
    ({ model } = await getMemoryModel());
  } catch {
    return { level: 'none' };
  }

  // 3. LLM 判定（含 none 复核：首次判 none 时再判一次，压低偶发误判）
  try {
    const res1 = await generateText({ model, prompt: DEDUP_PROMPT(candidate, existing) });
    const result1 = parseDedupResult(res1.text, existing);
    // none 复核：LLM 判定偶发不稳定，单次 none 会直接新建（不可逆），复核能压低误判率。
    if (result1.level !== 'none') return result1;
    try {
      const res2 = await generateText({ model, prompt: DEDUP_PROMPT(candidate, existing) });
      const result2 = parseDedupResult(res2.text, existing);
      // 第二次非 none，以第二次为准（更可能是漏判）；两次都 none 才最终 none。
      return result2;
    } catch {
      return { level: 'none' };
    }
  } catch {
    return { level: 'none' }; // 失败不阻断
  }
}

export const DEDUP_PROMPT = (
  candidate: Candidate,
  existing: MemoryEntry[]
) => `你是一个记忆去重助手。判断「待判定记忆」与下方「已有记忆列表」的关系，决定是丢弃、合并还是新建。

## 相似度判定（按"主题/实体"维度）
- exact   = 完全相似：与某条已有记忆是同一事实，仅措辞/标点/语序不同 → 丢弃
- high    = 基本相似：与某条已有记忆是同一事实，但信息更全或有更新/修正 → 合并
- partial = 主题相关：与某条已有记忆指向同一主题/实体（同一个人/公司/项目/偏好…），但补充了新的信息维度（新增一个此前没有的事实点）→ 合并
- none    = 无关：与任何已有记忆都不指向同一主题/实体，是全新的事实 → 新建

## 判定准则（按优先级）
1. 先找"主题/实体"是否重合：同一个人、同一公司、同一项目、同一偏好领域等。
2. 主题重合则【至少 partial（应合并）】，绝不要判 none。
   - 正例：「公司注册时间」vs「公司名称」→ 同一公司主题，新维度（注册时间）→ partial → 合并
   - 正例：「同事李博闻的生日」vs「李博闻负责的模块」→ 同一人，新维度（生日）→ partial → 合并
   - 反例：「同事李博闻的生日」vs「公司名称」→ 不同主题/实体 → none → 新建
3. 同一事实的不同表述 → exact；同一事实的补充/修正 → high。

## 合并规则
- 合并目标：选择信息最丰富、最能代表该主题的那条已有记忆作为"宿主"（existingIndex 指向它）。
- 合并内容 = 把新旧所有信息整合成一条完整陈述，不丢失原有信息，不引入臆测。
- 合并标题 = 概括合并后所有信息的简短标题（≤20字）。

## 待判定记忆
标题：${candidate.title}
内容：${candidate.content}
分类：${candidate.categoryId ?? '未分类'}

## 已有记忆列表（仅同分类）
${existing.map((m, i) => `#${i} [id:${m.id}] ${m.title} —— ${m.content}`).join('\n')}

## 输出（仅 JSON，不要 markdown 代码块，不要解释）
若命中 exact/high/partial（应丢弃或合并）：
{"level":"exact|high|partial","existingIndex":<已有记忆的#序号>,"mergedTitle":"合并后标题","mergedContent":"合并后内容"}
若 none（应新建）：
{"level":"none"}
`;

/** 解析 LLM 判定输出。任何异常都降级为 {level:'none'}。 */
export function parseDedupResult(text: string, existing: MemoryEntry[]): DedupResult {
  try {
    const jsonStr = text
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();
    const parsed = JSON.parse(jsonStr) as {
      level?: string;
      existingIndex?: number;
      mergedTitle?: string;
      mergedContent?: string;
    };
    if (!parsed.level || parsed.level === 'none') return { level: 'none' };
    const validLevels: SimilarityLevel[] = ['exact', 'high', 'partial'];
    const level = validLevels.includes(parsed.level as SimilarityLevel) ? (parsed.level as SimilarityLevel) : 'none';
    if (level === 'none') return { level: 'none' };
    const idx = Number(parsed.existingIndex);
    const existingId = Number.isInteger(idx) && existing[idx] ? existing[idx].id : undefined;
    if (!existingId) return { level: 'none' }; // 序号越界 → 降级
    return {
      level,
      existingId,
      existingVersion: existing[idx].version,
      mergedTitle: parsed.mergedTitle?.slice(0, 40),
      // 合并内容设上限，防止 LLM 偶发超长输出污染记忆库（与 title 的 40 字约束配套）
      mergedContent: parsed.mergedContent?.slice(0, 2000),
    };
  } catch {
    return { level: 'none' };
  }
}
