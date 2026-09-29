// E-14：记忆协议（<memorize> 标记）单测——解析/清洗/注入指令。
// 2026-09-29：分类改为「分类名（可选，来自用户现有分类清单）」，指令动态生成。

import { describe, expect, it } from 'vitest';
import {
  buildMemorizeProtocolDirective,
  parseMemorizeBlocks,
  stripMemorizeBlocks,
  INJECTION_MARK,
  INJECTION_MARK_END,
  stripInjectionBlock,
} from '@/renderer/services/memory/memoryInjection';
import { enhanceInputWithTeamMemory } from '@/renderer/services/memory/memoryInjection';

const DIRECTIVE = buildMemorizeProtocolDirective(['偏好习惯', '个人事实']);

describe('parseMemorizeBlocks', () => {
  it('解析完整块与全部属性，缺省值兜底', () => {
    const text = [
      '好的，已了解。',
      '<memorize audience="team" category="要求约束" scope="code" title="发布规范">发布前需双人复核</memorize>',
      '<memorize>个人偏好：深色主题</memorize>',
    ].join('\n');
    const blocks = parseMemorizeBlocks(text);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({
      audience: 'team',
      categoryName: '要求约束',
      scope: 'code',
      title: '发布规范',
      content: '发布前需双人复核',
    });
    expect(blocks[1]).toMatchObject({
      audience: 'personal',
      categoryName: null,
      title: '个人偏好：深色主题',
    });
  });

  it('忽略未闭合前缀与空内容块', () => {
    expect(parseMemorizeBlocks('思考中 <memorize audie')).toEqual([]);
    expect(parseMemorizeBlocks('<memorize title="空">   </memorize>')).toEqual([]);
  });
});

describe('stripMemorizeBlocks（气泡不展示标记）', () => {
  it('剥离完整块与流式未闭合前缀，收敛多余空行', () => {
    const dirty = '答复正文A\n\n<memorize audience="personal" title="t">内容</memorize>\n\n结尾 <memorize audi';
    expect(stripMemorizeBlocks(dirty)).toBe('答复正文A\n\n结尾');
  });
  it('无标记时原样返回（trimEnd 除外）', () => {
    expect(stripMemorizeBlocks('普通回复  ')).toBe('普通回复');
  });
});

describe('stripInjectionBlock（注入块不进气泡）', () => {
  it('剥离起止标记包裹的完整注入块，保留用户原文', () => {
    const injected = `${INJECTION_MARK}\n上下文…\n${DIRECTIVE}\n${INJECTION_MARK_END}\n用户原文第一行\n第二行`;
    expect(stripInjectionBlock(injected)).toBe('用户原文第一行\n第二行');
  });
  it('无标记时原样返回；异常未闭合时丢弃后段（保守）', () => {
    expect(stripInjectionBlock('普通消息')).toBe('普通消息');
    expect(stripInjectionBlock(`${INJECTION_MARK}\n孤儿块\n用户原文`)).toBe('');
  });
});

describe('归属原则（默认个人，显式共享才团队）与分类清单', () => {
  it('协议指令包含硬规则：默认 personal、用户明确要求才 team', () => {
    expect(DIRECTIVE).toContain('默认一律用 personal');
    expect(DIRECTIVE).toContain('只有当用户本轮明确说出');
  });
  it('协议指令注入现有分类名（≤30 条；无分类时提示可省略）', () => {
    expect(DIRECTIVE).toContain('偏好习惯、个人事实');
    expect(DIRECTIVE).toContain('没有合适的就直接省略该属性');
    const empty = buildMemorizeProtocolDirective([]);
    expect(empty).toContain('category 可省略');
    const capped = buildMemorizeProtocolDirective(Array.from({ length: 40 }, (_, index) => `分类${index}`));
    expect(capped).toContain('分类29');
    expect(capped).not.toContain('分类30');
  });
});

describe('注入附带协议指令', () => {
  it('未启用 BFF 时原文返回（不附带指令）', async () => {
    const input = '你好';
    expect(await enhanceInputWithTeamMemory(input)).toBe(input);
    expect(input.includes(DIRECTIVE)).toBe(false);
  });
});
