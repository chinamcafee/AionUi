// AionUi 新增：Team BFF 生命周期（docs/03 D-2：主进程内嵌 @hono/node-server，替代独立进程 spawn）。

import { serve, type ServerType } from '@hono/node-server';
import { createTeamBffApp } from './app';
import type { TeamBffService } from './teamBffService';

export const TEAM_BFF_PORT = 4118;

let server: ServerType | null = null;
let activeService: TeamBffService | null = null;

export function teamBffPort(): number {
  return Number(process.env.AIONUI_TEAM_BFF_PORT) || TEAM_BFF_PORT;
}

export async function startTeamBff(service: TeamBffService): Promise<number> {
  if (server) return teamBffPort();
  const port = teamBffPort();
  const app = createTeamBffApp(service);
  await new Promise<void>((resolve, reject) => {
    server = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, () => resolve());
    server.on('error', reject);
  });
  activeService = service;
  return port;
}

export async function stopTeamBff() {
  if (!server) return;
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  server = null;
  // E-25：应用退出时不清凭据——logout() 会删 refresh-token.bin 导致每次重启需重新登录。
  // 仅清理内存状态；凭据文件保留，下次启动 initialize() 自动恢复会话。
  // 用户主动登出（设置→退出团队账号）才会走 logout() 清除凭据。
  activeService = null;
}

export function teamBffRunning(): boolean {
  return server !== null;
}
