// AionUi 新增（T3.3/T3.4/T3.5）：团队记忆面板。移植 client MemoryPage 的 TeamMemoryPanel：
// 列表（workflow_status 徽标）/新建提交审批（202 草稿保留提示）/个人记忆升级提交/失效状态轮询。
// 审阅工作台（approve/reject/publish）在 team-admin 控制台完成（外链跳转，D-4 决策）。

import React, { useCallback, useEffect, useState } from 'react';
import {
  Button,
  Card,
  Empty,
  Input,
  List,
  Message,
  Modal,
  Select,
  Space,
  Tag,
  Typography,
} from '@arco-design/web-react';
import { IconPlus, IconRefresh } from '@arco-design/web-react/icon';
import { teamApi, TeamApiError, type TeamMemoryCandidate } from '@/renderer/api/teamClient';
import { useTeamAuth } from '@/renderer/hooks/context/TeamAuthContext';

/** 个人记忆「升级为团队记忆」的带入形状（个人侧按分类 id 引用，团队侧当前为自由文本 → 传分类名） */
export interface TeamMemoryUpgradeCandidate {
  id: string;
  title: string;
  content: string;
  categoryName: string | null;
  scope: 'chat' | 'code';
}

/** 列表项内嵌最新版本（对象或字符串形态都兼容），取展示字段。 */
function latestVersionOf(item: TeamMemoryCandidate): Partial<{
  title: string;
  content: string;
  category: string;
  memoryScope: string;
  tags: string[];
  sourceType: string;
  submittedAt: string;
}> {
  const raw = (item as { latestVersion?: unknown }).latestVersion;
  if (!raw) return {};
  if (typeof raw === 'object') return raw as Record<string, never>;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      // Go map-repr 形态：宽松提取 title/content
      const title = /'title':\s*'([^']*)'/.exec(raw)?.[1];
      const content = /'content':\s*'([^']*)'/.exec(raw)?.[1];
      return { title, content } as Record<string, never>;
    }
  }
  return {};
}

const STATUS_COLOR: Record<string, string> = {
  draft: 'gray',
  pending_review: 'orange',
  pending_activation: 'arcoblue',
  active: 'green',
  archived: 'gray',
  deleted: 'red',
};

const STATUS_LABEL: Record<string, string> = {
  draft: '草稿',
  pending_review: '待审批',
  pending_activation: '待生效',
  active: '已生效',
  archived: '已归档',
  deleted: '已删除',
};

export const TeamMemoryPanel: React.FC<{
  initialUpgrade?: TeamMemoryUpgradeCandidate | null;
  onUpgradeConsumed?: () => void;
}> = ({ initialUpgrade, onUpgradeConsumed }) => {
  const { hasPermission } = useTeamAuth();
  const [memories, setMemories] = useState<TeamMemoryCandidate[]>([]);
  const [loading, setLoading] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [upgradeSource, setUpgradeSource] = useState<TeamMemoryUpgradeCandidate | null>(null);
  const [draft, setDraft] = useState({ title: '', content: '', category: 'fact', memoryScope: 'chat', tags: '' });
  const [invalidation, setInvalidation] = useState<{ connected: boolean; dirty: boolean } | null>(null);
  const canSubmit = hasPermission('team_memory.submit');

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const result = await teamApi.listTeamMemories();
      setMemories(result.memories ?? []);
    } catch (error) {
      Message.error(`加载团队记忆失败：${error instanceof TeamApiError ? error.code : '未知错误'}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
    const timer = setInterval(() => {
      void teamApi
        .teamMemoryInvalidation()
        .then(setInvalidation)
        .catch(() => {});
    }, 5_000);
    return () => clearInterval(timer);
  }, [reload]);

  // 个人记忆升级入口（T3.4）：带入标题/内容/分类名/空间预填并打开提交 Modal
  useEffect(() => {
    if (!initialUpgrade) return;
    setUpgradeSource(initialUpgrade);
    setDraft({
      title: initialUpgrade.title.slice(0, 200),
      content: initialUpgrade.content.slice(0, 50_000),
      category: initialUpgrade.categoryName ?? 'fact',
      memoryScope: initialUpgrade.scope,
      tags: '',
    });
    setModalOpen(true);
    onUpgradeConsumed?.();
  }, [initialUpgrade, onUpgradeConsumed]);

  const submit = useCallback(async () => {
    const tags = draft.tags
      .split(/[,，]/)
      .map((tag) => tag.trim())
      .filter(Boolean);
    const input = upgradeSource
      ? {
          title: draft.title,
          content: draft.content,
          category: draft.category,
          memoryScope: draft.memoryScope as 'chat' | 'code',
          tags,
          personalMemoryId: upgradeSource.id,
        }
      : {
          title: draft.title,
          content: draft.content,
          category: draft.category,
          memoryScope: draft.memoryScope as 'chat' | 'code',
          tags,
        };
    try {
      const result = (await teamApi.createTeamMemory(input)) as { warning?: string };
      if (result?.warning) {
        Message.warning(`草稿已创建，但提交审批未完成（${result.warning}）；刷新后可在列表中看到 Draft 状态。`);
      } else {
        Message.success('已提交审批');
      }
      setModalOpen(false);
      setUpgradeSource(null);
      await reload();
    } catch (error) {
      Message.error(`提交失败：${error instanceof TeamApiError ? error.code : '未知错误'}`);
    }
  }, [draft, upgradeSource, reload]);

  return (
    <Card
      title='团队记忆（审批后全团队共享）'
      extra={
        <Space>
          {invalidation && (
            <Tag size='small' color={invalidation.connected ? 'green' : 'gray'}>
              {invalidation.connected ? '实时同步' : '离线'}
            </Tag>
          )}
          {invalidation?.dirty && (
            <Tag size='small' color='orange'>
              有更新未刷新
            </Tag>
          )}
          <Button size='small' icon={<IconRefresh />} onClick={() => void reload()}>
            刷新
          </Button>
          {canSubmit && (
            <Button
              size='small'
              type='primary'
              icon={<IconPlus />}
              onClick={() => {
                setUpgradeSource(null);
                setDraft({ title: '', content: '', category: 'fact', memoryScope: 'chat', tags: '' });
                setModalOpen(true);
              }}
            >
              新建并提交审批
            </Button>
          )}
        </Space>
      }
    >
      <Typography.Text type='secondary' size='small' style={{ display: 'block', marginBottom: 8 }}>
        审阅/发布/合并工作台在团队管理控制台（设置 → 团队平台 → 打开团队控制台）完成。
      </Typography.Text>
      {loading ? (
        <div style={{ textAlign: 'center', padding: 32, color: 'var(--color-text-3)' }}>加载中…</div>
      ) : memories.length === 0 ? (
        <Empty description='暂无团队记忆' />
      ) : (
        <List
          dataSource={memories}
          render={(memory) => {
            const version = latestVersionOf(memory);
            const title = version.title ?? memory.title ?? memory.id.slice(0, 8);
            const content = version.content ?? memory.content ?? '';
            const category = version.category ?? memory.category;
            const scope = version.memoryScope ?? memory.memoryScope;
            const tags = version.tags ?? memory.tags ?? [];
            return (
              <List.Item key={memory.id}>
                <List.Item.Meta
                  title={
                    <Space size={8} wrap>
                      <Typography.Text bold>{title}</Typography.Text>
                      <Tag size='small' color={STATUS_COLOR[memory.workflowStatus ?? ''] ?? 'gray'}>
                        {STATUS_LABEL[memory.workflowStatus ?? ''] ?? memory.workflowStatus ?? 'unknown'}
                      </Tag>
                      {category && (
                        <Tag size='small' color='arcoblue'>
                          {category}
                        </Tag>
                      )}
                      {scope && <Tag size='small'>{scope === 'code' ? '编码' : '对话'}</Tag>}
                      {tags.slice(0, 6).map((tag) => (
                        <Tag key={tag} size='small'>
                          {tag}
                        </Tag>
                      ))}
                    </Space>
                  }
                  description={
                    <div>
                      <div>{content || <Typography.Text type='secondary'>（无内容）</Typography.Text>}</div>
                      {version.submittedAt && (
                        <Typography.Text
                          type='secondary'
                          size='small'
                          style={{ marginTop: 4, display: 'inline-block' }}
                        >
                          提交于 {new Date(version.submittedAt).toLocaleString()} · 来源{' '}
                          {version.sourceType ?? 'manual'} · 待 team-admin 审批后生效（draft→pending_review→active）
                        </Typography.Text>
                      )}
                    </div>
                  }
                />
              </List.Item>
            );
          }}
        />
      )}

      <Modal
        title={upgradeSource ? `升级个人记忆为团队记忆：${upgradeSource.title}` : '新建团队记忆'}
        visible={modalOpen}
        onOk={() => void submit()}
        onCancel={() => {
          setModalOpen(false);
          setUpgradeSource(null);
        }}
        okText='提交审批'
      >
        <Space direction='vertical' size='large' style={{ width: '100%' }}>
          <Input
            placeholder='标题（<=200 字）'
            value={draft.title}
            onChange={(v) => setDraft((d) => ({ ...d, title: v }))}
          />
          <Input.TextArea
            placeholder='内容（<=50000 字）'
            autoSize={{ minRows: 3, maxRows: 8 }}
            value={draft.content}
            onChange={(v) => setDraft((d) => ({ ...d, content: v }))}
          />
          <Space>
            <Input
              placeholder='分类（<=80 字）'
              style={{ width: 140 }}
              value={draft.category}
              onChange={(v) => setDraft((d) => ({ ...d, category: v }))}
            />
            <Select
              style={{ width: 120 }}
              value={draft.memoryScope}
              options={[
                { value: 'chat', label: '对话' },
                { value: 'code', label: '编码' },
              ]}
              onChange={(v) => setDraft((d) => ({ ...d, memoryScope: v }))}
            />
          </Space>
          <Input
            placeholder='标签（逗号分隔，<=20 个）'
            value={draft.tags}
            onChange={(v) => setDraft((d) => ({ ...d, tags: v }))}
          />
        </Space>
      </Modal>
    </Card>
  );
};
