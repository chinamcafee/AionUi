// AionUi 移植（T4.2）：摄入任务进度轮询（源 client src/hooks/useUploadProgress.ts）。
// 差异：fetch 目标改为 BFF 绝对地址；状态机 building → done/failed/cancelled 与上游一致。

import { useEffect, useState } from 'react';
import { teamBffBaseUrl } from '@/renderer/api/teamClient';

export interface ProgressEntry {
  sequence?: number;
  stage?: string;
  detail?: string;
  current?: number;
  total?: number;
  percent?: number;
  outcome?: 'running' | 'success' | 'warning' | 'failed';
  ts?: number;
  [k: string]: unknown;
}

export type UploadStatus = 'building' | 'done' | 'failed' | 'cancelled';

export function useUploadProgress(jobId: string | null, pollGeneration = 0) {
  const [progress, setProgress] = useState<ProgressEntry[]>([]);
  const [status, setStatus] = useState<UploadStatus>('building');
  const [doneStats, setDoneStats] = useState<Record<string, unknown> | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [percent, setPercent] = useState(0);
  const [stage, setStage] = useState('queued');

  useEffect(() => {
    setProgress([]);
    setStatus('building');
    setDoneStats(null);
    setErrorMsg(null);
    setPercent(0);
    setStage('queued');
    if (!jobId) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastState = '';
    const poll = async () => {
      try {
        const base = teamBffBaseUrl();
        if (!base) throw new Error('TEAM_BFF_UNAVAILABLE');
        const response = await fetch(`${base}/teamapi/knowledge/jobs/${encodeURIComponent(jobId)}`, {
          cache: 'no-store',
        });
        const payload = (await response.json().catch(() => ({}))) as {
          data?: {
            status?: string;
            failureCode?: string | null;
            updatedAt?: string;
            progress?: {
              stage?: string;
              percent?: number;
              current?: number;
              total?: number;
              logs?: ProgressEntry[];
              result?: Record<string, unknown>;
              updatedAt?: string;
            };
          };
          error?: { code?: string };
        };
        if (!response.ok || !payload.data?.status) throw new Error(payload.error?.code ?? `HTTP_${response.status}`);
        const state = payload.data.status;
        const serverProgress = payload.data.progress;
        if (serverProgress) {
          const logs = Array.isArray(serverProgress.logs) ? serverProgress.logs : [];
          setProgress(logs);
          if (typeof serverProgress.percent === 'number')
            setPercent(Math.max(0, Math.min(100, serverProgress.percent)));
          if (serverProgress.stage) setStage(serverProgress.stage);
          if (serverProgress.result) setDoneStats(serverProgress.result);
        }
        if (state !== lastState && (!serverProgress?.logs || serverProgress.logs.length === 0)) {
          lastState = state;
          const labels: Record<string, string> = {
            queued: '等待 KE-v2 接收任务',
            retry_wait: '摄入服务暂不可用，等待自动重试',
            running: 'KE-v2 正在拆解、抽取并建立索引',
            completed: '文档解析和索引已完成',
          };
          setProgress((items) => [...items, { stage: state, detail: labels[state] ?? state, ts: Date.now() }]);
          setStage(state);
        }
        if (state === 'completed') {
          setDoneStats(serverProgress?.result ?? { status: 'completed' });
          setPercent(100);
          setStatus('done');
          return;
        }
        if (state === 'failed' || state === 'cancelled') {
          const progressError = [...(serverProgress?.logs ?? [])]
            .toReversed()
            .find((entry) => entry.outcome === 'failed')?.detail;
          setErrorMsg(
            progressError ?? payload.data.failureCode ?? (state === 'cancelled' ? '任务已终止' : '摄入任务失败')
          );
          setStatus(state === 'cancelled' ? 'cancelled' : 'failed');
          return;
        }
      } catch (error) {
        if (!cancelled) setErrorMsg(error instanceof Error ? error.message : String(error));
      }
      if (!cancelled) timer = setTimeout(poll, 1_500);
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [jobId, pollGeneration]);

  return { progress, status, doneStats, errorMsg, percent, stage };
}
