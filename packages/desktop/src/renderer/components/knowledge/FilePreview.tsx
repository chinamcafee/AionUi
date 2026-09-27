// E-23 对齐 KE-v2：资料库上传件预览（源 KE-v2 viewer/UploadFilePreview.tsx）。
// 语义与 KE 一致：多格式内嵌预览（PDF/Office/图片/文本 20+ 格式）、**只读**（「上传文档 · 只读预览」标注）、
// 可下载（经 BFF /teamapi/knowledge/files/:id 授权流）；文件类型判定表与 getFileKind/getFileExt 逐条对齐。
// 差异：UI 用 AionUI 的 Arco + @icon-park 渲染（替代 shadcn/lucide）；主题取 AionUI ThemeContext。

import React, { useCallback, useEffect, useState } from 'react';
import { Button, Modal, Spin, Typography } from '@arco-design/web-react';
import { Close, Download, FileExcel, FilePdf, FileQuestion, FileText, FileWord, Picture } from '@icon-park/react';
import { FilePreviewEmbed } from '@eternalheart/react-file-preview';
import '@eternalheart/react-file-preview/style.css';
import { teamBffBaseUrl } from '@/renderer/api/teamClient';
import { useThemeContext } from '@/renderer/hooks/context/ThemeContext';

export type KnowledgeFileKind = 'pdf' | 'docx' | 'xlsx' | 'image' | 'text' | 'unknown';

/** 与 KE-v2 getFileExt 一致：取扩展名大写；无扩展名返回 "?"。 */
export function knowledgeFileExt(file: { filename?: string; mime?: string }): string {
  const ref = file.filename ?? '';
  const ext = ref.toLowerCase().match(/\.([^.]+)$/)?.[1];
  return ext ? ext.toUpperCase() : '?';
}

/** 与 KE-v2 getFileKind 判定表一致（扩展名优先，mime 兜底）。 */
export function knowledgeFileKind(file: { filename?: string; mime?: string }): KnowledgeFileKind {
  const ext = (file.filename ?? '').toLowerCase().match(/\.([^.]+)$/)?.[1] ?? '';
  if (ext === 'pdf' || file.mime === 'application/pdf') return 'pdf';
  if (ext === 'docx' || ext === 'doc') return 'docx';
  if (ext === 'xlsx' || ext === 'xls') return 'xlsx';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'].includes(ext)) return 'image';
  if (['txt', 'md', 'markdown', 'csv', 'json', 'log', 'ts', 'js', 'py', 'go', 'rs', 'java'].includes(ext))
    return 'text';
  if (file.mime?.startsWith('image/')) return 'image';
  if (file.mime?.startsWith('text/')) return 'text';
  return 'unknown';
}

function FileKindIcon({ kind, size = 18 }: { kind: KnowledgeFileKind; size?: number }) {
  const common = { theme: 'outline', size: String(size), fill: 'currentColor' } as const;
  if (kind === 'pdf') return <FilePdf {...common} style={{ color: '#DC2626' }} />;
  if (kind === 'docx') return <FileWord {...common} style={{ color: '#2563EB' }} />;
  if (kind === 'xlsx') return <FileExcel {...common} style={{ color: '#16A34A' }} />;
  if (kind === 'image') return <Picture {...common} style={{ color: '#7C3AED' }} />;
  if (kind === 'text') return <FileText {...common} style={{ color: '#475569' }} />;
  return <FileQuestion {...common} style={{ color: '#64748B' }} />;
}

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
  const kind = knowledgeFileKind({ filename, mime });
  const ext = knowledgeFileExt({ filename });

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
    fetch(`${base}/teamapi/knowledge/files/${docId}`, { cache: 'no-store' })
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

  const download = useCallback(() => {
    if (!file) return;
    const objectURL = URL.createObjectURL(file);
    const anchor = document.createElement('a');
    anchor.href = objectURL;
    anchor.download = filename || 'document';
    anchor.click();
    queueMicrotask(() => URL.revokeObjectURL(objectURL));
  }, [file, filename]);

  if (!open) return null;

  return (
    <Modal
      visible={open}
      footer={null}
      onCancel={onClose}
      style={{ width: '86vw', top: 24 }}
      mountOnEnter
      unmountOnExit
    >
      {/* 顶栏（对齐 KE-v2 UploadFilePreview：类型图标 + 标题 + 扩展名/只读标注 + 下载） */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '12px 16px',
          borderBottom: '1px solid var(--color-border-2)',
        }}
      >
        <FileKindIcon kind={kind} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <Typography.Text bold ellipsis={{ showTooltip: true }} style={{ display: 'block' }}>
            {filename}
          </Typography.Text>
          <Typography.Text type='secondary' style={{ fontSize: 12 }}>
            {ext} · 上传文档 · 只读预览
          </Typography.Text>
        </div>
        <Button size='small' icon={<Download />} disabled={!file || loading} onClick={download}>
          下载
        </Button>
        <Button size='small' type='text' icon={<Close />} onClick={onClose} aria-label='关闭预览' />
      </div>

      <div style={{ minHeight: 320, maxHeight: 'calc(90vh - 120px)', overflow: 'auto' }}>
        {loading ? (
          <div style={{ textAlign: 'center', padding: 48 }}>
            <Spin tip='加载文件中…' />
          </div>
        ) : error || !file ? (
          <div style={{ textAlign: 'center', padding: 48 }}>
            <FileKindIcon kind='unknown' size={44} />
            <Typography.Paragraph style={{ marginTop: 16, fontWeight: 600 }}>
              加载失败：{error ?? '未知错误'}
            </Typography.Paragraph>
          </div>
        ) : (
          <FilePreviewEmbed
            files={[file]}
            currentIndex={0}
            theme={theme === 'dark' ? 'dark' : 'light'}
            locale='zh-CN'
            style={{ width: '100%', height: 'calc(90vh - 168px)' }}
          />
        )}
      </div>
    </Modal>
  );
};
