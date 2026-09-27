// E-23 K6：可编辑文档 Tab——文档列表 + BlockSuite Markdown 编辑器/只读查看器 + 保存（触发异步知识抽取）。
// 与 KE-v2 对齐：可编辑文档只含 docType === 'native'（上传件在「资料库」预览，不可编辑）；
// 编辑器/查看器移植自 KE-v2 editor/{DocEditor,DocViewer}.tsx，见 components/knowledge/blocksuite/。

import React, { useCallback, useEffect, useState } from 'react';
import { Button, Card, Empty, Input, List, Message, Popconfirm, Space, Spin, Typography } from '@arco-design/web-react';
import { IconPlus, IconRefresh, IconSearch } from '@arco-design/web-react/icon';
import { teamApi, TeamApiError } from '@/renderer/api/teamClient';
import { useTeamAuth } from '@/renderer/hooks/context/TeamAuthContext';
import {
  BlockSuiteDocEditor,
  BlockSuiteDocViewer,
  type EditableKnowledgeDoc,
} from '@/renderer/components/knowledge/blocksuite/DocEditor';
import type { KnowledgeDoc } from './types';

const asEditableDoc = (doc: KnowledgeDoc): EditableKnowledgeDoc => ({
  id: doc.id,
  title: doc.title,
  content: doc.content ?? '',
});

const DocList: React.FC<{
  onEdit: (doc: KnowledgeDoc) => void;
  onView: (doc: KnowledgeDoc) => void;
  onNew: () => void;
  refreshKey: number;
}> = ({ onEdit, onView, onNew, refreshKey }) => {
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
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload, refreshKey]);

  const remove = useCallback(
    async (id: string) => {
      try {
        await teamApi.deleteKnowledgeDoc(id);
        await reload();
      } catch (error) {
        Message.error(`删除失败：${error instanceof TeamApiError ? error.code : '未知错误'}`);
      }
    },
    [reload]
  );

  // 与 KE-v2 App.tsx 一致：可编辑文档只列 docType === 'native'；
  // docType === 'upload'（资料库上传件）属另一套体系，只在「资料库」展示与预览。
  const nativeDocs = docs.filter((d) => d.docType === 'native');
  const filtered = nativeDocs.filter((d) => !search.trim() || d.title.toLowerCase().includes(search.toLowerCase()));
  const preview = (text?: string) => (text ?? '').replace(/[#*`~[\]()!>-]/g, '').slice(0, 120);

  return (
    <Card
      title='可编辑文档'
      extra={
        <Space>
          <Input
            size='small'
            style={{ width: 200 }}
            prefix={<IconSearch />}
            placeholder='搜索标题'
            value={search}
            onChange={setSearch}
            allowClear
          />
          <Button size='small' icon={<IconRefresh />} onClick={() => void reload()}>
            刷新
          </Button>
          <Button size='small' type='primary' icon={<IconPlus />} onClick={onNew}>
            新建文档
          </Button>
        </Space>
      }
    >
      {loading ? (
        <div style={{ textAlign: 'center', padding: 32 }}>
          <Spin />
        </div>
      ) : filtered.length === 0 ? (
        <Empty description='暂无文档，点击右上角新建' />
      ) : (
        <List
          dataSource={filtered}
          render={(doc) => (
            <List.Item
              key={doc.id}
              actions={[
                <Button key='view' size='mini' type='text' onClick={() => onView(doc)}>
                  查看
                </Button>,
                <Button key='edit' size='mini' type='text' onClick={() => onEdit(doc)}>
                  编辑
                </Button>,
                <Popconfirm key='del' title='确认删除？' onOk={() => void remove(doc.id)}>
                  <Button size='mini' type='text' status='danger'>
                    删除
                  </Button>
                </Popconfirm>,
              ]}
            >
              <List.Item.Meta
                title={<Typography.Text bold>{doc.title}</Typography.Text>}
                description={preview(doc.content)}
              />
            </List.Item>
          )}
        />
      )}
    </Card>
  );
};

export const DocsTab: React.FC = () => {
  const { view } = useTeamAuth();
  const [editing, setEditing] = useState<KnowledgeDoc | null>(null);
  const [viewing, setViewing] = useState<KnowledgeDoc | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  if (view.phase !== 'authenticated') {
    return <Empty description='请先登录团队账号' />;
  }
  const backToList = () => {
    setEditing(null);
    setViewing(null);
    setIsNew(false);
  };
  if (isNew || editing) {
    return (
      <BlockSuiteDocEditor
        doc={editing ? asEditableDoc(editing) : null}
        onSaved={() => {
          setRefreshKey((k) => k + 1);
        }}
        onBack={backToList}
      />
    );
  }
  if (viewing) {
    return <BlockSuiteDocViewer doc={asEditableDoc(viewing)} onBack={backToList} />;
  }
  return (
    <DocList
      onEdit={(d) => setEditing(d)}
      onView={(d) => setViewing(d)}
      onNew={() => setIsNew(true)}
      refreshKey={refreshKey}
    />
  );
};
