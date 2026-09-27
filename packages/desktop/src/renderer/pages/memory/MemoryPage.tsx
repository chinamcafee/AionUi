// AionUi 新增（T2.8）：记忆页。个人记忆面板移植自 client MemoryPage（Arco 重写）；
// 团队记忆 Tab 在 M3（T3.3）接入后启用（TeamMemoryPanel）。
// 数据经 BFF /teamapi/memories*（个人=本地 libsql；团队=team-server 网关）。

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Tabs } from '@arco-design/web-react';
import {
  Button,
  Card,
  Empty,
  Input,
  List,
  Message,
  Modal,
  Popconfirm,
  Select,
  Space,
  Spin,
  Switch,
  Tag,
  Typography,
} from '@arco-design/web-react';
import { IconPlus, IconRefresh, IconSearch } from '@arco-design/web-react/icon';
import { teamApi, TeamApiError, type TeamMemoryEntry } from '@/renderer/api/teamClient';
import { useTeamAuth } from '@/renderer/hooks/context/TeamAuthContext';
import { isMemoryInjectionEnabled, setMemoryInjectionEnabled } from '@/renderer/services/memory/memoryInjection';
import { TeamMemoryPanel } from './TeamMemoryPanel';
import {
  getMemoryMergeMode,
  setMemoryMergeMode,
  type MemoryMergeMode,
} from '@/renderer/services/memory/memoryInjection';
import type { TeamConsolidationOperation } from '@/renderer/api/teamClient';

const CATEGORIES = [
  { value: '', label: '全部分类' },
  { value: 'preference', label: '偏好' },
  { value: 'fact', label: '事实' },
  { value: 'requirement', label: '要求' },
  { value: 'event', label: '事件' },
];

const SCOPES = [
  { value: '', label: '全部空间' },
  { value: 'chat', label: '对话记忆' },
  { value: 'code', label: '编码记忆' },
];

const CATEGORY_COLOR: Record<string, string> = {
  preference: 'arcoblue',
  fact: 'green',
  requirement: 'orangered',
  event: 'purple',
};

const PersonalMemoryPanel: React.FC<{ onUpgrade?: (memory: TeamMemoryEntry) => void }> = ({ onUpgrade }) => {
  const [memories, setMemories] = useState<TeamMemoryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [category, setCategory] = useState('');
  const [scope, setScope] = useState('');
  const [search, setSearch] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<TeamMemoryEntry | null>(null);
  const [draft, setDraft] = useState({ title: '', content: '', category: 'fact', scope: 'chat' });
  const [injectionEnabled, setInjectionEnabledState] = useState(isMemoryInjectionEnabled());
  const [mergeMode, setMergeMode] = useState<MemoryMergeMode>(() => getMemoryMergeMode());
  const [consolidating, setConsolidating] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewOps, setReviewOps] = useState<TeamConsolidationOperation[]>([]);
  const [selectedOpIds, setSelectedOpIds] = useState<string[]>([]);
  const [reviewSummary, setReviewSummary] = useState('');

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const result = await teamApi.listMemories({
        category: category || undefined,
        scope: scope || undefined,
        search: search.trim() || undefined,
      });
      setMemories(result?.memories ?? []);
    } catch (error) {
      const detail = error instanceof TeamApiError ? error.code : error instanceof Error ? error.message : '未知错误';
      Message.error(`加载记忆失败：${detail}（可点右上角「模型整理」旁的刷新重试）`);
    } finally {
      setLoading(false);
    }
  }, [category, scope, search]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const sorted = useMemo(
    () => [...memories].toSorted((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt),
    [memories]
  );

  const submit = useCallback(async () => {
    if (!draft.title.trim() || !draft.content.trim()) {
      Message.warning('标题与内容不能为空');
      return;
    }
    try {
      if (editing) {
        await teamApi.updateMemory(
          editing.id,
          { title: draft.title, content: draft.content, category: draft.category, scope: draft.scope },
          editing.version
        );
      } else {
        await teamApi.createMemory(draft);
      }
      setModalOpen(false);
      setEditing(null);
      Message.success(editing ? '已更新' : '已创建');
      await reload();
    } catch (error) {
      Message.error(`保存失败：${error instanceof TeamApiError ? error.code : '未知错误'}`);
    }
  }, [draft, editing, reload]);

  const remove = useCallback(
    async (memory: TeamMemoryEntry) => {
      try {
        await teamApi.deleteMemory(memory.id, memory.version);
        await reload();
      } catch (error) {
        Message.error(`删除失败：${error instanceof TeamApiError ? error.code : '未知错误'}`);
      }
    },
    [reload]
  );

  const togglePin = useCallback(
    async (memory: TeamMemoryEntry) => {
      try {
        await teamApi.updateMemory(memory.id, { pinned: !memory.pinned }, memory.version);
        await reload();
      } catch (error) {
        Message.error(`操作失败：${error instanceof TeamApiError ? error.code : '未知错误'}`);
      }
    },
    [reload]
  );

  const consolidate = useCallback(async () => {
    setConsolidating(true);
    try {
      const mode = getMemoryMergeMode();
      if (mode === 'auto') {
        const result = await teamApi.consolidateMemories('all', 'auto');
        Message.success(`自动整理完成：${result.summary}`);
        await reload();
        return;
      }
      // 手动模式：review（不执行）→ 弹窗勾选 → apply
      const result = await teamApi.consolidateMemories('all', 'review');
      if (result.operations.length === 0) {
        Message.info(result.summary || '未发现可整理项');
        await reload();
        return;
      }
      setReviewOps(result.operations);
      setSelectedOpIds(result.operations.map((op) => op.id));
      setReviewSummary(result.summary);
      setReviewOpen(true);
    } catch (error) {
      Message.error(
        `整理失败：${error instanceof TeamApiError ? error.code : error instanceof Error ? error.message : '未知错误'}`
      );
    } finally {
      setConsolidating(false);
    }
  }, [reload]);

  const applyReview = useCallback(async () => {
    const selected = reviewOps.filter((op) => selectedOpIds.includes(op.id));
    if (selected.length === 0) {
      Message.warning('请至少勾选一项操作');
      return;
    }
    setConsolidating(true);
    try {
      const result = await teamApi.applyConsolidation(selected);
      Message.success(`已应用 ${result.appliedCount} 项整理操作`);
      setReviewOpen(false);
      await reload();
    } catch (error) {
      Message.error(`应用失败：${error instanceof TeamApiError ? error.code : '未知错误'}`);
    } finally {
      setConsolidating(false);
    }
  }, [reviewOps, selectedOpIds, reload]);

  return (
    <Card
      title='个人记忆（本地优先，仅本人可见）'
      extra={
        <Space>
          <span style={{ fontSize: 12 }}>对话注入</span>
          <Switch
            size='small'
            checked={injectionEnabled}
            onChange={(value) => {
              setMemoryInjectionEnabled(value);
              setInjectionEnabledState(value);
            }}
          />
          <span style={{ fontSize: 12, marginLeft: 8 }}>合并模式</span>
          <Switch
            size='small'
            checked={mergeMode === 'auto'}
            checkedText='自动'
            uncheckedText='手动'
            onChange={(value) => {
              const next = value ? 'auto' : 'manual';
              setMemoryMergeMode(next);
              setMergeMode(next);
            }}
          />
          <Button size='small' icon={<IconRefresh />} onClick={() => void reload()}>
            刷新
          </Button>
          <Button
            size='small'
            type='primary'
            icon={<IconRefresh />}
            loading={consolidating}
            onClick={() => void consolidate()}
          >
            {consolidating ? '整理中…' : mergeMode === 'auto' ? '自动整理' : '整理（勾选确认）'}
          </Button>
          <Button
            size='small'
            type='primary'
            icon={<IconPlus />}
            onClick={() => {
              setEditing(null);
              setDraft({ title: '', content: '', category: 'fact', scope: 'chat' });
              setModalOpen(true);
            }}
          >
            新建
          </Button>
        </Space>
      }
    >
      <Space style={{ marginBottom: 12 }} size={8}>
        <Select size='small' style={{ width: 120 }} value={category} options={CATEGORIES} onChange={setCategory} />
        <Select size='small' style={{ width: 120 }} value={scope} options={SCOPES} onChange={setScope} />
        <Input
          size='small'
          style={{ width: 220 }}
          prefix={<IconSearch />}
          placeholder='搜索标题/内容'
          value={search}
          onChange={setSearch}
          allowClear
        />
      </Space>
      {loading ? (
        <div style={{ textAlign: 'center', padding: 32 }}>
          <Spin />
        </div>
      ) : sorted.length === 0 ? (
        <Empty description='暂无记忆：完成对话后自动抽取，或点击右上角新建' />
      ) : (
        <List
          dataSource={sorted}
          render={(memory) => (
            <List.Item
              key={memory.id}
              actions={[
                <Button key='pin' size='mini' type='text' onClick={() => void togglePin(memory)}>
                  {memory.pinned ? '取消置顶' : '置顶'}
                </Button>,
                <Button
                  key='edit'
                  size='mini'
                  type='text'
                  onClick={() => {
                    setEditing(memory);
                    setDraft({
                      title: memory.title,
                      content: memory.content,
                      category: memory.category,
                      scope: memory.scope,
                    });
                    setModalOpen(true);
                  }}
                >
                  编辑
                </Button>,
                onUpgrade && (
                  <Button key='upgrade' size='mini' type='text' onClick={() => onUpgrade(memory)}>
                    升级为团队记忆
                  </Button>
                ),
                <Popconfirm key='delete' title='确认删除该记忆？' onOk={() => void remove(memory)}>
                  <Button size='mini' type='text' status='danger'>
                    删除
                  </Button>
                </Popconfirm>,
              ]}
            >
              <List.Item.Meta
                title={
                  <Space size={8}>
                    {memory.pinned && (
                      <Tag size='small' color='gold'>
                        置顶
                      </Tag>
                    )}
                    <Typography.Text bold>{memory.title}</Typography.Text>
                    <Tag size='small' color={CATEGORY_COLOR[memory.category] ?? 'gray'}>
                      {memory.category}
                    </Tag>
                    <Tag size='small'>{memory.scope === 'code' ? '编码' : '对话'}</Tag>
                    <Typography.Text type='secondary' size='small'>
                      v{memory.version}
                    </Typography.Text>
                  </Space>
                }
                description={memory.content}
              />
            </List.Item>
          )}
        />
      )}

      <Modal
        title='整理预览（勾选要应用的操作）'
        visible={reviewOpen}
        onCancel={() => setReviewOpen(false)}
        onOk={() => void applyReview()}
        okText={`应用 ${selectedOpIds.length} 项`}
        cancelText='取消'
        okButtonProps={{ loading: consolidating }}
        style={{ width: 620 }}
      >
        <Typography.Text type='secondary' style={{ display: 'block', marginBottom: 8 }}>
          {reviewSummary}
        </Typography.Text>
        <div style={{ maxHeight: 400, overflow: 'auto' }}>
          {reviewOps.map((op) => (
            <div
              key={op.id}
              style={{
                padding: '8px 12px',
                marginBottom: 6,
                borderRadius: 6,
                border: selectedOpIds.includes(op.id)
                  ? '1px solid var(--color-primary-light-3)'
                  : '1px solid var(--color-border-2)',
                cursor: 'pointer',
              }}
              onClick={() => {
                setSelectedOpIds((prev) =>
                  prev.includes(op.id) ? prev.filter((id) => id !== op.id) : [...prev, op.id]
                );
              }}
            >
              <Space size={8}>
                <input
                  type='checkbox'
                  checked={selectedOpIds.includes(op.id)}
                  readOnly
                  style={{ pointerEvents: 'none' }}
                />
                <Tag size='small' color={op.type === 'merge' ? 'arcoblue' : op.type === 'delete' ? 'red' : 'green'}>
                  {op.type === 'merge' ? '合并' : op.type === 'delete' ? '清理' : '更新'}
                </Tag>
                <Typography.Text bold>{op.title ?? op.targetId.slice(0, 8)}</Typography.Text>
              </Space>
              <Typography.Paragraph type='secondary' size='small' style={{ marginBottom: 0, marginTop: 4 }}>
                {op.type === 'merge' && op.sourceIds ? `将 ${op.sourceIds.length} 条源记忆并入此条目。` : ''}
                {op.reason}
              </Typography.Paragraph>
              {op.content && (
                <Typography.Paragraph type='secondary' size='small' style={{ marginBottom: 0 }}>
                  {op.content.slice(0, 100)}
                  {op.content.length > 100 ? '…' : ''}
                </Typography.Paragraph>
              )}
            </div>
          ))}
        </div>
      </Modal>

      <Modal
        title={editing ? '编辑记忆' : '新建记忆'}
        visible={modalOpen}
        onOk={() => void submit()}
        onCancel={() => setModalOpen(false)}
        okText='保存'
      >
        <Space direction='vertical' size='large' style={{ width: '100%' }}>
          <Input
            placeholder='标题（<=20 字）'
            value={draft.title}
            onChange={(v) => setDraft((d) => ({ ...d, title: v }))}
          />
          <Input.TextArea
            placeholder='内容'
            autoSize={{ minRows: 3, maxRows: 8 }}
            value={draft.content}
            onChange={(v) => setDraft((d) => ({ ...d, content: v }))}
          />
          <Space>
            <Select
              style={{ width: 120 }}
              value={draft.category}
              options={CATEGORIES.slice(1)}
              onChange={(v) => setDraft((d) => ({ ...d, category: v }))}
            />
            <Select
              style={{ width: 120 }}
              value={draft.scope}
              options={SCOPES.slice(1)}
              onChange={(v) => setDraft((d) => ({ ...d, scope: v }))}
            />
          </Space>
        </Space>
      </Modal>
    </Card>
  );
};

const MemoryPage: React.FC = () => {
  const { view } = useTeamAuth();
  const [activeTab, setActiveTab] = useState<'personal' | 'team'>('personal');
  const [upgradeTarget, setUpgradeTarget] = useState<TeamMemoryEntry | null>(null);

  if (view.phase !== 'authenticated') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
        <Empty description='请先在登录页使用团队账号登录后使用记忆功能' />
      </div>
    );
  }

  return (
    <div style={{ padding: 16, height: '100%', overflow: 'auto' }}>
      <Tabs activeTab={activeTab} onChange={(key) => setActiveTab(key as 'personal' | 'team')}>
        <Tabs.TabPane key='personal' title='个人记忆'>
          <PersonalMemoryPanel
            onUpgrade={(memory) => {
              setUpgradeTarget(memory);
              setActiveTab('team');
            }}
          />
        </Tabs.TabPane>
        <Tabs.TabPane key='team' title='团队记忆'>
          <TeamMemoryPanel initialUpgrade={upgradeTarget} onUpgradeConsumed={() => setUpgradeTarget(null)} />
        </Tabs.TabPane>
      </Tabs>
    </div>
  );
};

export default MemoryPage;
