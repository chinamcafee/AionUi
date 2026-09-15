// 移植自 client-reference/electron/auth/session-manager.cjs（上游 commit 915d14c0）。
// AionUi 适配：redirectUri 校验改为 aionui://oauth/callback；TS 化。

import { createPkceAttempt, parseAuthorizationCallback, type PkceAttempt } from './pkce';

const MAX_RESPONSE_BYTES = 64 * 1024;
export const AIONUI_REDIRECT_URI = 'aionui://oauth/callback';

export type AuthPhase =
  | 'signed_out'
  | 'authorizing'
  | 'exchanging'
  | 'authenticated'
  | 'refresh_available'
  | 'error';

export interface AuthStatus {
  phase: AuthPhase;
  hasRefreshToken: boolean;
  errorCode?: string;
  deviceId?: string;
  expiresAt?: string;
  accessExpiresAt?: string;
}

function validatedHttpUrl(raw: string, name: string): URL {
  let value: URL;
  try {
    value = new URL(raw);
  } catch {
    throw new Error(`${name}_INVALID`);
  }
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(value.hostname);
  if (value.username || value.password || value.hash ||
      (value.protocol !== 'https:' && !(loopback && value.protocol === 'http:'))) {
    throw new Error(`${name}_INVALID`);
  }
  return value;
}

async function boundedJson(response: Response): Promise<any> {
  if (!(response.headers.get('content-type') || '').toLowerCase().startsWith('application/json')) {
    throw new Error('AUTH_RESPONSE_INVALID');
  }
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new Error('AUTH_RESPONSE_INVALID');
  if (!response.body) throw new Error('AUTH_RESPONSE_INVALID');
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {});
      throw new Error('AUTH_RESPONSE_INVALID');
    }
    chunks.push(Buffer.from(value));
  }
  const text = Buffer.concat(chunks, size).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('AUTH_RESPONSE_INVALID');
  }
}

function parseTokenExchange(raw: any) {
  const value = raw?.data;
  if (!value || typeof value !== 'object' ||
      typeof value.refreshToken !== 'string' || value.refreshToken.length < 32 || value.refreshToken.length > 4096 ||
      typeof value.accessToken !== 'string' || value.accessToken.length < 32 || value.accessToken.length > 4096 ||
      typeof value.deviceId !== 'string' || !value.deviceId ||
      typeof value.expiresAt !== 'string' || !Number.isFinite(Date.parse(value.expiresAt)) ||
      typeof value.accessExpiresAt !== 'string' || !Number.isFinite(Date.parse(value.accessExpiresAt))) {
    throw new Error('AUTH_RESPONSE_INVALID');
  }
  return {
    refreshToken: value.refreshToken, accessToken: value.accessToken, deviceId: value.deviceId,
    expiresAt: value.expiresAt, accessExpiresAt: value.accessExpiresAt,
  };
}

export interface SessionManagerDeps {
  teamServerBaseUrl: string;
  /** 授权确认页（team-admin 路由）。绝对 URL 直接用；相对路径则拼到 serverBaseUrl（兼容）。 */
  authorizationPageUrl?: string;
  clientId: string;
  fetcher: typeof fetch;
  openExternal: (url: string) => Promise<void>;
  refreshStore: { get(): Promise<string | null>; set(token: string): Promise<void>; clear(): Promise<void> };
  now?: () => number;
  onStatus?: (status: AuthStatus) => void;
}

export class ElectronAuthSessionManager {
  private readonly teamServerBaseUrl: URL;
  private readonly authorizationPageUrl: URL;
  private readonly clientId: string;
  private readonly redirectUri = AIONUI_REDIRECT_URI;
  private readonly fetcher: typeof fetch;
  private readonly openExternal: (url: string) => Promise<void>;
  private readonly refreshStore: SessionManagerDeps['refreshStore'];
  private readonly now: () => number;
  private readonly onStatus: (status: AuthStatus) => void;
  private attempt: PkceAttempt | null = null;
  private accessCredentials: { accessToken: string; deviceId: string; expiresAt: string; accessExpiresAt: string } | null = null;
  private status: AuthStatus = { phase: 'signed_out', hasRefreshToken: false };

  constructor(deps: SessionManagerDeps) {
    this.teamServerBaseUrl = validatedHttpUrl(deps.teamServerBaseUrl, 'TEAM_SERVER_BASE_URL');
    this.authorizationPageUrl = validatedHttpUrl(
      deps.authorizationPageUrl ?? 'http://127.0.0.1:30190/electron/authorize',
      'TEAM_AUTHORIZATION_PAGE_URL',
    );
    if (this.teamServerBaseUrl.pathname !== '/' || this.teamServerBaseUrl.search) {
      throw new Error('TEAM_SERVER_BASE_URL_INVALID');
    }
    if (!/^[A-Za-z0-9._-]{3,128}$/.test(deps.clientId)) throw new Error('TEAM_ELECTRON_CLIENT_ID_INVALID');
    this.clientId = deps.clientId;
    this.fetcher = deps.fetcher;
    this.openExternal = deps.openExternal;
    this.refreshStore = deps.refreshStore;
    this.now = deps.now ?? Date.now;
    this.onStatus = deps.onStatus ?? (() => {});
  }

  publicStatus(): AuthStatus {
    return Object.freeze({ ...this.status });
  }

  private emit(status: AuthStatus): AuthStatus {
    this.status = status;
    this.onStatus(this.publicStatus());
    return this.publicStatus();
  }

  async initialize(): Promise<AuthStatus> {
    const refreshToken = await this.refreshStore.get().catch(() => null);
    return this.emit({ phase: refreshToken ? 'refresh_available' : 'signed_out', hasRefreshToken: !!refreshToken });
  }

  private async hasRefreshToken() {
    try {
      return !!(await this.refreshStore.get());
    } catch {
      return false;
    }
  }

  async beginLogin(): Promise<AuthStatus> {
    const attempt = createPkceAttempt(this.now());
    this.attempt = attempt;
    const target = new URL(this.authorizationPageUrl);
    target.searchParams.set('clientId', this.clientId);
    target.searchParams.set('redirectUri', this.redirectUri);
    target.searchParams.set('codeChallenge', attempt.codeChallenge);
    target.searchParams.set('deviceChallenge', attempt.deviceChallenge);
    target.searchParams.set('state', attempt.state);
    target.searchParams.set('nonce', attempt.nonce);
    try {
      await this.openExternal(target.toString());
      return this.emit({ phase: 'authorizing', hasRefreshToken: await this.hasRefreshToken() });
    } catch {
      this.attempt = null;
      this.emit({ phase: 'error', hasRefreshToken: await this.hasRefreshToken(), errorCode: 'AUTH_BROWSER_OPEN_FAILED' });
      throw new Error('AUTH_BROWSER_OPEN_FAILED');
    }
  }

  async handleCallback(rawUrl: string): Promise<AuthStatus> {
    const attempt = this.attempt;
    if (!attempt) throw new Error('AUTH_CALLBACK_UNEXPECTED');
    if (this.now() > attempt.expiresAt) {
      this.attempt = null;
      this.emit({ phase: 'error', hasRefreshToken: await this.hasRefreshToken(), errorCode: 'AUTH_ATTEMPT_EXPIRED' });
      throw new Error('AUTH_ATTEMPT_EXPIRED');
    }
    const { code } = parseAuthorizationCallback(rawUrl, attempt.state);
    this.attempt = null;
    this.emit({ phase: 'exchanging', hasRefreshToken: await this.hasRefreshToken() });
    try {
      const endpoint = new URL('/api/v1/auth/electron/token', this.teamServerBaseUrl);
      const response = await this.fetcher(endpoint, {
        method: 'POST', redirect: 'error', cache: 'no-store',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code, clientId: this.clientId, redirectUri: this.redirectUri, codeVerifier: attempt.codeVerifier,
        }),
      });
      if (!response.ok) throw new Error(response.status === 401 ? 'AUTHORIZATION_CODE_INVALID' : 'AUTH_EXCHANGE_FAILED');
      const credentials = parseTokenExchange(await boundedJson(response));
      await this.refreshStore.set(credentials.refreshToken);
      this.accessCredentials = {
        accessToken: credentials.accessToken, deviceId: credentials.deviceId,
        expiresAt: credentials.expiresAt, accessExpiresAt: credentials.accessExpiresAt,
      };
      return this.emit({
        phase: 'authenticated', hasRefreshToken: true, deviceId: credentials.deviceId,
        expiresAt: credentials.expiresAt, accessExpiresAt: credentials.accessExpiresAt,
      });
    } catch (error) {
      this.accessCredentials = null;
      const code = error instanceof Error && /^[A-Z][A-Z0-9_]{2,80}$/.test(error.message)
        ? error.message
        : 'AUTH_EXCHANGE_FAILED';
      this.emit({ phase: 'error', hasRefreshToken: await this.hasRefreshToken(), errorCode: code });
      throw new Error(code);
    }
  }

  takeAccessCredentials(): { accessToken: string; deviceId: string; expiresAt: string; accessExpiresAt: string } | null {
    const credentials = this.accessCredentials;
    this.accessCredentials = null;
    return credentials ? { ...credentials } : null;
  }

  readRefreshToken() {
    return this.refreshStore.get();
  }

  async persistRotatedCredentials(rawCredentials: any) {
    const credentials = parseTokenExchange({ data: rawCredentials });
    await this.refreshStore.set(credentials.refreshToken);
    this.emit({
      phase: 'authenticated', hasRefreshToken: true, deviceId: credentials.deviceId,
      expiresAt: credentials.expiresAt, accessExpiresAt: credentials.accessExpiresAt,
    });
  }

  async logout(): Promise<AuthStatus> {
    this.attempt = null;
    this.accessCredentials = null;
    await this.refreshStore.clear();
    return this.emit({ phase: 'signed_out', hasRefreshToken: false });
  }
}
