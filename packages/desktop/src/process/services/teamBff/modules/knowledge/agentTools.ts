// AionUi 移植（T5.3）：Agent 知识工具 Tool Gateway 通道。
// 源：client server/mastra/tools/definitions/team-knowledge.ts 的调用方式
// （POST .../knowledge/agent-tools:invoke，body {name, input}，强制注入 organizerFilter）。
// 结论依据 docs/workLog/T5.1 spike：个人知识 scope 隔离必须经 team-server 签发
// KEAccessGrant 的网关路径（KE MCP 端 4143 不感知用户身份），故 Tool Gateway 为默认通道。

import { Hono } from 'hono';
import { callTeamGateway, currentTeamGatewayScope } from '../memory/team-gateway-runtime.js';
import { accountRuntime } from '../memory/account-runtime.js';

/** KE-v2 Tool Gateway 暴露的 6 个知识工具（上游 client 同名单单） */
export const KNOWLEDGE_AGENT_TOOLS = Object.freeze([
  'knowledge.query',
  'knowledge.synthesize',
  'knowledge.global_search',
  'knowledge.find_gaps',
  'knowledge.graph',
  'knowledge.submit_memory',
]);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function knowledgeGatewayError(error: unknown) {
  const code = error instanceof Error && /^[A-Z][A-Z0-9_]{2,100}$/.test(error.message)
    ? error.message : 'TEAM_GATEWAY_UPSTREAM_FAILED';
  return { code, status: code === 'TEAM_GATEWAY_UNAVAILABLE' ? 409 : 502 } as const;
}

export function createAgentToolsRoutes() {
  const app = new Hono();

  const hasActiveAccount = () => {
    try {
      return accountRuntime.currentSubject() !== null;
    } catch {
      return false;
    }
  };

  app.post('/agent-tools/invoke', async (c) => {
    if (!hasActiveAccount()) return c.json({ error: { code: 'ACCOUNT_RUNTIME_REQUIRED' } }, 409);
    const body = await c.req.json().catch(() => null) as {
      name?: unknown; input?: unknown; organizerFilter?: unknown;
    } | null;
    if (!body || typeof body.name !== 'string' || !KNOWLEDGE_AGENT_TOOLS.includes(body.name) ||
        (body.input !== undefined && (typeof body.input !== 'object' || body.input === null))) {
      return c.json({ error: { code: 'VALIDATION_ERROR' } }, 400);
    }
    // organizerFilter（分组/标签范围）由调用端传入，服务端强制随工具透传（上游语义）
    const input = { ...(typeof body.input === 'object' && body.input ? body.input as Record<string, unknown> : {}) };
    const filter = body.organizerFilter;
    if (filter !== undefined) {
      if (typeof filter !== 'object' || filter === null || Array.isArray(filter) ||
          Object.keys(filter).some((key) => key !== 'groupIds' && key !== 'tagIds')) {
        return c.json({ error: { code: 'KNOWLEDGE_FILTER_INVALID' } }, 400);
      }
      input.organizerFilter = filter;
    }
    try {
      const { tenantId, teamId } = currentTeamGatewayScope();
      const data = await callTeamGateway(
        `/api/v1/tenants/${encodeURIComponent(tenantId)}/teams/${encodeURIComponent(teamId)}/knowledge/agent-tools:invoke`,
        {
          method: 'POST',
          body: JSON.stringify({ name: body.name, input }),
          signal: AbortSignal.any([c.req.raw.signal, accountRuntime.signal()]),
        },
      );
      return c.json({ data });
    } catch (error) {
      const mapped = knowledgeGatewayError(error);
      return c.json({ error: { code: mapped.code } }, mapped.status);
    }
  });

  app.get('/agent-tools', (c) => c.json({ data: { tools: [...KNOWLEDGE_AGENT_TOOLS] } }));

  return app;
}

export { UUID_PATTERN };
