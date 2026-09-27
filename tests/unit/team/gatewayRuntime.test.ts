import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountRuntimeManager } from '@/process/services/teamBff/accountRuntime';
import { TeamGatewayRuntime } from '@/process/services/teamBff/gatewayRuntime';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const TOKEN = 't'.repeat(64);
const UUID_TENANT = '018f0000-0000-7000-8000-000000000001';
const UUID_MEMBER = '018f0000-0000-7000-8000-000000000002';
const UUID_TEAM = '018f0000-0000-7000-8000-000000000003';

async function newStack() {
  const root = mkdtempSync(path.join(tmpdir(), 'aionui-team-test-'));
  const accountRuntime = new AccountRuntimeManager(root);
  await accountRuntime.activate({ tenantId: UUID_TENANT, tenantMemberId: UUID_MEMBER, activeTeamId: UUID_TEAM });
  const invalidation = { start: vi.fn(), stop: vi.fn() };
  const gateway = new TeamGatewayRuntime(accountRuntime, invalidation);
  return { root, accountRuntime, gateway, invalidation };
}

describe('TeamGatewayRuntime（移植自 client server/team-gateway-runtime.ts）', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('configure 校验：拒绝非 loopback http、短 token、带路径的 baseUrl', async () => {
    const { gateway } = await newStack();
    expect(() =>
      gateway.configure({
        teamServerBaseUrl: 'http://example.com',
        accessToken: TOKEN,
        tenantId: UUID_TENANT,
        teamId: UUID_TEAM,
      })
    ).toThrow('TEAM_GATEWAY_CONFIG_INVALID');
    expect(() =>
      gateway.configure({
        teamServerBaseUrl: 'http://127.0.0.1:8080/',
        accessToken: 'short',
        tenantId: UUID_TENANT,
        teamId: UUID_TEAM,
      })
    ).toThrow('TEAM_GATEWAY_CONFIG_INVALID');
    expect(() =>
      gateway.configure({
        teamServerBaseUrl: 'http://127.0.0.1:8080/api',
        accessToken: TOKEN,
        tenantId: UUID_TENANT,
        teamId: UUID_TEAM,
      })
    ).toThrow('TEAM_GATEWAY_CONFIG_INVALID');
  });

  it('configure 校验：subject 不匹配（tenant/team 与账号运行时不一致）拒绝', async () => {
    const { gateway } = await newStack();
    expect(() =>
      gateway.configure({
        teamServerBaseUrl: 'http://127.0.0.1:8080',
        accessToken: TOKEN,
        tenantId: '018f0000-0000-7000-8000-000000000009',
        teamId: UUID_TEAM,
      })
    ).toThrow('TEAM_GATEWAY_SUBJECT_MISMATCH');
  });

  it('callTeamGateway 解析信封并映射错误码（401→SESSION_INVALID）', async () => {
    const { gateway } = await newStack();
    gateway.configure({
      teamServerBaseUrl: 'http://127.0.0.1:8080',
      accessToken: TOKEN,
      tenantId: UUID_TENANT,
      teamId: UUID_TEAM,
    });
    const fetchMock = vi.fn(
      async (input: any) =>
        new Response(JSON.stringify({ data: { ok: 1 } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
    );
    vi.stubGlobal('fetch', fetchMock);
    const data = await gateway.callTeamGateway('/api/v1/echo');
    expect(data).toEqual({ ok: 1 });
    const call = fetchMock.mock.calls[0];
    expect((call[0] as URL).toString()).toBe('http://127.0.0.1:8080/api/v1/echo');
    const headers = call[1]?.headers as Headers;
    expect(headers.get('Authorization')).toBe(`Bearer ${TOKEN}`);

    fetchMock.mockImplementation(
      async () =>
        new Response(JSON.stringify({ error: { code: 'X' } }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        })
    );
    await expect(gateway.callTeamGateway('/api/v1/echo')).rejects.toThrow('X');
    // 上游语义：非 JSON 响应 → RESPONSE_INVALID；401 + 无 error.code 的合法 JSON 信封 → SESSION_INVALID
    fetchMock.mockImplementation(async () => new Response('not-json', { status: 500 }));
    await expect(gateway.callTeamGateway('/api/v1/echo')).rejects.toThrow('TEAM_GATEWAY_RESPONSE_INVALID');
    fetchMock.mockImplementation(
      async () =>
        new Response(JSON.stringify({ data: null }), { status: 401, headers: { 'content-type': 'application/json' } })
    );
    await expect(gateway.callTeamGateway('/api/v1/echo')).rejects.toThrow('SESSION_INVALID');
  });

  it('账号切换后 generation 失效：旧网关凭据不可用并触发 invalidation.stop', async () => {
    const { accountRuntime, gateway, invalidation } = await newStack();
    gateway.configure({
      teamServerBaseUrl: 'http://127.0.0.1:8080',
      accessToken: TOKEN,
      tenantId: UUID_TENANT,
      teamId: UUID_TEAM,
    });
    expect(invalidation.start).toHaveBeenCalledTimes(1);
    await accountRuntime.activate({
      tenantId: UUID_TENANT,
      tenantMemberId: UUID_MEMBER,
      activeTeamId: '018f0000-0000-7000-8000-000000000004',
    });
    expect(gateway.isConfigured()).toBe(false);
    expect(invalidation.stop).toHaveBeenCalled();
    await expect(gateway.callTeamGateway('/x')).rejects.toThrow('TEAM_GATEWAY_UNAVAILABLE');
  });
});
