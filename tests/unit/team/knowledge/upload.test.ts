// T4.9：知识库 renderer 侧纯逻辑单测（MIME 解析、citations 解析/清洗/合并）。

import { describe, expect, it } from 'vitest';
import { resolveKnowledgeMIME } from '@/renderer/services/knowledge/upload';
import {
  mergeKnowledgeCitations, parseKnowledgeCitations, stripKnowledgeCitationMarkers,
} from '@/renderer/services/knowledge/citations';

describe('resolveKnowledgeMIME（移植自 client knowledge-upload）', () => {
  it('声明类型在白名单内优先返回', () => {
    expect(resolveKnowledgeMIME({ name: 'a.pdf', type: 'application/pdf' })).toBe('application/pdf');
    expect(resolveKnowledgeMIME({ name: 'b', type: 'application/vnd.open-ms-excel-x' })).toBe('');
  });

  it('声明缺失/未知时按扩展名回退，未知扩展返回空串', () => {
    expect(resolveKnowledgeMIME({ name: '报告.docx', type: '' })).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(resolveKnowledgeMIME({ name: '笔记.md', type: '' })).toBe('text/markdown');
    expect(resolveKnowledgeMIME({ name: '工具.ts', type: '' })).toBe('text/plain');
    expect(resolveKnowledgeMIME({ name: 'virus.exe', type: '' })).toBe('');
  });
});

describe('parseKnowledgeCitations / merge / strip（citations.ts 零改动复制）', () => {
  const docId = '018f0000-0000-7000-8000-0000000000aa';

  it('解析 JSON（裸串/text 包装/content 包装）中的结构化引用并去重', () => {
    const payload = { citations: [
      { documentId: docId, quote: '要点一', filename: '产品手册.pdf' },
      { documentId: docId.toUpperCase(), quote: '重复文档' },
      { documentId: 'not-a-uuid' },
      'garbage',
    ] };
    expect(parseKnowledgeCitations(JSON.stringify(payload))).toEqual([
      { docId, quote: '要点一', title: '产品手册.pdf' },
    ]);
    expect(parseKnowledgeCitations({ text: JSON.stringify(payload) })).toHaveLength(1);
    expect(parseKnowledgeCitations({ content: [{ text: JSON.stringify(payload) }] })).toHaveLength(1);
    expect(parseKnowledgeCitations({ citations: 'nope' })).toEqual([]);
  });

  it('merge 按 docId 小写合并，非法 id 剔除', () => {
    const merged = mergeKnowledgeCitations(
      [{ docId: docId, title: '旧标题' }],
      [{ docId: docId.toUpperCase(), quote: '新引文' }, { docId: 'bad' }],
    );
    expect(merged).toEqual([{ docId, title: '旧标题', quote: '新引文' }]);
  });

  it('strip 清洗机器标识（含未闭合前缀与裸 id）', () => {
    const noisy = `结论一<cite_${'x'.repeat(20)}/>更多[no-cite]</no-cite>`;
    const cleaned = stripKnowledgeCitationMarkers(noisy);
    expect(cleaned).not.toMatch(/cite_/i);
    // 未闭合前缀被截断（上游仅折叠行尾空白，不动行内尾随空格）
    expect(stripKnowledgeCitationMarkers('开头 <ci')).toBe('开头 ');
    expect(stripKnowledgeCitationMarkers('裸 id cite_abcdefgh12345 结束')).toBe('裸 id  结束');
  });
});
