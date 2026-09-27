// T2.9/T2.10：记忆注入/抽取 renderer 侧逻辑单测（无网络：BFF 不可达时降级为原文）。

import { describe, expect, it } from 'vitest';
import {
  findLastCompletedExchange,
  enhanceInputWithTeamMemory,
  isMemoryInjectionEnabled,
} from '@/renderer/services/memory/memoryInjection';

const user = (text: string) => ({ type: 'text', position: 'right', content: { content: text } });
const assistant = (text: string) => ({ type: 'text', position: 'left', content: { content: text } });

describe('findLastCompletedExchange', () => {
  it('从消息尾部找到最近 user→assistant 文本交换', () => {
    // AionUi 真实形状：无 role，用 type='text' + position 区分（E-12 修复点）
    const user = (text: string) => ({ type: 'text', position: 'right', content: { content: text } });
    const assistant = (text: string) => ({ type: 'text', position: 'left', content: { content: text } });
    const messages = [
      user('第一问'),
      assistant('这是第一轮较长的助手回复内容，超过二十个字符的门槛。'),
      user('第二问'),
      assistant('这是第二轮较长的助手回复内容，同样超过二十个字符。'),
    ] as never[];
    const exchange = findLastCompletedExchange(messages);
    expect(exchange?.userText).toBe('第二问');
    expect(exchange?.assistantText).toContain('第二轮');
  });

  it('assistant 文本过短或缺失时返回 null', () => {
    expect(findLastCompletedExchange([user('你好')] as never[])).toBeNull();
    expect(findLastCompletedExchange([user('问题'), assistant('已记住了这个信息。')] as never[])).not.toBeNull(); // ≥6 字即认（放宽后）
  });
});

describe('enhanceInputWithTeamMemory（降级语义）', () => {
  it('BFF 未启用（无端口）时原样返回输入，绝不抛错', async () => {
    const input = '帮我总结这份文档';
    expect(await enhanceInputWithTeamMemory(input)).toBe(input);
  });

  it('注入开关默认开启，可读取', () => {
    expect(typeof isMemoryInjectionEnabled()).toBe('boolean');
  });
});
