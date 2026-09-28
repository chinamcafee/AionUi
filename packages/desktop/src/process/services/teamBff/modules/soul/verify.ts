// AionUi 移植自 client-reference/electron/bff/soul-cache.cjs（上游 commit 915d14c0）：
// 团队 Soul 的签名负载校验。团队服务端用 service JWT（Ed25519）对 {version, soulVersion,
// teamPolicyVersion, expiresAt} 签名，客户端必须用 JWKS 验签、逐条比对声明与内容 hash，
// 才能把 soul 视为可信。任何失败都以固定错误码抛出，调用方按不可信处理。

import { createHash, createPublicKey, verify } from 'node:crypto';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH_PATTERN = /^[0-9a-f]{64}$/;

export const SOUL_SIGNATURE_INVALID = 'SOUL_CACHE_SIGNATURE_INVALID';
export const SOUL_CACHE_INVALID = 'SOUL_CACHE_INVALID';

export type SoulVersionView = {
  id: string;
  content: string;
  contentHash: string;
  versionNo?: number;
  [key: string]: unknown;
};

export type SignedSoul = {
  version: SoulVersionView;
  soulVersion: number;
  teamPolicyVersion: number;
  signature: string;
  expiresAt: string;
};

export type SoulJwks = { keys: Array<Record<string, unknown>> };

export type SoulExpectation = {
  tenantId: string;
  teamId: string;
  teamPolicyVersion: number;
};

function decodeSegment(value: string): Record<string, unknown> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error(SOUL_SIGNATURE_INVALID);
  try {
    return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new Error(SOUL_SIGNATURE_INVALID);
  }
}

export function verifySignedSoul(
  signed: unknown,
  jwks: unknown,
  expected: SoulExpectation,
  now = Date.now()
): SignedSoul {
  const candidate = signed as SignedSoul | undefined;
  const version = candidate?.version;
  if (
    !version ||
    typeof version.content !== 'string' ||
    !UUID_PATTERN.test(version.id) ||
    !HASH_PATTERN.test(version.contentHash) ||
    !Number.isSafeInteger(candidate?.soulVersion) ||
    !Number.isSafeInteger(candidate?.teamPolicyVersion) ||
    typeof candidate?.signature !== 'string' ||
    !Number.isFinite(Date.parse(candidate?.expiresAt ?? '')) ||
    !expected ||
    !UUID_PATTERN.test(expected.tenantId) ||
    !UUID_PATTERN.test(expected.teamId) ||
    !Number.isSafeInteger(expected.teamPolicyVersion)
  ) {
    throw new Error(SOUL_CACHE_INVALID);
  }
  const parts = candidate.signature.split('.');
  if (parts.length !== 3) throw new Error(SOUL_SIGNATURE_INVALID);
  const header = decodeSegment(parts[0]);
  const claims = decodeSegment(parts[1]);
  const keys = (jwks as SoulJwks | undefined)?.keys;
  if (header.alg !== 'EdDSA' || header.typ !== 'JWT' || typeof header.kid !== 'string' || !Array.isArray(keys)) {
    throw new Error(SOUL_SIGNATURE_INVALID);
  }
  const key = keys.find(
    (candidateKey) =>
      candidateKey?.kid === header.kid &&
      candidateKey.kty === 'OKP' &&
      candidateKey.crv === 'Ed25519' &&
      candidateKey.alg === 'EdDSA' &&
      !candidateKey.d
  );
  if (!key) throw new Error(SOUL_SIGNATURE_INVALID);
  let valid = false;
  try {
    valid = verify(
      null,
      Buffer.from(`${parts[0]}.${parts[1]}`),
      createPublicKey({ key: key as never, format: 'jwk' }),
      Buffer.from(parts[2], 'base64url')
    );
  } catch {
    valid = false;
  }
  const contentHash = createHash('sha256').update(version.content).digest('hex');
  const nowSeconds = Math.floor(now / 1000);
  if (
    !valid ||
    claims.iss !== 'team-server' ||
    claims.aud !== 'zhongshuling-client-soul' ||
    claims.tid !== expected.tenantId ||
    claims.team !== expected.teamId ||
    claims.sub !== expected.teamId ||
    claims.soulVersionId !== version.id ||
    claims.soulVersion !== candidate.soulVersion ||
    claims.contentHash !== version.contentHash ||
    contentHash !== version.contentHash ||
    claims.teamPolicyVersion !== expected.teamPolicyVersion ||
    candidate.teamPolicyVersion !== expected.teamPolicyVersion ||
    !Number.isSafeInteger(claims.iat) ||
    !Number.isSafeInteger(claims.exp) ||
    (claims.iat as number) > nowSeconds ||
    (claims.exp as number) <= nowSeconds ||
    (claims.exp as number) - (claims.iat as number) > 24 * 60 * 60 ||
    Date.parse(candidate.expiresAt) / 1000 !== claims.exp
  ) {
    throw new Error(SOUL_SIGNATURE_INVALID);
  }
  return Object.freeze({ ...candidate, version: Object.freeze({ ...version }) }) as SignedSoul;
}

/** JWKS 形状校验（移植自 team-api-client.cjs:getPublicJWKS）：只接受公开的 Ed25519 验签键。 */
export function parsePublicJwks(payload: unknown): SoulJwks {
  const keys = (payload as SoulJwks | undefined)?.keys;
  if (!Array.isArray(keys) || keys.length < 1 || keys.length > 5) throw new Error('SOUL_JWKS_INVALID');
  const parsed = keys.map((key) => {
    if (
      key?.kty !== 'OKP' ||
      key.crv !== 'Ed25519' ||
      key.alg !== 'EdDSA' ||
      typeof key.kid !== 'string' ||
      typeof key.x !== 'string' ||
      'd' in key
    ) {
      throw new Error('SOUL_JWKS_INVALID');
    }
    return key;
  });
  return { keys: parsed };
}
