/**
 * 记忆场景模型工具（AionUi 移植版）。
 * 上游（client server/memory-model-util.ts）从「模型绑定」页（model-binding.ts）取端点；
 * AionUi 无该页面，改为由 teamBffService 注入配置驱动的 provider
 * （团队平台设置 → 记忆模型端点，configStore.memoryModel）。
 * 其余语义（未绑定抛友好错误、角色校验、OpenAI 兼容 provider 构建）与上游一致。
 */
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';

export interface MemoryModelHandle {
  model: LanguageModel;
  name: string;
}

export interface MemoryModelEndpoint {
  baseUrl: string;
  apiKey: string;
  model: string;
  name?: string;
}

type MemoryModelProvider = () => Promise<MemoryModelEndpoint | null>;

let provider: MemoryModelProvider = async () => null;

export function bindMemoryModelProvider(next: MemoryModelProvider) {
  provider = next;
}

/**
 * 取 memory 场景绑定的模型。未绑定或字段不完整时抛友好错误（上游语义）。
 */
export async function getMemoryModel(): Promise<MemoryModelHandle> {
  const ep = await provider();
  if (!ep || !ep.baseUrl || !ep.apiKey || !ep.model) {
    throw new Error('尚未为「记忆整理」场景绑定模型，请先在设置 → 团队平台中配置记忆模型端点。');
  }
  const providerClient = createOpenAICompatible({
    name: 'aionui-memory',
    baseURL: ep.baseUrl,
    apiKey: ep.apiKey,
    supportsStructuredOutputs: false,
  });
  return { model: providerClient(ep.model) as unknown as LanguageModel, name: `${ep.name ?? ep.model} (${ep.model})` };
}
