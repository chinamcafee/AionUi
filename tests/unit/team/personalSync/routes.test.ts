// 个人记忆云备份（E-31 移植）：BFF 路由契约验证。
// 直接挂载 Hono 路由并调用：① 未登录（账户运行时未激活）→ 409 ACCOUNT_RUNTIME_REQUIRED；
// ② 已登录且未初始化 → 200 且状态形状与渲染层契约一致（active/initialized/conflicts 等）；
// ③ 参数校验（恢复码/配对输入非法 → 400，错误信封为 {error:{code}}）。

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { AccountRuntimeManager } from '@/process/services/teamBff/accountRuntime';
import { bindAccountRuntime } from '@/process/services/teamBff/modules/memory/account-runtime';
import { getMemoryStoreContext } from '@/process/services/teamBff/modules/memory/memory-store';
import { createPersonalSyncRoutes } from '@/process/services/teamBff/modules/personalSync/routes';
import { createMemoryRoutes } from '@/process/services/teamBff/modules/memory/routes';
import { unlockSecretVault } from '@/process/services/teamBff/modules/personalSync/secretVault';

const T1 = '018f0000-0000-7000-8000-000000000001';
const M1 = '018f0000-0000-7000-8000-000000000002';
const TEAM_A = '018f0000-0000-7000-8000-000000000003';
const VAULT_KEY = Buffer.from(Array.from({ length: 32 }, (_, index) => index + 1)).toString('base64url');

function createApp() {
  const app = new Hono();
  app.route('/teamapi', createPersonalSyncRoutes());
  return app;
}

describe('personal-sync BFF 路由契约', () => {
  let runtime: AccountRuntimeManager | null = null;

  it('BFF 模块图可加载：团队记忆路由（经 ai → @ai-sdk/provider-utils 链）可用', () => {
    // 回归守卫：vendored ai 链的依赖（@workflow/serde）被裁剪时，主进程 `registerTeamIntegration`
    // 会静默 "integration disabled"，团队功能整块失效——此断言把该类问题前移到单测。
    const app = new Hono();
    app.route('/teamapi', createMemoryRoutes());
    expect(app).toBeTruthy();
  });

  beforeEach(() => {
    unlockSecretVault(VAULT_KEY);
  });

  afterEach(async () => {
    if (runtime) {
      await runtime.deactivate();
      runtime = null;
    }
  });

  it('未登录：status/devices/sync-now 均 409 ACCOUNT_RUNTIME_REQUIRED', async () => {
    runtime = new AccountRuntimeManager(mkdtempSync(path.join(tmpdir(), 'aionui-personal-sync-routes-')));
    bindAccountRuntime(runtime);
    const app = createApp();
    for (const [method, url] of [
      ['GET', '/teamapi/personal-sync/status'],
      ['GET', '/teamapi/personal-sync/devices'],
      ['POST', '/teamapi/personal-sync/sync-now'],
    ] as const) {
      const response = await app.request(url, { method });
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: { code: 'ACCOUNT_RUNTIME_REQUIRED' } });
    }
  });

  it('已登录未初始化：status 返回渲染层契约形状（active/initialized/conflicts/remote）', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'aionui-personal-sync-routes-'));
    runtime = new AccountRuntimeManager(root);
    bindAccountRuntime(runtime);
    await runtime.activate({ tenantId: T1, tenantMemberId: M1, activeTeamId: TEAM_A });
    await getMemoryStoreContext();
    const response = await createApp().request('/teamapi/personal-sync/status');
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('application/json');
    const body = (await response.json()) as { data: Record<string, unknown> };
    expect(body.data.active).toBe(false); // 未 activate 云备份（无凭据）
    expect(body.data.initialized).toBe(false);
    expect(body.data.autoEnabled).toBe(false);
    expect(body.data.syncing).toBe(false);
    expect(body.data.conflicts).toEqual([]);
    expect(body.data.pendingEvents).toBe(0);
    expect(body.data.cursor).toBe(0);
    expect(body.data.remote).toBeNull();
    expect(body.data.deviceId).toBeNull();
  });

  it('参数校验：非法恢复码/配对输入 → 400 + {error:{code}}；未初始化操作 → 409', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'aionui-personal-sync-routes-'));
    runtime = new AccountRuntimeManager(root);
    bindAccountRuntime(runtime);
    await runtime.activate({ tenantId: T1, tenantMemberId: M1, activeTeamId: TEAM_A });
    await getMemoryStoreContext();
    const app = createApp();
    const badRecovery = await app.request('/teamapi/personal-sync/recovery', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recoveryCode: 'too-short' }),
    });
    expect(badRecovery.status).toBe(400);
    expect(await badRecovery.json()).toEqual({ error: { code: 'RECOVERY_CODE_INVALID' } });

    const badPairing = await app.request('/teamapi/personal-sync/pairing/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pairingId: 'not-a-uuid', displayCode: '1' }),
    });
    expect(badPairing.status).toBe(400);
    expect((await badPairing.json()) as { error: { code: string } }).toMatchObject({
      error: { code: 'PERSONAL_SYNC_PAIRING_INVALID' },
    });

    const badPreference = await app.request('/teamapi/personal-sync/preferences', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ autoEnabled: 'yes' }),
    });
    expect(badPreference.status).toBe(400);

    // 未初始化即手动同步：PERSONAL_SYNC_NOT_ACTIVE → 409
    const syncNow = await app.request('/teamapi/personal-sync/sync-now', { method: 'POST' });
    expect(syncNow.status).toBe(409);
    expect((await syncNow.json()) as { error: { code: string } }).toMatchObject({
      error: { code: 'PERSONAL_SYNC_NOT_ACTIVE' },
    });
  });
});
