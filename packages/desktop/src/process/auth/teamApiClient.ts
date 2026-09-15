// 移植自 client-reference/electron/bff/team-api-client.cjs（上游 commit 915d14c0）。
// AionUi 适配：TS 化；剥离 personal-sync 系列（不在本次能力范围，见 docs/workLog/T1.6）；
// 保留核心：URL 校验、受限 JSON 读取、凭据解析、bootstrap 解析、access/refresh 轮换、
// authenticatedRequest（401 单次重试）、switchActiveTeam（切换团队签发新 access token）。

const MAX_RESPONSE_BYTES = 256 * 1024;
const EXPIRY_SKEW_MS = 30_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function validatedTeamServerBaseUrl(raw: string): URL {
  let value: URL;
  try {
    value = new URL(raw);
  } catch {
    throw new Error('TEAM_SERVER_BASE_URL_INVALID');
  }
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(value.hostname);
  if (value.username || value.password || value.hash || value.search || value.pathname !== '/' ||
      (value.protocol !== 'https:' && !(loopback && value.protocol === 'http:'))) {
    throw new Error('TEAM_SERVER_BASE_URL_INVALID');
  }
  return value;
}

async function readJson(response: Response): Promise<any> {
  if (!(response.headers.get('content-type') || '').toLowerCase().startsWith('application/json') || !response.body) {
    throw new Error('TEAM_API_RESPONSE_INVALID');
  }
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new Error('TEAM_API_RESPONSE_INVALID');
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {});
      throw new Error('TEAM_API_RESPONSE_INVALID');
    }
    chunks.push(Buffer.from(value));
  }
  try {
    return JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
  } catch {
    throw new Error('TEAM_API_RESPONSE_INVALID');
  }
}

function validToken(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 32 && value.length <= 4096;
}

export interface ElectronCredentials {
  refreshToken: string;
  accessToken: string;
  deviceId: string;
  expiresAt: string;
  accessExpiresAt: string;
}

export function parseCredentials(raw: any): ElectronCredentials {
  const data = raw?.data;
  if (!data || typeof data !== 'object' || !validToken(data.refreshToken) || !validToken(data.accessToken) ||
      typeof data.deviceId !== 'string' || !data.deviceId ||
      typeof data.expiresAt !== 'string' || !Number.isFinite(Date.parse(data.expiresAt)) ||
      typeof data.accessExpiresAt !== 'string' || !Number.isFinite(Date.parse(data.accessExpiresAt))) {
    throw new Error('TEAM_API_RESPONSE_INVALID');
  }
  return {
    refreshToken: data.refreshToken, accessToken: data.accessToken, deviceId: data.deviceId,
    expiresAt: data.expiresAt, accessExpiresAt: data.accessExpiresAt,
  };
}

function stringField(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value || value.length > 512) throw new Error(`SESSION_BOOTSTRAP_${name}_INVALID`);
  return value;
}

function parseTeam(raw: any) {
  if (!raw || typeof raw !== 'object') throw new Error('SESSION_BOOTSTRAP_TEAM_INVALID');
  if (raw.status !== 'active' && raw.status !== 'suspended') throw new Error('SESSION_BOOTSTRAP_TEAM_INVALID');
  return {
    id: stringField(raw.id, 'TEAM'),
    name: stringField(raw.name, 'TEAM'),
    teamMembershipId: stringField(raw.teamMembershipId, 'TEAM'),
    roleCode: stringField(raw.roleCode, 'TEAM'),
    status: raw.status as 'active' | 'suspended',
  };
}

export interface SessionBootstrap {
  state: 'tenant_required' | 'team_required' | 'membership_suspended' | 'ready';
  user: { id: string; email: string; displayName: string; avatarUrl: string | null };
  tenant: { id: string; name: string; tenantMemberId: string; tenantRole: string; status?: string } | null;
  activeTeam: ReturnType<typeof parseTeam> | null;
  teams: ReturnType<typeof parseTeam>[];
  permissions: string[];
  versions: Record<'tenantMembership' | 'teamMembership' | 'tenantPolicy' | 'teamPolicy', number>;
  features: Record<string, boolean>;
  session: { id: string; deviceId: string; expiresAt: string };
}

export function parseBootstrap(raw: any): SessionBootstrap {
  if (!raw || typeof raw !== 'object' || !['tenant_required', 'team_required', 'membership_suspended', 'ready'].includes(raw.state) ||
      !raw.user || typeof raw.user !== 'object' || !raw.session || typeof raw.session !== 'object' ||
      !Array.isArray(raw.teams) || !Array.isArray(raw.permissions) || !raw.versions || typeof raw.versions !== 'object' ||
      !raw.features || typeof raw.features !== 'object') {
    throw new Error('SESSION_BOOTSTRAP_INVALID');
  }
  const tenant = raw.tenant === null ? null : {
    id: stringField(raw.tenant?.id, 'TENANT'),
    name: stringField(raw.tenant?.name, 'TENANT'),
    tenantMemberId: stringField(raw.tenant?.tenantMemberId, 'TENANT'),
    tenantRole: stringField(raw.tenant?.tenantRole, 'TENANT'),
    status: raw.tenant?.status,
  };
  if (tenant && tenant.status !== 'active' && tenant.status !== 'suspended') throw new Error('SESSION_BOOTSTRAP_TENANT_INVALID');
  const activeTeam = raw.activeTeam === null ? null : parseTeam(raw.activeTeam);
  const permissions = [...new Set(raw.permissions.map((value: unknown) => stringField(value, 'PERMISSION')))] as string[];
  const versions = {} as SessionBootstrap['versions'];
  for (const key of ['tenantMembership', 'teamMembership', 'tenantPolicy', 'teamPolicy'] as const) {
    const value = raw.versions[key];
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('SESSION_BOOTSTRAP_VERSION_INVALID');
    versions[key] = value;
  }
  const features: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(raw.features as Record<string, unknown>)) {
    if (!/^[A-Za-z][A-Za-z0-9._-]{0,127}$/.test(key) || typeof value !== 'boolean') {
      throw new Error('SESSION_BOOTSTRAP_FEATURE_INVALID');
    }
    features[key] = value;
  }
  const expiresAt = stringField(raw.session.expiresAt, 'SESSION');
  if (!Number.isFinite(Date.parse(expiresAt))) throw new Error('SESSION_BOOTSTRAP_SESSION_INVALID');
  return {
    state: raw.state,
    user: {
      id: stringField(raw.user.id, 'USER'),
      email: stringField(raw.user.email, 'USER'),
      displayName: stringField(raw.user.displayName, 'USER'),
      avatarUrl: raw.user.avatarUrl === null ? null : stringField(raw.user.avatarUrl, 'USER'),
    },
    tenant, activeTeam, teams: raw.teams.map(parseTeam), permissions, versions, features,
    session: {
      id: stringField(raw.session.id, 'SESSION'),
      deviceId: stringField(raw.session.deviceId, 'SESSION'),
      expiresAt,
    },
  };
}

export interface TeamApiClientDeps {
  teamServerBaseUrl: string;
  fetcher: typeof fetch;
  readRefreshToken: () => Promise<string | null>;
  persistRotatedCredentials: (credentials: ElectronCredentials) => Promise<void>;
  clearSession: () => Promise<void>;
  now?: () => number;
}

export class TeamApiClient {
  private readonly baseUrl: URL;
  private readonly fetcher: typeof fetch;
  private readonly readRefreshToken: () => Promise<string | null>;
  private readonly persistRotatedCredentials: (credentials: ElectronCredentials) => Promise<void>;
  private readonly clearSessionHook: () => Promise<void>;
  private readonly now: () => number;
  private access: { token: string; expiresAt: number } | null = null;
  private refreshInFlight: Promise<string> | null = null;

  constructor(deps: TeamApiClientDeps) {
    this.baseUrl = validatedTeamServerBaseUrl(deps.teamServerBaseUrl);
    if (typeof deps.fetcher !== 'function' || typeof deps.readRefreshToken !== 'function' ||
        typeof deps.persistRotatedCredentials !== 'function' || typeof deps.clearSession !== 'function') {
      throw new Error('TEAM_API_CLIENT_CONFIG_INVALID');
    }
    this.fetcher = deps.fetcher;
    this.readRefreshToken = deps.readRefreshToken;
    this.persistRotatedCredentials = deps.persistRotatedCredentials;
    this.clearSessionHook = deps.clearSession;
    this.now = deps.now ?? Date.now;
  }

  get serverBaseUrl() {
    return this.baseUrl;
  }

  installAccessCredentials(credentials: { accessToken: string; accessExpiresAt: string }) {
    if (!credentials || !validToken(credentials.accessToken) ||
        typeof credentials.accessExpiresAt !== 'string' || !Number.isFinite(Date.parse(credentials.accessExpiresAt))) {
      throw new Error('ACCESS_CREDENTIALS_INVALID');
    }
    this.access = { token: credentials.accessToken, expiresAt: Date.parse(credentials.accessExpiresAt) };
  }

  clearAccess() {
    this.access = null;
  }

  private async refreshAccess(): Promise<string> {
    if (this.refreshInFlight) return this.refreshInFlight;
    this.refreshInFlight = (async () => {
      const refreshToken = await this.readRefreshToken();
      if (!validToken(refreshToken)) throw new Error('SESSION_REQUIRED');
      let response: Response;
      try {
        response = await this.fetcher(new URL('/api/v1/auth/electron/refresh', this.baseUrl), {
          method: 'POST', redirect: 'error', cache: 'no-store',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken }),
        });
      } catch {
        throw new Error('TEAM_API_UNAVAILABLE');
      }
      if (response.status === 401) {
        this.clearAccess();
        // E-22：不再立即 clearSessionHook（会删凭据文件）——保留 refresh token，
        // 仅标 SESSION_INVALID；用户主动 logout 或确认过期才清除。
        throw new Error('SESSION_INVALID');
      }
      if (!response.ok) throw new Error('TEAM_API_UNAVAILABLE');
      const credentials = parseCredentials(await readJson(response));
      await this.persistRotatedCredentials(credentials);
      this.installAccessCredentials(credentials);
      return this.access!.token;
    })().finally(() => {
      this.refreshInFlight = null;
    });
    return this.refreshInFlight;
  }

  async accessToken(forceRefresh = false): Promise<string> {
    if (!forceRefresh && this.access && this.access.expiresAt > this.now() + EXPIRY_SKEW_MS) return this.access.token;
    return this.refreshAccess();
  }

  private async fetchWithAccess(pathname: string, init: RequestInit, token: string): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('Accept', 'application/json');
    headers.set('Authorization', `Bearer ${token}`);
    try {
      return await this.fetcher(new URL(pathname, this.baseUrl), {
        ...init, headers, redirect: 'error', cache: 'no-store',
      });
    } catch {
      throw new Error('TEAM_API_UNAVAILABLE');
    }
  }

  async authenticatedRequest(pathname: string, init: RequestInit = {}): Promise<Response> {
    const firstToken = await this.accessToken();
    let response = await this.fetchWithAccess(pathname, init, firstToken);
    if (response.status !== 401) return response;
    let retryToken: string;
    if (this.access && this.access.token !== firstToken && this.access.expiresAt > this.now() + EXPIRY_SKEW_MS) {
      retryToken = this.access.token;
    } else {
      this.clearAccess();
      retryToken = await this.accessToken(true);
    }
    response = await this.fetchWithAccess(pathname, init, retryToken);
    if (response.status === 401) {
      this.clearAccess();
      throw new Error('SESSION_INVALID'); // E-22：不清 session
    }
    return response;
  }

  async bootstrap(): Promise<SessionBootstrap> {
    const response = await this.authenticatedRequest('/api/v1/session/bootstrap');
    if (!response.ok) throw new Error(response.status === 403 ? 'SESSION_FORBIDDEN' : 'TEAM_API_UNAVAILABLE');
    const envelope = await readJson(response);
    if (['accessToken', 'accessTokenExpiresAt', 'refreshToken', 'csrfToken']
      .some((field) => envelope?.data?.[field] !== undefined)) {
      throw new Error('SESSION_BOOTSTRAP_INVALID');
    }
    return parseBootstrap(envelope?.data);
  }

  async switchActiveTeam(tenantId: string, teamId: string): Promise<SessionBootstrap> {
    for (const value of [tenantId, teamId]) {
      if (typeof value !== 'string' || !UUID_PATTERN.test(value)) throw new Error('ACTIVE_TEAM_INVALID');
    }
    const response = await this.authenticatedRequest('/api/v1/me/active-team', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tenantId, teamId }),
    });
    if (!response.ok) throw new Error(response.status === 403 ? 'ACTIVE_TEAM_FORBIDDEN' : 'TEAM_API_UNAVAILABLE');
    const envelope = await readJson(response);
    if (!validToken(envelope?.data?.accessToken) ||
        typeof envelope.data.accessTokenExpiresAt !== 'string' ||
        !Number.isFinite(Date.parse(envelope.data.accessTokenExpiresAt))) {
      throw new Error('SESSION_BOOTSTRAP_INVALID');
    }
    this.installAccessCredentials({
      accessToken: envelope.data.accessToken,
      accessExpiresAt: envelope.data.accessTokenExpiresAt,
    });
    return parseBootstrap(envelope.data);
  }
}
