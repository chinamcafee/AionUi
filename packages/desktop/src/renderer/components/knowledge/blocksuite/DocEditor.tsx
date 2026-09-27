// E-23 对齐 KE-v2：可编辑文档的 BlockSuite 编辑器（源 KE-v2 editor/DocEditor.tsx）。
// React ↔ Lit 隔离：host div 由 React 创建空壳，内部 children 完全由原生 DOM API 管理
// （appendChild/removeChild），避免 React diff 对 Lit 节点报错；卸载时同样用原生 API 移除。
// 差异：UI 用 AionUI 的 Arco + @icon-park；保存走 teamApi.saveKnowledgeDoc（BFF → team-server web-op documents.save）。

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Input, Message, Modal, Spin } from '@arco-design/web-react';
import { Left, Save } from '@icon-park/react';
import { teamApi, TeamApiError } from '@/renderer/api/teamClient';
import { bootstrapBlockSuite } from './bs-bootstrap';
import { docToMarkdown, markdownToBlocks } from './export';

export interface EditableKnowledgeDoc {
  id: string;
  title: string;
  content: string;
}

const seedDocFromMarkdown = (
  bsDoc: unknown,
  markdown: string,
  TextCtor: new (input: string | { insert: string; attributes?: Record<string, unknown> }[]) => unknown
): void => {
  const doc = bsDoc as {
    root: { children: { flavour: string; id: string }[] } | null;
    addBlock: (flavour: string, props?: Record<string, unknown>, parent?: string) => string;
    getBlocksByFlavour: (flavour: string | string[]) => { flavour: string; id: string }[];
  };
  if (!doc?.addBlock) return;
  const note =
    doc.getBlocksByFlavour?.('affine:note')?.[0] ?? doc.root?.children?.find((c) => c.flavour === 'affine:note');
  const parentId = note?.id;
  for (const block of markdownToBlocks(markdown)) {
    const props: Record<string, unknown> = {};
    if (block.flavour === 'affine:paragraph' || block.flavour === 'affine:list') {
      props.type = block.type ?? 'text';
      props.text = block.deltas.length > 0 ? new TextCtor(block.deltas) : new TextCtor('');
    }
    doc.addBlock(block.flavour, props, parentId);
  }
};

/** 挂载一个 BlockSuite 容器到 host div；readonly=true 时禁用一切编辑输入。 */
function useBlockSuiteHost(
  hostRef: React.RefObject<HTMLDivElement>,
  doc: EditableKnowledgeDoc | null,
  readonly: boolean
) {
  const bsDocRef = useRef<unknown>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reloadKey = doc ? `${doc.id}:${doc.content.length}` : 'new';

  useEffect(() => {
    let editorEl: HTMLElement | null = null;
    let disposed = false;
    setReady(false);
    setError(null);

    (async () => {
      try {
        const presets = await import('@blocksuite/presets');
        const { Text } = await import('@blocksuite/store');

        const { doc: bsDoc, init } = presets.createEmptyDoc();
        init();
        await new Promise((resolve) => setTimeout(resolve, 0));

        if (doc?.content || doc?.title) {
          try {
            if (doc.title && bsDoc.root) {
              (bsDoc.root as unknown as { title: unknown }).title = new Text(doc.title);
            }
            if (doc.content) seedDocFromMarkdown(bsDoc, doc.content, Text);
          } catch (seedError) {
            console.warn('[BlockSuiteDocEditor] 灌入内容失败：', seedError);
          }
        }

        if (disposed || !hostRef.current) return;
        await bootstrapBlockSuite();

        editorEl = document.createElement('affine-editor-container');
        const container = editorEl as unknown as { doc: unknown; mode: string; autofocus: boolean };
        container.doc = bsDoc;
        container.mode = 'page';
        container.autofocus = !readonly;
        hostRef.current.appendChild(editorEl);
        bsDocRef.current = bsDoc;

        if (readonly) {
          // 只读：禁用所有 contenteditable + 拦截输入（与 KE-v2 DocViewer 同款）
          requestAnimationFrame(() => {
            if (!editorEl) return;
            editorEl.querySelectorAll('[contenteditable="true"]').forEach((el) => {
              el.setAttribute('contenteditable', 'false');
            });
            editorEl.addEventListener('input', (e) => e.preventDefault(), { capture: true });
            editorEl.addEventListener('beforeinput', (e) => e.preventDefault(), { capture: true });
          });
        }
        setReady(true);
      } catch (initError) {
        console.error('[BlockSuiteDocEditor] 初始化失败：', initError);
        if (!disposed) setError(String(initError));
      }
    })();

    return () => {
      disposed = true;
      try {
        (bsDocRef.current as { dispose?: () => void } | null)?.dispose?.();
      } catch {
        /* ignore */
      }
      if (editorEl?.parentNode) editorEl.parentNode.removeChild(editorEl);
      editorEl = null;
      bsDocRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadKey, readonly]);

  return { bsDocRef, ready, error };
}

const HOST_STYLE: React.CSSProperties = {
  minHeight: 420,
  border: '1px solid var(--color-border-2)',
  borderRadius: 8,
  padding: '8px 12px',
  overflow: 'auto',
};

export const BlockSuiteDocEditor: React.FC<{
  doc: EditableKnowledgeDoc | null;
  onSaved: () => void;
  onBack: () => void;
}> = ({ doc, onSaved, onBack }) => {
  const hostRef = useRef<HTMLDivElement>(null);
  const [title, setTitle] = useState('');
  const [fallbackContent, setFallbackContent] = useState('');
  const [saving, setSaving] = useState(false);
  const { bsDocRef, ready, error } = useBlockSuiteHost(hostRef, doc, false);

  useEffect(() => {
    setTitle(doc?.title ?? '');
    setFallbackContent(doc?.content ?? '');
  }, [doc]);

  const save = useCallback(async () => {
    if (!title.trim()) {
      Message.warning('请输入标题');
      return;
    }
    setSaving(true);
    try {
      let content = fallbackContent;
      if (bsDocRef.current) {
        const exported = docToMarkdown(bsDocRef.current);
        if (exported.trim()) content = exported;
      }
      const result = await teamApi.saveKnowledgeDoc({
        id: doc?.id ?? `native-${Date.now()}`,
        title: title.trim(),
        content,
      });
      Message.success(`已保存（${result?.isNew ? '新建' : '更新'}），知识抽取将在后台进行`);
      onSaved();
      onBack();
    } catch (saveError) {
      Message.error(`保存失败：${saveError instanceof TeamApiError ? saveError.code : '未知错误'}`);
    } finally {
      setSaving(false);
    }
  }, [bsDocRef, doc, fallbackContent, onBack, onSaved, title]);

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <Button size='small' type='text' icon={<Left />} onClick={onBack} aria-label='返回文档列表' />
        <Input placeholder='文档标题' value={title} onChange={setTitle} style={{ flex: 1 }} />
        <Button
          type='primary'
          size='small'
          icon={saving ? undefined : <Save />}
          loading={saving}
          onClick={() => void save()}
        >
          {saving ? '保存中…' : doc ? '更新' : '创建'}
        </Button>
      </div>
      {error ? (
        <Input.TextArea
          placeholder='输入文档内容…（编辑器加载失败，使用纯文本模式）'
          value={fallbackContent}
          onChange={setFallbackContent}
          autoSize={{ minRows: 16, maxRows: 40 }}
          style={{ fontFamily: 'monospace', fontSize: 13 }}
        />
      ) : (
        <div ref={hostRef} style={HOST_STYLE}>
          {!ready && (
            <div style={{ textAlign: 'center', padding: 32 }}>
              <Spin tip='正在加载编辑器…' />
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export const BlockSuiteDocViewer: React.FC<{ doc: EditableKnowledgeDoc; onBack: () => void }> = ({ doc, onBack }) => {
  const hostRef = useRef<HTMLDivElement>(null);
  const { ready, error } = useBlockSuiteHost(hostRef, doc, true);

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <Button size='small' type='text' icon={<Left />} onClick={onBack} aria-label='返回文档列表' />
        <span style={{ flex: 1, fontWeight: 600 }}>{doc.title}</span>
        <span style={{ fontSize: 12, color: 'var(--color-text-3)' }}>只读</span>
      </div>
      {error ? (
        <div style={{ ...HOST_STYLE, whiteSpace: 'pre-wrap' }}>{doc.content || '（空文档）'}</div>
      ) : (
        <div ref={hostRef} style={HOST_STYLE}>
          {!ready && (
            <div style={{ textAlign: 'center', padding: 32 }}>
              <Spin tip='正在加载…' />
            </div>
          )}
        </div>
      )}
    </div>
  );
};
