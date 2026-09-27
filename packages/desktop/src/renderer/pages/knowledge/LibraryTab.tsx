// E-23 K7：资料库 Tab——上传（拖拽+可见性+密级）+ 文档列表（状态/权限/预览/删除/可见性切换）。
// 替代旧 KnowledgePage 的简单列表；API 全走 BFF 网关。
// 上传交互对齐 KE-v2 Web #uploads（UploadLibrary.tsx）：原生 dropzone（dragover 高亮/点击选择）、
// 终止上传（abort + 清理临时文档）、错误码友好文案、上传/摄入完成后刷新列表、行内任务重试/终止。

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Button,
  Card,
  Empty,
  List,
  Message,
  Popconfirm,
  Progress,
  Radio,
  Select,
  Space,
  Spin,
  Tag,
  Typography,
} from '@arco-design/web-react';
import { IconRefresh } from '@arco-design/web-react/icon';
import { teamApi, TeamApiError, teamBffBaseUrl } from '@/renderer/api/teamClient';
import { useTeamAuth } from '@/renderer/hooks/context/TeamAuthContext';
import { uploadKnowledgeFile, KnowledgeUploadError } from '@/renderer/services/knowledge/upload';
import { useUploadProgress } from '@/renderer/hooks/knowledge/useUploadProgress';
import { KnowledgeFilePreview } from '@/renderer/components/knowledge/FilePreview';
import type { TeamKnowledgeDocument } from './types';

// 与 KE-v2 UploadLibrary 一致：normal 普通 / internal 内部 / confidential 机密 / restricted 受限
const CLASSIFICATIONS = [
  { value: 'normal', label: '普通' },
  { value: 'internal', label: '内部' },
  { value: 'confidential', label: '机密' },
  { value: 'restricted', label: '受限（仅受控流）' },
];

const ACCEPT_EXTENSIONS = '.pdf,.doc,.docx,.xls,.xlsx,.pptx,.txt,.md,.markdown,.csv,.json,.png,.jpg,.jpeg,.gif,.webp';

const STATUS_LABEL: Record<string, { text: string; color: string }> = {
  ready: { text: '就绪', color: 'green' },
  pending: { text: '处理中', color: 'arcoblue' },
  failed: { text: '失败', color: 'red' },
  deleted: { text: '已删除', color: 'gray' },
  queued: { text: '排队中', color: 'orange' },
  running: { text: '摄入中', color: 'arcoblue' },
  completed: { text: '已完成', color: 'green' },
  retry_wait: { text: '等待重试', color: 'orange' },
};

// 与 KE-v2 UploadLibrary 一致的错误码文案
const uploadErrorMessage = (error: unknown): string => {
  if ((error as Error)?.name === 'AbortError') return '上传已终止，已清理临时对象和解析数据。';
  const code = error instanceof KnowledgeUploadError ? error.code : 'UPLOAD_FAILED';
  if (code === 'MIME_UNSUPPORTED') return '暂不支持该文件类型';
  if (code === 'PAYLOAD_TOO_LARGE') return '文件不能为空且不能超过 100 MiB';
  if (code === 'OBJECT_QUARANTINED') return '文件未通过安全扫描，已隔离';
  return `文件上传失败，请稍后重试（${code}）`;
};

export const LibraryTab: React.FC = () => {
  const { view, hasPermission } = useTeamAuth();
  const [docs, setDocs] = useState<TeamKnowledgeDocument[]>([]);
  const [loading, setLoading] = useState(false);
  const [visibility, setVisibility] = useState<'personal' | 'team'>('personal');
  const [classification, setClassification] = useState('normal');
  const [uploading, setUploading] = useState(false);
  const [activeFilename, setActiveFilename] = useState('');
  const [uploadError, setUploadError] = useState('');
  const [dragover, setDragover] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [previewDoc, setPreviewDoc] = useState<{ id: string; filename: string; mime?: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const uploadAbortRef = useRef<AbortController | null>(null);
  const activeDocumentIdRef = useRef('');
  const { status, percent, stage, doneStats, errorMsg } = useUploadProgress(jobId ?? null);
  const canPublish = hasPermission('knowledge.publish_team');

  const reload = useCallback(async () => {
    const base = teamBffBaseUrl();
    if (!base) return;
    setLoading(true);
    try {
      const response = await fetch(`${base}/teamapi/knowledge/documents`, { cache: 'no-store' });
      const payload = (await response.json().catch(() => ({}))) as { data?: unknown; error?: { code?: string } };
      if (!response.ok) throw new Error(payload.error?.code ?? `HTTP_${response.status}`);
      const data = payload.data;
      setDocs(Array.isArray(data) ? (data as TeamKnowledgeDocument[]) : []);
    } catch (error) {
      Message.error(`加载失败：${error instanceof Error ? error.message : '未知错误'}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // 摄入任务结束后刷新列表，让新文档/最新状态出现在列表中（对齐 KE-v2 的 onUploadComplete + onRefresh）
  useEffect(() => {
    if (jobId && (status === 'done' || status === 'failed' || status === 'cancelled')) {
      void reload();
    }
  }, [jobId, status, reload]);

  const deleteDocument = useCallback(async (id: string) => {
    const base = teamBffBaseUrl();
    if (!base) throw new Error('TEAM_BFF_UNAVAILABLE');
    const response = await fetch(`${base}/teamapi/knowledge/documents/${id}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idempotencyKey: crypto.randomUUID() }),
    });
    if (!response.ok) throw new Error('DELETE_FAILED');
  }, []);

  const uploadFile = useCallback(
    async (file: File) => {
      if (uploading) return;
      const controller = new AbortController();
      uploadAbortRef.current = controller;
      activeDocumentIdRef.current = '';
      setActiveFilename(file.name);
      setUploading(true);
      setUploadError('');
      setJobId(null);
      try {
        const completed = await uploadKnowledgeFile(file, {
          visibility,
          classification: classification as never,
          signal: controller.signal,
          onSessionCreated: (session) => {
            activeDocumentIdRef.current = session.documentId;
          },
        });
        setJobId(completed.ingestionJobId);
        void reload();
      } catch (error) {
        setUploadError(uploadErrorMessage(error));
        // 终止上传时清理已创建的临时文档（对齐 KE-v2 cancel-upload 行为）
        if ((error as Error)?.name === 'AbortError' && activeDocumentIdRef.current) {
          await deleteDocument(activeDocumentIdRef.current).catch(() => {});
        }
      } finally {
        if (uploadAbortRef.current === controller) uploadAbortRef.current = null;
        activeDocumentIdRef.current = '';
        setUploading(false);
      }
    },
    [uploading, visibility, classification, reload, deleteDocument]
  );

  const cancelUpload = useCallback(() => {
    uploadAbortRef.current?.abort();
  }, []);

  const runJobAction = useCallback(
    async (doc: TeamKnowledgeDocument, action: 'retry' | 'cancel') => {
      if (!doc.jobId) return;
      const base = teamBffBaseUrl();
      if (!base) return;
      try {
        const response = await fetch(`${base}/teamapi/knowledge/jobs/${doc.jobId}/${action}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        });
        if (!response.ok) throw new Error('JOB_ACTION_FAILED');
        Message.success(action === 'retry' ? '已重新排队摄入任务' : '已终止摄入任务');
        await reload();
      } catch {
        Message.error(
          action === 'retry' ? '任务重试失败，任务状态可能已变化，请刷新后重试' : '任务终止失败，请刷新后重试'
        );
      }
    },
    [reload]
  );

  const toggleVisibility = useCallback(
    async (doc: TeamKnowledgeDocument) => {
      const next = doc.visibility === 'team' ? 'personal' : 'team';
      try {
        await teamApi.patchDocumentVisibility(doc.id, next, doc.version);
        Message.success(`已切换为${next === 'team' ? '团队共享' : '个人'}`);
        await reload();
      } catch (error) {
        Message.error(`切换失败：${error instanceof TeamApiError ? error.code : '未知错误'}`);
      }
    },
    [reload]
  );

  const remove = useCallback(
    async (id: string) => {
      try {
        await deleteDocument(id);
        Message.success('已删除');
        await reload();
      } catch {
        Message.error('删除失败');
      }
    },
    [reload, deleteDocument]
  );

  if (view.phase !== 'authenticated') return <Empty description='请先登录团队账号' />;

  const personal = docs.filter((d) => d.visibility === 'personal');
  const team = docs.filter((d) => d.visibility === 'team');
  const displayDocs = visibility === 'personal' ? personal : team;

  return (
    <Space direction='vertical' size='large' style={{ width: '100%' }}>
      <Card
        title='上传文档'
        extra={
          <Space>
            <Radio.Group
              type='button'
              size='small'
              value={visibility}
              onChange={(v) => setVisibility(v as 'personal' | 'team')}
              options={[
                { label: '个人', value: 'personal' },
                { label: '团队共享', value: 'team', disabled: !canPublish },
              ]}
            />
            <Select
              size='small'
              style={{ width: 140 }}
              value={classification}
              options={CLASSIFICATIONS}
              onChange={setClassification}
            />
          </Space>
        }
      >
        {/* 原生 dropzone，交互对齐 KE-v2 UploadLibrary（Arco Upload 在此场景下因 disabled 状态无法响应） */}
        <div
          role='button'
          tabIndex={uploading ? -1 : 0}
          aria-label={uploading ? `正在上传 ${activeFilename}` : '选择或拖入要上传的知识文件'}
          onDragOver={(event) => {
            event.preventDefault();
            if (!uploading) setDragover(true);
          }}
          onDragLeave={() => setDragover(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragover(false);
            const file = event.dataTransfer.files[0];
            if (file && !uploading) void uploadFile(file);
          }}
          onClick={() => {
            if (!uploading) fileRef.current?.click();
          }}
          onKeyDown={(event) => {
            if (!uploading && (event.key === 'Enter' || event.key === ' ')) {
              event.preventDefault();
              fileRef.current?.click();
            }
          }}
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
            padding: '32px 16px',
            border: `1px dashed ${dragover ? 'rgb(var(--primary-6))' : 'var(--color-border-2)'}`,
            borderRadius: 8,
            background: dragover ? 'rgba(var(--primary-6), 0.06)' : 'var(--color-fill-1)',
            cursor: uploading ? 'default' : 'pointer',
            transition: 'border-color 0.15s, background 0.15s',
          }}
        >
          {uploading ? (
            <>
              <Typography.Text bold>{activeFilename}</Typography.Text>
              <Typography.Text type='secondary' size='small'>
                正在计算校验、上传或等待服务端完成…
              </Typography.Text>
              <Popconfirm title='终止当前上传？已上传的临时对象和解析数据会被清理。' onOk={cancelUpload}>
                <Button size='mini' status='danger' onClick={(event) => event.stopPropagation()}>
                  终止上传
                </Button>
              </Popconfirm>
            </>
          ) : (
            <>
              <Typography.Text bold>拖拽文件到这里，或点击选择</Typography.Text>
              <Typography.Text type='secondary' size='small'>
                支持文档、表格、图片等格式 · 最大 100 MiB
              </Typography.Text>
            </>
          )}
          <input
            ref={fileRef}
            type='file'
            style={{ display: 'none' }}
            accept={ACCEPT_EXTENSIONS}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void uploadFile(file);
              event.target.value = '';
            }}
          />
        </div>
        {uploadError && (
          <Typography.Text type='error' size='small' style={{ display: 'block', marginTop: 8 }}>
            {uploadError}
          </Typography.Text>
        )}
        {jobId && status !== 'done' && (
          <div style={{ marginTop: 8 }}>
            <Typography.Text size='small'>摄入进度：{stage}</Typography.Text>
            <Progress percent={percent} size='small' status={status === 'failed' ? 'error' : 'normal'} />
            {errorMsg && (
              <Typography.Text type='error' size='small'>
                {errorMsg}
              </Typography.Text>
            )}
          </div>
        )}
        {jobId && status === 'done' && doneStats && (
          <Typography.Text type='success' size='small' style={{ display: 'block', marginTop: 8 }}>
            完成：
            {Object.entries(doneStats)
              .map(([k, v]) => `${k}=${String(v)}`)
              .join(' · ')}
          </Typography.Text>
        )}
      </Card>

      <Card
        title={visibility === 'personal' ? '个人文档' : '团队文档'}
        extra={
          <Button size='small' icon={<IconRefresh />} onClick={() => void reload()}>
            刷新
          </Button>
        }
      >
        {loading ? (
          <div style={{ textAlign: 'center', padding: 32 }}>
            <Spin />
          </div>
        ) : displayDocs.length === 0 ? (
          <Empty description='暂无文档' />
        ) : (
          <List
            dataSource={displayDocs}
            render={(doc) => {
              const statusMeta = STATUS_LABEL[doc.status ?? doc.jobStatus ?? ''] ?? {
                text: doc.status ?? doc.jobStatus ?? '—',
                color: 'gray',
              };
              const jobActive = doc.jobStatus && ['queued', 'running', 'retry_wait'].includes(doc.jobStatus);
              const jobFailed = doc.jobStatus === 'failed';
              return (
                <List.Item
                  key={doc.id}
                  actions={[
                    <Button
                      key='preview'
                      size='mini'
                      type='text'
                      onClick={() =>
                        setPreviewDoc({ id: doc.id, filename: doc.filename ?? doc.title ?? doc.id, mime: doc.mime })
                      }
                    >
                      预览
                    </Button>,
                    canPublish && (
                      <Button key='vis' size='mini' type='text' onClick={() => void toggleVisibility(doc)}>
                        {doc.visibility === 'team' ? '转为个人' : '共享到团队'}
                      </Button>
                    ),
                    // 任务级操作（对齐 KE-v2 行内 重试/终止）
                    jobFailed && doc.jobId && (
                      <Button key='retry' size='mini' type='text' onClick={() => void runJobAction(doc, 'retry')}>
                        重试
                      </Button>
                    ),
                    jobActive && doc.jobId && (
                      <Popconfirm
                        key='cancel-job'
                        title='终止解析任务？已产生的解析与图谱数据会被清理。'
                        onOk={() => void runJobAction(doc, 'cancel')}
                      >
                        <Button size='mini' type='text' status='danger'>
                          终止
                        </Button>
                      </Popconfirm>
                    ),
                    <Popconfirm key='del' title='确认删除？' onOk={() => void remove(doc.id)}>
                      <Button size='mini' type='text' status='danger'>
                        删除
                      </Button>
                    </Popconfirm>,
                  ].filter(Boolean)}
                >
                  <List.Item.Meta
                    title={
                      <Space size={6} wrap>
                        <Typography.Text bold>{doc.filename ?? doc.title ?? doc.id}</Typography.Text>
                        <Tag size='small' color={statusMeta.color}>
                          {statusMeta.text}
                        </Tag>
                        {doc.classification && doc.classification !== 'normal' && (
                          <Tag size='small' color='orange'>
                            {CLASSIFICATIONS.find((c) => c.value === doc.classification)?.label ?? doc.classification}
                          </Tag>
                        )}
                        {doc.visibilityStatus && doc.visibilityStatus !== doc.visibility && (
                          <Tag size='small' color='arcoblue'>
                            过渡中
                          </Tag>
                        )}
                      </Space>
                    }
                    description={`${doc.owner ?? ''} · ${doc.updatedAt ?? ''}${doc.jobFailureCode ? ` · 失败: ${doc.jobFailureCode}` : ''}`}
                  />
                </List.Item>
              );
            }}
          />
        )}
      </Card>

      {previewDoc && (
        <KnowledgeFilePreview
          docId={previewDoc.id}
          filename={previewDoc.filename}
          mime={previewDoc.mime}
          open
          onClose={() => setPreviewDoc(null)}
        />
      )}
    </Space>
  );
};
