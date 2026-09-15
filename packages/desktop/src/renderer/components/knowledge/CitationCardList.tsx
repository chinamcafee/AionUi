// AionUi 新增（T5.5）：知识引用卡片列表。消费 knowledge.synthesize 输出的结构化 citations
//（T4.8 parse），点击预览原文档（T4.6 下载 grant 代理）。工具调用结果 → 消息侧引用区的渲染件。

import React, { useEffect, useState } from 'react';
import { Collapse, Spin, Tag, Typography } from '@arco-design/web-react';
import { KnowledgeFilePreview } from './FilePreview';
import {
  mergeKnowledgeCitations, parseKnowledgeCitations, type KnowledgeCitation,
} from '@/renderer/services/knowledge/citations';

export const KnowledgeCitationCardList: React.FC<{
  /** 工具原始输出（JSON 串/对象/{text}/{content[]} 任一形态，见 citations.unwrap） */
  output: unknown;
}> = ({ output }) => {
  const [citations, setCitations] = useState<KnowledgeCitation[]>([]);
  const [preview, setPreview] = useState<KnowledgeCitation | null>(null);

  useEffect(() => {
    const incoming = parseKnowledgeCitations(output);
    setCitations((current) => mergeKnowledgeCitations(current, incoming));
  }, [output]);

  if (citations.length === 0) return null;

  return (
    <>
      <Collapse bordered={false} style={{ marginTop: 8 }}>
        <Collapse.Item
          name='citations'
          header={(
            <Typography.Text size='small' type='secondary'>
              知识引用（{citations.length}）
            </Typography.Text>
          )}
        >
          {citations.map((citation) => (
            <div key={citation.docId} style={{ marginBottom: 6, cursor: 'pointer' }} onClick={() => setPreview(citation)}>
              <Tag color='arcoblue' size='small'>{citation.title ?? citation.docId.slice(0, 8)}</Tag>
              {citation.quote && (
                <Typography.Text type='secondary' size='small' style={{ marginLeft: 8 }}>
                  “{citation.quote.length > 120 ? `${citation.quote.slice(0, 120)}…` : citation.quote}”
                </Typography.Text>
              )}
            </div>
          ))}
          {!preview && <Spin hidden />}
        </Collapse.Item>
      </Collapse>
      {preview && (
        <KnowledgeFilePreview
          docId={preview.docId}
          filename={preview.title ?? preview.docId}
          mime={preview.mime}
          open
          onClose={() => setPreview(null)}
        />
      )}
    </>
  );
};
