// AionUi 新增：Team BFF 编排层（移植自 client/server 的网关编排 + electron/auth 生命周期，见 docs/02 M1）。
// 职责：组合 配置/凭据存储/账号运行时/网关/认证会话/API client，并向 Hono 路由与主进程事件提供统一入口。

import path from 'node:path';
import { AccountRuntimeManager } from './accountRuntime';
import { TeamGatewayRuntime } from './gatewayRuntime';
import { TeamConfigStore } from './configStore';
import { SafeStorageRefreshTokenStore, type SafeStorageLike } from '../../auth/secureRefreshStore';
import { ElectronAuthSessionManager } from '../../auth/sessionManager';
import { TeamApiClient, type SessionBootstrap } from '../../auth/teamApiClient';

export interface TeamBffDeps {
  userDataPath: string;
  safeStorage: SafeStorageLike;
  openExternal: (url: string) => Promise<void>;
  fetcher?: typeof fetch;
}

export interface TeamSessionView {
  authPhase: string;
  bootstrap: SessionBootstrap | null;
  gatewayConfigured: boolean;
  accountActive: boolean;
}

export class TeamBffService {
  readonly config: TeamConfigStore;
  readonly accountRuntime: AccountRuntimeManager;
  /** invalidation hooks 注入后会重建（见 gatewayAttachInvalidation），非 readonly */
  gateway: TeamGatewayRuntime;
  private readonly refreshStore: SafeStorageRefreshTokenStore;
  private readonly openExternal: (url: string) => Promise<void>;
  private readonly fetcher: typeof fetch;
  private authManager: ElectronAuthSessionManager | null = null;
  private apiClient: TeamApiClient | null = null;
  private cachedBootstrap: SessionBootstrap | null = null;
  private readonly statusListeners = new Set<(view: TeamSessionView) => void>();

  private gatewayAttached = false;

  private gatewayAttachInvalidation(invalidation: {
    startTeamMemoryInvalidationStream: (input: {
      baseUrl: URL;
      accessToken: string;
      tenantId: string;
      teamId: string;
      accountSignal: AbortSignal;
    }) => void;
    stopTeamMemoryInvalidationStream: () => void;
  }) {
    if (this.gatewayAttached) return;
    this.gatewayAttached = true;
    // 重新构造 gateway 以注入 invalidation hooks（构造时 accountRuntime 已就绪）
    const gateway = new TeamGatewayRuntime(this.accountRuntime, {
      start: (input) => invalidation.startTeamMemoryInvalidationStream(input),
      stop: () => invalidation.stopTeamMemoryInvalidationStream(),
    });
    this.gateway = gateway;
    void import('./modules/memory/team-gateway-runtime').then(({ bindTeamGateway }) => bindTeamGateway(gateway));
  }

  constructor(deps: TeamBffDeps) {
    const root = path.join(deps.userDataPath, 'team-platform');
    this.config = new TeamConfigStore(path.join(root, 'config.json'));
    this.refreshStore = new SafeStorageRefreshTokenStore(
      deps.safeStorage,
      path.join(root, 'auth', 'refresh-token.bin')
    );
    this.accountRuntime = new AccountRuntimeManager(path.join(deps.userDataPath, 'aionui-team-accounts'));
    // 个人记忆云备份（E2EE 同步引擎）：vault 主密钥经 safeStorage 保护，随账户/团队状态激活或停用
    void import('./modules/personalSync/service').then((personalSync) => {
      personalSync.configurePersonalSync({
        vaultKeyFilePath: personalSync.personalSyncVaultKeyPath(deps.userDataPath),
        safeStorage: deps.safeStorage,
        fetcher: deps.fetcher,
      });
    });
    // 团队记忆失效 SSE（T3.1）：网关配置成功即拉流，账号/团队切换自动停流重启
    void import('./modules/memory/team-memory-invalidation').then((invalidation) => {
      this.gatewayAttachInvalidation(invalidation);
    });
    this.openExternal = deps.openExternal;
    this.fetcher = deps.fetcher ?? fetch.bind(globalThis);
    // 记忆模块 shim 绑定：上游单例 → 本服务实例（T2.1）
    void import('./modules/memory/account-runtime').then(({ bindAccountRuntime }) =>
      bindAccountRuntime(this.accountRuntime)
    );
    void import('./modules/memory/team-gateway-runtime').then(({ bindTeamGateway }) => bindTeamGateway(this.gateway));
    void import('./modules/memory/memory-model-util').then(({ bindMemoryModelProvider }) =>
      bindMemoryModelProvider(async () => (await this.config.get()).memoryModel ?? null)
    );
    // 记忆向量：云端 embedding 端点复用记忆模型配置（未配置则整体降级为词法检索，上游语义）
    void import('./modules/memory/memory-embedding').then(({ setCloudEmbeddingConfigResolver }) =>
      setCloudEmbeddingConfigResolver(async () => {
        const model = (await this.config.get()).memoryModel;
        return model ? { baseUrl: model.baseUrl, apiKey: model.apiKey, model: model.model, dimensions: 2048 } : null;
      })
    );
  }

  onStatus(listener: (view: TeamSessionView) => void) {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  private async emitStatus(authPhase?: string) {
    const view: TeamSessionView = {
      authPhase: authPhase ?? this.authManager?.publicStatus().phase ?? 'signed_out',
      bootstrap: this.cachedBootstrap,
      gatewayConfigured: this.gateway.isConfigured(),
      accountActive: this.accountRuntime.currentSubject() !== null,
    };
    for (const listener of this.statusListeners) listener(view);
    return view;
  }

  private async ensureManagers() {
    const config = await this.config.get();
    if (!this.authManager) {
      this.authManager = new ElectronAuthSessionManager({
        teamServerBaseUrl: config.serverBaseUrl,
        authorizationPageUrl: config.authorizationPageUrl,
        clientId: config.clientId,
        fetcher: this.fetcher,
        openExternal: this.openExternal,
        refreshStore: this.refreshStore,
        onStatus: () => {
          void this.emitStatus();
        },
      });
      this.apiClient = new TeamApiClient({
        teamServerBaseUrl: config.serverBaseUrl,
        fetcher: this.fetcher,
        readRefreshToken: () => this.refreshStore.get(),
        persistRotatedCredentials: (credentials) => this.authManager!.persistRotatedCredentials(credentials),
        clearSession: async () => {
          await this.authManager!.logout();
        },
      });
      // 网关 401 自救：强制刷新 access token 并原地更新网关凭据（E-11）
      this.gateway.setTokenRefresher(async () => {
        try {
          const token = await this.apiClient!.accessToken(true);
          this.gateway.updateAccessToken(token);
          return token;
        } catch {
          return null;
        }
      });
    }
    return { authManager: this.authManager, apiClient: this.apiClient! };
  }

  async initialize() {
    const { authManager } = await this.ensureManagers();
    const status = await authManager.initialize();
    // eslint-disable-next-line no-console -- 诊断观测点（E-22）：凭据恢复链路
    console.info('[teamBff] initialize: phase=', status.phase, 'hasToken=', status.hasRefreshToken);
    if (status.phase === 'refresh_available') {
      try {
        await this.fetchBootstrap();
        console.info('[teamBff] session restored from refresh token');
      } catch (error) {
        // E-22：恢复失败不清凭据文件——可能是服务端暂不可达/token 过期窗口，
        // 保留 token 供下次重试；仅标 signed_out 让 UI 呈现。
        console.warn('[teamBff] session restore failed (token kept):', error instanceof Error ? error.message : error);
        this.cachedBootstrap = null;
        this.gateway.clear();
        await this.accountRuntime.deactivate();
      }
    }
    return this.emitStatus();
  }

  async beginLogin() {
    const { authManager } = await this.ensureManagers();
    return authManager.beginLogin();
  }

  async handleOAuthCallback(rawUrl: string) {
    const { authManager, apiClient } = await this.ensureManagers();
    const status = await authManager.handleCallback(rawUrl);
    const credentials = authManager.takeAccessCredentials();
    if (credentials) {
      apiClient.installAccessCredentials({
        accessToken: credentials.accessToken,
        accessExpiresAt: credentials.accessExpiresAt,
      });
    }
    try {
      await this.fetchBootstrap();
    } catch {
      /* bootstrap 失败保留已认证状态，由 UI 呈现错误 */
    }
    return this.emitStatus(status.phase);
  }

  /** 调 session/bootstrap 并按状态激活账号运行时与网关。 */
  async fetchBootstrap(): Promise<SessionBootstrap> {
    const { apiClient } = await this.ensureManagers();
    const bootstrap = await apiClient.bootstrap();
    this.cachedBootstrap = bootstrap;
    if (bootstrap.state === 'ready' && bootstrap.tenant && bootstrap.activeTeam) {
      await this.accountRuntime.activate({
        tenantId: bootstrap.tenant.id,
        tenantMemberId: bootstrap.tenant.tenantMemberId,
        activeTeamId: bootstrap.activeTeam.id,
      });
      const token = await apiClient.accessToken();
      this.gateway.configure({
        teamServerBaseUrl: (await this.config.get()).serverBaseUrl,
        accessToken: token,
        tenantId: bootstrap.tenant.id,
        teamId: bootstrap.activeTeam.id,
      });
    } else if (bootstrap.state === 'team_required' && bootstrap.tenant) {
      this.gateway.clear();
      await this.accountRuntime.activate({
        tenantId: bootstrap.tenant.id,
        tenantMemberId: bootstrap.tenant.tenantMemberId,
        activeTeamId: null,
      });
    } else {
      // 未选租户/团队或被停用：释放本地账号态
      this.gateway.clear();
      await this.accountRuntime.deactivate();
    }
    await this.syncPersonalSyncLifecycle(bootstrap, apiClient);
    await this.emitStatus('authenticated');
    return bootstrap;
  }

  async listTenants() {
    const { apiClient } = await this.ensureManagers();
    return apiClient.listTenants();
  }
  async switchTenant(tenantId: string): Promise<SessionBootstrap> {
    const { apiClient } = await this.ensureManagers();
    await apiClient.switchActiveTenant(tenantId);
    return this.fetchBootstrap();
  }
  async switchTeam(tenantId: string, teamId: string): Promise<SessionBootstrap> {
    const { apiClient } = await this.ensureManagers();
    const bootstrap = await apiClient.switchActiveTeam(tenantId, teamId);
    this.cachedBootstrap = bootstrap;
    if (bootstrap.state === 'ready' && bootstrap.tenant && bootstrap.activeTeam) {
      await this.accountRuntime.activate({
        tenantId: bootstrap.tenant.id,
        tenantMemberId: bootstrap.tenant.tenantMemberId,
        activeTeamId: bootstrap.activeTeam.id,
      });
      const token = await apiClient.accessToken();
      this.gateway.configure({
        teamServerBaseUrl: (await this.config.get()).serverBaseUrl,
        accessToken: token,
        tenantId: bootstrap.tenant.id,
        teamId: bootstrap.activeTeam.id,
      });
    }
    await this.syncPersonalSyncLifecycle(bootstrap, apiClient);
    await this.emitStatus('authenticated');
    return bootstrap;
  }

  /** 个人记忆云备份：账户/团队就绪即激活（含 deviceId 与令牌来源），否则停用。 */
  private async syncPersonalSyncLifecycle(bootstrap: SessionBootstrap, apiClient: TeamApiClient) {
    try {
      const personalSync = await import('./modules/personalSync/service');
      if (['ready', 'team_required'].includes(bootstrap.state) && bootstrap.tenant && bootstrap.session?.deviceId) {
        const config = await this.config.get();
        await personalSync.activatePersonalSync({
          baseUrl: config.serverBaseUrl,
          deviceId: bootstrap.session.deviceId,
          userId: bootstrap.user.id,
          tenantId: bootstrap.tenant.id,
          getAccessToken: (forceRefresh) => apiClient.accessToken(forceRefresh),
        });
      } else {
        personalSync.deactivatePersonalSync();
      }
    } catch (error) {
      console.warn('[teamBff] personal sync lifecycle failed:', (error as Error)?.message ?? error);
    }
  }

  async logout() {
    // 登出/切换前做一次尽力而为的备份冲刷（对齐上游 account-switch 触发）
    try {
      const personalSync = await import('./modules/personalSync/service');
      if (this.apiClient) {
        await personalSync.runPersonalSync('account-switch').catch((error) => {
          console.warn('[teamBff] final personal sync failed:', (error as Error)?.message ?? error);
        });
      }
      personalSync.deactivatePersonalSync();
    } catch (error) {
      console.warn('[teamBff] personal sync deactivate failed:', (error as Error)?.message ?? error);
    }
    this.cachedBootstrap = null;
    this.gateway.clear();
    await this.accountRuntime.deactivate();
    this.apiClient?.clearAccess();
    await this.authManager?.logout();
    return this.emitStatus();
  }

  currentView(): TeamSessionView {
    return {
      authPhase: this.authManager?.publicStatus().phase ?? 'signed_out',
      bootstrap: this.cachedBootstrap,
      gatewayConfigured: this.gateway.isConfigured(),
      accountActive: this.accountRuntime.currentSubject() !== null,
    };
  }
}
