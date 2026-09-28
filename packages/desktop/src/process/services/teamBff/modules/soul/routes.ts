// AionUi 新增：团队 Soul 的 BFF 路由（/teamapi/soul/*）。只读：团队统一设定的展示与注入取数。
// 渲染进程不持有令牌；未登录（账户运行时未激活）统一 409 ACCOUNT_RUNTIME_REQUIRED。

import { Hono } from 'hono';
import { accountRuntime } from '../memory/account-runtime.js';
import * as service from './service.js';

export function createSoulRoutes(): Hono {
  const app = new Hono();

  app.get('/soul/current', async (c) => {
    if (!accountRuntime.currentSubject()) {
      return c.json({ error: { code: 'ACCOUNT_RUNTIME_REQUIRED' } }, 409);
    }
    c.header('Cache-Control', 'no-store');
    try {
      const result = await service.getTeamSoul({ forceRefresh: c.req.query('refresh') === '1' });
      return c.json({ soul: result.soul, reason: result.reason });
    } catch (error) {
      return c.json({ error: { code: error instanceof Error ? error.message : 'SOUL_UNAVAILABLE' } }, 503);
    }
  });

  return app;
}
