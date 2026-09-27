// E-23 对齐 KE-v2：右下角「上传任务 / 文档抽取任务」面板的数据层。
// 与 KE-v2 同源：BFF → team-server web-operations 透传 → KE-v2 的 /api/upload-progress、/api/save-progress；
// 状态机、阶段文案、进度估算逐条对齐 KE-v2 的 UploadTaskDock/SaveTaskDock（src/app/shell）。

import { teamBffBaseUrl } from '@/renderer/api/teamClient';

export type TaskStatus = 'building' | 'done' | 'failed' | 'parse_failed' | 'cancelled';

export interface TaskLog {
  sequence?: number;
  stage: string;
  detail?: string;
  current?: number;
  total?: number;
  percent?: number;
  outcome?: string;
  ts?: number;
  token?: string;
}

export interface TaskResult {
  entities?: number;
  relationships?: number;
  communities?: number;
  reports?: number;
  skipped?: boolean;
}

export interface UploadTask {
  docId: string;
  jobId?: string;
  filename: string;
  status: TaskStatus;
  logs: TaskLog[];
  result?: TaskResult;
  error?: string;
  startedAt?: number;
  finishedAt?: number;
}

export interface SaveTask {
  docId: string;
  title?: string;
  isNew?: boolean;
  status: 'building' | 'done' | 'failed';
  logs: TaskLog[];
  result?: TaskResult;
  error?: string;
  startedAt?: number;
  finishedAt?: number;
}

// 与 KE-v2 UploadTaskDock STAGE_LABELS 一致
export const STAGE_LABELS: Record<string, string> = {
  start: '启动',
  parsing: '解析',
  image_extract: '图片提取',
  models: '模型检查',
  vision: '视觉',
  chunk: '切片',
  extract: '抽取',
  detect: '社区',
  report: '报告',
  embed: '向量化',
  embedding: '向量化',
  activate: '索引激活',
  failed: '失败',
  done: '完成',
  cleanup: '清理',
  token: 'LLM',
};

export function stageLabel(stage?: string): string {
  if (!stage) return '';
  return STAGE_LABELS[stage] ?? stage;
}

async function webOp<T>(operation: string, input: Record<string, unknown> = {}): Promise<T> {
  const base = teamBffBaseUrl();
  if (!base) throw new Error('TEAM_BFF_UNAVAILABLE');
  const response = await fetch(`${base}/teamapi/knowledge/web-ops`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ operation, input }),
  });
  const payload = (await response.json().catch(() => ({}))) as { data?: T; error?: { code?: string } };
  if (!response.ok) throw new Error(payload.error?.code ?? `HTTP_${response.status}`);
  return payload.data as T;
}

export async function fetchUploadTasks(): Promise<UploadTask[]> {
  const data = await webOp<{ tasks?: UploadTask[] }>('upload.tasks');
  return Array.isArray(data?.tasks) ? data.tasks : [];
}

export async function fetchSaveTasks(): Promise<SaveTask[]> {
  const data = await webOp<{ tasks?: SaveTask[] }>('save.tasks');
  return Array.isArray(data?.tasks) ? data.tasks : [];
}

export function clearFinishedUploadTasks(): Promise<unknown> {
  return webOp('upload.tasks.clear');
}

export function clearUploadTask(docId: string): Promise<unknown> {
  return webOp('upload.task.delete', { id: docId });
}

export async function retryUploadTask(task: Pick<UploadTask, 'docId' | 'jobId'>): Promise<void> {
  if (task.jobId) {
    const base = teamBffBaseUrl();
    if (!base) throw new Error('TEAM_BFF_UNAVAILABLE');
    const response = await fetch(`${base}/teamapi/knowledge/jobs/${encodeURIComponent(task.jobId)}/retry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (!response.ok) throw new Error('JOB_RETRY_FAILED');
    return;
  }
  await webOp('upload.task.retry', { id: task.docId });
}

export function retrySaveTask(docId: string): Promise<unknown> {
  return webOp('save.task.retry', { id: docId });
}

// 终止上传：与 KE-v2 UploadTaskDock.terminateTask 同路径（删除文档 → 服务端回滚派生数据）
export async function cancelUploadTask(docId: string): Promise<void> {
  const base = teamBffBaseUrl();
  if (!base) throw new Error('TEAM_BFF_UNAVAILABLE');
  const response = await fetch(`${base}/teamapi/knowledge/documents/${docId}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idempotencyKey: crypto.randomUUID() }),
  });
  if (!response.ok) throw new Error('TERMINATE_FAILED');
}

// 单条日志进度（对齐 KE-v2：优先 current/total，其次从 detail 解析 "N/M"）
export function logPercent(log?: TaskLog): number | null {
  if (!log) return null;
  if (log.current !== undefined && log.total !== undefined) {
    return Math.round((log.current / log.total) * 100);
  }
  const match = log.detail?.match(/(\d+)\/(\d+)/);
  if (match) return Math.round((parseInt(match[1], 10) / parseInt(match[2], 10)) * 100);
  return null;
}

const STAGE_BASE: Record<string, number> = {
  start: 2,
  parsing: 5,
  vision: 10,
  chunk: 35,
  extract: 40,
  detect: 80,
  report: 90,
  embed: 95,
  done: 100,
};

// 整体进度（对齐 KE-v2 overallPct：显式 percent 优先，否则阶段基值 + 子进度插值）
export function overallPercent(task: Pick<UploadTask, 'status' | 'logs'>): number {
  if (task.status !== 'building') return 100;
  const last = task.logs[task.logs.length - 1];
  if (typeof last?.percent === 'number') return Math.max(0, Math.min(100, last.percent));
  const stage = last?.stage ?? '';
  const base = STAGE_BASE[stage] ?? 20;
  const sub = logPercent(last);
  if ((stage === 'extract' || stage === 'vision') && sub !== null) {
    const next = stage === 'vision' ? 35 : 80;
    return Math.round(base + (next - base) * (sub / 100));
  }
  return base;
}

export function statusText(task: Pick<UploadTask, 'status' | 'result'>): string {
  if (task.status === 'building') return '构建中…';
  if (task.status === 'done') return `${task.result?.entities ?? 0} 实体`;
  if (task.status === 'parse_failed') return '已跳过';
  if (task.status === 'cancelled') return '已终止';
  return '失败';
}
