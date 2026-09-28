// 团队 Soul 服务：缓存优先/强制回源/404 清理/失败退缓存/策略版本推进复核。

import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const gateway = vi.hoisted(() => ({
  callTeamGateway: vi.fn(),
  currentTeamGatewayScope: vi.fn(),
}));

vi.mock('@process/services/teamBff/modules/memory/team-gateway-runtime', () => ({
  callTeamGateway: gateway.callTeamGateway,
  currentTeamGatewayScope: gateway.currentTeamGatewayScope,
  fetchTeamGateway: vi.fn(),
}));

import { configureSoul, getTeamSoul, renderTeamSoulSection } from '@process/services/teamBff/modules/soul/service.js';

const tenantId = '00000000-0000-7000-8000-000000000001';
const teamId = '00000000-0000-7000-8000-000000000002';
const versionId = '00000000-0000-7000-8000-000000000003';

function fixture(policy = 9, now = Math.floor(Date.now() / 1000) * 1000) {
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
      teamPolicyVersion: policy,
      jti: '00000000-0000-7000-8000-000000000004',
      iat: Math.floor(now / 1000),
      exp: Math.floor(now / 1000) + 3600,
    })
  ).toString('base64url');
  const signature = sign(null, Buffer.from(`${header}.${claims}`), privateKey).toString('base64url');
  return {
    jwks: { keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'soul-key', use: 'sig', alg: 'EdDSA' }] },
    signed: {
      version: { id: versionId, content, contentHash, versionNo: 3, publishedAt: new Date(now).toISOString() },
      soulVersion: 3,
      teamPolicyVersion: policy,
      signature: `${header}.${claims}.${signature}`,
      expiresAt: new Date(now + 3600_000).toISOString(),
    },
  };
}

let directory = '';
let policy = 9;
let refreshPolicy: ReturnType<typeof vi.fn>;
let fetcher: ReturnType<typeof vi.fn>;

function setup() {
  const f = fixture(policy);
  fetcher = vi.fn(async () => ({ ok: true, status: 200, json: async () => f.jwks }) as unknown as Response);
  configureSoul({
    userDataPath: directory,
    // 每个用例用独立 baseUrl，隔离进程内 JWKS 缓存
    getBaseUrl: async () => `http://127.0.0.1:${40000 + Math.floor(Math.random() * 1000)}`,
    getTeamPolicyVersion: () => policy,
    refreshTeamPolicyVersion: refreshPolicy as unknown as () => Promise<number | null>,
    fetcher: fetcher as unknown as typeof fetch,
  });
  return f;
}

function cacheFiles(): string[] {
  const dir = path.join(directory, 'team-platform', 'soul');
  return existsSync(dir) ? readdirSync(dir) : [];
}

beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'aionui-soul-'));
  policy = 9;
  refreshPolicy = vi.fn(async () => policy);
  gateway.callTeamGateway.mockReset();
  gateway.currentTeamGatewayScope.mockReset();
  gateway.currentTeamGatewayScope.mockReturnValue({ tenantId, teamId });
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe('团队 Soul 服务', () => {
  it('首次回源验签并落缓存，二次读取走缓存不再请求', async () => {
    const f = setup();
    gateway.callTeamGateway.mockResolvedValue(f.signed);

    const first = await getTeamSoul();
    expect(first.soul?.content).toContain('assistant');
    expect(first.soul?.fromCache).toBe(false);
    expect(cacheFiles().length).toBe(1);

    const second = await getTeamSoul();
    expect(second.soul?.fromCache).toBe(true);
    expect(gateway.callTeamGateway).toHaveBeenCalledTimes(1);
  });

  it('forceRefresh 强制回源', async () => {
    const f = setup();
    gateway.callTeamGateway.mockResolvedValue(f.signed);
    await getTeamSoul();
    await getTeamSoul({ forceRefresh: true });
    expect(gateway.callTeamGateway).toHaveBeenCalledTimes(2);
  });

  it('团队未发布（SOUL_NOT_FOUND）返回 null 并清理缓存', async () => {
    const f = setup();
    gateway.callTeamGateway.mockResolvedValue(f.signed);
    await getTeamSoul();
    expect(cacheFiles().length).toBe(1);

    gateway.callTeamGateway.mockRejectedValueOnce(new Error('SOUL_NOT_FOUND'));
    const result = await getTeamSoul({ forceRefresh: true });
    expect(result.soul).toBeNull();
    expect(result.reason).toBe('SOUL_NOT_FOUND');
    expect(cacheFiles().length).toBe(0);
  });

  it('回源失败时退回仍可验签的缓存', async () => {
    const f = setup();
    gateway.callTeamGateway.mockResolvedValue(f.signed);
    await getTeamSoul();

    gateway.callTeamGateway.mockRejectedValueOnce(new Error('TEAM_GATEWAY_UPSTREAM_FAILED'));
    const result = await getTeamSoul({ forceRefresh: true });
    expect(result.soul?.fromCache).toBe(true);
    expect(result.reason).toBeNull();
  });

  it('策略版本推进：重取 bootstrap 后按新版本复核同一份签名负载', async () => {
    const f = fixture(10);
    fetcher = vi.fn(async () => ({ ok: true, status: 200, json: async () => f.jwks }) as unknown as Response);
    configureSoul({
      userDataPath: directory,
      getBaseUrl: async () => 'http://127.0.0.1:45999',
      getTeamPolicyVersion: () => 9,
      refreshTeamPolicyVersion: async () => 10,
      fetcher: fetcher as unknown as typeof fetch,
    });
    gateway.callTeamGateway.mockResolvedValue(f.signed);

    const result = await getTeamSoul();
    expect(result.soul?.teamPolicyVersion).toBe(10);
    expect(gateway.callTeamGateway).toHaveBeenCalledTimes(1);
  });

  it('缓存损坏时删除并重新回源；注入段落包含版本标题', async () => {
    const f = setup();
    gateway.callTeamGateway.mockResolvedValue(f.signed);
    await getTeamSoul();

    const [file] = cacheFiles();
    writeFileSync(path.join(directory, 'team-platform', 'soul', file), '{"version":{"content":"tampered"}}');

    const result = await getTeamSoul();
    expect(result.soul?.content).toContain('assistant');
    expect(gateway.callTeamGateway).toHaveBeenCalledTimes(2);

    const section = await renderTeamSoulSection();
    expect(section).toContain('## 团队 Agent 设定');
    expect(section).toContain('v3');
  });
});
