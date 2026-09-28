// 团队 Soul 验签（移植 client-reference soul-cache 的校验语义）：签名/内容 hash/团队范围/策略版本/有效期。

import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  parsePublicJwks,
  SOUL_CACHE_INVALID,
  SOUL_SIGNATURE_INVALID,
  verifySignedSoul,
} from '@process/services/teamBff/modules/soul/verify.js';

const tenantId = '00000000-0000-7000-8000-000000000001';
const teamId = '00000000-0000-7000-8000-000000000002';
const versionId = '00000000-0000-7000-8000-000000000003';

function fixture(now = 1_700_000_000_000) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const content = 'You are the team assistant.';
  const contentHash = createHash('sha256').update(content).digest('hex');
  const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', kid: 'soul-key', typ: 'JWT' })).toString('base64url');
  const claims = Buffer.from(
    JSON.stringify({
      iss: 'team-server',
      aud: 'zhongshuling-client-soul',
      sub: teamId,
      tid: tenantId,
      team: teamId,
      soulVersionId: versionId,
      soulVersion: 3,
      contentHash,
      teamPolicyVersion: 9,
      jti: '00000000-0000-7000-8000-000000000004',
      iat: now / 1000,
      exp: now / 1000 + 3600,
    })
  ).toString('base64url');
  const signature = sign(null, Buffer.from(`${header}.${claims}`), privateKey).toString('base64url');
  return {
    now,
    jwks: { keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'soul-key', use: 'sig', alg: 'EdDSA' }] },
    expected: { tenantId, teamId, teamPolicyVersion: 9 },
    signed: {
      version: { id: versionId, content, contentHash, versionNo: 3, publishedAt: new Date(now).toISOString() },
      soulVersion: 3,
      teamPolicyVersion: 9,
      signature: `${header}.${claims}.${signature}`,
      expiresAt: new Date(now + 3600_000).toISOString(),
    },
  };
}

describe('团队 Soul 验签', () => {
  it('验签通过并返回冻结对象', () => {
    const f = fixture();
    const verified = verifySignedSoul(f.signed, f.jwks, f.expected, f.now);
    expect(verified.version.content).toContain('assistant');
    expect(Object.isFrozen(verified)).toBe(true);
  });

  it('拒绝被篡改的正文与过期的策略版本', () => {
    const f = fixture();
    expect(() =>
      verifySignedSoul(
        { ...f.signed, version: { ...f.signed.version, content: 'tampered' } },
        f.jwks,
        f.expected,
        f.now
      )
    ).toThrow(SOUL_SIGNATURE_INVALID);
    expect(() => verifySignedSoul(f.signed, f.jwks, { ...f.expected, teamPolicyVersion: 10 }, f.now)).toThrow(
      SOUL_SIGNATURE_INVALID
    );
  });

  it('拒绝过期签名与跨团队负载', () => {
    const f = fixture();
    expect(() => verifySignedSoul(f.signed, f.jwks, f.expected, f.now + 7200_000)).toThrow(SOUL_SIGNATURE_INVALID);
    expect(() => verifySignedSoul(f.signed, f.jwks, { ...f.expected, teamId: versionId }, f.now)).toThrow(
      SOUL_SIGNATURE_INVALID
    );
  });

  it('形状非法与私钥泄漏的 JWKS 直接拒绝', () => {
    const f = fixture();
    expect(() => verifySignedSoul({ version: {} }, f.jwks, f.expected, f.now)).toThrow(SOUL_CACHE_INVALID);
    expect(() => parsePublicJwks({ keys: [{ ...f.jwks.keys[0], d: 'private' }] })).toThrow('SOUL_JWKS_INVALID');
    expect(() => parsePublicJwks({ keys: [] })).toThrow('SOUL_JWKS_INVALID');
  });
});
