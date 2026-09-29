// E-21：对话内记忆整理卡片（单张动态卡片：过程+结果合一，会话流内嵌式）。
// 记忆写入后自动触发，在最后一条消息与输入框之间渲染为对话风格的系统卡片。
// 生命周期：整理中（含操作预览）→ [手动模式：勾选] → 完成（含结果详情）→ 自动收起。

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Checkbox, Tag, Typography } from '@arco-design/web-react';
import { IconSync, IconCheck, IconClose } from '@arco-design/web-react/icon';
import { teamApi, type TeamConsolidationOperation } from '@/renderer/api/teamClient';
import { getMemoryMergeMode } from '@/renderer/services/memory/memoryInjection';

type Phase = 'running' | 'review' | 'done';

interface CardState {
  phase: Phase;
  mode: 'manual' | 'auto';
  summary: string;
  operations: TeamConsolidationOperation[];
  selectedIds: string[];
  doneDetail: string;
  error: string | null;
}

const INITIAL: CardState = {
  phase: 'running',
  mode: 'manual',
  summary: '',
  operations: [],
  selectedIds: [],
  doneDetail: '',
  error: null,
};

const OP_META: Record<string, { text: string; color: string }> = {
  merge: { text: '合并', color: 'arcoblue' },
  update: { text: '更新', color: 'green' },
  delete: { text: '清理', color: 'red' },
  create_category: { text: '新建分类', color: 'purple' },
};

const opTitle = (op: TeamConsolidationOperation) =>
  op.type === 'create_category' ? (op.name ?? op.id) : (op.title ?? op.targetId.slice(0, 8));

export const MemoryConsolidationCard: React.FC = () => {
  const [state, setState] = useState<CardState>(INITIAL);
  const [visible, setVisible] = useState(false);
  const dismissTimer = useRef<ReturnType<typeof setTimeout>>();

  const run = useCallback(async () => {
    clearTimeout(dismissTimer.current);
    const mode = getMemoryMergeMode();
    setVisible(true);
    setState({ ...INITIAL, mode, phase: 'running' });
    try {
      if (mode === 'auto') {
        const result = await teamApi.consolidateMemories('all', 'auto');
        setState((s) => ({
          ...s,
          phase: 'done',
          doneDetail: result.summary || `已执行 ${result.appliedCount} 项操作`,
          operations: result.operations.slice(0, 6),
        }));
        dismissTimer.current = setTimeout(() => setVisible(false), 8000);
        return;
      }
      const result = await teamApi.consolidateMemories('all', 'review');
      if (result.operations.length === 0) {
        setState((s) => ({ ...s, phase: 'done', doneDetail: result.summary || '未发现可整理项' }));
        dismissTimer.current = setTimeout(() => setVisible(false), 4000);
        return;
      }
      setState((s) => ({
        ...s,
        phase: 'review',
        summary: result.summary,
        operations: result.operations,
        selectedIds: result.operations.map((op) => op.id),
      }));
    } catch (err) {
      setState((s) => ({ ...s, phase: 'done', error: err instanceof Error ? err.message : '未知错误' }));
      dismissTimer.current = setTimeout(() => setVisible(false), 5000);
    }
  }, []);

  useEffect(() => {
    const handler = () => void run();
    window.addEventListener('aionui:memory-consolidation', handler);
    return () => {
      window.removeEventListener('aionui:memory-consolidation', handler);
      clearTimeout(dismissTimer.current);
    };
  }, [run]);

  const applySelected = useCallback(async () => {
    const selected = state.operations.filter((op) => state.selectedIds.includes(op.id));
    if (selected.length === 0) return;
    setState((s) => ({ ...s, phase: 'running' }));
    try {
      const result = await teamApi.applyConsolidation(selected);
      setState((s) => ({
        ...s,
        phase: 'done',
        doneDetail: `已应用 ${result.appliedCount} 项操作`,
        operations: selected,
      }));
      dismissTimer.current = setTimeout(() => setVisible(false), 6000);
    } catch (err) {
      setState((s) => ({ ...s, phase: 'done', error: err instanceof Error ? err.message : '应用失败' }));
      dismissTimer.current = setTimeout(() => setVisible(false), 5000);
    }
  }, [state.operations, state.selectedIds]);

  if (!visible) return null;

  const isRunning = state.phase === 'running';
  const isDone = state.phase === 'done';
  const hasOps = state.operations.length > 0;

  return (
    <div
      style={{
        margin: '4px 20px 8px',
        borderRadius: 10,
        border: '1px solid var(--color-border-2)',
        background: 'var(--color-fill-1)',
        overflow: 'hidden',
        fontSize: 13,
        lineHeight: 1.6,
      }}
    >
      {/* 标题栏（始终可见，状态+摘要） */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '10px 16px 6px',
          borderBottom: state.phase === 'review' || (isDone && hasOps) ? '1px solid var(--color-border-2)' : 'none',
        }}
      >
        {isRunning ? (
          <IconSync spin style={{ fontSize: 16, color: 'var(--color-primary-6)' }} />
        ) : state.error ? (
          <IconClose style={{ fontSize: 16, color: 'var(--color-danger-6)' }} />
        ) : (
          <IconCheck style={{ fontSize: 16, color: 'var(--color-success-6)' }} />
        )}
        <Typography.Text bold style={{ fontSize: 13 }}>
          {isRunning ? '记忆整理中' : state.error ? '记忆整理失败' : '记忆整理完成'}
        </Typography.Text>
        <Typography.Text type='secondary' size='small' style={{ flex: 1 }}>
          {isRunning && !hasOps && '正在分析可合并/可清理的记忆条目…'}
          {isRunning && hasOps && '正在执行选中的操作…'}
          {state.phase === 'review' && `${state.operations.length} 项待确认`}
          {isDone && !state.error && state.doneDetail}
          {isDone && state.error}
        </Typography.Text>
        {isDone && (
          <Button size='mini' type='text' onClick={() => setVisible(false)}>
            收起
          </Button>
        )}
      </div>

      {/* 手动模式：勾选列表 */}
      {state.phase === 'review' && (
        <div style={{ padding: '8px 16px', maxHeight: 280, overflow: 'auto' }}>
          {state.operations.map((op) => {
            const meta = OP_META[op.type] ?? { text: op.type, color: 'gray' };
            const checked = state.selectedIds.includes(op.id);
            return (
              <div
                key={op.id}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 8,
                  padding: '6px 10px',
                  marginBottom: 4,
                  borderRadius: 6,
                  background: checked ? 'var(--color-primary-light-1)' : 'transparent',
                  cursor: 'pointer',
                  transition: 'background 0.15s',
                }}
                onClick={() => {
                  setState((s) => ({
                    ...s,
                    selectedIds: s.selectedIds.includes(op.id)
                      ? s.selectedIds.filter((id) => id !== op.id)
                      : [...s.selectedIds, op.id],
                  }));
                }}
              >
                <Checkbox checked={checked} readOnly style={{ marginTop: 2 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    <Tag size='small' color={meta.color}>
                      {meta.text}
                    </Tag>
                    <Typography.Text bold size='small'>
                      {opTitle(op)}
                    </Typography.Text>
                  </div>
                  <Typography.Text type='secondary' size='small' style={{ display: 'block' }}>
                    {op.type === 'merge' && op.sourceIds ? `← 并入 ${op.sourceIds.length} 条源记忆 · ` : ''}
                    {op.reason}
                  </Typography.Text>
                  {op.content && (
                    <Typography.Text type='secondary' size='small' style={{ display: 'block' }}>
                      {op.content.slice(0, 80)}
                      {op.content.length > 80 ? '…' : ''}
                    </Typography.Text>
                  )}
                </div>
              </div>
            );
          })}
          <div style={{ display: 'flex', gap: 8, marginTop: 8, justifyContent: 'flex-end' }}>
            <Button size='small' onClick={() => setVisible(false)}>
              跳过
            </Button>
            <Button size='small' type='primary' onClick={() => void applySelected()}>
              应用 {state.selectedIds.length} 项
            </Button>
          </div>
        </div>
      )}

      {/* 完成态：操作结果摘要 */}
      {isDone && !state.error && hasOps && (
        <div style={{ padding: '6px 16px 10px' }}>
          {state.operations.map((op) => {
            const meta = OP_META[op.type] ?? { text: op.type, color: 'gray' };
            return (
              <div key={op.id} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 0' }}>
                <Tag size='small' color={meta.color}>
                  {meta.text}
                </Tag>
                <Typography.Text size='small'>{opTitle(op)}</Typography.Text>
              </div>
            );
          })}
        </div>
      )}

      {/* 运行中骨架（无操作列表时） */}
      {isRunning && !hasOps && (
        <div style={{ padding: '4px 16px 10px' }}>
          <Typography.Text type='secondary' size='small'>
            合并相似条目 · 清理低价值记忆 · 优化检索索引
          </Typography.Text>
        </div>
      )}
    </div>
  );
};
