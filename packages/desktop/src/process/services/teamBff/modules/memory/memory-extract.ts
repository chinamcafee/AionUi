/**
 * 记忆抽取服务（配合对话能力）。
 *
 * 这是供离线/整理场景复用的独立 LLM 抽取器。生产对话不调用本模块：对话主模型
 * 会在同一轮回复中自行判断是否输出 `<memorize>`，显式与隐式记忆意图都不经过
 * 关键词、正则或固定句式规则。
 *
 * 设计参见 doc/memorySystem/conversationMemory/01-extraction.md。
 *
 * 启用判定：以「模型绑定」页是否为 memory 场景绑定模型为准——
 * 能取到绑定模型就抽取；未绑定则返回「跳过」。
 * （不再使用 process.env.LLM_ENABLED，统一以「模型绑定」页设置为准。）
 */
import { generateText } from 'ai';
import { createMemory, listMemoryCategories } from './memory-store.js';
import { getMemoryModel } from './memory-model-util.js';

const EXTRACT_PROMPT = (
  userInput: string,
  assistantText: string,
  categoriesText: string
) => `你是一个记忆抽取助手。判断下面这轮对话中，用户是否陈述了值得长期记住的个人偏好、事实、要求或重要事件。
只抽取**用户主动陈述的、关于用户自身的、稳定可复用的**信息。忽略：闲聊、一次性提问、与用户自身无关的内容。

用户输入：${userInput}
助手回复：${assistantText}

现有分类（名称 | 说明）：
${categoriesText || '（暂无）'}

如果值得记忆，输出 JSON（仅一个对象，不要 markdown 代码块）：
{"title":"简洁标题(<=20字)","content":"完整内容","categoryName":"可选：从现有分类中选一个最合适的名称，拿不准就省略"}
如果不值得记忆，仅输出：{"skip":true}`;

export interface ExtractResult {
  status: 'created' | 'skipped' | 'failed';
  reason: string;
  memoryId?: string;
}

/**
 * 自动抽取记忆。
 * - 未在「模型绑定」页绑定 memory 模型：跳过，返回 skipped。
 * - 已绑定：调绑定模型判断，命中则落库（source='auto'）。
 */
export async function autoExtractMemory(userInput: string, assistantText: string): Promise<ExtractResult> {
  // 输入过短直接跳过
  if (!userInput?.trim() || userInput.trim().length < 4) {
    return { status: 'skipped', reason: '用户输入过短，跳过自动抽取' };
  }

  // 取「模型绑定」页绑定的 memory 模型；未绑定 → 跳过。
  let model;
  let name;
  try {
    ({ model, name } = await getMemoryModel());
  } catch {
    return { status: 'skipped', reason: '未为 memory 场景绑定模型，自动抽取已跳过' };
  }

  try {
    const categories = await listMemoryCategories().catch((): Awaited<ReturnType<typeof listMemoryCategories>> => []);
    const categoriesText = categories.map((category) => `${category.name} | ${category.description ?? ''}`).join('\n');
    const res = await generateText({ model, prompt: EXTRACT_PROMPT(userInput, assistantText, categoriesText) });
    const text = res.text.trim();
    // 容错：剥离可能的 ```json 包裹
    const jsonStr = text
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();
    const parsed = JSON.parse(jsonStr) as {
      skip?: boolean;
      title?: string;
      content?: string;
      categoryName?: string;
    };
    if (parsed.skip || !parsed.title || !parsed.content) {
      return { status: 'skipped', reason: '模型判定不值得记忆' };
    }
    const m = await createMemory({
      title: parsed.title.slice(0, 40),
      content: parsed.content,
      categoryName: parsed.categoryName,
      source: 'auto',
    });
    return { status: 'created', reason: `已自动抽取（模型：${name}）`, memoryId: m.id };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { status: 'failed', reason: `自动抽取失败：${msg}` };
  }
}
