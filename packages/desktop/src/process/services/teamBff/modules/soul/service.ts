// AionUi 新增：团队 Soul 的拉取/验签/缓存服务（移植 client-reference 的 BFF 原语并接线）。
// 团队服务端只在存在「已发布」版本时返回 souls/current，因此本服务把结果视为可选：
// 未发布/未配置团队时返回 null（不是错误），网络/会话失败时退回最近一次通过验签的缓存。

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { callTeamGateway, currentTeamGatewayScope } from '../memory/team-gateway-runtime.js';
import { parsePublicJwks, SOUL_SIGNATURE_INVALID, verifySignedSoul, type SignedSoul, type SoulJwks } from './verify.js';

export type TeamSoulView = {
  versionId: string;
  versionNo: number | null;
  soulVersion: number;
  teamPolicyVersion: number;
  contentHash: string;
  content: string;
  publishedAt: string | null;
  expiresAt: string;
  fromCache: boolean;
};

export type TeamSoulResult = { soul: TeamSoulView | null; reason: string | null };

export type SoulDeps = {
  userDataPath: string;
  getBaseUrl: () => Promise<string>;
  getTeamPolicyVersion: () => number | null;
  /** 缓存/令牌绑定的策略版本过期时，重新拉取 bootstrap 以取得新的 teamPolicy 版本。 */
  refreshTeamPolicyVersion?: () => Promise<number | null>;
  fetcher?: typeof fetch;
};

let deps: SoulDeps | null = null;

export function configureSoul(next: SoulDeps) {
  deps = next;
}

function cacheDir(): string {
  return path.join(deps!.userDataPath, 'team-platform', 'soul');
}

function cacheFile(scope: { tenantId: string; teamId: string }): string {
  return path.join(cacheDir(), `${scope.tenantId}.${scope.teamId}.json`);
}

async function readCache(scope: { tenantId: string; teamId: string }): Promise<unknown | null> {
  try {
    const raw = await readFile(cacheFile(scope), 'utf8');
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

async function writeCache(scope: { tenantId: string; teamId: string }, signed: SignedSoul): Promise<void> {
  const file = cacheFile(scope);
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(signed), { mode: 0o600 });
  await rename(temporary, file);
}

async function removeCache(scope: { tenantId: string; teamId: string }): Promise<void> {
  await rm(cacheFile(scope), { force: true });
}

function toView(signed: SignedSoul, fromCache: boolean): TeamSoulView {
  const version = signed.version as { versionNo?: unknown; publishedAt?: unknown };
  return {
    versionId: signed.version.id,
    versionNo: typeof version.versionNo === 'number' ? version.versionNo : null,
    soulVersion: signed.soulVersion,
    teamPolicyVersion: signed.teamPolicyVersion,
    contentHash: signed.version.contentHash,
    content: signed.version.content,
    publishedAt: typeof version.publishedAt === 'string' ? version.publishedAt : null,
    expiresAt: signed.expiresAt,
    fromCache,
  };
}

let jwksCache: { baseUrl: string; jwks: SoulJwks; fetchedAt: number } | null = null;

const JWKS_TTL_MS = 5 * 60 * 1000;

async function currentJwks(baseUrl: string, fetcher: typeof fetch, force = false): Promise<SoulJwks> {
  if (!force && jwksCache && jwksCache.baseUrl === baseUrl && Date.now() - jwksCache.fetchedAt < JWKS_TTL_MS) {
    return jwksCache.jwks;
  }
  const response = await fetcher(new URL('/.well-known/jwks.json', baseUrl), {
    redirect: 'error',
    cache: 'no-store',
  } as RequestInit);
  if (!response.ok) throw new Error('SOUL_JWKS_UNAVAILABLE');
  const jwks = parsePublicJwks(await response.json());
  jwksCache = { baseUrl, jwks, fetchedAt: Date.now() };
  return jwks;
}

/**
 * 读取当前团队的已发布 Soul。默认优先使用仍可验签的缓存；forceRefresh 时强制回源。
 * 任何不可用情形都返回 { soul: null, reason }，调用方按“无团队 Soul”降级。
 */
export async function getTeamSoul(options: { forceRefresh?: boolean } = {}): Promise<TeamSoulResult> {
  if (!deps) return { soul: null, reason: 'SOUL_UNAVAILABLE' };
  if (!deps.getTeamPolicyVersion || deps.getTeamPolicyVersion() == null) {
    return { soul: null, reason: 'SOUL_POLICY_VERSION_UNAVAILABLE' };
  }
  let scope: { tenantId: string; teamId: string };
  try {
    scope = currentTeamGatewayScope();
  } catch {
    return { soul: null, reason: 'SOUL_UNAVAILABLE' };
  }
  let expectedPolicy = deps.getTeamPolicyVersion() as number;
  const fetcher = deps.fetcher ?? fetch;
  const verifyAgainst = async (payload: unknown, policyVersion: number): Promise<SignedSoul> => {
    const baseUrl = await deps!.getBaseUrl();
    const expected = { tenantId: scope.tenantId, teamId: scope.teamId, teamPolicyVersion: policyVersion };
    try {
      return verifySignedSoul(payload, await currentJwks(baseUrl, fetcher), expected);
    } catch (error) {
      // JWKS 轮换窗口：强制刷新一次再验（换钥后的首次请求）
      if (error instanceof Error && error.message === SOUL_SIGNATURE_INVALID) {
        return verifySignedSoul(payload, await currentJwks(baseUrl, fetcher, true), expected);
      }
      throw error;
    }
  };

  if (!options.forceRefresh) {
    const raw = await readCache(scope);
    if (raw) {
      try {
        return { soul: toView(await verifyAgainst(raw, expectedPolicy), true), reason: null };
      } catch (error) {
        if (error instanceof Error && error.message === SOUL_SIGNATURE_INVALID) await removeCache(scope);
      }
    }
  }

  try {
    const data = await callTeamGateway(
      `/api/v1/tenants/${encodeURIComponent(scope.tenantId)}/teams/${encodeURIComponent(scope.teamId)}/souls/current`
    );
    let signed: SignedSoul;
    try {
      signed = await verifyAgainst(data, expectedPolicy);
    } catch (error) {
      // 团队策略版本已推进（发布于签名之内）：重取 bootstrap 后按新版本复核同一份签名负载
      const refreshed =
        error instanceof Error && error.message === SOUL_SIGNATURE_INVALID && deps!.refreshTeamPolicyVersion
          ? await deps!.refreshTeamPolicyVersion().catch((): null => null)
          : null;
      if (refreshed == null || refreshed === expectedPolicy) throw error;
      expectedPolicy = refreshed;
      signed = await verifyAgainst(data, refreshed);
    }
    await writeCache(scope, signed);
    return { soul: toView(signed, false), reason: null };
  } catch (error) {
    const code = error instanceof Error ? error.message : 'SOUL_UNAVAILABLE';
    if (code === 'SOUL_NOT_FOUND') {
      await removeCache(scope);
      return { soul: null, reason: 'SOUL_NOT_FOUND' };
    }
    const raw = await readCache(scope);
    if (raw) {
      try {
        return { soul: toView(await verifyAgainst(raw, expectedPolicy), true), reason: null };
      } catch {
        await removeCache(scope);
      }
    }
    return { soul: null, reason: code };
  }
}

/** 注入用：Soul 正文段（无可用 soul 时返回 null）。 */
export async function renderTeamSoulSection(): Promise<string | null> {
  const result = await getTeamSoul();
  if (!result.soul) return null;
  const versionLabel = result.soul.versionNo != null ? `v${result.soul.versionNo}` : `#${result.soul.soulVersion}`;
  return `## 团队 Agent 设定（Team Soul · ${versionLabel}）\n${result.soul.content}`;
}
