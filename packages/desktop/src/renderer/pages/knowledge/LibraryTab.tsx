// E-23 K7：资料库 Tab——上传（拖拽+可见性+密级）+ 文档列表（状态/权限/预览/删除/可见性切换）。
// 替代旧 KnowledgePage 的简单列表；API 全走 BFF 网关。

import React, { useCallback, useEffect, useState } from 'react';
import {
  Button, Card, Empty, List, Message, Popconfirm, Progress, Radio,
  Select, Space, Spin, Tag, Typography, Upload as ArcoUpload,
} from '@arco-design/web-react';
import { IconPlus, IconRefresh } from '@arco-design/web-react/icon';
import { teamApi, TeamApiError, teamBffBaseUrl } from '@/renderer/api/teamClient';
import { useTeamAuth } from '@/renderer/hooks/context/TeamAuthContext';
import { uploadKnowledgeFile, KnowledgeUploadError } from '@/renderer/services/knowledge/upload';
import { useUploadProgress } from '@/renderer/hooks/knowledge/useUploadProgress';
import { KnowledgeFilePreview } from '@/renderer/components/knowledge/FilePreview';
import type { TeamKnowledgeDocument } from './types';

const CLASSIFICATIONS = [
  { value: 'normal', label: '普通' }, { value: 'internal', label: '内部' },
  { value: 'confidential', label: '秘密' }, { value: 'restricted', label: '机密' },
];

const STATUS_LABEL: Record<string, { text: string; color: string }> = {
  ready: { text: '就绪', color: 'green' }, pending: { text: '处理中', color: 'arcoblue' },
  failed: { text: '失败', color: 'red' }, deleted: { text: '已删除', color: 'gray' },
  queued: { text: '排队中', color: 'orange' }, running: { text: '摄入中', color: 'arcoblue' },
  completed: { text: '已完成', color: 'green' }, retry_wait: { text: '等待重试', color: 'orange' },
};

export const LibraryTab: React.FC = () => {
  const { view, hasPermission } = useTeamAuth();
  const [docs, setDocs] = useState<TeamKnowledgeDocument[]>([]);
  const [loading, setLoading] = useState(false);
  const [visibility, setVisibility] = useState<'personal' | 'team'>('personal');
  const [classification, setClassification] = useState('normal');
  const [uploading, setUploading] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [previewDoc, setPreviewDoc] = useState<{ id: string; filename: string; mime?: string } | null>(null);
  const { status, percent, stage, doneStats, errorMsg } = useUploadProgress(jobId ?? null);
  const canPublish = hasPermission('knowledge.publish_team');

  const reload = useCallback(async () => {
    const base = teamBffBaseUrl();
    if (!base) return;
    setLoading(true);
    try {
      const response = await fetch(`${base}/teamapi/knowledge/documents`, { cache: 'no-store' });
      const payload = await response.json().catch(() => ({})) as { data?: unknown; error?: { code?: string } };
      if (!response.ok) throw new Error(payload.error?.code ?? `HTTP_${response.status}`);
      const data = payload.data;
      setDocs(Array.isArray(data) ? (data as TeamKnowledgeDocument[]) : []);
    } catch (error) {
      Message.error(`加载失败：${error instanceof Error ? error.message : '未知错误'}`);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  const handleFiles = useCallback(async (files: File[]) => {
    const file = files[0];
    if (!file) return;
    setUploading(true); setJobId(null);
    try {
      const completed = await uploadKnowledgeFile(file, { visibility, classification: classification as never });
      setJobId(completed.ingestionJobId);
    } catch (error) {
      Message.error(`上传失败：${error instanceof KnowledgeUploadError ? error.code : String(error)}`);
    } finally { setUploading(false); }
  }, [visibility, classification]);

  const toggleVisibility = useCallback(async (doc: TeamKnowledgeDocument) => {
    const next = doc.visibility === 'team' ? 'personal' : 'team';
    try {
      await teamApi.patchDocumentVisibility(doc.id, next, doc.version);
      Message.success(`已切换为${next === 'team' ? '团队共享' : '个人'}`);
      await reload();
    } catch (error) {
      Message.error(`切换失败：${error instanceof TeamApiError ? error.code : '未知错误'}`);
    }
  }, [reload]);

  const remove = useCallback(async (id: string) => {
    const base = teamBffBaseUrl();
    if (!base) return;
    try {
      const response = await fetch(`${base}/teamapi/knowledge/documents/${id}`, {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idempotencyKey: crypto.randomUUID() }),
      });
      if (!response.ok) throw new Error('DELETE_FAILED');
      Message.success('已删除'); await reload();
    } catch { Message.error('删除失败'); }
  }, [reload]);

  if (view.phase !== 'authenticated') return <Empty description='请先登录团队账号' />;

  const personal = docs.filter((d) => d.visibility === 'personal');
  const team = docs.filter((d) => d.visibility === 'team');
  const displayDocs = visibility === 'personal' ? personal : team;

  return (
    <Space direction='vertical' size='large' style={{ width: '100%' }}>
      <Card title='上传文档' extra={(
        <Space>
          <Radio.Group type='button' size='small' value={visibility} onChange={(v) => setVisibility(v as 'personal' | 'team')}
            options={[{ label: '个人', value: 'personal' }, { label: '团队共享', value: 'team' }]} />
          <Select size='small' style={{ width: 100 }} value={classification} options={CLASSIFICATIONS} onChange={setClassification} />
        </Space>
      )}>
        <ArcoUpload drag multiple={false} limit={1} autoUpload={false} showFileList={false}
          disabled={uploading || status === 'building'}
          onChange={(_, files) => { void handleFiles(files.map((f) => f.originFile as File).filter(Boolean)); }}
          customRequest={() => Promise.resolve()} />
        {uploading && <Typography.Text type='secondary' style={{ display: 'block', marginTop: 8 }}>上传中…</Typography.Text>}
        {jobId && status !== 'done' && (
          <div style={{ marginTop: 8 }}>
            <Typography.Text size='small'>摄入进度：{stage}</Typography.Text>
            <Progress percent={percent} size='small' status={status === 'failed' ? 'error' : 'normal'} />
            {errorMsg && <Typography.Text type='error' size='small'>{errorMsg}</Typography.Text>}
          </div>
        )}
        {jobId && status === 'done' && doneStats && (
          <Typography.Text type='success' size='small' style={{ display: 'block', marginTop: 8 }}>
            完成：{Object.entries(doneStats).map(([k, v]) => `${k}=${String(v)}`).join(' · ')}
          </Typography.Text>
        )}
      </Card>

      <Card title={visibility === 'personal' ? '个人文档' : '团队文档'} extra={(
        <Button size='small' icon={<IconRefresh />} onClick={() => void reload()}>刷新</Button>
      )}>
        {loading ? <div style={{ textAlign: 'center', padding: 32 }}><Spin /></div>
          : displayDocs.length === 0 ? <Empty description='暂无文档' />
          : (
            <List dataSource={displayDocs} render={(doc) => {
              const statusMeta = STATUS_LABEL[doc.status ?? doc.jobStatus ?? ''] ?? { text: doc.status ?? doc.jobStatus ?? '—', color: 'gray' };
              return (
                <List.Item key={doc.id} actions={[
                  <Button key='preview' size='mini' type='text' onClick={() =>
                    setPreviewDoc({ id: doc.id, filename: doc.filename ?? doc.title ?? doc.id, mime: doc.mime })}>预览</Button>,
                  canPublish && (
                    <Button key='vis' size='mini' type='text' onClick={() => void toggleVisibility(doc)}>
                      {doc.visibility === 'team' ? '转为个人' : '共享到团队'}
                    </Button>),
                  <Popconfirm key='del' title='确认删除？' onOk={() => void remove(doc.id)}>
                    <Button size='mini' type='text' status='danger'>删除</Button>
                  </Popconfirm>,
                ].filter(Boolean)}>
                  <List.Item.Meta
                    title={(
                      <Space size={6} wrap>
                        <Typography.Text bold>{doc.filename ?? doc.title ?? doc.id}</Typography.Text>
                        <Tag size='small' color={statusMeta.color}>{statusMeta.text}</Tag>
                        {doc.classification && doc.classification !== 'normal' && <Tag size='small' color='orange'>{doc.classification}</Tag>}
                        {doc.visibilityStatus && doc.visibilityStatus !== doc.visibility && <Tag size='small' color='arcoblue'>过渡中</Tag>}
                      </Space>
                    )}
                    description={`${doc.owner ?? ''} · ${doc.updatedAt ?? ''}${doc.jobFailureCode ? ` · 失败: ${doc.jobFailureCode}` : ''}`}
                  />
                </List.Item>
              );
            }} />
          )}
      </Card>

      {previewDoc && (
        <KnowledgeFilePreview
          docId={previewDoc.id} filename={previewDoc.filename} mime={previewDoc.mime}
          open onClose={() => setPreviewDoc(null)} />
      )}
    </Space>
  );
};
