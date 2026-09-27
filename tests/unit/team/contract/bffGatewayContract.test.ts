// T6.4/T7.6：BFF ↔ team-server 契约测试。
// 用真实 TeamGatewayRuntime + fetch stub 捕获出站请求，断言路径/方法/头/体与
// team-server 知识网关约定一致（源 client main.ts 同款调用序列为契约基准）。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AccountRuntimeManager } from '@/process/services/teamBff/accountRuntime';
import { TeamGatewayRuntime } from '@/process/services/teamBff/gatewayRuntime';
import { bindAccountRuntime } from '@/process/services/teamBff/modules/memory/account-runtime';
import { bindTeamGateway } from '@/process/services/teamBff/modules/memory/team-gateway-runtime';
import { createKnowledgeRoutes } from '@/process/services/teamBff/modules/knowledge/routes';
import { createAgentToolsRoutes } from '@/process/services/teamBff/modules/knowledge/agentTools';
import { createMemoryRoutes } from '@/process/services/teamBff/modules/memory/routes';

const TOKEN = 't'.repeat(64);
const T = '018f0000-0000-7000-8000-000000000001';
const M = '018f0000-0000-7000-8000-000000000002';
const TEAM = '018f0000-0000-7000-8000-000000000003';
const BASE = 'http://127.0.0.1:8080';
const TEAM_BASE = `/api/v1/tenants/${T}/teams/${TEAM}`;

interface CapturedCall {
  url: string;
  init: RequestInit;
}

let calls: CapturedCall[];
let fetchMock: ReturnType<typeof vi.fn>;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

beforeEach(async () => {
  calls = [];
  fetchMock = vi.fn(async (input: any, init?: RequestInit) => {
    calls.push({ url: input.toString(), init: init ?? {} });
    const last = calls[calls.length - 1];
    if (last.url.includes('/knowledge/uploads') && !last.url.includes(':complete')) {
      return jsonResponse({
        data: {
          uploadSession: {
            id: '018f0000-0000-7000-8000-0000000000a1',
            documentId: '018f0000-0000-7000-8000-0000000000a2',
          },
          upload: { method: 'PUT', url: 'http://127.0.0.1:59000/signed-put', requiredHeaders: {} },
        },
      });
    }
    return jsonResponse({ data: { ok: true } });
  });
  vi.stubGlobal('fetch', fetchMock);

  const runtime = new AccountRuntimeManager(mkdtempSync(path.join(tmpdir(), 'contract-')));
  bindAccountRuntime(runtime);
  await runtime.activate({ tenantId: T, tenantMemberId: M, activeTeamId: TEAM });
  const gateway = new TeamGatewayRuntime(runtime);
  bindTeamGateway(gateway);
  gateway.configure({ teamServerBaseUrl: BASE, accessToken: TOKEN, tenantId: T, teamId: TEAM });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const headers = (init: RequestInit) => init.headers as Headers;

describe('知识上传契约（T4.3 路由 → team-server）', () => {
  it('POST /teamapi/knowledge/uploads：路径含租户/团队、Bearer 头、Idempotency-Key 透传、体含 sha256/visibility', async () => {
    const app = createKnowledgeRoutes();
    const response = await app.request('/knowledge/uploads', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        filename: 'a.pdf',
        mime: 'application/pdf',
        sizeBytes: 3,
        sha256: 'x'.repeat(64),
        visibility: 'team',
        classification: 'internal',
        idempotencyKey: '018f0000-0000-7000-8000-0000000000ff',
      }),
    });
    expect(response.status).toBe(200);
    const call = calls[0];
    expect(call.url).toBe(`${BASE}${TEAM_BASE}/knowledge/uploads`);
    expect(call.init.method).toBe('POST');
    expect(headers(call.init).get('Authorization')).toBe(`Bearer ${TOKEN}`);
    expect(headers(call.init).get('Idempotency-Key')).toBe('018f0000-0000-7000-8000-0000000000ff');
    const body = JSON.parse(String(call.init.body));
    expect(body).toMatchObject({
      filename: 'a.pdf',
      sha256: 'x'.repeat(64),
      visibility: 'team',
      classification: 'internal',
    });
  });

  it('complete/retry/cancel 命中 `:action` 形状路径', async () => {
    const app = createKnowledgeRoutes();
    await app.request('/knowledge/uploads/018f0000-0000-7000-8000-0000000000a1/complete', { method: 'POST' });
    expect(calls[0].url).toBe(`${BASE}${TEAM_BASE}/knowledge/uploads/018f0000-0000-7000-8000-0000000000a1:complete`);
    await app.request('/knowledge/jobs/018f0000-0000-7000-8000-0000000000b1/retry', { method: 'POST' });
    expect(calls[1].url.endsWith('/api/v1/knowledge/jobs/018f0000-0000-7000-8000-0000000000b1:retry')).toBe(true);
    await app.request('/knowledge/jobs/018f0000-0000-7000-8000-0000000000b1/cancel', { method: 'POST' });
    expect(calls[2].url.endsWith('/api/v1/knowledge/jobs/018f0000-0000-7000-8000-0000000000b1:cancel')).toBe(true);
  });
});

describe('Agent 工具契约（T5.3）', () => {
  it('invoke：`knowledge/agent-tools:invoke` + organizerFilter 注入 input', async () => {
    const app = createAgentToolsRoutes();
    const response = await app.request('/agent-tools/invoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'knowledge.query',
        input: { query: '产品指标' },
        organizerFilter: { groupIds: ['g1'], tagIds: [] },
      }),
    });
    expect(response.status).toBe(200);
    const call = calls[0];
    expect(call.url).toBe(`${BASE}${TEAM_BASE}/knowledge/agent-tools:invoke`);
    const body = JSON.parse(String(call.init.body));
    expect(body).toEqual({
      name: 'knowledge.query',
      input: { query: '产品指标', organizerFilter: { groupIds: ['g1'], tagIds: [] } },
    });
  });
});

describe('团队记忆契约（T3.2）', () => {
  it('POST：`team-memories` 创建（Idempotency-Key + source.manual）后 `:submit` 提交', async () => {
    fetchMock.mockImplementation(async (input: any, init?: RequestInit) => {
      calls.push({ url: input.toString(), init: init ?? {} });
      const url = input.toString();
      if (url.endsWith('/team-memories')) {
        return jsonResponse({ data: { id: 'm1', version: { id: '018f0000-0000-7000-8000-0000000000c1' } } }, 200);
      }
      return jsonResponse({ data: { submitted: true } }, 200);
    });
    const app = createMemoryRoutes();
    const response = await app.request('/team-memories', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: '发布规范',
        content: '所有发布需二人复核',
        category: 'requirement',
        memoryScope: 'chat',
        tags: ['规范'],
      }),
    });
    expect(response.status).toBe(201);
    expect(calls[0].url).toBe(`${BASE}${TEAM_BASE}/team-memories`);
    expect(headers(calls[0].init).get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({
      title: '发布规范',
      memoryScope: 'chat',
      source: { type: 'manual' },
    });
    expect(calls[1].url).toBe(`${BASE}${TEAM_BASE}/team-memory-versions/018f0000-0000-7000-8000-0000000000c1:submit`);
  });

  it('GET：`team-memories?limit=100&memoryScope=code` 列表', async () => {
    const app = createMemoryRoutes();
    await app.request('/team-memories?memoryScope=code');
    expect(calls[0].url).toBe(`${BASE}${TEAM_BASE}/team-memories?limit=100&memoryScope=code`);
  });
});
