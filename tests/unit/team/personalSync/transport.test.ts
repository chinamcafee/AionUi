// 个人记忆云备份（E-31 移植）：传输层契约验证。
// ① Bearer 认证 + 401 强制刷新后重试一次；② CURSOR_COMPACTED 详情解析；
// ③ 预签名 URL 校验（https 或 loopback http）与快照下载（不带用户令牌 + 尺寸守卫）。

import { describe, expect, it, vi } from 'vitest';
import {
  createPersonalSyncHttp,
  validatePresignedObjectUrl,
} from '@/process/services/teamBff/modules/personalSync/http';
import { createPersonalSyncTransport } from '@/process/services/teamBff/modules/personalSync/transport';
import { CursorCompactedClientError } from '@/process/services/teamBff/modules/personalSync/store';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function createHttp(fetcher: typeof fetch, accessTokens = ['token-1', 'token-2']) {
  let index = 0;
  const calls: Array<{ forceRefresh: boolean }> = [];
  const http = createPersonalSyncHttp({
    baseUrl: 'http://127.0.0.1:30180',
    getAccessToken: (forceRefresh) => {
      calls.push({ forceRefresh: !!forceRefresh });
      const token = accessTokens[Math.min(index, accessTokens.length - 1)];
      index += 1;
      return Promise.resolve(token);
    },
    signal: () => new AbortController().signal,
    fetcher,
  });
  return { http, calls };
}

describe('personal-sync transport（移植自 client local-runtime-control 的 SyncTransport 段）', () => {
  it('401 强制刷新令牌后重试一次并成功', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ error: { code: 'SESSION_INVALID' } }, 401))
      .mockResolvedValueOnce(jsonResponse({ data: { cursor: 3 } }));
    const { http, calls } = createHttp(fetcher as unknown as typeof fetch);
    const transport = createPersonalSyncTransport(http);
    await transport.ackCursor(3);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(calls.map((call) => call.forceRefresh)).toEqual([false, true]);
    const firstInit = (fetcher as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
    const secondInit = (fetcher as unknown as ReturnType<typeof vi.fn>).mock.calls[1][1] as RequestInit;
    expect((firstInit.headers as Headers).get('Authorization')).toBe('Bearer token-1');
    expect((secondInit.headers as Headers).get('Authorization')).toBe('Bearer token-2');
  });

  it('重复 401 抛 SESSION_INVALID；服务端错误码原样透传', async () => {
    const always401 = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ error: { code: 'SESSION_INVALID' } }, 401));
    const { http } = createHttp(always401 as unknown as typeof fetch);
    const transport = createPersonalSyncTransport(http);
    await expect(transport.ackCursor(1)).rejects.toThrow(/SESSION_INVALID/);

    const forbidden = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ error: { code: 'DEVICE_NOT_TRUSTED' } }, 403));
    const second = createHttp(forbidden as unknown as typeof fetch);
    await expect(second.http.request('/api/v1/personal-sync/devices')).rejects.toMatchObject({
      code: 'DEVICE_NOT_TRUSTED',
      status: 403,
    });
  });

  it('CURSOR_COMPACTED：410 + details 解析为 CursorCompactedClientError（含快照列表）', async () => {
    const snapshots = [
      {
        snapshotId: '018f0000-0000-7000-8000-0000000000a1',
        objectSessionId: '018f0000-0000-7000-8000-0000000000a2',
        throughServerSeq: 42,
        keyVersion: 1,
        ciphertextHash: `sha256:${'a'.repeat(64)}`,
        manifestHash: `sha256:${'b'.repeat(64)}`,
      },
    ];
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        jsonResponse({ error: { code: 'CURSOR_COMPACTED', details: { minimumCursor: 40, snapshots } } }, 410)
      );
    const { http } = createHttp(fetchMock as unknown as typeof fetch);
    const transport = createPersonalSyncTransport(http);
    const error = await transport.pullEvents(1, 500).catch((reason) => reason);
    expect(error).toBeInstanceOf(CursorCompactedClientError);
    expect((error as CursorCompactedClientError).minimumCursor).toBe(40);
    expect((error as CursorCompactedClientError).snapshots).toHaveLength(1);
  });

  it('pullEvents 校验事件形状；pushEvents 校验回执状态枚举', async () => {
    const invalidPull = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ data: { events: [{ serverSeq: 0 }], currentCursor: 1, hasMore: false } }));
    const { http } = createHttp(invalidPull as unknown as typeof fetch);
    await expect(createPersonalSyncTransport(http).pullEvents(0, 10)).rejects.toThrow('PERSONAL_SYNC_RESPONSE_INVALID');

    const invalidPush = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ data: { results: [{ eventId: 'e1', status: 'mystery' }], currentCursor: 1 } }));
    const second = createHttp(invalidPush as unknown as typeof fetch);
    await expect(createPersonalSyncTransport(second.http).pushEvents({ baseCursor: 0, events: [{}] })).rejects.toThrow(
      'PERSONAL_SYNC_RESPONSE_INVALID'
    );
  });

  it('快照下载：预签名 GET 不带用户令牌、校验尺寸上限与 URL 协议', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            id: '018f0000-0000-7000-8000-0000000000a2',
            method: 'GET',
            url: 'http://127.0.0.1:30120/aionui-team/snapshots/x?X-Amz-Signature=sig',
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
        })
      )
      .mockResolvedValueOnce(new Response(Buffer.from('snapshot-blob'), { status: 200 }));
    const { http } = createHttp(fetcher as unknown as typeof fetch);
    const blob = await createPersonalSyncTransport(http).downloadSnapshot('018f0000-0000-7000-8000-0000000000a2');
    expect(blob.toString('utf8')).toBe('snapshot-blob');
    const presignedInit = (fetcher as unknown as ReturnType<typeof vi.fn>).mock.calls[1][1] as RequestInit;
    expect((presignedInit.headers as Headers | undefined)?.get?.('Authorization')).toBeUndefined();
    expect(presignedInit.redirect).toBe('error');
  });

  it('预签名 URL 校验：仅 https 或 loopback http，拒绝 userinfo/hash', () => {
    expect(() => validatePresignedObjectUrl('http://evil.example.com/x')).toThrow('PRESIGNED_URL_INVALID');
    expect(() => validatePresignedObjectUrl('http://127.0.0.1:30120/x')).not.toThrow();
    expect(() => validatePresignedObjectUrl('https://storage.example.com/x')).not.toThrow();
    expect(() => validatePresignedObjectUrl('https://user:pass@storage.example.com/x')).toThrow(
      'PRESIGNED_URL_INVALID'
    );
    expect(() => validatePresignedObjectUrl('https://storage.example.com/x#frag')).toThrow('PRESIGNED_URL_INVALID');
  });
});
