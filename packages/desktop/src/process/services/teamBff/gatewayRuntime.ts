// 移植自 client-reference/server/team-gateway-runtime.ts（上游 commit 915d14c0）。
// AionUi 适配：accountRuntime 与 team-memory 失效流（M3 接入）改为构造注入，解耦单例全局状态。

import type { AccountRuntimeManager } from './accountRuntime';

export interface GatewayInvalidationHooks {
  start?(input: { baseUrl: URL; accessToken: string; tenantId: string; teamId: string; accountSignal: AbortSignal }): void;
  stop?(): void;
}

/**
 * 网关 401 时的自救回调（AionUi 扩展，上游由 local-account-runtime 在 refresh 后重新
 * configure 网关实现同等效果）：用 refresh token 换新 access token 并更新本网关凭据。
 * 返回 null 表示刷新失败（会话已失效），调用方维持 SESSION_INVALID 语义。
 */
export type GatewayTokenRefresher = () => Promise<string | null>;

interface GatewayCredential {
  baseUrl: URL;
  accessToken: string;
  tenantId: string;
  teamId: string;
  generation: number;
}

export interface TeamGatewayConfiguration {
  teamServerBaseUrl: string;
  accessToken: string;
  tenantId: string;
  teamId: string;
}

export class TeamGatewayRuntime {
  private credential: GatewayCredential | null = null;

  private tokenRefresher: GatewayTokenRefresher | null = null;

  constructor(
    private readonly accountRuntime: AccountRuntimeManager,
    private readonly invalidation: GatewayInvalidationHooks = {},
  ) {
    accountRuntime.registerCacheInvalidator(() => this.clear());
  }

  /** 注入 401 自救回调（teamBffService 在 apiClient 就绪后设置）。 */
  setTokenRefresher(refresher: GatewayTokenRefresher) {
    this.tokenRefresher = refresher;
  }

  /** 用新 access token 原地更新凭据（保持 tenant/team/generation 不变）。 */
  updateAccessToken(token: string) {
    if (!this.credential || token.length < 32) return;
    this.credential = { ...this.credential, accessToken: token };
  }

  configure(input: TeamGatewayConfiguration) {
    let baseUrl: URL;
    try {
      baseUrl = new URL(input.teamServerBaseUrl);
    } catch {
      throw new Error('TEAM_GATEWAY_CONFIG_INVALID');
    }
    const loopback = ['127.0.0.1', 'localhost', '::1'].includes(baseUrl.hostname);
    // 与上游一致的 token 字符白名单（控制字符显式排除）
    const validToken = input.accessToken.length >= 32 && input.accessToken.length <= 4096 &&
      // eslint-disable-next-line no-control-regex
      !/[\s\u0000-\u001f\u007f]/.test(input.accessToken);
    if (baseUrl.username || baseUrl.password || baseUrl.hash || baseUrl.search || baseUrl.pathname !== '/' ||
        (baseUrl.protocol !== 'https:' && !(loopback && baseUrl.protocol === 'http:')) || !validToken) {
      throw new Error('TEAM_GATEWAY_CONFIG_INVALID');
    }
    const subject = this.accountRuntime.currentSubject();
    if (!subject || subject.tenantId !== input.tenantId || subject.activeTeamId !== input.teamId) {
      throw new Error('TEAM_GATEWAY_SUBJECT_MISMATCH');
    }
    this.credential = {
      baseUrl,
      accessToken: input.accessToken,
      tenantId: input.tenantId,
      teamId: input.teamId,
      generation: this.accountRuntime.currentGeneration(),
    };
    this.invalidation.start?.({
      baseUrl,
      accessToken: input.accessToken,
      tenantId: input.tenantId,
      teamId: input.teamId,
      accountSignal: this.accountRuntime.signal(),
    });
  }

  clear() {
    this.invalidation.stop?.();
    this.credential = null;
  }

  private requireCredential(): GatewayCredential {
    const value = this.credential;
    const subject = this.accountRuntime.currentSubject();
    if (!value || !subject || value.generation !== this.accountRuntime.currentGeneration() ||
        subject.tenantId !== value.tenantId || subject.activeTeamId !== value.teamId) {
      throw new Error('TEAM_GATEWAY_UNAVAILABLE');
    }
    return value;
  }

  async fetchTeamGateway(pathname: string, init: RequestInit = {}): Promise<Response> {
    const value = this.requireCredential();
    const headers = new Headers(init.headers);
    headers.set('Accept', 'application/json');
    headers.set('Authorization', `Bearer ${value.accessToken}`);
    if (init.body) headers.set('Content-Type', 'application/json');
    return fetch(new URL(pathname, value.baseUrl), {
      ...init,
      headers,
      redirect: 'error',
      cache: 'no-store',
      signal: init.signal
        ? AbortSignal.any([this.accountRuntime.signal(), init.signal])
        : this.accountRuntime.signal(),
    });
  }

  async callTeamGateway(pathname: string, init: RequestInit = {}): Promise<unknown> {
    let response = await this.fetchTeamGateway(pathname, init);
    // access token 短时效：网关 401 时刷新凭据并重试一次（上游同等效果的本地化实现）
    if (response.status === 401 && this.tokenRefresher) {
      const refreshed = await this.tokenRefresher().catch(() => null);
      if (refreshed) response = await this.fetchTeamGateway(pathname, init);
    }
    const text = await response.text();
    if (text.length > 4 * 1024 * 1024) throw new Error('TEAM_GATEWAY_RESPONSE_TOO_LARGE');
    let envelope: { data?: unknown; error?: { code?: string } };
    try {
      envelope = JSON.parse(text);
    } catch {
      // eslint-disable-next-line no-console -- 诊断：raw 响应前 300 字符（E-23）
      console.warn('[teamGateway] non-JSON response:', pathname, 'status:', response.status, 'body:', text.slice(0, 300));
      throw new Error('TEAM_GATEWAY_RESPONSE_INVALID');
    }
    if (!response.ok) {
      // eslint-disable-next-line no-console -- 诊断（E-23）
      console.warn('[teamGateway] upstream error:', pathname, 'status:', response.status, 'body:', text.slice(0, 300));
      throw new Error(envelope.error?.code ?? (response.status === 401
        ? 'SESSION_INVALID' : 'TEAM_GATEWAY_UPSTREAM_FAILED'));
    }
    return envelope.data;
  }

  currentTeamGatewayScope(): { tenantId: string; teamId: string } {
    const value = this.requireCredential();
    return { tenantId: value.tenantId, teamId: value.teamId };
  }

  isConfigured() {
    return this.credential !== null;
  }
}
