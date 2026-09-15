// AionUi 新增：团队平台连接配置（Server URL / 功能开关），userData 下 JSON 持久化。
// 参照 client 的运行时配置方式（client 由 Electron 主进程注入），此处以最小实现落地。

import fs from 'node:fs/promises';
import path from 'node:path';
import { validatedTeamServerBaseUrl } from '../../auth/teamApiClient';

export interface TeamPlatformConfig {
  enabled: boolean;
  serverBaseUrl: string;
  clientId: string;
  /** 记忆场景模型端点（个人记忆抽取/整理/去重/图谱用，OpenAI 兼容） */
  memoryModel?: {
    baseUrl: string;
    apiKey: string;
    model: string;
    name?: string;
  };
  /**
   * Electron OAuth 授权确认页地址（team-admin 控制台路由，非 team-server API）。
   * 本地栈默认 http://127.0.0.1:30190/electron/authorize；生产为控制台域名同路径。
   */
  authorizationPageUrl?: string;
}

const DEFAULT_CONFIG: TeamPlatformConfig = {
  enabled: false,
  serverBaseUrl: 'http://127.0.0.1:30180',
  clientId: 'aionui-desktop',
};

export class TeamConfigStore {
  private cache: TeamPlatformConfig | null = null;

  constructor(private readonly filePath: string) {}

  async get(): Promise<TeamPlatformConfig> {
    if (this.cache) return this.cache;
    try {
      const raw = JSON.parse(await fs.readFile(this.filePath, 'utf8'));
      this.cache = {
        enabled: raw.enabled === true,
        serverBaseUrl: typeof raw.serverBaseUrl === 'string' ? raw.serverBaseUrl : DEFAULT_CONFIG.serverBaseUrl,
        clientId: typeof raw.clientId === 'string' && /^[A-Za-z0-9._-]{3,128}$/.test(raw.clientId)
          ? raw.clientId
          : DEFAULT_CONFIG.clientId,
        authorizationPageUrl: typeof raw.authorizationPageUrl === 'string' && /^https?:\/\//.test(raw.authorizationPageUrl)
          ? raw.authorizationPageUrl
          : undefined,
        memoryModel: raw.memoryModel && typeof raw.memoryModel === 'object' &&
          typeof raw.memoryModel.baseUrl === 'string' && typeof raw.memoryModel.apiKey === 'string' &&
          typeof raw.memoryModel.model === 'string' && raw.memoryModel.baseUrl && raw.memoryModel.apiKey && raw.memoryModel.model
          ? {
            baseUrl: raw.memoryModel.baseUrl,
            apiKey: raw.memoryModel.apiKey,
            model: raw.memoryModel.model,
            name: typeof raw.memoryModel.name === 'string' ? raw.memoryModel.name : undefined,
          }
          : undefined,
      };
      validatedTeamServerBaseUrl(this.cache.serverBaseUrl);
    } catch {
      this.cache = { ...DEFAULT_CONFIG };
    }
    return this.cache;
  }

  async set(patch: Partial<TeamPlatformConfig>): Promise<TeamPlatformConfig> {
    const current = await this.get();
    const next: TeamPlatformConfig = {
      enabled: patch.enabled ?? current.enabled,
      serverBaseUrl: patch.serverBaseUrl ?? current.serverBaseUrl,
      clientId: patch.clientId ?? current.clientId,
      memoryModel: 'memoryModel' in patch ? patch.memoryModel : current.memoryModel,
      authorizationPageUrl: 'authorizationPageUrl' in patch ? patch.authorizationPageUrl : current.authorizationPageUrl,
    };
    validatedTeamServerBaseUrl(next.serverBaseUrl);
    if (!/^[A-Za-z0-9._-]{3,128}$/.test(next.clientId)) throw new Error('TEAM_ELECTRON_CLIENT_ID_INVALID');
    await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(next, null, 2), { mode: 0o600, flag: 'wx' });
    await fs.rename(temporary, this.filePath);
    this.cache = next;
    return next;
  }
}
