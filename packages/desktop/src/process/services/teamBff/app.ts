// AionUi 新增：Team BFF Hono 路由（T1.2/T1.5）。
// 仅监听 127.0.0.1:4118；renderer 经 /teamapi/* 访问；后续 M2/M3/M4 模块在同 app 上挂载。

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { TeamBffService } from './teamBffService';
import { createMemoryRoutes } from './modules/memory/routes';
import { createKnowledgeRoutes } from './modules/knowledge/routes';
import { createAgentToolsRoutes } from './modules/knowledge/agentTools';
import { createPersonalSyncRoutes } from './modules/personalSync/routes';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function errorBody(message: string) {
  return { error: { code: message.replace(/^Error:\s*/, '') } };
}

export function createTeamBffApp(service: TeamBffService) {
  const app = new Hono();

  // 渲染器（vite dev 的 localhost:5173、webui 宿主、打包后的本地源）与本服务跨源，
  // 无 CORS 头时浏览器预检失败表现为 renderer 端 "TypeError: Failed to fetch"。
  // 仅放行本机回环源（任意端口）与打包渲染的 null 源；不启用 credentials。
  app.use(
    '/teamapi/*',
    cors({
      origin: (origin) =>
        origin === 'null' || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin || '') ? origin : null,
      allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'Accept'],
    })
  );

  app.get('/healthz', (c) => c.json({ ok: true, service: 'aionui-team-bff' }));

  // ── 配置 ─────────────────────────────────────────────
  app.get('/teamapi/config', async (c) => c.json({ data: await service.config.get() }));
  app.post('/teamapi/config', async (c) => {
    try {
      const body = await c.req.json();
      return c.json({ data: await service.config.set(body ?? {}) });
    } catch (error) {
      return c.json(errorBody(String(error)), 400);
    }
  });

  // ── 认证会话 ─────────────────────────────────────────
  app.get('/teamapi/auth/status', (c) => c.json({ data: service.currentView() }));
  app.post('/teamapi/auth/login', async (c) => {
    try {
      return c.json({ data: await service.beginLogin() });
    } catch (error) {
      return c.json(errorBody(String(error)), 400);
    }
  });
  app.post('/teamapi/auth/logout', async (c) => {
    await service.logout();
    return c.json({ data: service.currentView() });
  });

  // ── 会话 bootstrap / 团队切换 ─────────────────────────
  app.get('/teamapi/session/bootstrap', async (c) => {
    try {
      return c.json({ data: await service.fetchBootstrap() });
    } catch (error) {
      return c.json(errorBody(String(error)), 401);
    }
  });
  app.get('/teamapi/session/tenants', async (c) => {
    try {
      return c.json({ data: await service.listTenants() });
    } catch {
      return c.json(errorBody('SESSION_INVALID'), 401);
    }
  });
  app.post('/teamapi/session/switch-tenant', async (c) => {
    const body = await c.req.json().catch(() => null);
    if (typeof body?.tenantId !== 'string' || !UUID_PATTERN.test(body.tenantId))
      return c.json(errorBody('ACTIVE_TENANT_INVALID'), 400);
    try {
      return c.json({ data: await service.switchTenant(body.tenantId) });
    } catch {
      return c.json(errorBody('ACTIVE_TENANT_FORBIDDEN'), 403);
    }
  });
  app.post('/teamapi/session/switch-team', async (c) => {
    const body = await c.req.json().catch(() => null);
    const tenantId = body?.tenantId;
    const teamId = body?.teamId;
    if (
      typeof tenantId !== 'string' ||
      typeof teamId !== 'string' ||
      !UUID_PATTERN.test(tenantId) ||
      !UUID_PATTERN.test(teamId)
    ) {
      return c.json(errorBody('ACTIVE_TEAM_INVALID'), 400);
    }
    try {
      return c.json({ data: await service.switchTeam(tenantId, teamId) });
    } catch (error) {
      return c.json(errorBody(String(error)), 400);
    }
  });

  // ── 个人记忆（M2，/teamapi/memories*）─────────────────
  app.route('/teamapi', createMemoryRoutes());

  // ── 知识库网关（M4，/teamapi/knowledge/*）──────────────
  app.route('/teamapi', createKnowledgeRoutes());

  // ── Agent 知识工具（M5，/teamapi/agent-tools*）──────────
  app.route('/teamapi', createAgentToolsRoutes());

  // ── 个人记忆云备份（/teamapi/personal-sync/*）───────────
  app.route('/teamapi', createPersonalSyncRoutes());

  return app;
}
