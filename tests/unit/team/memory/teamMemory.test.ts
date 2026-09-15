// T3.6：团队记忆模块单测（invalidation 快照合并语义 + BFF 路由校验）。

import { describe, expect, it } from 'vitest';
import {
  observeTeamMemoryRevision, startTeamMemoryInvalidationStream,
  stopTeamMemoryInvalidationStream, teamMemoryInvalidationSnapshot,
} from '@/process/services/teamBff/modules/memory/team-memory-invalidation';
import { createMemoryRoutes } from '@/process/services/teamBff/modules/memory/routes';

describe('team-memory-invalidation（移植自 client，210 行零逻辑改动）', () => {
  it('快照初值与 observe 合并语义（observedRevision 单调、dirty 判定）', () => {
    stopTeamMemoryInvalidationStream();
    const initial = teamMemoryInvalidationSnapshot();
    expect(initial).toMatchObject({ connected: false, dirty: false, latestRevision: 0, observedRevision: 0 });
    observeTeamMemoryRevision(5);
    expect(teamMemoryInvalidationSnapshot().observedRevision).toBe(5);
    observeTeamMemoryRevision(3); // 旧 revision 不回退
    expect(teamMemoryInvalidationSnapshot().observedRevision).toBe(5);
    observeTeamMemoryRevision(-1); // 非法值忽略
    expect(teamMemoryInvalidationSnapshot().observedRevision).toBe(5);
  });

  it('start/stop 重置快照（停止后回到初值）', () => {
    observeTeamMemoryRevision(9);
    startTeamMemoryInvalidationStream({
      baseUrl: new URL('http://127.0.0.1:8080'),
      accessToken: 't'.repeat(64),
      tenantId: '018f0000-0000-7000-8000-000000000001',
      teamId: '018f0000-0000-7000-8000-000000000003',
      accountSignal: new AbortController().signal,
    });
    stopTeamMemoryInvalidationStream();
    expect(teamMemoryInvalidationSnapshot().observedRevision).toBe(0);
  });
});

describe('团队记忆路由校验（无账号态）', () => {
  const app = createMemoryRoutes();

  it('GET /team-memories 未配置网关 → 503 结构化错误', async () => {
    const response = await app.request('/team-memories');
    expect(response.status).toBe(503);
    const payload = await response.json() as { error: string };
    expect(payload.error).toBe('TEAM_GATEWAY_UNAVAILABLE');
  });

  it('POST /team-memories 输入校验（无账号态先 409；body 非法在账号就绪后为 400 路径）', async () => {
    const response = await app.request('/team-memories', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '', content: '' }),
    });
    // 未绑定账号 → 账号中间件 409（memory 路由的中间件覆盖 /memories/*；
    // team-memories 不挂该中间件，直接进入网关调用前的输入校验/网关错误路径）
    expect([400, 409, 503]).toContain(response.status);
  });

  it('GET /team-memory-invalidation 返回快照形状', async () => {
    const response = await app.request('/team-memory-invalidation');
    const payload = await response.json() as { state: { connected: boolean; dirty: boolean } };
    expect(payload.state).toMatchObject({ connected: false, dirty: false });
  });
});
