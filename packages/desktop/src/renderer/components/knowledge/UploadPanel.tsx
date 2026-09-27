// AionUi 移植（T4.4）：知识库上传抽屉（源 client components/knowledge/KnowledgeUploadPanel.tsx）。
// 交互对齐上游：拖拽/选择文件 → 上传（presign 直传）→ 摄入进度（实体/关系/社区 doneStats）→
// 失败重试（jobId:retry）/终止确认（jobId:cancel）；可见性 personal/team 与密级选择。

import React, { useCallback, useRef, useState } from 'react';
import {
  Button,
  Drawer,
  Message,
  Popconfirm,
  Progress,
  Radio,
  Select,
  Space,
  Typography,
  Upload,
} from '@arco-design/web-react';
import { IconDelete, IconRefresh } from '@arco-design/web-react/icon';
import {
  KnowledgeUploadError,
  uploadKnowledgeFile,
  type CompletedKnowledgeUpload,
  type KnowledgeClassification,
  type KnowledgeVisibility,
} from '@/renderer/services/knowledge/upload';
import { useUploadProgress } from '@/renderer/hooks/knowledge/useUploadProgress';
import { teamBffBaseUrl } from '@/renderer/api/teamClient';

const CLASSIFICATIONS: { value: KnowledgeClassification; label: string }[] = [
  { value: 'normal', label: '普通' },
  { value: 'internal', label: '内部' },
  { value: 'confidential', label: '秘密' },
  { value: 'restricted', label: '机密' },
];

export const KnowledgeUploadPanel: React.FC<{
  visible: boolean;
  onClose: () => void;
}> = ({ visible, onClose }) => {
  const [visibility, setVisibility] = useState<KnowledgeVisibility>('personal');
  const [classification, setClassification] = useState<KnowledgeClassification>('normal');
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [job, setJob] = useState<CompletedKnowledgeUpload | null>(null);
  const [pollGeneration, setPollGeneration] = useState(0);
  const cancelRef = useRef<AbortController | null>(null);
  const { progress, status, doneStats, errorMsg, percent, stage } = useUploadProgress(
    job?.ingestionJobId ?? null,
    pollGeneration
  );

  const handleFiles = useCallback(
    async (files: File[]) => {
      const file = files[0];
      if (!file) return;
      setUploading(true);
      setUploadError(null);
      setJob(null);
      cancelRef.current = new AbortController();
      try {
        const completed = await uploadKnowledgeFile(file, {
          visibility,
          classification,
          signal: cancelRef.current.signal,
        });
        setJob(completed);
        setPollGeneration((g) => g + 1);
      } catch (error) {
        if ((error as Error)?.name === 'AbortError') {
          setUploadError('已取消上传');
        } else {
          setUploadError(error instanceof KnowledgeUploadError ? error.code : String(error));
        }
      } finally {
        setUploading(false);
      }
    },
    [visibility, classification]
  );

  const retryJob = useCallback(async () => {
    if (!job) return;
    const base = teamBffBaseUrl();
    if (!base) return;
    await fetch(`${base}/teamapi/knowledge/jobs/${job.ingestionJobId}/retry`, { method: 'POST' });
    setPollGeneration((g) => g + 1);
  }, [job]);

  const cancelJob = useCallback(async () => {
    if (!job) return;
    const base = teamBffBaseUrl();
    if (!base) return;
    await fetch(`${base}/teamapi/knowledge/jobs/${job.ingestionJobId}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
  }, [job]);

  return (
    <Drawer title='上传到知识库' visible={visible} onCancel={onClose} width={420} footer={null}>
      <Space direction='vertical' size='large' style={{ width: '100%' }}>
        <div>
          <Typography.Text type='secondary' size='small'>
            可见范围
          </Typography.Text>
          <div>
            <Radio.Group
              type='button'
              value={visibility}
              onChange={(v) => setVisibility(v as KnowledgeVisibility)}
              options={[
                { label: '个人知识库', value: 'personal' },
                { label: '团队知识库（共享）', value: 'team' },
              ]}
            />
          </div>
        </div>
        <div>
          <Typography.Text type='secondary' size='small'>
            密级
          </Typography.Text>
          <div>
            <Select
              size='small'
              style={{ width: 160 }}
              value={classification}
              options={CLASSIFICATIONS}
              onChange={(v) => setClassification(v)}
            />
          </div>
        </div>

        <Upload
          drag
          multiple={false}
          limit={1}
          autoUpload={false}
          showFileList={false}
          disabled={uploading || status === 'building'}
          onChange={(_, files) => {
            void handleFiles(files.map((f) => f.originFile as File).filter(Boolean));
          }}
          customRequest={() => Promise.resolve()}
        />

        {uploading && <Typography.Text type='secondary'>上传中（签名 URL 直传对象存储）…</Typography.Text>}
        {uploadError && <Typography.Text type='error'>上传失败：{uploadError}</Typography.Text>}

        {job && (
          <div>
            <Typography.Text bold>摄入任务 {stage}</Typography.Text>
            <Progress
              percent={percent}
              status={status === 'failed' ? 'error' : status === 'done' ? 'success' : 'normal'}
            />
            <div style={{ maxHeight: 160, overflow: 'auto', fontSize: 12, color: 'var(--color-text-3)' }}>
              {progress.map((entry, index) => (
                <div key={index}>
                  [{entry.stage ?? ''}] {entry.detail ?? ''} {entry.outcome === 'failed' ? '（失败）' : ''}
                </div>
              ))}
            </div>
            {status === 'failed' && (
              <Space style={{ marginTop: 8 }}>
                <Typography.Text type='error'>{errorMsg}</Typography.Text>
                <Button size='mini' icon={<IconRefresh />} onClick={() => void retryJob()}>
                  重试
                </Button>
              </Space>
            )}
            {status === 'building' && (
              <Popconfirm title='确认终止摄入任务？' onOk={() => void cancelJob()}>
                <Button size='mini' status='danger' icon={<IconDelete />}>
                  终止
                </Button>
              </Popconfirm>
            )}
            {status === 'done' && doneStats && (
              <Typography.Text type='success' size='small'>
                完成：
                {Object.entries(doneStats)
                  .map(([key, value]) => `${key}=${String(value)}`)
                  .join(' · ')}
              </Typography.Text>
            )}
          </div>
        )}
      </Space>
    </Drawer>
  );
};
