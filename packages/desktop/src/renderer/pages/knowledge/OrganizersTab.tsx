// E-23 K8：分组与标签 Tab——双栏管理（分组/标签 CRUD + 颜色）+ 文档分配（搜索 + 分组标签关联）。
// 对齐 KE-v2 GroupAndTagManager 功能；UI 用 Arco。

import React, { useCallback, useEffect, useState } from 'react';
import {
  Button,
  Card,
  Checkbox,
  Empty,
  Grid,
  Input,
  List,
  Message,
  Modal,
  Popconfirm,
  Select,
  Space,
  Spin,
  Tag,
  Typography,
} from '@arco-design/web-react';
import { IconPlus, IconRefresh, IconSearch } from '@arco-design/web-react/icon';
import { teamApi, TeamApiError } from '@/renderer/api/teamClient';
import { useTeamAuth } from '@/renderer/hooks/context/TeamAuthContext';
import type { OrganizerItem, OrganizerDocument } from './types';

const COLORS = [
  '#626ea3',
  '#e86e6e',
  '#4caf7d',
  '#d4a72c',
  '#9b59b6',
  '#3498db',
  '#e67e22',
  '#1abc9c',
  '#e74c3c',
  '#34495e',
];

// ── 分组/标签管理面板 ──
const OrganizerManager: React.FC<{
  kind: 'groups' | 'tags';
  items: OrganizerItem[];
  loading: boolean;
  onReload: () => void;
}> = ({ kind, items, loading, onReload }) => {
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<OrganizerItem | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: '', description: '', color: COLORS[0] });
  const [saving, setSaving] = useState(false);
  const label = kind === 'groups' ? '分组' : '标签';

  const submit = useCallback(async () => {
    if (!form.name.trim()) {
      Message.warning('名称不能为空');
      return;
    }
    setSaving(true);
    try {
      if (editing) {
        await teamApi.updateOrganizer(kind, editing.id, {
          name: form.name.trim(),
          description: form.description,
          color: form.color,
          expectedVersion: editing.version,
        });
      } else {
        await teamApi.createOrganizer(kind, form);
      }
      Message.success(editing ? '已更新' : '已创建');
      setEditing(null);
      setCreating(false);
      onReload();
    } catch (error) {
      Message.error(`保存失败：${error instanceof TeamApiError ? error.code : '未知错误'}`);
    } finally {
      setSaving(false);
    }
  }, [kind, form, editing, onReload]);

  const remove = useCallback(
    async (item: OrganizerItem) => {
      try {
        await teamApi.deleteOrganizer(kind, item.id, item.version);
        onReload();
      } catch (error) {
        Message.error(`删除失败：${error instanceof TeamApiError ? error.code : '未知错误'}`);
      }
    },
    [kind, onReload]
  );

  const filtered = items.filter((i) => !search.trim() || i.name.toLowerCase().includes(search.toLowerCase()));

  return (
    <Card
      title={`${label}管理`}
      extra={
        <Space>
          <Input
            size='small'
            style={{ width: 140 }}
            prefix={<IconSearch />}
            placeholder='搜索'
            value={search}
            onChange={setSearch}
            allowClear
          />
          <Button
            size='mini'
            icon={<IconPlus />}
            onClick={() => {
              setEditing(null);
              setForm({ name: '', description: '', color: COLORS[0] });
              setCreating(true);
            }}
          >
            新建
          </Button>
          <Button size='mini' icon={<IconRefresh />} onClick={onReload} />
        </Space>
      }
    >
      {loading ? (
        <Spin />
      ) : filtered.length === 0 ? (
        <Empty description={`暂无${label}`} />
      ) : (
        <List
          size='small'
          dataSource={filtered}
          render={(item) => (
            <List.Item
              key={item.id}
              actions={[
                <Button
                  key='edit'
                  size='mini'
                  type='text'
                  onClick={() => {
                    setEditing(item);
                    setForm({ name: item.name, description: item.description ?? '', color: item.color });
                    setCreating(false);
                  }}
                >
                  编辑
                </Button>,
                <Popconfirm key='del' title={`确认删除${label}「${item.name}」？`} onOk={() => void remove(item)}>
                  <Button size='mini' type='text' status='danger'>
                    删除
                  </Button>
                </Popconfirm>,
              ]}
            >
              <List.Item.Meta
                title={
                  <Space size={6}>
                    <span
                      style={{
                        width: 12,
                        height: 12,
                        borderRadius: '50%',
                        background: item.color,
                        display: 'inline-block',
                      }}
                    />
                    <Typography.Text bold size='small'>
                      {item.name}
                    </Typography.Text>
                    {typeof item.documentCount === 'number' && <Tag size='small'>{item.documentCount} 篇</Tag>}
                  </Space>
                }
                description={item.description}
              />
            </List.Item>
          )}
        />
      )}

      <Modal
        title={editing ? `编辑${label}` : `新建${label}`}
        visible={creating || !!editing}
        onCancel={() => {
          setEditing(null);
          setCreating(false);
        }}
        onOk={() => void submit()}
        okText='保存'
        okButtonProps={{ loading: saving }}
      >
        <Space direction='vertical' size='large' style={{ width: '100%' }}>
          <Input placeholder={`${label}名称`} value={form.name} onChange={(v) => setForm((f) => ({ ...f, name: v }))} />
          <Input
            placeholder='描述（可选）'
            value={form.description}
            onChange={(v) => setForm((f) => ({ ...f, description: v }))}
          />
          <Space wrap>
            <Typography.Text size='small'>颜色：</Typography.Text>
            {COLORS.map((c) => (
              <span
                key={c}
                onClick={() => setForm((f) => ({ ...f, color: c }))}
                style={{
                  width: 24,
                  height: 24,
                  borderRadius: '50%',
                  background: c,
                  cursor: 'pointer',
                  border: form.color === c ? '3px solid var(--color-primary-6)' : '2px solid transparent',
                  display: 'inline-block',
                }}
              />
            ))}
          </Space>
        </Space>
      </Modal>
    </Card>
  );
};

// ── 文档分配面板 ──
const AssignmentPanel: React.FC<{
  groups: OrganizerItem[];
  tags: OrganizerItem[];
  onReload: () => void;
}> = ({ groups, tags, onReload }) => {
  const [docs, setDocs] = useState<OrganizerDocument[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [docType, setDocType] = useState('all');
  const [assignDoc, setAssignDoc] = useState<OrganizerDocument | null>(null);
  const [selectedGroups, setSelectedGroups] = useState<string[]>([]);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  const loadDocs = useCallback(async () => {
    setLoading(true);
    try {
      const result = await teamApi.searchOrganizerDocuments({
        query: search || undefined,
        docType: docType !== 'all' ? docType : undefined,
      });
      setDocs(Array.isArray(result) ? (result as OrganizerDocument[]) : []);
    } catch {
      setDocs([]);
    } finally {
      setLoading(false);
    }
  }, [search, docType]);

  useEffect(() => {
    void loadDocs();
  }, [loadDocs]);

  const openAssign = (doc: OrganizerDocument) => {
    setAssignDoc(doc);
    setSelectedGroups((doc.groups ?? []).map((g) => g.id));
    setSelectedTags((doc.tags ?? []).map((t) => t.id));
  };

  const saveAssign = useCallback(async () => {
    if (!assignDoc) return;
    setSaving(true);
    try {
      await teamApi.replaceAssignments(assignDoc.id, selectedGroups, selectedTags);
      Message.success('已更新分配');
      setAssignDoc(null);
      loadDocs();
      onReload();
    } catch (error) {
      Message.error(`分配失败：${error instanceof TeamApiError ? error.code : '未知错误'}`);
    } finally {
      setSaving(false);
    }
  }, [assignDoc, selectedGroups, selectedTags, loadDocs, onReload]);

  return (
    <Card
      title='文档分配'
      extra={
        <Space>
          <Input
            size='small'
            style={{ width: 140 }}
            prefix={<IconSearch />}
            placeholder='搜索文档'
            value={search}
            onChange={setSearch}
            allowClear
          />
          <Select
            size='small'
            style={{ width: 100 }}
            value={docType}
            onChange={setDocType}
            options={[
              { value: 'all', label: '全部' },
              { value: 'native', label: '文档' },
              { value: 'upload', label: '上传' },
            ]}
          />
          <Button size='mini' icon={<IconRefresh />} onClick={() => void loadDocs()} />
        </Space>
      }
    >
      {loading ? (
        <Spin />
      ) : docs.length === 0 ? (
        <Empty description='暂无文档' />
      ) : (
        <List
          size='small'
          dataSource={docs}
          render={(doc) => (
            <List.Item
              key={doc.id}
              actions={[
                <Button key='assign' size='mini' type='text' onClick={() => openAssign(doc)}>
                  设置分组标签
                </Button>,
              ]}
            >
              <List.Item.Meta
                title={
                  <Space size={6} wrap>
                    <Typography.Text bold size='small'>
                      {doc.title}
                    </Typography.Text>
                    <Tag size='small'>{doc.docType === 'native' ? '文档' : '上传'}</Tag>
                  </Space>
                }
                description={
                  <Space size={4} wrap>
                    {(doc.groups ?? []).map((g) => (
                      <Tag key={g.id} size='small' color='arcoblue'>
                        {g.name}
                      </Tag>
                    ))}
                    {(doc.tags ?? []).map((t) => (
                      <Tag key={t.id} size='small' color='green'>
                        {t.name}
                      </Tag>
                    ))}
                    {(doc.groups ?? []).length + (doc.tags ?? []).length === 0 && (
                      <Typography.Text type='secondary' size='small'>
                        未分组
                      </Typography.Text>
                    )}
                  </Space>
                }
              />
            </List.Item>
          )}
        />
      )}

      <Modal
        title={`设置分组与标签：${assignDoc?.title ?? ''}`}
        visible={!!assignDoc}
        onCancel={() => setAssignDoc(null)}
        onOk={() => void saveAssign()}
        okText='保存分配'
        okButtonProps={{ loading: saving }}
      >
        <Grid.Row gutter={16}>
          <Grid.Col span={12}>
            <Typography.Text bold size='small' style={{ display: 'block', marginBottom: 8 }}>
              分组
            </Typography.Text>
            <Space direction='vertical' size='small'>
              {groups.map((g) => (
                <Checkbox
                  key={g.id}
                  checked={selectedGroups.includes(g.id)}
                  onChange={(v) =>
                    setSelectedGroups((prev) => (v ? [...prev, g.id] : prev.filter((id) => id !== g.id)))
                  }
                >
                  <span style={{ color: g.color }}>{g.name}</span>
                </Checkbox>
              ))}
              {groups.length === 0 && (
                <Typography.Text type='secondary' size='small'>
                  暂无分组
                </Typography.Text>
              )}
            </Space>
          </Grid.Col>
          <Grid.Col span={12}>
            <Typography.Text bold size='small' style={{ display: 'block', marginBottom: 8 }}>
              标签
            </Typography.Text>
            <Space direction='vertical' size='small'>
              {tags.map((t) => (
                <Checkbox
                  key={t.id}
                  checked={selectedTags.includes(t.id)}
                  onChange={(v) => setSelectedTags((prev) => (v ? [...prev, t.id] : prev.filter((id) => id !== t.id)))}
                >
                  <span style={{ color: t.color }}>{t.name}</span>
                </Checkbox>
              ))}
              {tags.length === 0 && (
                <Typography.Text type='secondary' size='small'>
                  暂无标签
                </Typography.Text>
              )}
            </Space>
          </Grid.Col>
        </Grid.Row>
      </Modal>
    </Card>
  );
};

export const OrganizersTab: React.FC = () => {
  const { view } = useTeamAuth();
  const [groups, setGroups] = useState<OrganizerItem[]>([]);
  const [tags, setTags] = useState<OrganizerItem[]>([]);
  const [loading, setLoading] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const result = await teamApi.listOrganizers();
      setGroups((result as { groups: OrganizerItem[] }).groups ?? []);
      setTags((result as { tags: OrganizerItem[] }).tags ?? []);
    } catch {
      setGroups([]);
      setTags([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  if (view.phase !== 'authenticated') return <Empty description='请先登录团队账号' />;

  return (
    <Space direction='vertical' size='large' style={{ width: '100%' }}>
      <Grid.Row gutter={16}>
        <Grid.Col span={12}>
          <OrganizerManager kind='groups' items={groups} loading={loading} onReload={reload} />
        </Grid.Col>
        <Grid.Col span={12}>
          <OrganizerManager kind='tags' items={tags} loading={loading} onReload={reload} />
        </Grid.Col>
      </Grid.Row>
      <AssignmentPanel groups={groups} tags={tags} onReload={reload} />
    </Space>
  );
};
