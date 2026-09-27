// 移植自 client-reference/server/local-runtime-control.ts 的 personalSyncTransport 段（上游 commit 915d14c0）。
// SyncTransport 的 team-server 实现：事件推送/拉取/游标确认/快照下载，均为 Bearer 认证；
// 快照下载走预签名对象 URL（不带用户令牌）。

import {
  CursorCompactedClientError,
  type CompactedSnapshotPoint,
  type EncryptedCloudEvent,
  type SyncTransport,
} from './store.js';
import { validatePresignedObjectUrl, type PersonalSyncHttp } from './http.js';

const MAX_OBJECT_BYTES = 512 * 1024 * 1024;

export function createPersonalSyncTransport(http: PersonalSyncHttp): SyncTransport {
  return {
    pushEvents: async (payload) => {
      const { data } = await http.request('/api/v1/personal-sync/events:push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (
        !Array.isArray(data.results) ||
        !Number.isSafeInteger(data.currentCursor) ||
        data.results.some(
          (item: unknown) =>
            !item ||
            typeof (item as { eventId?: unknown }).eventId !== 'string' ||
            !['accepted', 'acceptedConflict', 'duplicate', 'rejected'].includes(
              String((item as { status?: unknown }).status)
            )
        )
      )
        throw new Error('PERSONAL_SYNC_RESPONSE_INVALID');
      return data as unknown as Awaited<ReturnType<SyncTransport['pushEvents']>>;
    },
    pullEvents: async (after, limit) => {
      let response: { data: Record<string, unknown> };
      try {
        response = await http.request(`/api/v1/personal-sync/events?after=${after}&limit=${limit}`);
      } catch (error) {
        const failure = error as { status?: number; code?: string; details?: unknown };
        if (failure.status === 410 && failure.code === 'CURSOR_COMPACTED') {
          const details = failure.details as { minimumCursor?: unknown; snapshots?: unknown } | undefined;
          if (!Number.isSafeInteger(details?.minimumCursor) || !Array.isArray(details?.snapshots)) {
            throw new Error('PERSONAL_SYNC_RESPONSE_INVALID');
          }
          throw new CursorCompactedClientError(
            Number(details?.minimumCursor),
            details?.snapshots as CompactedSnapshotPoint[]
          );
        }
        throw error;
      }
      const data = response.data;
      if (
        !Array.isArray(data.events) ||
        !Number.isSafeInteger(data.currentCursor) ||
        typeof data.hasMore !== 'boolean' ||
        (data.events as unknown[]).some(
          (event) =>
            !event ||
            !Number.isSafeInteger((event as EncryptedCloudEvent).serverSeq) ||
            typeof (event as EncryptedCloudEvent).eventId !== 'string' ||
            typeof (event as EncryptedCloudEvent).ciphertext !== 'string'
        )
      )
        throw new Error('PERSONAL_SYNC_RESPONSE_INVALID');
      return {
        events: data.events as EncryptedCloudEvent[],
        currentCursor: Number(data.currentCursor),
        hasMore: Boolean(data.hasMore),
      };
    },
    ackCursor: async (cursor) => {
      const { data } = await http.request('/api/v1/personal-sync/cursors:ack', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cursor }),
      });
      if (data.cursor !== cursor) throw new Error('PERSONAL_SYNC_RESPONSE_INVALID');
    },
    downloadSnapshot: async (objectSessionId) => {
      const { data } = await http.request(`/api/v1/personal-sync/objects/${objectSessionId}/download-url`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      if (data.method !== 'GET' || typeof data.url !== 'string') throw new Error('PERSONAL_SYNC_RESPONSE_INVALID');
      const target = validatePresignedObjectUrl(data.url);
      const response = await http.fetcher(target, {
        method: 'GET',
        redirect: 'error',
        cache: 'no-store',
        signal: http.signal(),
      });
      if (!response.ok) throw new Error('SNAPSHOT_DOWNLOAD_FAILED');
      // 上游写法 Number(header) 在头部缺失时得 0 会被误判超限；仅在头部存在时做前置校验，实长仍以落盘字节为准
      const declaredHeader = response.headers.get('content-length');
      const declared = declaredHeader === null ? Number.NaN : Number(declaredHeader);
      if (Number.isFinite(declared) && (declared < 1 || declared > MAX_OBJECT_BYTES)) {
        throw new Error('SNAPSHOT_DOWNLOAD_INVALID');
      }
      const blob = Buffer.from(await response.arrayBuffer());
      if (blob.length < 1 || blob.length > MAX_OBJECT_BYTES) throw new Error('SNAPSHOT_DOWNLOAD_INVALID');
      return blob;
    },
  };
}
