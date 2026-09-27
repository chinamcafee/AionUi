// AionUi 新增（T5.2/T5.4）：团队知识内置 MCP server 的虚拟描述符常量与工具调用客户端。
// 直连 MCP 仅限自托管单用户场景（scope 限制见 docs/workLog/T5.1 spike）；
// 默认通道为 BFF Tool Gateway（/teamapi/agent-tools/invoke，见 process/services/teamBff/modules/knowledge/agentTools.ts）。

import { request } from '@/renderer/api/teamClient';

export const KNOWLEDGE_MCP_SERVER_ID = 'aionui-team-knowledge-builtin';

export const KNOWLEDGE_TOOL_NAMES = [
  'knowledge.query',
  'knowledge.synthesize',
  'knowledge.global_search',
  'knowledge.find_gaps',
  'knowledge.graph',
  'knowledge.submit_memory',
] as const;

export type KnowledgeToolName = (typeof KNOWLEDGE_TOOL_NAMES)[number];

export function isKnowledgeToolName(value: string): value is KnowledgeToolName {
  return (KNOWLEDGE_TOOL_NAMES as readonly string[]).includes(value);
}

/** 经 team-server Tool Gateway 调用知识工具（KEAccessGrant scope 隔离，默认通道）。 */
export function invokeKnowledgeTool<T = unknown>(
  name: KnowledgeToolName,
  input: Record<string, unknown> = {},
  organizerFilter?: { groupIds: string[]; tagIds: string[] }
): Promise<T> {
  return request<T>('/teamapi/agent-tools/invoke', {
    method: 'POST',
    body: JSON.stringify(organizerFilter ? { name, input, organizerFilter } : { name, input }),
  });
}
