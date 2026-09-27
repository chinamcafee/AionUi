import { parseStrictJSON } from '../orgescrow/protocol';
// AionUi 新增：个人同步的 team-server HTTP 基础层。
// 与网关同款约定：Bearer access token、401 强制刷新重试一次、redirect:'error'、cache:'no-store'、
// 账户 AbortSignal 组合、响应体上限与 {data}/{error:{code,details}} 信封解包。

import { validatedTeamServerBaseUrl } from '../../../../auth/teamApiClient.js';

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export class PersonalSyncHttpError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    public readonly details?: unknown
  ) {
    super(code);
  }
}

export interface PersonalSyncHttpDeps {
  baseUrl: string;
  getAccessToken: (forceRefresh?: boolean) => Promise<string>;
  signal: () => AbortSignal;
  fetcher?: typeof fetch;
}

export function createPersonalSyncHttp(deps: PersonalSyncHttpDeps) {
  const base = validatedTeamServerBaseUrl(deps.baseUrl);
  const fetcher = deps.fetcher ?? fetch.bind(globalThis);

  async function send(pathname: string, init: RequestInit, token: string): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('Accept', 'application/json');
    headers.set('Authorization', `Bearer ${token}`);
    return fetcher(new URL(pathname, base), {
      ...init,
      headers,
      redirect: 'error',
      cache: 'no-store',
      signal: deps.signal(),
    });
  }

  /** 单次请求（含 401 自救）：返回解析后的信封。非 2xx 抛 PersonalSyncHttpError（携带 code/details）。 */
  async function request(pathname: string, init: RequestInit = {}) {
    let token = await deps.getAccessToken();
    let response = await send(pathname, init, token);
    if (response.status === 401) {
      token = await deps.getAccessToken(true);
      response = await send(pathname, init, token);
    }
    if (response.status === 401) throw new PersonalSyncHttpError('SESSION_INVALID', 401);
    const text = await response.text();
    if (text.length > MAX_RESPONSE_BYTES)
      throw new PersonalSyncHttpError('PERSONAL_SYNC_RESPONSE_TOO_LARGE', response.status);
    let envelope: { data?: unknown; error?: { code?: string; details?: unknown } };
    try {
      envelope = (
        /escrow|rekey|device-proof/.test(pathname) ? parseStrictJSON(text) : JSON.parse(text)
      ) as typeof envelope;
    } catch {
      throw new PersonalSyncHttpError('PERSONAL_SYNC_RESPONSE_INVALID', response.status);
    }
    if (!response.ok) {
      throw new PersonalSyncHttpError(
        envelope.error?.code ?? (response.status === 403 ? 'DEVICE_NOT_TRUSTED' : 'PERSONAL_SYNC_UPSTREAM_FAILED'),
        response.status,
        envelope.error?.details
      );
    }
    if (!envelope.data || typeof envelope.data !== 'object')
      throw new PersonalSyncHttpError('PERSONAL_SYNC_RESPONSE_INVALID', response.status);
    return { status: response.status, data: envelope.data as Record<string, unknown> };
  }

  return { request, base, fetcher, signal: deps.signal };
}

export type PersonalSyncHttp = ReturnType<typeof createPersonalSyncHttp>;

/** 预签名对象 URL 校验（下载/上传直连对象存储，不带用户令牌）。 */
export function validatePresignedObjectUrl(raw: string): URL {
  let value: URL;
  try {
    value = new URL(raw);
  } catch {
    throw new Error('PRESIGNED_URL_INVALID');
  }
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(value.hostname);
  if (
    value.username ||
    value.password ||
    value.hash ||
    (value.protocol !== 'https:' && !(loopback && value.protocol === 'http:'))
  ) {
    throw new Error('PRESIGNED_URL_INVALID');
  }
  return value;
}
