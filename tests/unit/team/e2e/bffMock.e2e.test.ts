// T7.7：BFF 全链路 mock e2e —— 团队平台主链路（登录→bootstrap→切团队→记忆→知识上传→Agent 工具→上下文组装）。
// team-server 以 fetch mock 扮演（契约见 contract 测试）；safeStorage 内存直通。
// 这是 mock 模式的功能性回归主套件（regression.sh 的 e2e-mock 层）。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { TeamBffService } from '@/process/services/teamBff/teamBffService';
import { createTeamBffApp } from '@/process/services/teamBff/app';
import type { SafeStorageLike } from '@/process/auth/secureRefreshStore';

const T = '018f0000-0000-7000-8000-000000000001';
const M = '018f0000-0000-7000-8000-000000000002';
const TEAM_A = '018f0000-0000-7000-8000-000000000003';
const TEAM_B = '018f0000-0000-7000-8000-000000000004';
const BASE = 'http://127.0.0.1:8080';
const REFRESH = 'r'.repeat(64);
const ACCESS = 'a'.repeat(64);

function memorySafeStorage(): SafeStorageLike {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (text) => Buffer.from(`enc:${text}`),
    decryptString: (buf) => {
      const text = Buffer.from(buf).toString('utf8');
      if (!text.startsWith('enc:')) throw new Error('bad');
      return text.slice(4);
    },
  };
}

function bootstrap(state: 'ready' | 'team_required', activeTeamId: string | null) {
  return {
    data: {
      state,
      user: { id: 'u1', email: 'dev@aionui', displayName: 'Dev', avatarUrl: null },
      tenant: { id: T, name: 'AionOrg', tenantMemberId: M, tenantRole: 'tenant_owner', status: 'active' },
      activeTeam: activeTeamId
        ? {
            id: activeTeamId,
            name: `Team-${activeTeamId.slice(-1)}`,
            teamMembershipId: 'tm1',
            roleCode: 'owner',
            status: 'active',
          }
        : null,
      teams: [
        { id: TEAM_A, name: 'Team-A', teamMembershipId: 'tm1', roleCode: 'owner', status: 'active' },
        { id: TEAM_B, name: 'Team-B', teamMembershipId: 'tm2', roleCode: 'member', status: 'active' },
      ],
      permissions: ['team_memory.read', 'team_memory.submit', 'knowledge.upload_personal'],
      versions: { tenantMembership: 1, teamMembership: 1, tenantPolicy: 1, teamPolicy: 1 },
      features: { knowledge: true },
      session: { id: 's1', deviceId: 'd1', expiresAt: new Date(Date.now() + 3600_000).toISOString() },
    },
  };
}

describe('BFF mock 全链路', () => {
  let root: string;
  let service: TeamBffService;
  let authorizeUrl: URL | null;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'bff-e2e-'));
    authorizeUrl = null;
    fetchMock = vi.fn(async (input: any, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/auth/electron/token')) {
        return new Response(
          JSON.stringify({
            data: {
              refreshToken: REFRESH,
              accessToken: ACCESS,
              deviceId: 'd1',
              expiresAt: new Date(Date.now() + 7 * 86400_000).toISOString(),
              accessExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (url.includes('/auth/electron/refresh')) {
        return new Response(
          JSON.stringify({
            data: {
              refreshToken: REFRESH,
              accessToken: ACCESS,
              deviceId: 'd1',
              expiresAt: new Date(Date.now() + 7 * 86400_000).toISOString(),
              accessExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (url.includes('/session/bootstrap'))
        return new Response(JSON.stringify(bootstrap('ready', TEAM_A)), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      if (url.includes('/me/active-team'))
        return new Response(
          JSON.stringify({
            data: {
              ...bootstrap('ready', TEAM_B).data,
              accessToken: ACCESS,
              accessTokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      if (url.includes('/knowledge/uploads') && !url.includes(':complete')) {
        return new Response(
          JSON.stringify({
            data: {
              uploadSession: {
                id: '018f0000-0000-7000-8000-0000000000a1',
                documentId: '018f0000-0000-7000-8000-0000000000a2',
              },
              upload: { method: 'PUT', url: 'http://127.0.0.1:59000/signed', requiredHeaders: {} },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (url.includes(':complete')) {
        return new Response(
          JSON.stringify({
            data: {
              status: 'completed',
              uploadSessionId: '018f0000-0000-7000-8000-0000000000a1',
              documentId: '018f0000-0000-7000-8000-0000000000a2',
              ingestionJobId: '018f0000-0000-7000-8000-0000000000b1',
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (url.includes('/knowledge/jobs/')) {
        return new Response(
          JSON.stringify({
            data: {
              status: 'completed',
              progress: {
                stage: 'completed',
                percent: 100,
                logs: [],
                result: { chunks: 12, entities: 7, communities: 2 },
              },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (url.includes('/team-memories') && (init?.method ?? 'GET') === 'POST' && !url.includes(':submit')) {
        return new Response(
          JSON.stringify({ data: { id: 'm1', version: { id: '018f0000-0000-7000-8000-0000000000c1' } } }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (url.includes(':submit')) {
        return new Response(JSON.stringify({ data: { submitted: true } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/team-memories')) {
        // team-server 信封 { data: [...] }，BFF 的 callTeamGateway 解包后再包 { memories }
        return new Response(JSON.stringify({ data: [{ id: 'm1', title: '既有团队记忆', workflowStatus: 'active' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/agent-tools:invoke')) {
        return new Response(JSON.stringify({ data: { answer: '来自知识库的答案', citations: [] } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ data: { ok: true } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    service = new TeamBffService({
      userDataPath: root,
      safeStorage: memorySafeStorage(),
      openExternal: async (url) => {
        authorizeUrl = new URL(url);
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(root, { recursive: true, force: true });
  });

  it('登录 → bootstrap → 账号/网关就绪 → 切团队 → 记忆 CRUD → 知识上传/进度 → Agent 工具 → 上下文组装', async () => {
    // ① 启用功能 + 初始化
    await service.config.set({ enabled: true, serverBaseUrl: BASE });
    await service.initialize();
    expect(service.currentView().authPhase).toBe('signed_out');

    // ② 发起登录（PKCE 参数完整）
    await service.beginLogin();
    expect(service.currentView().authPhase).toBe('authorizing');
    expect(authorizeUrl).not.toBeNull();
    // 授权确认页在 team-admin（默认 30190），而非 team-server API 域（E-8 修复回归）
    expect(authorizeUrl!.origin).toBe('http://127.0.0.1:30190');
    expect(authorizeUrl!.pathname).toBe('/electron/authorize');
    expect(authorizeUrl!.searchParams.get('clientId')).toBe('aionui-desktop');
    expect(authorizeUrl!.searchParams.get('redirectUri')).toBe('aionui://oauth/callback');
    const codeChallenge = authorizeUrl!.searchParams.get('codeChallenge')!;
    expect(codeChallenge).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    const state = authorizeUrl!.searchParams.get('state')!;

    // ③ OAuth 回调（state 必须匹配）
    const code = 'c'.repeat(64);
    await expect(service.handleOAuthCallback(`aionui://oauth/callback?code=${code}&state=other`)).rejects.toThrow();
    await service.handleOAuthCallback(`aionui://oauth/callback?code=${code}&state=${state}`);
    expect(service.currentView().authPhase).toBe('authenticated');
    // bootstrap ready → 账号运行时 + 网关配置
    expect(service.accountRuntime.currentSubject()).toMatchObject({
      tenantId: T,
      tenantMemberId: M,
      activeTeamId: TEAM_A,
    });
    expect(service.gateway.isConfigured()).toBe(true);

    // ④ 切换团队（generation 失效旧网关 → 新团队生效）
    const switched = await service.switchTeam(T, TEAM_B);
    expect(switched.activeTeam?.id).toBe(TEAM_B);
    expect(service.accountRuntime.currentSubject()?.activeTeamId).toBe(TEAM_B);

    const app = createTeamBffApp(service);
    const json = async (response: Response) => ({ status: response.status, body: await response.json() });

    // ⑤ 个人记忆 CRUD
    const created = await json(
      await app.request('/teamapi/memories', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: '偏好：简洁回答',
          content: '用户偏好简洁',
          categoryId: 'preference',
          scope: 'chat',
        }),
      })
    );
    expect([200, 201]).toContain(created.status);
    const list = await json(await app.request('/teamapi/memories'));
    expect(list.body.memories.some((m: { title: string }) => m.title.includes('简洁回答'))).toBe(true);

    // ⑤b 分类体系：新建分类 → 归档记忆 → 按分类过滤 → 归档分类并迁移引用（决策 D3）
    const categoryCreated = await json(
      await app.request('/teamapi/memory-categories', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '工作流程', description: '与工作推进相关' }),
      })
    );
    expect(categoryCreated.status).toBe(201);
    const workCategory = categoryCreated.body.category as { id: string; version: number };
    const categoriesList = await json(await app.request('/teamapi/memory-categories'));
    expect(categoriesList.body.categories.some((c: { id: string }) => c.id === workCategory.id)).toBe(true);

    const createdWithCategory = await json(
      await app.request('/teamapi/memories', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: '流程：周报',
          content: '每周五发周报',
          categoryId: workCategory.id,
          scope: 'chat',
        }),
      })
    );
    expect(createdWithCategory.status).toBe(200);
    const filtered = await json(await app.request(`/teamapi/memories?categoryId=${workCategory.id}`));
    expect(filtered.body.memories).toHaveLength(1);

    const archived = await json(
      await app.request(`/teamapi/memory-categories/${workCategory.id}`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ baseVersion: workCategory.version, reassignTo: 'fact' }),
      })
    );
    expect(archived.status).toBe(200);
    expect(archived.body.reassigned).toBe(1);
    const afterArchive = await json(await app.request('/teamapi/memories?categoryId=fact'));
    expect(afterArchive.body.memories.some((m: { title: string }) => m.title.includes('周报'))).toBe(true);

    // ⑥ 团队记忆提交（201）与列表
    const submitted = await json(
      await app.request('/teamapi/team-memories', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: '发布规范',
          content: '发布需复核',
          category: 'requirement',
          memoryScope: 'chat',
          tags: ['规范'],
        }),
      })
    );
    expect(submitted.status).toBe(201);
    const teamList = await json(await app.request('/teamapi/team-memories'));
    expect(teamList.body.memories[0].title).toBe('既有团队记忆');

    // ⑦ 知识上传 → complete → job 进度（mock 全 completed）
    const upload = await json(
      await app.request('/teamapi/knowledge/uploads', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          filename: 'a.pdf',
          mime: 'application/pdf',
          sizeBytes: 3,
          sha256: 'x'.repeat(64),
          idempotencyKey: '018f0000-0000-7000-8000-0000000000f1',
        }),
      })
    );
    expect(upload.body.data.uploadSession.id).toBe('018f0000-0000-7000-8000-0000000000a1');
    const complete = await json(
      await app.request('/teamapi/knowledge/uploads/018f0000-0000-7000-8000-0000000000a1/complete', { method: 'POST' })
    );
    expect(complete.body.data.ingestionJobId).toBe('018f0000-0000-7000-8000-0000000000b1');
    const job = await json(await app.request('/teamapi/knowledge/jobs/018f0000-0000-7000-8000-0000000000b1'));
    expect(job.body.data.status).toBe('completed');
    expect(job.body.data.progress.result).toMatchObject({ chunks: 12, entities: 7, communities: 2 });

    // ⑧ Agent 工具（Tool Gateway 通道）
    const tool = await json(
      await app.request('/teamapi/agent-tools/invoke', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'knowledge.synthesize',
          input: { query: '发布规范是什么' },
          organizerFilter: { groupIds: [], tagIds: [] },
        }),
      })
    );
    expect(tool.body.data.answer).toBe('来自知识库的答案');

    // ⑨ 上下文组装（个人通道词法召回 + 云端通道 mock）
    const context = await json(
      await app.request('/teamapi/context/assemble', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: '回答风格偏好', scope: 'chat' }),
      })
    );
    expect(context.status).toBe(200);
    expect(context.body.result).toHaveProperty('personalHits');
    expect(typeof context.body.rendered).toBe('string');

    // ⑩ 登出：账号/网关释放
    await service.logout();
    expect(service.accountRuntime.currentSubject()).toBeNull();
    expect(service.gateway.isConfigured()).toBe(false);
  });

  it('登出后记忆路由返回 409（账号态释放验证）', async () => {
    await service.config.set({ enabled: true, serverBaseUrl: BASE });
    await service.initialize();
    await service.beginLogin();
    const state = authorizeUrl!.searchParams.get('state')!;
    await service.handleOAuthCallback(`aionui://oauth/callback?code=${'c'.repeat(64)}&state=${state}`);
    await service.logout();
    const app = createTeamBffApp(service);
    const response = await app.request('/teamapi/memories');
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toBe('ACCOUNT_RUNTIME_REQUIRED');
  });
});

// sha256 工具（与上传库一致）用于断言 mock 数据一致性
export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
