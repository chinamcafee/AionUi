// E-23 K6：可编辑文档 Tab——文档列表 + Markdown 编辑器 + 保存（触发异步知识抽取）。
// UI：Arco Design（与 AionUI 统一）；编辑器用 textarea+预览（替代 KE-v2 的 BlockSuite，避免 Lit 元素侵入）。

import React, { useCallback, useEffect, useState } from 'react';
import {
  Button, Card, Empty, Input, List, Message, Popconfirm, Space,
  Spin, Typography,
} from '@arco-design/web-react';
import { IconPlus, IconRefresh, IconSearch } from '@arco-design/web-react/icon';
import { teamApi, TeamApiError } from '@/renderer/api/teamClient';
import { useTeamAuth } from '@/renderer/hooks/context/TeamAuthContext';
import MarkdownView from '@renderer/components/Markdown';
import type { KnowledgeDoc } from './types';

const DocList: React.FC<{ onEdit: (doc: KnowledgeDoc) => void; onNew: () => void; refreshKey: number }> = ({ onEdit, onNew, refreshKey }) => {
  const [docs, setDocs] = useState<KnowledgeDoc[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const result = await teamApi.listKnowledgeDocs();
      setDocs(Array.isArray(result) ? (result as KnowledgeDoc[]) : []);
    } catch (error) {
      Message.error(`加载文档失败：${error instanceof TeamApiError ? error.code : '未知错误'}`);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void reload(); }, [reload, refreshKey]);

  const remove = useCallback(async (id: string) => {
    try { await teamApi.deleteKnowledgeDoc(id); await reload(); }
    catch (error) { Message.error(`删除失败：${error instanceof TeamApiError ? error.code : '未知错误'}`); }
  }, [reload]);

  const filtered = docs.filter((d) => !search.trim() || d.title.toLowerCase().includes(search.toLowerCase()));
  const preview = (text?: string) => (text ?? '').replace(/[#*`~[\]()!>-]/g, '').slice(0, 120);

  return (
    <Card title='可编辑文档' extra={(
      <Space>
        <Input size='small' style={{ width: 200 }} prefix={<IconSearch />} placeholder='搜索标题' value={search} onChange={setSearch} allowClear />
        <Button size='small' icon={<IconRefresh />} onClick={() => void reload()}>刷新</Button>
        <Button size='small' type='primary' icon={<IconPlus />} onClick={onNew}>新建文档</Button>
      </Space>
    )}>
      {loading ? <div style={{ textAlign: 'center', padding: 32 }}><Spin /></div>
        : filtered.length === 0 ? <Empty description='暂无文档，点击右上角新建' />
        : (
          <List dataSource={filtered} render={(doc) => (
            <List.Item key={doc.id} actions={[
              <Button key='edit' size='mini' type='text' onClick={() => onEdit(doc)}>编辑</Button>,
              <Popconfirm key='del' title='确认删除？' onOk={() => void remove(doc.id)}>
                <Button size='mini' type='text' status='danger'>删除</Button>
              </Popconfirm>,
            ]}>
              <List.Item.Meta
                title={<Typography.Text bold>{doc.title}</Typography.Text>}
                description={preview(doc.content)}
              />
            </List.Item>
          )} />
        )}
    </Card>
  );
};

const DocEditor: React.FC<{ doc: KnowledgeDoc | null; onSaved: () => void; onBack: () => void }> = ({ doc, onSaved, onBack }) => {
  const [title, setTitle] = useState(doc?.title ?? '');
  const [content, setContent] = useState(doc?.content ?? '');
  const [saving, setSaving] = useState(false);
  const [previewMode, setPreviewMode] = useState<'edit' | 'preview'>('edit');

  useEffect(() => { setTitle(doc?.title ?? ''); setContent(doc?.content ?? ''); }, [doc]);

  const save = useCallback(async () => {
    if (!title.trim()) { Message.warning('标题不能为空'); return; }
    setSaving(true);
    try {
      const result = await teamApi.saveKnowledgeDoc({ id: doc?.id, title: title.trim(), content });
      Message.success(`已保存（${result.isNew ? '新建' : '更新'}），知识抽取将在后台进行`);
      onSaved();
    } catch (error) {
      Message.error(`保存失败：${error instanceof TeamApiError ? error.code : '未知错误'}`);
    } finally { setSaving(false); }
  }, [doc, title, content, onSaved]);

  return (
    <Card title={doc ? `编辑：${doc.title}` : '新建文档'} extra={(
      <Space>
        <Button size='small' onClick={() => setPreviewMode(p => p === 'edit' ? 'preview' : 'edit')}>
          {previewMode === 'edit' ? '预览' : '编辑'}
        </Button>
        <Button size='small' onClick={onBack}>返回列表</Button>
        <Button size='small' type='primary' loading={saving} onClick={() => void save()}>保存</Button>
      </Space>
    )}>
      <Space direction='vertical' size='large' style={{ width: '100%' }}>
        <Input size='large' placeholder='文档标题' value={title} onChange={setTitle} />
        {previewMode === 'edit' ? (
          <Input.TextArea
            placeholder='输入 Markdown 内容…'
            value={content}
            onChange={setContent}
            autoSize={{ minRows: 16, maxRows: 40 }}
            style={{ fontFamily: 'monospace', fontSize: 13 }}
          />
        ) : (
          <div style={{ minHeight: 400, padding: 16, border: '1px solid var(--color-border-2)', borderRadius: 8, overflow: 'auto' }}>
            <MarkdownView>{content || '（空文档）'}</MarkdownView>
          </div>
        )}
      </Space>
    </Card>
  );
};

export const DocsTab: React.FC = () => {
  const { view } = useTeamAuth();
  const [editing, setEditing] = useState<KnowledgeDoc | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  if (view.phase !== 'authenticated') {
    return <Empty description='请先登录团队账号' />;
  }
  if (isNew || editing) {
    return (
      <DocEditor
        doc={editing}
        onSaved={() => { setEditing(null); setIsNew(false); setRefreshKey(k => k + 1); }}
        onBack={() => { setEditing(null); setIsNew(false); }}
      />
    );
  }
  return (
    <DocList
      onEdit={(d) => setEditing(d)}
      onNew={() => setIsNew(true)}
      refreshKey={refreshKey}
    />
  );
};
