// AionUi 移植（T4.6）：统一文件预览（源 client components/knowledge/FilePreview.tsx）。
// 差异：下载走 BFF /teamapi/knowledge/files/:id（grant 代理）；主题取 AionUi ThemeContext；
// pdfjs worker 配置与初始缩放属 client 私有增强，不移植（react-file-preview 自带默认 worker）。

import React, { useEffect, useState } from 'react';
import { Modal, Spin, Typography } from '@arco-design/web-react';
import { FilePreviewModal } from '@eternalheart/react-file-preview';
import '@eternalheart/react-file-preview/style.css';
import { teamBffBaseUrl } from '@/renderer/api/teamClient';
import { useThemeContext } from '@/renderer/hooks/context/ThemeContext';

export const KnowledgeFilePreview: React.FC<{
  docId: string;
  filename: string;
  mime?: string;
  open: boolean;
  onClose: () => void;
}> = ({ docId, filename, mime, open, onClose }) => {
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { theme } = useThemeContext();

  useEffect(() => {
    if (!open || !docId) {
      setFile(null);
      setError(null);
      return;
    }
    let cancelled = false;
    const base = teamBffBaseUrl();
    if (!base) {
      setError('TEAM_BFF_UNAVAILABLE');
      return;
    }
    setLoading(true);
    setError(null);
    fetch(`${base}/teamapi/knowledge/files/${docId}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.blob();
      })
      .then((blob) => {
        if (cancelled) return;
        setFile(new File([blob], filename, { type: mime ?? blob.type ?? 'application/octet-stream' }));
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, docId, filename, mime]);

  if (!open) return null;
  if (loading) {
    return (
      <Modal visible={open} footer={null} onCancel={onClose} title={filename}>
        <div style={{ textAlign: 'center', padding: 32 }}>
          <Spin tip='加载文件中…' />
        </div>
      </Modal>
    );
  }
  if (error || !file) {
    return (
      <Modal visible={open} footer={null} onCancel={onClose} title={filename}>
        <Typography.Text type='error'>加载失败：{error ?? '未知错误'}</Typography.Text>
      </Modal>
    );
  }

  return (
    <FilePreviewModal
      files={[file]}
      currentIndex={0}
      isOpen={open}
      onClose={onClose}
      theme={theme === 'dark' ? 'dark' : 'light'}
      locale='zh-CN'
    />
  );
};
