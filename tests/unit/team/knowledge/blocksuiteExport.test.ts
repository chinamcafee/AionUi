// 可编辑文档：Markdown ↔ BlockSuite 块转换（KE-v2 export.ts 原样移植）单测。

import { describe, expect, it } from 'vitest';
import { markdownToBlocks } from '@/renderer/components/knowledge/blocksuite/export';

describe('markdownToBlocks（与 KE-v2 export.ts 一致）', () => {
  it('标题/引用/段落按类型映射，空行跳过', () => {
    const blocks = markdownToBlocks('# 标题\n> 引用\n\n正文');
    expect(blocks.map((b) => [b.flavour, b.type])).toEqual([
      ['affine:paragraph', 'h1'],
      ['affine:paragraph', 'quote'],
      ['affine:paragraph', 'text'],
    ]);
  });

  it('列表三种形态：无序/有序/待办', () => {
    const blocks = markdownToBlocks('- 要点\n1. 第一步\n- [x] 已完成');
    expect(blocks.map((b) => [b.flavour, b.type])).toEqual([
      ['affine:list', 'bulleted'],
      ['affine:list', 'numbered'],
      ['affine:list', 'todo'],
    ]);
  });

  it('代码块保留原文，分隔线生成 divider', () => {
    const blocks = markdownToBlocks('```ts\nconst a = 1\n```\n---');
    expect(blocks[0]).toMatchObject({ flavour: 'affine:code', raw: 'const a = 1' });
    expect(blocks[1]?.flavour).toBe('affine:divider');
  });

  it('行内格式生成 deltas（bold/code）', () => {
    const [block] = markdownToBlocks('有**加粗**和`代码`');
    expect(block?.flavour).toBe('affine:paragraph');
    expect(block?.deltas.some((d) => d.insert === '加粗' && d.attributes?.bold)).toBe(true);
    expect(block?.deltas.some((d) => d.insert === '代码' && d.attributes?.code)).toBe(true);
  });
});
