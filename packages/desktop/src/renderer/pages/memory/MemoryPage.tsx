// AionUi 新增（T2.8）：记忆页。个人记忆面板移植自 client MemoryPage（Arco 重写）；
// 团队记忆 Tab 在 M3（T3.3）接入后启用（TeamMemoryPanel）。
// 数据经 BFF /teamapi/memories*（个人=本地 libsql；团队=team-server 网关）。
// 2026-09-29：个人记忆引入可管理「分类」归档维度（不参与召回，见 docs/team/05-记忆分类体系-技术评估报告.md）。

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
import { teamApi, TeamApiError, type MemoryCategoryView, type TeamMemoryEntry } from '@/renderer/api/teamClient';
import { useTeamAuth } from '@/renderer/hooks/context/TeamAuthContext';
import {
  invalidateMemorizeCategoryCache,
  isMemoryInjectionEnabled,
  setMemoryInjectionEnabled,
} from '@/renderer/services/memory/memoryInjection';
import { TeamMemoryPanel, type TeamMemoryUpgradeCandidate } from './TeamMemoryPanel';
import {
  getMemoryMergeMode,
  setMemoryMergeMode,
  type MemoryMergeMode,
} from '@/renderer/services/memory/memoryInjection';
import type { TeamConsolidationOperation } from '@/renderer/api/teamClient';

/** 「未分类」过滤值（与 BFF 约定一致） */
const UNCATEGORIZED_FILTER = '__uncategorized__';

const SCOPES = [
  { value: '', label: '全部空间' },
  { value: 'chat', label: '对话记忆' },
  { value: 'code', label: '编码记忆' },
];

/** 分类标签配色：按分类顺序循环使用既有色板（不落库，纯展示） */
const CATEGORY_TAG_COLORS = ['arcoblue', 'green', 'orangered', 'purple', 'cyan', 'magenta'];

const OP_META: Record<string, { text: string; color: string }> = {
  merge: { text: '合并', color: 'arcoblue' },
  update: { text: '更新', color: 'green' },
  delete: { text: '清理', color: 'red' },
  create_category: { text: '新建分类', color: 'purple' },
};

const opTitle = (op: TeamConsolidationOperation) =>
  op.type === 'create_category' ? (op.name ?? op.id) : (op.title ?? op.targetId.slice(0, 8));

/** 分类管理弹窗：新建/改名/归档（归档需先把引用记忆迁往目标分类或未分类，决策 D3） */
const CategoryManagerModal: React.FC<{
  visible: boolean;
  categories: MemoryCategoryView[];
  onClose: () => void;
  onChanged: () => void;
}> = ({ visible, categories, onClose, onChanged }) => {
  const [search, setSearch] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [archivingId, setArchivingId] = useState<string | null>(null);
  const [reassignTo, setReassignTo] = useState<string>('');

  const filtered = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    if (!keyword) return categories;
    return categories.filter(
      (category) =>
        category.name.toLowerCase().includes(keyword) || (category.description ?? '').toLowerCase().includes(keyword)
    );
  }, [categories, search]);

  const notifyChanged = useCallback(() => {
    invalidateMemorizeCategoryCache();
    onChanged();
  }, [onChanged]);

  const create = useCallback(async () => {
    if (!name.trim()) {
      Message.warning('分类名不能为空');
      return;
    }
    setBusy(true);
    try {
      await teamApi.createMemoryCategory({ name: name.trim(), description: description.trim() || undefined });
      setName('');
      setDescription('');
      Message.success('已创建分类');
      notifyChanged();
    } catch (error) {
      Message.error(`创建失败：${error instanceof TeamApiError ? error.code : '未知错误'}`);
    } finally {
      setBusy(false);
    }
  }, [name, description, notifyChanged]);

  const saveEdit = useCallback(
    async (category: MemoryCategoryView) => {
      if (!editName.trim()) {
        Message.warning('分类名不能为空');
        return;
      }
      setBusy(true);
      try {
        await teamApi.updateMemoryCategory(
          category.id,
          { name: editName.trim(), description: editDescription.trim() || null },
          category.version
        );
        setEditingId(null);
        Message.success('已保存');
        notifyChanged();
      } catch (error) {
        Message.error(`保存失败：${error instanceof TeamApiError ? error.code : '未知错误'}`);
      } finally {
        setBusy(false);
      }
    },
    [editName, editDescription, notifyChanged]
  );

  const archive = useCallback(
    async (category: MemoryCategoryView) => {
      setBusy(true);
      try {
        const result = await teamApi.deleteMemoryCategory(category.id, category.version, reassignTo || null);
        setArchivingId(null);
        setReassignTo('');
        Message.success(
          result.reassigned > 0 ? `已归档分类，${result.reassigned} 条记忆已迁移` : '已归档分类（无引用记忆）'
        );
        notifyChanged();
      } catch (error) {
        Message.error(`归档失败：${error instanceof TeamApiError ? error.code : '未知错误'}`);
      } finally {
        setBusy(false);
      }
    },
    [reassignTo, notifyChanged]
  );

  return (
    <Modal title='管理分类' visible={visible} onCancel={onClose} footer={null} style={{ width: 640 }}>
      <Space direction='vertical' size='medium' style={{ width: '100%' }}>
        <Typography.Text type='secondary' size='small'>
          分类仅用于归档与浏览筛选，不参与对话召回；整理时模型会优先复用现有分类，必要时新建。
        </Typography.Text>
        <Space style={{ width: '100%' }} size={8}>
          <Input
            style={{ width: 180 }}
            placeholder='新分类名（≤20 字）'
            value={name}
            onChange={setName}
            maxLength={20}
          />
          <Input
            style={{ width: 260 }}
            placeholder='说明（可选，供模型判别）'
            value={description}
            onChange={setDescription}
            maxLength={200}
          />
          <Button type='primary' loading={busy} onClick={() => void create()}>
            新建分类
          </Button>
        </Space>
        {categories.length > 10 && (
          <Input
            style={{ width: 240 }}
            size='small'
            prefix={<IconSearch />}
            placeholder='搜索分类'
            value={search}
            onChange={setSearch}
            allowClear
          />
        )}
        <div style={{ maxHeight: 360, overflow: 'auto' }}>
          {filtered.length === 0 ? (
            <Empty description='没有匹配的分类' />
          ) : (
            filtered.map((category) => (
              <div
                key={category.id}
                style={{
                  padding: '8px 10px',
                  marginBottom: 6,
                  border: '1px solid var(--color-border-2)',
                  borderRadius: 6,
                }}
              >
                {editingId === category.id ? (
                  <Space size={8} style={{ width: '100%' }}>
                    <Input style={{ width: 160 }} value={editName} maxLength={20} onChange={setEditName} />
                    <Input
                      style={{ width: 220 }}
                      value={editDescription}
                      maxLength={200}
                      placeholder='说明（可选）'
                      onChange={setEditDescription}
                    />
                    <Button size='mini' type='primary' loading={busy} onClick={() => void saveEdit(category)}>
                      保存
                    </Button>
                    <Button size='mini' onClick={() => setEditingId(null)}>
                      取消
                    </Button>
                  </Space>
                ) : (
                  <Space size={8} style={{ width: '100%' }}>
                    <Typography.Text bold>{category.name}</Typography.Text>
                    {category.source === 'consolidated' && (
                      <Tag size='small' color='purple'>
                        整理新建
                      </Tag>
                    )}
                    <Typography.Text type='secondary' size='small' style={{ flex: 1 }}>
                      {category.description ?? ''}
                    </Typography.Text>
                    <Button
                      size='mini'
                      type='text'
                      onClick={() => {
                        setEditingId(category.id);
                        setEditName(category.name);
                        setEditDescription(category.description ?? '');
                      }}
                    >
                      编辑
                    </Button>
                    <Button
                      size='mini'
                      type='text'
                      status='danger'
                      onClick={() => {
                        setArchivingId(category.id);
                        setReassignTo('');
                      }}
                    >
                      归档
                    </Button>
                  </Space>
                )}
                {archivingId === category.id && (
                  <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px dashed var(--color-border-2)' }}>
                    <Space size={8}>
                      <Typography.Text type='secondary' size='small'>
                        该分类下的记忆迁移到：
                      </Typography.Text>
                      <Select
                        size='small'
                        style={{ width: 160 }}
                        value={reassignTo}
                        onChange={setReassignTo}
                        options={[
                          { value: '', label: '未分类' },
                          ...categories
                            .filter((item) => item.id !== category.id)
                            .map((item) => ({ value: item.id, label: item.name })),
                        ]}
                      />
                      <Popconfirm
                        title='确认归档该分类？'
                        content='归档后分类不再出现在选择器中，引用记忆将迁移到所选分类。'
                        onOk={() => void archive(category)}
                      >
                        <Button size='mini' status='danger' loading={busy}>
                          确认归档
                        </Button>
                      </Popconfirm>
                      <Button size='mini' type='text' onClick={() => setArchivingId(null)}>
                        取消
                      </Button>
                    </Space>
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      </Space>
    </Modal>
  );
};

const PersonalMemoryPanel: React.FC<{ onUpgrade?: (candidate: TeamMemoryUpgradeCandidate) => void }> = ({
  onUpgrade,
}) => {
  const [memories, setMemories] = useState<TeamMemoryEntry[]>([]);
  const [categories, setCategories] = useState<MemoryCategoryView[]>([]);
  const [loading, setLoading] = useState(false);
  const [category, setCategory] = useState('');
  const [scope, setScope] = useState('');
  const [search, setSearch] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [managerOpen, setManagerOpen] = useState(false);
  const [editing, setEditing] = useState<TeamMemoryEntry | null>(null);
  const [draft, setDraft] = useState<{ title: string; content: string; categoryId: string; scope: string }>({
    title: '',
    content: '',
    categoryId: '',
    scope: 'chat',
  });
  const [injectionEnabled, setInjectionEnabledState] = useState(isMemoryInjectionEnabled());
  const [mergeMode, setMergeMode] = useState<MemoryMergeMode>(() => getMemoryMergeMode());
  const [consolidating, setConsolidating] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewOps, setReviewOps] = useState<TeamConsolidationOperation[]>([]);
  const [selectedOpIds, setSelectedOpIds] = useState<string[]>([]);
  const [reviewSummary, setReviewSummary] = useState('');

  const categoryNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of categories) map.set(item.id, item.name);
    return map;
  }, [categories]);

  const categoryColorById = useMemo(() => {
    const map = new Map<string, string>();
    categories.forEach((item, index) => map.set(item.id, CATEGORY_TAG_COLORS[index % CATEGORY_TAG_COLORS.length]));
    return map;
  }, [categories]);

  const categoryLabelOf = useCallback(
    (categoryId: string | null | undefined) =>
      categoryId ? (categoryNameById.get(categoryId) ?? '已归档分类') : '未分类',
    [categoryNameById]
  );

  const loadCategories = useCallback(async () => {
    try {
      const result = await teamApi.listMemoryCategories();
      setCategories(result?.categories ?? []);
    } catch {
      // 分类加载失败不阻断记忆列表（选择器退化为仅「未分类」）
    }
  }, []);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const result = await teamApi.listMemories({
        categoryId: category || undefined,
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
    void loadCategories();
  }, [loadCategories]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const sorted = useMemo(
    () => [...memories].toSorted((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt),
    [memories]
  );

  const categoryOptions = useMemo(
    () => [{ value: '', label: '未分类' }, ...categories.map((item) => ({ value: item.id, label: item.name }))],
    [categories]
  );

  const filterOptions = useMemo(
    () => [
      { value: '', label: '全部分类' },
      ...categories.map((item) => ({ value: item.id, label: item.name })),
      { value: UNCATEGORIZED_FILTER, label: '未分类' },
    ],
    [categories]
  );

  const submit = useCallback(async () => {
    if (!draft.title.trim() || !draft.content.trim()) {
      Message.warning('标题与内容不能为空');
      return;
    }
    const categoryId = draft.categoryId || null;
    try {
      if (editing) {
        await teamApi.updateMemory(
          editing.id,
          { title: draft.title, content: draft.content, categoryId, scope: draft.scope },
          editing.version
        );
      } else {
        await teamApi.createMemory({ ...draft, categoryId });
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
        await loadCategories();
        invalidateMemorizeCategoryCache();
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
  }, [reload, loadCategories]);

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
      await loadCategories();
      invalidateMemorizeCategoryCache();
      await reload();
    } catch (error) {
      Message.error(`应用失败：${error instanceof TeamApiError ? error.code : '未知错误'}`);
    } finally {
      setConsolidating(false);
    }
  }, [reviewOps, selectedOpIds, reload, loadCategories]);

  const opCategoryHint = useCallback(
    (op: TeamConsolidationOperation) => {
      if (op.type === 'create_category') return op.description ?? '';
      if (op.categoryName) return `新分类：${op.categoryName}`;
      if (op.categoryId !== undefined) return `分类：${categoryLabelOf(op.categoryId)}`;
      return '';
    },
    [categoryLabelOf]
  );

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
              setDraft({ title: '', content: '', categoryId: '', scope: 'chat' });
              setModalOpen(true);
            }}
          >
            新建
          </Button>
        </Space>
      }
    >
      <Space style={{ marginBottom: 12 }} size={8}>
        <Select size='small' style={{ width: 140 }} value={category} options={filterOptions} onChange={setCategory} />
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
        <Button size='small' onClick={() => setManagerOpen(true)}>
          管理分类
        </Button>
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
                      categoryId: memory.categoryId ?? '',
                      scope: memory.scope,
                    });
                    setModalOpen(true);
                  }}
                >
                  编辑
                </Button>,
                onUpgrade && (
                  <Button
                    key='upgrade'
                    size='mini'
                    type='text'
                    onClick={() =>
                      onUpgrade({
                        id: memory.id,
                        title: memory.title,
                        content: memory.content,
                        categoryName: memory.categoryId ? (categoryNameById.get(memory.categoryId) ?? null) : null,
                        scope: memory.scope,
                      })
                    }
                  >
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
                    <Tag
                      size='small'
                      color={memory.categoryId ? (categoryColorById.get(memory.categoryId) ?? 'gray') : 'gray'}
                    >
                      {categoryLabelOf(memory.categoryId)}
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

      <CategoryManagerModal
        visible={managerOpen}
        categories={categories}
        onClose={() => setManagerOpen(false)}
        onChanged={() => {
          void loadCategories();
          void reload();
        }}
      />

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
                <Tag size='small' color={OP_META[op.type]?.color ?? 'gray'}>
                  {OP_META[op.type]?.text ?? op.type}
                </Tag>
                <Typography.Text bold>{opTitle(op)}</Typography.Text>
              </Space>
              <Typography.Paragraph type='secondary' size='small' style={{ marginBottom: 0, marginTop: 4 }}>
                {op.type === 'merge' && op.sourceIds ? `将 ${op.sourceIds.length} 条源记忆并入此条目。` : ''}
                {op.type !== 'create_category' ? opCategoryHint(op) : ''}
                {op.type !== 'create_category' && opCategoryHint(op) && op.reason ? ' · ' : ''}
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
              style={{ width: 140 }}
              value={draft.categoryId}
              options={categoryOptions}
              onChange={(v) => setDraft((d) => ({ ...d, categoryId: v }))}
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
  const [upgradeTarget, setUpgradeTarget] = useState<TeamMemoryUpgradeCandidate | null>(null);

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
            onUpgrade={(candidate) => {
              setUpgradeTarget(candidate);
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
