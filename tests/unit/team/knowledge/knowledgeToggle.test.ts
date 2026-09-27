// 会话「知识库」开关：持久化 + 注入管线透传（对齐 client 决策 Q2）。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { assembleContext } = vi.hoisted(() => ({
  assembleContext: vi.fn(async () => ({ rendered: '## 知识库检索结果\n- 命中一条', degraded: [] })),
}));

vi.mock('@/renderer/api/teamClient', () => ({
  teamBffBaseUrl: () => 'http://127.0.0.1:4118',
  teamApi: { assembleContext },
}));

import { enhanceInputWithTeamMemory, INJECTION_MARK } from '@/renderer/services/memory/memoryInjection';
import {
  KNOWLEDGE_TOGGLE_KEY,
  isKnowledgeEnabled,
  setKnowledgeEnabled,
} from '@/renderer/services/knowledge/knowledgeToggle';

describe('knowledgeToggle 持久化', () => {
  const original = (globalThis as { localStorage?: Storage }).localStorage;

  beforeEach(() => {
    const store = new Map<string, string>();
    (globalThis as { localStorage?: Storage }).localStorage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
      clear: () => store.clear(),
      key: () => null,
      length: 0,
    } as Storage;
  });

  afterEach(() => {
    (globalThis as { localStorage?: Storage }).localStorage = original;
  });

  it('默认开启，显式关闭后可读回', () => {
    expect(isKnowledgeEnabled()).toBe(true);
    setKnowledgeEnabled(false);
    expect(isKnowledgeEnabled()).toBe(false);
    expect(globalThis.localStorage.getItem(KNOWLEDGE_TOGGLE_KEY)).toBe('false');
    setKnowledgeEnabled(true);
    expect(isKnowledgeEnabled()).toBe(true);
  });
});

describe('enhanceInputWithTeamMemory 透传 includeKnowledge', () => {
  beforeEach(() => {
    assembleContext.mockClear();
  });

  it('开关关闭时告知 assemble 不召回知识；开启时按原语义', async () => {
    await enhanceInputWithTeamMemory('公司开户行？', { includeKnowledge: false });
    expect(assembleContext).toHaveBeenCalledWith('公司开户行？', expect.objectContaining({ includeKnowledge: false }));

    await enhanceInputWithTeamMemory('公司开户行？', { includeKnowledge: true });
    expect(assembleContext).toHaveBeenLastCalledWith(
      '公司开户行？',
      expect.objectContaining({ includeKnowledge: true })
    );
  });

  it('注入块带 INJECTION_MARK 标记（气泡展示时会被剥离）', async () => {
    const enhanced = await enhanceInputWithTeamMemory('问题', { includeKnowledge: true });
    expect(enhanced).toContain(INJECTION_MARK);
    expect(enhanced).toContain('知识库检索结果');
    expect(enhanced.endsWith('问题')).toBe(true);
  });
});
