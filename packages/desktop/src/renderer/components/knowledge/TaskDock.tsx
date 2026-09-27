// E-23 对齐 KE-v2：右下角常驻任务面板（上传任务 / 文档抽取任务）。
// 行为与视觉对齐 KE-v2 src/app/shell/{UploadTaskDock,SaveTaskDock}.tsx：
// 可折叠、有运行中任务自动展开、阶段文案与进度估算同源、支持终止/重试/清除。
// 数据统一经 BFF（task-api.ts），与 KE-v2 共用同一套上传/文档抽取逻辑。

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Message, Modal } from '@arco-design/web-react';
import { CheckOne, CloseOne, Down, FileText, Forbid, Refresh, Redo, Right, Time, Upload } from '@icon-park/react';
import {
  cancelUploadTask,
  clearFinishedUploadTasks,
  clearUploadTask,
  fetchSaveTasks,
  fetchUploadTasks,
  logPercent,
  overallPercent,
  retrySaveTask,
  retryUploadTask,
  stageLabel,
  statusText,
  type SaveTask,
  type TaskLog,
  type UploadTask,
} from '@/renderer/services/knowledge/task-api';

const COLOR = {
  surface: 'var(--color-bg-popup)',
  border: 'var(--color-border-2)',
  text: 'var(--color-text-1)',
  muted: 'var(--color-text-3)',
  fill: 'var(--color-fill-2)',
  primary: 'rgb(var(--primary-6))',
  success: '#00b42a',
  danger: '#f53f3f',
  warn: '#ff7d00',
};

interface DockTaskView {
  key: string;
  building: boolean;
  status: 'building' | 'done' | 'parse_failed' | 'cancelled' | 'failed';
  title: string;
  statusText: string;
  percent: number;
  logs: TaskLog[];
  result?: { entities?: number; relationships?: number; communities?: number; reports?: number; skipped?: boolean };
  error?: string;
}

function useTaskFeed<T>(load: () => Promise<T[]>, refreshSignal: number, isBuilding: (task: T) => boolean) {
  const [tasks, setTasks] = useState<T[]>([]);
  const tasksRef = useRef<T[]>([]);
  tasksRef.current = tasks;

  const refresh = useCallback(async () => {
    try {
      setTasks(await load());
    } catch {
      /* 面板保持上一条数据，网络恢复后下一拍自愈（对齐 KE-v2 的容错） */
    }
  }, [load]);

  useEffect(() => {
    void refresh();
  }, [refresh, refreshSignal]);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      await refresh();
      if (stopped) return;
      timer = setTimeout(tick, tasksRef.current.some(isBuilding) ? 2000 : 15000);
    };
    timer = setTimeout(tick, 2000);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [refresh, isBuilding]);

  return { tasks, refresh };
}

const dockStyle: React.CSSProperties = {
  width: 400,
  background: COLOR.surface,
  border: `1px solid ${COLOR.border}`,
  borderRadius: 12,
  boxShadow: '0 18px 52px rgb(25 29 43 / 0.16)',
  overflow: 'hidden',
};

const headerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '12px 16px',
  borderBottom: `1px solid ${COLOR.border}`,
  cursor: 'pointer',
  userSelect: 'none',
};

const bodyStyle: React.CSSProperties = { maxHeight: '50vh', overflowY: 'auto', padding: 8 };
const rowStyle: React.CSSProperties = {
  padding: '10px 12px',
  borderRadius: 6,
  background: COLOR.fill,
  marginBottom: 6,
};

function ProgressBar({ percent, status }: { percent: number; status: DockTaskView['status'] }) {
  const color =
    status === 'done' ? COLOR.success : status === 'failed' || status === 'parse_failed' ? COLOR.danger : COLOR.primary;
  return (
    <div style={{ height: 4, background: COLOR.fill, borderRadius: 2, marginTop: 8, overflow: 'hidden' }}>
      <div
        style={{
          height: '100%',
          width: `${status === 'building' ? percent : 100}%`,
          background: color,
          borderRadius: 2,
          transition: 'width 0.4s ease',
        }}
      />
    </div>
  );
}

function TaskLogs({ logs }: { logs: TaskLog[] }) {
  if (logs.length === 0) return null;
  return (
    <div
      style={{
        marginTop: 8,
        maxHeight: 160,
        overflowY: 'auto',
        background: '#1E293B',
        borderRadius: 6,
        padding: '8px 10px',
        fontFamily: '"SF Mono", Menlo, monospace',
        fontSize: 11,
        color: '#CBD5E1',
      }}
    >
      {logs.map((log, index) => (
        <div key={index} style={{ marginBottom: 2 }}>
          <span>[{stageLabel(log.stage)}]</span> {log.detail || log.token || ''}
        </div>
      ))}
    </div>
  );
}

function TaskRow({
  task,
  onTerminate,
  onRetry,
  onClear,
}: {
  task: DockTaskView;
  onTerminate?: () => void;
  onRetry?: () => void;
  onClear: () => void;
}) {
  const [showDetail, setShowDetail] = useState(false);
  const [showResult, setShowResult] = useState(false);
  const lastLog = task.logs[task.logs.length - 1];
  const subPercent = logPercent(lastLog);
  const StatusIcon = task.building
    ? Time
    : task.status === 'done'
      ? CheckOne
      : task.status === 'cancelled'
        ? Forbid
        : CloseOne;
  const statusColor = task.building
    ? COLOR.primary
    : task.status === 'done'
      ? COLOR.success
      : task.status === 'cancelled'
        ? COLOR.muted
        : COLOR.warn;

  return (
    <div style={rowStyle}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <StatusIcon
          theme='outline'
          size='16'
          style={{ color: statusColor, flexShrink: 0 }}
          className={task.building ? 'animate-pulse' : undefined}
        />
        <span
          title={task.title}
          style={{
            flex: 1,
            fontSize: 13,
            fontWeight: 600,
            color: COLOR.text,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {task.title}
        </span>
        <span style={{ fontSize: 12, fontWeight: 600, color: statusColor }}>{task.statusText}</span>
        {task.logs.length > 0 && (
          <Button type='text' size='mini' onClick={() => setShowDetail((v) => !v)}>
            {showDetail ? '收起' : '详情'}
          </Button>
        )}
        {task.building && onTerminate && (
          <Button type='text' size='mini' status='danger' onClick={onTerminate}>
            终止
          </Button>
        )}
        {!task.building && (
          <Button type='text' size='mini' onClick={onClear}>
            清除
          </Button>
        )}
      </div>

      <ProgressBar percent={task.percent} status={task.status} />

      {task.building && lastLog && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, fontSize: 12, color: COLOR.muted }}>
          <span style={{ color: COLOR.primary, fontWeight: 600 }}>[{stageLabel(lastLog.stage)}]</span>
          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {lastLog.detail}
          </span>
          {subPercent !== null && <span style={{ fontWeight: 600 }}>{subPercent}%</span>}
        </div>
      )}
      {!task.building && task.status === 'done' && task.result && (
        <div style={{ marginTop: 6, fontSize: 12, color: COLOR.muted }}>
          {task.result.entities ?? 0} 实体 · {task.result.relationships ?? 0} 关系 · {task.result.communities ?? 0} 社区
          {task.result.reports ? ` · ${task.result.reports} 报告` : ''}
        </div>
      )}
      {!task.building && (task.status === 'failed' || task.status === 'cancelled') && task.error && (
        <div style={{ marginTop: 6, fontSize: 12, color: task.status === 'failed' ? COLOR.danger : COLOR.muted }}>
          {task.error}
        </div>
      )}

      {!task.building && task.status === 'done' && task.result && (
        <div style={{ marginTop: 8 }}>
          <Button type='text' size='mini' onClick={() => setShowResult((v) => !v)}>
            {showResult ? '隐藏' : '查看'}抽取结果
          </Button>
          {showResult && (
            <div
              style={{
                marginTop: 6,
                padding: '8px 10px',
                background: '#1E293B',
                borderRadius: 6,
                fontSize: 11,
                color: '#CBD5E1',
              }}
            >
              <span style={{ color: '#67E8F9', fontWeight: 600 }}>抽取结果：</span>
              {task.result.entities ?? 0} 实体 · {task.result.relationships ?? 0} 关系 · {task.result.communities ?? 0}{' '}
              社区
            </div>
          )}
        </div>
      )}

      {!task.building && task.status === 'failed' && onRetry && (
        <div style={{ marginTop: 8 }}>
          <Button size='mini' type='outline' icon={<Redo theme='outline' />} onClick={onRetry}>
            重试
          </Button>
        </div>
      )}

      {showDetail && <TaskLogs logs={task.logs} />}
    </div>
  );
}

function uploadTaskView(task: UploadTask): DockTaskView {
  return {
    key: task.docId,
    building: task.status === 'building',
    status: task.status,
    title: task.filename,
    statusText: statusText(task),
    percent: overallPercent(task),
    logs: task.logs ?? [],
    result: task.result,
    error: task.error,
  };
}

function saveTaskView(task: SaveTask): DockTaskView {
  const status = task.status === 'building' ? 'building' : task.status === 'done' ? 'done' : 'failed';
  return {
    key: task.docId,
    building: status === 'building',
    status,
    title: task.title ?? task.docId,
    statusText: status === 'building' ? '抽取中…' : status === 'done' ? `${task.result?.entities ?? 0} 实体` : '失败',
    percent:
      status === 'building' ? (typeof task.logs?.at(-1)?.percent === 'number' ? task.logs.at(-1)!.percent! : 20) : 100,
    logs: task.logs ?? [],
    result: task.result,
    error: task.error,
  };
}

function TaskDock({
  title,
  standbyIcon,
  tasks,
  loadBuilding,
  refresh,
  onClearFinished,
  onTerminate,
  onRetry,
  onClear,
  showRefresh,
}: {
  title: string;
  standbyIcon: React.ReactNode;
  tasks: DockTaskView[];
  loadBuilding: boolean;
  refresh: () => void;
  onClearFinished?: () => void;
  onTerminate?: (task: DockTaskView) => void;
  onRetry?: (task: DockTaskView) => void;
  onClear?: (task: DockTaskView) => void;
  showRefresh?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const hasBuilding = loadBuilding;
  useEffect(() => {
    if (hasBuilding) setExpanded(true);
  }, [hasBuilding]);

  return (
    <div style={dockStyle}>
      <div style={headerStyle} onClick={() => setExpanded((v) => !v)}>
        <span
          style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 14, fontWeight: 600, color: COLOR.text }}
        >
          {hasBuilding ? (
            <Time theme='outline' size='16' style={{ color: COLOR.primary }} className='animate-pulse' />
          ) : (
            standbyIcon
          )}
          {title}
          {tasks.length > 0 ? `（${tasks.length}）` : ''}
        </span>
        <span style={{ flex: 1 }} />
        {showRefresh && (
          <Button
            type='text'
            size='mini'
            icon={<Refresh theme='outline' />}
            onClick={(e) => {
              e.stopPropagation();
              refresh();
            }}
          >
            刷新
          </Button>
        )}
        {onClearFinished && tasks.some((t) => !t.building) && (
          <Button
            type='text'
            size='mini'
            onClick={(e) => {
              e.stopPropagation();
              onClearFinished();
            }}
          >
            清除已完成
          </Button>
        )}
        <span style={{ color: COLOR.muted, display: 'flex' }}>
          {expanded ? <Down theme='outline' size='14' /> : <Right theme='outline' size='14' />}
        </span>
      </div>

      {expanded && (
        <div style={bodyStyle}>
          {tasks.length === 0 ? (
            <div style={{ padding: 16, textAlign: 'center', color: COLOR.muted, fontSize: 13 }}>
              暂无{title.includes('抽取') ? '抽取' : '上传'}任务
            </div>
          ) : (
            tasks.map((task) => (
              <TaskRow
                key={task.key}
                task={task}
                onTerminate={onTerminate ? () => onTerminate(task) : undefined}
                onRetry={onRetry ? () => onRetry(task) : undefined}
                onClear={() => onClear?.(task)}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

export const UploadTaskDock: React.FC<{ refreshSignal?: number }> = ({ refreshSignal = 0 }) => {
  const isBuilding = useCallback((task: UploadTask) => task.status === 'building', []);
  const { tasks, refresh } = useTaskFeed(fetchUploadTasks, refreshSignal, isBuilding);
  const views = tasks.map(uploadTaskView);

  const terminate = (task: DockTaskView) => {
    Modal.confirm({
      title: '终止解析任务？',
      content: '服务端会中止 LLM 解析、删除对象存储全部文件版本，并回滚已经生成的文本切片、实体关系和图谱数据。',
      okText: '终止并清理',
      cancelText: '取消',
      okButtonProps: { status: 'danger' },
      onOk: async () => {
        try {
          await cancelUploadTask(task.key);
          Message.success('已终止');
        } catch {
          Message.error('终止失败，请稍后重试');
        }
        refresh();
      },
    });
  };

  const retry = async (task: DockTaskView) => {
    try {
      await retryUploadTask({ docId: task.key, jobId: tasks.find((t) => t.docId === task.key)?.jobId });
      Message.success('已重新排队摄入任务');
    } catch {
      Message.error('任务重试失败，任务状态可能已变化，请刷新后重试');
    }
    refresh();
  };

  const clear = async (task: DockTaskView) => {
    try {
      await clearUploadTask(task.key);
    } catch {
      /* 下一拍列表刷新会纠正显示 */
    }
    refresh();
  };

  return (
    <TaskDock
      title='上传任务'
      standbyIcon={<Upload theme='outline' size='16' style={{ color: COLOR.muted }} />}
      tasks={views}
      loadBuilding={views.some((v) => v.building)}
      refresh={refresh}
      showRefresh
      onTerminate={terminate}
      onRetry={retry}
      onClear={clear}
      onClearFinished={() => {
        void clearFinishedUploadTasks().catch(() => {});
        refresh();
      }}
    />
  );
};

export const SaveTaskDock: React.FC<{ refreshSignal?: number }> = ({ refreshSignal = 0 }) => {
  const isBuilding = useCallback((task: SaveTask) => task.status === 'building', []);
  const { tasks, refresh } = useTaskFeed(fetchSaveTasks, refreshSignal, isBuilding);
  // 与 KE-v2 SaveTaskDock 一致：清除仅作用于本地面板（不动服务端记录）
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const views = tasks.map(saveTaskView).filter((view) => !hidden.has(view.key));

  const hide = (keys: string[]) => setHidden((prev) => new Set([...prev, ...keys]));

  return (
    <TaskDock
      title='文档抽取任务'
      standbyIcon={<FileText theme='outline' size='16' style={{ color: COLOR.muted }} />}
      tasks={views}
      loadBuilding={views.some((v) => v.building)}
      refresh={refresh}
      onRetry={async (task) => {
        try {
          await retrySaveTask(task.key);
          Message.success('已重新排队抽取任务');
        } catch {
          Message.error('任务重试失败，请刷新后重试');
        }
        refresh();
      }}
      onClear={(task) => hide([task.key])}
      onClearFinished={() => hide(views.filter((v) => !v.building).map((v) => v.key))}
    />
  );
};

export const KnowledgeTaskDocks: React.FC = () => (
  <div
    style={{
      position: 'fixed',
      bottom: 20,
      right: 20,
      zIndex: 100,
      display: 'flex',
      flexDirection: 'column',
      gap: 10,
      alignItems: 'flex-end',
    }}
  >
    <SaveTaskDock />
    <UploadTaskDock />
  </div>
);
