// AionUi 新增：Team BFF 主进程集成（T1.7/T1.8/T1.9）。
// 注册 IPC（preload 消费）、OAuth 深链回调、BFF 启停（按 config.enabled），状态经 'team-auth-status' 广播。

import { app, ipcMain, powerMonitor, safeStorage, shell, type BrowserWindow } from 'electron';
import { TeamBffService } from './teamBffService';
import { startTeamBff, stopTeamBff, teamBffPort, teamBffRunning } from './lifecycle';

let service: TeamBffService | null = null;
let bffPort = 0;
let getWindow: () => BrowserWindow | null = () => null;

function broadcastStatus(view: unknown) {
  const win = getWindow();
  if (win && !win.isDestroyed()) win.webContents.send('team-auth-status', view);
}

async function ensureService(): Promise<TeamBffService> {
  if (!service) {
    service = new TeamBffService({
      userDataPath: app.getPath('userData'),
      safeStorage,
      openExternal: (url) => shell.openExternal(url),
    });
    service.onStatus((view) => broadcastStatus(view));
  }
  return service;
}

async function syncServerState() {
  const active = await ensureService();
  const config = await active.config.get();
  // 双层开关（T6.1）：运行时 config.enabled（设置页）∧ 编译/环境级 AIONUI_TEAM_FEATURE!==0。
  // 环境级关闭用于发布灰度——即使配置文件 enabled 也保持关闭（默认关闭，零回归）。
  const envEnabled = process.env.AIONUI_TEAM_FEATURE !== '0';
  if (config.enabled && envEnabled && !teamBffRunning()) {
    bffPort = await startTeamBff(active);
    await active.initialize().catch((error) => console.warn('[teamBff] initialize failed:', error?.message ?? error));
  } else if ((!config.enabled || !envEnabled) && teamBffRunning()) {
    await stopTeamBff();
    bffPort = 0;
  }
}

export async function registerTeamIntegration(deps: { getWindow: () => BrowserWindow | null }) {
  getWindow = deps.getWindow;

  ipcMain.on('get-team-bff-port', (event) => {
    event.returnValue = bffPort;
  });

  ipcMain.handle('team:config.get', async () => (await ensureService()).config.get());

  ipcMain.handle('team:config.set', async (_event, patch) => {
    const active = await ensureService();
    const next = await active.config.set(patch ?? {});
    await syncServerState();
    return next;
  });

  ipcMain.handle('team:auth.status', async () => (await ensureService()).currentView());

  ipcMain.handle('team:auth.begin-login', async () => {
    const active = await ensureService();
    await syncServerState();
    return active.beginLogin();
  });

  ipcMain.handle('team:auth.logout', async () => {
    if (!service) return null;
    return service.logout();
  });

  ipcMain.handle('team:auth.switch-team', async (_event, tenantId: string, teamId: string) => {
    if (!service) throw new Error('TEAM_GATEWAY_UNAVAILABLE');
    return service.switchTeam(tenantId, teamId);
  });

  // 个人记忆云备份：系统休眠恢复后补一次同步（对齐上游 resume 触发；未激活/未初始化时静默）
  powerMonitor.on('resume', () => {
    void import('./modules/personalSync/service')
      .then((personalSync) => personalSync.runPersonalSync('resume'))
      .catch(() => {});
  });

  await syncServerState().catch((error) => console.warn('[teamBff] startup sync failed:', error?.message ?? error));
  return { port: bffPort, enabled: bffPort > 0 };
}

/** deepLink.ts 的 aionui://oauth/callback 拦截入口（T1.7）。 */
export async function handleTeamOAuthCallback(rawUrl: string) {
  const active = await ensureService();
  try {
    return await active.handleOAuthCallback(rawUrl);
  } catch (error) {
    console.warn('[teamBff] oauth callback failed:', (error as Error)?.message);
    return active.currentView();
  }
}

export async function stopTeamIntegration() {
  await stopTeamBff();
  bffPort = 0;
}
